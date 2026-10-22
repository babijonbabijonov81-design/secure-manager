// Electron main process: window, tray, notifications, file storage and the optional
// embedded relay. All cryptography happens in the renderer; this process only ever
// stores and moves already-encrypted bytes.

import {
  app,
  BrowserWindow,
  clipboard,
  ClipboardItem,
  dialog,
  ipcMain,
  Menu,
  nativeImage,
  nativeTheme,
  Notification,
  screen,
  session,
  shell,
  systemPreferences,
  Tray,
  type IpcMainInvokeEvent,
  type MenuItemConstructorOptions,
  type Rectangle,
} from 'electron';
import { mkdir, readdir, readFile, rename, rm, unlink, writeFile } from 'node:fs/promises';
import { hostname, networkInterfaces } from 'node:os';
import { join } from 'node:path';
import { startRelay, type RelayHandle } from '../../server/src/relay.ts';
import { SecretClipboard } from '../core/secret-clipboard.ts';
import { discoverBridges, LanBridge } from './bridge.ts';
import { findInvite, registerInviteProtocol } from './invite.ts';
import { cancelModelDownload, deleteModel, downloadModel, modelStatus, registerModelScheme, serveModels } from './models.ts';
import { CloudError, OneDrive } from './onedrive.ts';
import { fetchLinkPreview } from './preview.ts';
import { chooseScreenSource, listScreenSources, setupScreenShare, usesPortal } from './screen-share.ts';
import {
  disableQuickUnlock,
  enableFingerprint,
  enablePin,
  loadPin,
  pinFailed,
  pinSucceeded,
  quickSlot,
  quickUnlockStatus,
  unlockWithFingerprint,
  watchSystemLock,
} from './system.ts';
import { closeAllCards, closeCard, setupNotificationCards, showNotificationCard, type NotificationCard } from './notifications.ts';
import { setupUpdater } from './updater.ts';
import trayDark2xPath from '../../resources/tray-dark@2x.png?asset';
import trayDarkPath from '../../resources/tray-dark.png?asset';
import tray2xPath from '../../resources/tray@2x.png?asset';
import trayIconPath from '../../resources/tray.png?asset';
import windowIconPath from '../../resources/icon.png?asset';

const isMac = process.platform === 'darwin';
const isWindows = process.platform === 'win32';
const DEFAULT_PORT = 8787;

// Separate profiles (e.g. `Veil --profile=work` or VEIL_PROFILE=work) keep independent
// accounts on one computer, each with its own data directory.
const profile = process.env.VEIL_PROFILE || app.commandLine.getSwitchValue('profile');
if (profile && /^[\w-]{1,32}$/.test(profile)) app.setPath('userData', `${app.getPath('userData')}-${profile}`);

registerModelScheme();

if (!app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}

app.setAppUserModelId('app.veil.messenger');

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let quitting = false;
let relay: RelayHandle | null = null;
let relayError: string | undefined;
let lastBadge = 0;
let systemLock: Promise<boolean> = Promise.resolve(false);
// «Мост» over the local network: only encrypted frames pass through here.
const lanBridge = new LanBridge((channel, value) => mainWindow?.webContents.send(channel, value));

// Development builds may point at a fake Microsoft (tests); packaged ones always use the real one.
const oneDrive = new OneDrive({
  clientId: (!app.isPackaged && process.env.VEIL_MS_CLIENT_ID) || __VEIL_MS_CLIENT_ID__,
  openBrowser: (url) => void shell.openExternal(url),
  ...(!app.isPackaged && process.env.VEIL_MS_LOGIN ? { loginBase: process.env.VEIL_MS_LOGIN } : {}),
  ...(!app.isPackaged && process.env.VEIL_MS_GRAPH ? { graphBase: process.env.VEIL_MS_GRAPH } : {}),
});

const userData = () => app.getPath('userData');
const vaultDir = () => join(userData(), 'vault');
const configFile = () => join(userData(), 'config.json');

interface AppConfig {
  embeddedServer?: { autoStart: boolean; port: number };
  trayHintShown?: boolean;
  window?: { bounds?: Rectangle; maximized?: boolean; fullscreen?: boolean };
}

async function readConfig(): Promise<AppConfig> {
  try {
    return JSON.parse(await readFile(configFile(), 'utf8')) as AppConfig;
  } catch {
    return {};
  }
}

async function writeConfig(patch: Partial<AppConfig>): Promise<void> {
  const next = { ...(await readConfig()), ...patch };
  await mkdir(userData(), { recursive: true });
  await writeFile(configFile(), JSON.stringify(next, null, 2));
}

// ---- window ----------------------------------------------------------------------------

const TITLEBAR = {
  dark: { color: '#100d0b', symbolColor: '#c9c0b6' },
  light: { color: '#f6f1eb', symbolColor: '#4a413a' },
};

/** Saved size and position, if they still fit on a connected display. */
function restoredBounds(saved: Rectangle | undefined): Partial<Rectangle> {
  if (!saved) return {};
  const visible = screen.getAllDisplays().some((d) => {
    const a = d.workArea;
    return saved.x < a.x + a.width - 100 && saved.x + saved.width > a.x + 100 && saved.y >= a.y - 20 && saved.y < a.y + a.height - 100;
  });
  return visible ? saved : { width: saved.width, height: saved.height };
}

function createWindow(state: AppConfig['window'] = undefined): void {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    ...restoredBounds(state?.bounds),
    minWidth: 480,
    minHeight: 560,
    show: false,
    title: 'Veil',
    backgroundColor: '#0c0a09',
    icon: isMac ? undefined : windowIconPath,
    titleBarStyle: isMac ? 'hiddenInset' : 'hidden',
    ...(isMac ? { trafficLightPosition: { x: 14, y: 12 } } : { titleBarOverlay: { ...TITLEBAR.dark, height: 38 } }),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      spellcheck: true,
      devTools: !app.isPackaged,
    },
  });

  // First launch opens maximized; afterwards the last size, position and state are restored.
  mainWindow.once('ready-to-show', () => {
    if (!state || state.maximized) mainWindow?.maximize();
    if (state?.fullscreen) mainWindow?.setFullScreen(true);
    mainWindow?.show();
  });
  let saveTimer: ReturnType<typeof setTimeout> | null = null;
  const saveState = () => {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      const win = mainWindow;
      if (!win || win.isDestroyed() || win.isMinimized()) return;
      const normal = !win.isMaximized() && !win.isFullScreen();
      void readConfig().then((config) =>
        writeConfig({
          window: {
            bounds: normal ? win.getBounds() : config.window?.bounds,
            maximized: win.isMaximized(),
            fullscreen: win.isFullScreen(),
          },
        }),
      );
    }, 500);
  };
  for (const event of ['resize', 'move', 'maximize', 'unmaximize', 'enter-full-screen', 'leave-full-screen'] as const) {
    mainWindow.on(event as 'resize', saveState);
  }
  mainWindow.on('enter-full-screen', () => mainWindow?.webContents.send('fullscreen', true));
  mainWindow.on('leave-full-screen', () => mainWindow?.webContents.send('fullscreen', false));

  // F11 toggles full screen on Windows and Linux (macOS uses the green button / ⌃⌘F).
  mainWindow.webContents.on('before-input-event', (event, input) => {
    if (input.type === 'keyDown' && input.key === 'F11' && !isMac) {
      event.preventDefault();
      mainWindow?.setFullScreen(!mainWindow.isFullScreen());
    }
  });

  // Right-click on text: spelling suggestions and the usual clipboard actions.
  mainWindow.webContents.on('context-menu', (_event, params) => {
    const items: MenuItemConstructorOptions[] = [];
    if (params.misspelledWord) {
      for (const suggestion of params.dictionarySuggestions.slice(0, 5)) {
        items.push({ label: suggestion, click: () => mainWindow?.webContents.replaceMisspelling(suggestion) });
      }
      if (!params.dictionarySuggestions.length) items.push({ label: 'Нет вариантов', enabled: false });
      items.push({
        label: 'Добавить в словарь',
        click: () => mainWindow?.webContents.session.addWordToSpellCheckerDictionary(params.misspelledWord),
      });
      items.push({ type: 'separator' });
    }
    if (params.isEditable) {
      items.push(
        { label: 'Вырезать', role: 'cut', enabled: params.editFlags.canCut },
        { label: 'Копировать', role: 'copy', enabled: params.editFlags.canCopy },
        { label: 'Вставить', role: 'paste', enabled: params.editFlags.canPaste },
        { type: 'separator' },
        { label: 'Выделить всё', role: 'selectAll' },
      );
    } else if (params.selectionText.trim()) {
      items.push({ label: 'Копировать', role: 'copy' });
    }
    if (items.length) Menu.buildFromTemplate(items).popup({ window: mainWindow! });
  });

  // Never open other windows or navigate away from the app; links go to the browser.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (url !== mainWindow?.webContents.getURL()) event.preventDefault();
  });

  mainWindow.on('close', (event) => {
    if (quitting) return;
    // Keep running in the background so messages keep arriving.
    event.preventDefault();
    mainWindow?.hide();
    mainWindow?.webContents.send('window-hidden');
    if (!isMac) void showTrayHint();
  });

  mainWindow.on('focus', () => mainWindow?.flashFrame(false));

  if (process.env.ELECTRON_RENDERER_URL) void mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL);
  else void mainWindow.loadFile(join(__dirname, '../renderer/index.html'));
}

function showWindow(): void {
  if (!mainWindow) createWindow();
  if (mainWindow?.isMinimized()) mainWindow.restore();
  mainWindow?.show();
  mainWindow?.focus();
}

async function showTrayHint(): Promise<void> {
  const config = await readConfig();
  if (config.trayHintShown || !Notification.isSupported()) return;
  new Notification({ title: 'Veil работает в фоне', body: 'Чтобы выйти полностью, используйте меню значка в трее.', silent: true }).show();
  await writeConfig({ trayHintShown: true });
}

/** One-colour tray mark: light on dark panels, dark on the light Windows taskbar. */
function trayImage(): Electron.NativeImage {
  const light = isWindows && !nativeTheme.shouldUseDarkColorsForSystemIntegratedUI;
  const image = nativeImage.createFromPath(light ? trayDarkPath : trayIconPath);
  image.addRepresentation({ scaleFactor: 2, dataURL: nativeImage.createFromPath(light ? trayDark2xPath : tray2xPath).toDataURL() });
  return image;
}

function createTray(): void {
  if (isMac) return;
  tray = new Tray(trayImage());
  nativeTheme.on('updated', () => tray?.setImage(trayImage()));
  tray.setToolTip('Veil');
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Открыть Veil', click: showWindow },
      { type: 'separator' },
      {
        label: 'Выйти',
        click: () => {
          quitting = true;
          app.quit();
        },
      },
    ]),
  );
  tray.on('click', showWindow);
}

function createMenu(): void {
  if (!isMac) {
    Menu.setApplicationMenu(null);
    return;
  }
  // macOS needs an application menu for standard shortcuts (copy, paste, quit…).
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      { role: 'appMenu' },
      { role: 'editMenu' },
      {
        label: 'Вид',
        submenu: [{ role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { type: 'separator' }, { role: 'togglefullscreen' }],
      },
      { role: 'windowMenu' },
    ]),
  );
}

// ---- IPC -------------------------------------------------------------------------------

/** Only our own page may talk to the main process. */
function trusted(event: IpcMainInvokeEvent | Electron.IpcMainEvent): boolean {
  const url = event.senderFrame?.url ?? '';
  if (process.env.ELECTRON_RENDERER_URL) return url.startsWith(process.env.ELECTRON_RENDERER_URL);
  return url.startsWith('file://');
}

function handle<A extends unknown[], R>(channel: string, fn: (...args: A) => Promise<R> | R): void {
  ipcMain.handle(channel, (event, ...args) => {
    if (!trusted(event)) throw new Error('untrusted sender');
    return fn(...(args as A));
  });
}

const fileFor = (key: unknown): string => {
  if (typeof key !== 'string' || !key || key.length > 200) throw new Error('bad key');
  // Hex keeps names safe on case-insensitive file systems (Windows, macOS).
  return join(vaultDir(), `${Buffer.from(key, 'utf8').toString('hex')}.bin`);
};

const writeChains = new Map<string, Promise<void>>();
function serialized(file: string, task: () => Promise<void>): Promise<void> {
  const next = (writeChains.get(file) ?? Promise.resolve()).then(task, task);
  writeChains.set(
    file,
    next.catch(() => {}),
  );
  return next;
}

async function atomicWrite(file: string, data: Uint8Array): Promise<void> {
  await mkdir(vaultDir(), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, data);
  for (let attempt = 0; ; attempt++) {
    try {
      await rename(tmp, file);
      return;
    } catch (error) {
      // Windows can briefly lock files (antivirus, indexer): retry a few times.
      if (attempt >= 5) throw error;
      await new Promise((r) => setTimeout(r, 50 * (attempt + 1)));
    }
  }
}

function registerIpc(): void {
  ipcMain.on('app:version', (event) => {
    event.returnValue = app.getVersion();
  });
  ipcMain.on('app:device-name', (event) => {
    const os = isWindows ? 'Windows' : isMac ? 'macOS' : 'Linux';
    event.returnValue = `${hostname()} · ${os}`.slice(0, 80);
  });

  // «Мост» over the local network: only encrypted frames pass through here.
  handle('preview:fetch', (url: string) => fetchLinkPreview(String(url)));
  handle('models:status', () => modelStatus());
  handle('models:download', (id: string) =>
    downloadModel(id, (done, total) => mainWindow?.webContents.send('models:progress', { done, total })),
  );
  handle('models:cancel', () => cancelModelDownload());
  handle('models:delete', (id: string) => deleteModel(id));
  handle('screen:sources', async () => ({ portal: usesPortal, sources: await listScreenSources() }));
  handle('screen:choose', (id: string | null) => chooseScreenSource(id));
  handle('invite:take', () => {
    const invite = pendingInvite;
    pendingInvite = null;
    return invite;
  });
  handle('bridge:host', () => lanBridge.host());
  handle('bridge:discover', () => discoverBridges());
  handle('bridge:connect', (host: string, port: number) => lanBridge.connect(String(host), Number(port)));
  ipcMain.on('bridge:send', (event, data: Uint8Array) => trusted(event) && data instanceof Uint8Array && lanBridge.send(data));
  ipcMain.on('bridge:drop', (event) => trusted(event) && lanBridge.drop());
  ipcMain.on('bridge:stop', (event) => trusted(event) && lanBridge.stop());

  handle('storage:get', async (key: string) => {
    try {
      return new Uint8Array(await readFile(fileFor(key)));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  });
  handle('storage:set', (key: string, data: Uint8Array) => {
    const file = fileFor(key);
    if (!(data instanceof Uint8Array)) throw new Error('bad data');
    return serialized(file, () => atomicWrite(file, data));
  });
  handle('storage:delete', (key: string) => {
    const file = fileFor(key);
    return serialized(file, () => unlink(file).catch(() => {}));
  });
  handle('storage:list', async () => {
    try {
      return (await readdir(vaultDir()))
        .filter((name) => name.endsWith('.bin'))
        .map((name) => Buffer.from(name.slice(0, -4), 'hex').toString('utf8'));
    } catch {
      return [];
    }
  });
  handle('storage:clear', async () => {
    await Promise.all(writeChains.values());
    await rm(vaultDir(), { recursive: true, force: true });
  });

  ipcMain.on('notify', (event, options: { title: string; body: string; tag?: string; silent?: boolean; card?: NotificationCard }) => {
    if (!trusted(event)) return;
    if (options.card) {
      showNotificationCard({ ...options.card, tag: options.tag });
      if (options.card.call && !mainWindow?.isFocused()) mainWindow?.flashFrame(true);
      return;
    }
    if (!Notification.isSupported()) return;
    const notification = new Notification({
      title: String(options.title),
      body: String(options.body),
      silent: !!options.silent,
      icon: isMac ? undefined : windowIconPath,
    });
    notification.on('click', () => {
      showWindow();
      if (options.tag) mainWindow?.webContents.send('notification-click', options.tag);
    });
    notification.show();
  });

  ipcMain.on('notify:close', (event, tag: unknown) => {
    if (trusted(event) && typeof tag === 'string') closeCard(tag);
  });
  // Locked: no message text may stay on screen in notification cards.
  ipcMain.on('notify:close-all', (event) => trusted(event) && closeAllCards());

  // «Копия в OneDrive»: only files Veil has already encrypted pass through here.
  const cloud = <T>(task: () => Promise<T>) =>
    Promise.resolve()
      .then(task)
      .then(
      (value) => ({ ok: true as const, value }),
      (error: unknown) => ({
        ok: false as const,
        code: error instanceof CloudError ? error.code : 'failed',
        message: error instanceof Error ? error.message : 'Не получилось',
      }),
    );
  const bytes = (data: unknown) => {
    if (!(data instanceof Uint8Array)) throw new CloudError('failed', 'Нет данных');
    return data;
  };
  handle('cloud:status', () => ({ configured: oneDrive.configured }));
  handle('cloud:signin', () => cloud(() => oneDrive.signIn()));
  handle('cloud:cancel', () => oneDrive.cancel());
  handle('cloud:list', (refresh: string) => cloud(() => oneDrive.list(String(refresh))));
  handle('cloud:upload', (refresh: string, name: string, data: Uint8Array) => cloud(() => oneDrive.upload(String(refresh), String(name), bytes(data))));
  handle('cloud:download', (refresh: string, name: string) => cloud(() => oneDrive.download(String(refresh), String(name))));
  handle('cloud:remove', (refresh: string, name: string) => cloud(() => oneDrive.remove(String(refresh), String(name))));
  handle('cloud:forget', (refresh: string) => oneDrive.forget(String(refresh)));

  handle('quick:status', (slot: number) => quickUnlockStatus(quickSlot(slot)));
  handle('quick:enable-pin', (slot: number, blob: string) => enablePin(quickSlot(slot), blob));
  handle('quick:load-pin', (slot: number) => loadPin(quickSlot(slot)));
  handle('quick:pin-failed', (slot: number) => pinFailed(quickSlot(slot)));
  handle('quick:pin-ok', (slot: number) => pinSucceeded(quickSlot(slot)));
  handle('quick:enable-fingerprint', (slot: number, key: string) => enableFingerprint(quickSlot(slot), key));
  handle('quick:fingerprint', (slot: number) => unlockWithFingerprint(quickSlot(slot)));
  handle('quick:disable', (slot: number, what: 'pin' | 'fingerprint' | 'all') =>
    disableQuickUnlock(quickSlot(slot), ['pin', 'fingerprint'].includes(what) ? what : 'all'),
  );
  handle('system:lock-supported', () => systemLock);

  ipcMain.on('badge', (event, count: number) => {
    if (!trusted(event)) return;
    const value = Math.max(0, Math.floor(Number(count) || 0));
    if (!isWindows) app.setBadgeCount(value);
    if (isWindows && value > lastBadge && !mainWindow?.isFocused()) mainWindow?.flashFrame(true);
    tray?.setToolTip(value ? `Veil — непрочитанных: ${value}` : 'Veil');
    lastBadge = value;
  });

  ipcMain.on('focus', (event) => trusted(event) && showWindow());

  ipcMain.on('theme', (event, theme: 'dark' | 'light') => {
    if (!trusted(event) || isMac || !mainWindow) return;
    mainWindow.setTitleBarOverlay({ ...(theme === 'light' ? TITLEBAR.light : TITLEBAR.dark), height: 38 });
    mainWindow.setBackgroundColor(theme === 'light' ? '#faf7f3' : '#0c0a09');
  });

  ipcMain.on('content-protection', (event, enabled: boolean) => {
    if (trusted(event)) mainWindow?.setContentProtection(!!enabled);
  });

  ipcMain.on('clipboard:text', (event, text: string) => {
    if (trusted(event) && typeof text === 'string') void clipboard.writeText(text);
  });
  handle('clipboard:secret', (text: string, seconds: number) => secretClipboard.copy(String(text), Math.max(0, Number(seconds) || 0)));
  handle('clipboard:clear-secret', () => secretClipboard.clear());
  // The renderer converts images to PNG first.
  ipcMain.on('clipboard:image', (event, data: Uint8Array) => {
    if (!trusted(event) || !(data instanceof Uint8Array)) return;
    void clipboard.write([new ClipboardItem({ 'image/png': new Blob([data as BlobPart], { type: 'image/png' }) })]);
  });

  ipcMain.on('spell:enable', (event, enabled: boolean) => {
    if (trusted(event)) session.defaultSession.setSpellCheckerEnabled(!!enabled);
  });
  ipcMain.on('spell:add', (event, word: string) => {
    if (trusted(event) && typeof word === 'string' && word.length < 64) session.defaultSession.addWordToSpellCheckerDictionary(word);
  });

  handle('mic:request', async () => {
    if (!isMac) return true;
    if (systemPreferences.getMediaAccessStatus('microphone') === 'granted') return true;
    return systemPreferences.askForMediaAccess('microphone');
  });
  // macOS asks the person once before the camera can be used (video calls, QR codes).
  handle('camera:request', async () => {
    if (!isMac) return true;
    if (systemPreferences.getMediaAccessStatus('camera') === 'granted') return true;
    return systemPreferences.askForMediaAccess('camera');
  });

  ipcMain.on('fullscreen:toggle', (event) => {
    if (trusted(event) && mainWindow) mainWindow.setFullScreen(!mainWindow.isFullScreen());
  });

  ipcMain.on('open-external', (event, url: string) => {
    if (trusted(event) && typeof url === 'string' && /^https?:\/\//i.test(url)) void shell.openExternal(url);
  });

  handle('save-file', async (name: string, data: Uint8Array) => {
    if (!mainWindow) return false;
    const result = await dialog.showSaveDialog(mainWindow, {
      defaultPath: join(app.getPath('downloads'), String(name).replace(/[\\/:*?"<>|]/g, '_')),
    });
    if (result.canceled || !result.filePath) return false;
    await writeFile(result.filePath, data);
    return true;
  });

  handle('server:start', (port?: number) => startEmbeddedRelay(port));
  handle('server:stop', async () => {
    await relay?.close();
    relay = null;
    relayError = undefined;
    return relayStatus();
  });
  handle('server:status', () => relayStatus());
  handle('server:autostart', (enabled: boolean, port?: number) =>
    writeConfig({ embeddedServer: { autoStart: !!enabled, port: Number(port) || DEFAULT_PORT } }),
  );
}

// ---- passwords on the clipboard ------------------------------------------------------------

/** Windows clipboard formats that keep a copy out of Win+V history and the cloud clipboard. */
function windowsPrivacyFormats(): Record<string, Blob> {
  const zero = new Blob([new Uint8Array(4)]);
  const raw = (format: string) => `electron application/osclipboard;format="${format}"`;
  return {
    [raw('ExcludeClipboardContentFromMonitorProcessing')]: new Blob([new Uint8Array(0)]),
    [raw('CanIncludeInClipboardHistory')]: zero,
    [raw('CanUploadToCloudClipboard')]: zero,
  };
}

const secretClipboard = new SecretClipboard({
  write: async (text, secret) => {
    if (isWindows && secret) {
      try {
        await clipboard.write([new ClipboardItem({ 'text/plain': text, ...windowsPrivacyFormats() })]);
        return;
      } catch {
        // older Windows builds: a plain copy is still erased on time
      }
    }
    await clipboard.writeText(text);
  },
  read: () => clipboard.readText(),
  clear: () => clipboard.writeText(''),
});

// ---- embedded relay ----------------------------------------------------------------------

function lanAddresses(port: number): string[] {
  const addresses: string[] = [];
  for (const list of Object.values(networkInterfaces())) {
    for (const info of list ?? []) {
      if (info.family === 'IPv4' && !info.internal) addresses.push(`${info.address}:${port}`);
    }
  }
  return [`localhost:${port}`, ...addresses];
}

function relayStatus() {
  return {
    running: !!relay,
    port: relay?.port ?? DEFAULT_PORT,
    addresses: relay ? lanAddresses(relay.port) : [],
    ...(relayError ? { error: relayError } : {}),
  };
}

async function startEmbeddedRelay(port = DEFAULT_PORT) {
  if (relay) return relayStatus();
  try {
    relay = await startRelay({ port, dataDir: join(userData(), 'relay'), name: 'Veil Relay (встроенный)' });
    relayError = undefined;
  } catch (error) {
    relay = null;
    relayError =
      (error as NodeJS.ErrnoException).code === 'EADDRINUSE' ? `Порт ${port} уже занят другой программой` : (error as Error).message;
  }
  return relayStatus();
}

// ---- lifecycle ---------------------------------------------------------------------------

// A veil:// link opened while Veil runs (Windows and Linux start a second copy with it).
let pendingInvite: string | null = findInvite(process.argv);
// macOS hands veil:// links to the running app (or the one it starts) as an event.
app.on('open-url', (event, url) => {
  event.preventDefault();
  const invite = findInvite([url]);
  if (!invite) return;
  pendingInvite = invite;
  mainWindow?.webContents.send('invite');
  if (app.isReady()) showWindow();
});
app.on('second-instance', (_event, argv) => {
  const invite = findInvite(argv);
  if (invite) {
    pendingInvite = invite;
    mainWindow?.webContents.send('invite');
  }
  showWindow();
});
app.on('activate', showWindow);
app.on('before-quit', () => {
  quitting = true;
  lanBridge.stop();
  closeAllCards();
  void secretClipboard.clear();
});
app.on('will-quit', (event) => {
  if (!relay) return;
  event.preventDefault();
  const closing = relay;
  relay = null;
  void closing.close().finally(() => app.quit());
});
app.on('window-all-closed', () => {
  if (!isMac) app.quit();
});

app.whenReady().then(async () => {
  // Only what the app uses: notifications, clipboard writes, the microphone (voice messages and
  // calls) and the camera (scanning a veil:// QR code). No location, MIDI, USB etc.
  const allowed = (permission: string, mediaTypes?: string[]) =>
    permission === 'notifications' ||
    permission === 'clipboard-sanitized-write' ||
    (permission === 'media' && (!mediaTypes || mediaTypes.every((t) => t === 'audio' || t === 'video')));
  session.defaultSession.setPermissionRequestHandler((_wc, permission, callback, details) =>
    callback(allowed(permission, (details as { mediaTypes?: string[] }).mediaTypes)),
  );
  session.defaultSession.setPermissionCheckHandler((_wc, permission, _origin, details) => {
    const mediaType = (details as { mediaType?: string }).mediaType;
    // "unknown" is asked when listing devices: needed to show microphone names in Settings → Audio.
    return allowed(permission, mediaType && mediaType !== 'unknown' ? [mediaType] : undefined);
  });
  if (!isMac) {
    try {
      session.defaultSession.setSpellCheckerLanguages(['ru', 'en-US']);
    } catch {
      // dictionaries unavailable on this system
    }
  }

  registerIpc();
  serveModels();
  setupScreenShare();
  void registerInviteProtocol();
  createMenu();
  systemLock = watchSystemLock(() => mainWindow?.webContents.send('system-lock'));
  setupNotificationCards(
    (tag) => {
      showWindow();
      if (tag) mainWindow?.webContents.send('notification-click', tag);
    },
    (tag, action) => {
      if (action === 'accept') showWindow();
      mainWindow?.webContents.send('call-action', { tag, action });
    },
  );
  setupUpdater(
    () => mainWindow,
    () => {
      quitting = true;
    },
  );
  const config = await readConfig();
  if (config.embeddedServer?.autoStart) await startEmbeddedRelay(config.embeddedServer.port);
  createWindow(config.window);
  createTray();
});
