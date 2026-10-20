// Electron main process: window, tray, notifications, file storage and the optional
// embedded relay. All cryptography happens in the renderer; this process only ever
// stores and moves already-encrypted bytes.

import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, Notification, session, shell, Tray, type IpcMainInvokeEvent } from 'electron';
import { mkdir, readdir, readFile, rename, rm, unlink, writeFile } from 'node:fs/promises';
import { networkInterfaces } from 'node:os';
import { join } from 'node:path';
import { startRelay, type RelayHandle } from '../../server/src/relay.ts';
import trayIconPath from '../../resources/tray.png?asset';
import windowIconPath from '../../resources/icon.png?asset';

const isMac = process.platform === 'darwin';
const isWindows = process.platform === 'win32';
const DEFAULT_PORT = 8787;

// Separate profiles (e.g. `Veil --profile=work` or VEIL_PROFILE=work) keep independent
// accounts on one computer, each with its own data directory.
const profile = process.env.VEIL_PROFILE || app.commandLine.getSwitchValue('profile');
if (profile && /^[\w-]{1,32}$/.test(profile)) app.setPath('userData', `${app.getPath('userData')}-${profile}`);

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

const userData = () => app.getPath('userData');
const vaultDir = () => join(userData(), 'vault');
const configFile = () => join(userData(), 'config.json');

interface AppConfig {
  embeddedServer?: { autoStart: boolean; port: number };
  trayHintShown?: boolean;
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
  dark: { color: '#0d0f15', symbolColor: '#a4aabb' },
  light: { color: '#f6f7fb', symbolColor: '#5a6075' },
};

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 920,
    minHeight: 620,
    show: false,
    title: 'Veil',
    backgroundColor: '#08090d',
    icon: isMac ? undefined : windowIconPath,
    titleBarStyle: isMac ? 'hiddenInset' : 'hidden',
    ...(isMac ? { trafficLightPosition: { x: 14, y: 12 } } : { titleBarOverlay: { ...TITLEBAR.dark, height: 38 } }),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      spellcheck: false,
      devTools: !app.isPackaged,
    },
  });

  mainWindow.once('ready-to-show', () => mainWindow?.show());

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

function createTray(): void {
  if (isMac) return;
  tray = new Tray(nativeImage.createFromPath(trayIconPath));
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

  ipcMain.on('notify', (event, options: { title: string; body: string; tag?: string; silent?: boolean }) => {
    if (!trusted(event) || !Notification.isSupported()) return;
    const notification = new Notification({ title: String(options.title), body: String(options.body), silent: !!options.silent });
    notification.on('click', () => {
      showWindow();
      if (options.tag) mainWindow?.webContents.send('notification-click', options.tag);
    });
    notification.show();
  });

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
    mainWindow.setBackgroundColor(theme === 'light' ? '#eef0f6' : '#08090d');
  });

  ipcMain.on('content-protection', (event, enabled: boolean) => {
    if (trusted(event)) mainWindow?.setContentProtection(!!enabled);
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

app.on('second-instance', showWindow);
app.on('activate', showWindow);
app.on('before-quit', () => {
  quitting = true;
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
  // The app needs no camera, microphone, location etc.
  session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => callback(permission === 'notifications'));
  session.defaultSession.setPermissionCheckHandler((_wc, permission) => permission === 'notifications');

  registerIpc();
  createMenu();
  const config = await readConfig();
  if (config.embeddedServer?.autoStart) await startEmbeddedRelay(config.embeddedServer.port);
  createWindow();
  createTray();
});
