// The bridge exposed by the Electron preload script. In a plain browser (development,
// tests) it is absent and the app falls back to web APIs.

export interface EmbeddedServerStatus {
  running: boolean;
  /** The server's stable id (same as in its hello). */
  id?: string;
  port: number;
  addresses: string[];
  error?: string;
}

export interface UpdateState {
  status: 'idle' | 'checking' | 'available' | 'none' | 'downloading' | 'ready' | 'error';
  current: string;
  version?: string;
  percent?: number;
  /** This build cannot install updates itself: offer the download page instead. */
  manual: boolean;
  /**
   * Installed by a package manager (.deb, .rpm, Flatpak): «Обновите через менеджер пакетов» and
   * the command to run after downloading the new package.
   */
  packaged?: { kind: 'deb' | 'rpm' | 'flatpak'; command: string };
  error?: string;
}

export interface NotificationCardData {
  initials: string;
  gradient: string;
  theme: 'dark' | 'light';
  accent: string;
  title: string;
  body: string;
  /** Incoming call: answer/decline buttons, stays until the call is settled. */
  call?: boolean;
}

export interface QuickUnlockStatus {
  available: boolean;
  keychain: 'dpapi' | 'keychain' | 'libsecret' | 'kwallet' | 'test' | 'none';
  pin: boolean;
  attemptsLeft: number;
  fingerprint: { available: boolean; enabled: boolean };
  hello: false;
}

export interface CloudFile {
  name: string;
  size: number;
  modified: number;
}

export type CloudErrorCode = 'not_configured' | 'cancelled' | 'auth' | 'network' | 'not_found' | 'quota' | 'failed';
export type CloudResult<T> = { ok: true; value: T } | { ok: false; code: CloudErrorCode; message: string };

export interface VeilBridge {
  platform: 'darwin' | 'win32' | 'linux';
  version: string;
  /** "DESKTOP-1A2B · Windows": shown (encrypted) in Settings → «Устройства». */
  deviceName: string;
  storage: {
    get(key: string): Promise<Uint8Array | null>;
    set(key: string, value: Uint8Array): Promise<void>;
    delete(key: string): Promise<void>;
    list(): Promise<string[]>;
    clear(): Promise<void>;
  };
  /** With `card`, Veil's own styled notification is shown instead of the system one. */
  notify(options: { title: string; body: string; tag?: string; silent?: boolean; card?: NotificationCardData }): void;
  onNotificationClick(callback: (tag: string) => void): () => void;
  /** Removes a notification card (e.g. an incoming call that was answered or ended). */
  closeNotification(tag: string): void;
  /** Removes every notification card (when Veil locks). */
  closeAllNotifications(): void;
  /** Answer/decline pressed on an incoming call card. */
  onCallAction(callback: (action: { tag: string; action: 'accept' | 'decline' }) => void): () => void;
  setBadge(count: number): void;
  setTheme(theme: 'dark' | 'light'): void;
  setContentProtection(enabled: boolean): void;
  focus(): void;
  copyText(text: string): void;
  /**
   * Copies a password: kept out of the Windows clipboard history and cloud sync, erased after
   * `seconds` (0 = never) if the clipboard still holds it.
   */
  copySecret(text: string, seconds: number): Promise<void>;
  /** Erases a copied password right away (if it is still there). */
  clearSecret(): Promise<boolean>;
  /** PNG bytes. */
  copyImage(png: Uint8Array): void;
  spell: {
    /** Suggestions if the word is misspelled, otherwise null. */
    suggestions(word: string): string[] | null;
    addWord(word: string): void;
    setEnabled(enabled: boolean): void;
  };
  requestMicrophone(): Promise<boolean>;
  /** A call started or ended: while on, the window is not throttled when minimized (video keeps going). */
  setCallActive(active: boolean): void;
  /** macOS: the system's camera permission (video calls, QR codes); true elsewhere. */
  requestCamera(): Promise<boolean>;
  /** Quick unlock: the vault key in the system keychain, behind a PIN or a fingerprint. */
  quickUnlock: {
    /** Which account on this computer the calls below are about (each has its own PIN and fingerprint). */
    select(slot: 1 | 2): void;
    status(): Promise<QuickUnlockStatus>;
    enablePin(blob: string): Promise<void>;
    loadPin(): Promise<string | null>;
    pinFailed(): Promise<number>;
    pinSucceeded(): Promise<void>;
    enableFingerprint(key: string): Promise<void>;
    fingerprint(): Promise<string | null>;
    disable(what: 'pin' | 'fingerprint' | 'all'): Promise<void>;
  };
  /** The operating system locked the screen or went to sleep. */
  onSystemLock(callback: () => void): () => void;
  /** Whether locking together with the system can be detected here. */
  systemLockSupported(): Promise<boolean>;
  /** The window was hidden to the tray. */
  onHidden(callback: () => void): () => void;
  /** «Мост» over the local network (TCP + mDNS); frames are encrypted by the renderer. */
  lan: {
    host(): Promise<{ port: number; addresses: string[]; name: string }>;
    discover(): Promise<{ name: string; host: string; port: number }[]>;
    connect(host: string, port: number): Promise<void>;
    send(data: Uint8Array): void;
    /** Drop the current peer, keep listening. */
    drop(): void;
    stop(): void;
    onPeer(callback: () => void): () => void;
    onData(callback: (data: Uint8Array) => void): () => void;
    onClosed(callback: () => void): () => void;
  };
  toggleFullscreen(): void;
  onFullscreen(callback: (fullscreen: boolean) => void): () => void;
  update: {
    state(): Promise<UpdateState>;
    check(): Promise<void>;
    download(): void;
    install(): void;
    openPage(): void;
    onState(callback: (state: UpdateState) => void): () => void;
  };
  openExternal(url: string): void;
  /** The sender's side of link previews: fetches a public page's title, description and picture. */
  linkPreview(url: string): Promise<{ url: string; title: string; desc?: string; site?: string; image?: Uint8Array; imageType?: string } | null>;
  /** «Голосовые в текст»: Whisper models on this computer (downloaded only with consent). */
  models: {
    status(): Promise<Record<'tiny' | 'base' | 'small', { installed: boolean; mb: number }>>;
    download(id: 'tiny' | 'base' | 'small'): Promise<void>;
    cancel(): Promise<void>;
    remove(id: 'tiny' | 'base' | 'small'): Promise<void>;
    onProgress(callback: (progress: { done: number; total: number }) => void): () => void;
  };
  /** «Показ экрана»: screens and windows to pick from, or `portal` when the system asks itself (Wayland). */
  screen: {
    sources(): Promise<{ portal: boolean; sources: { id: string; name: string; kind: 'screen' | 'window'; thumbnail: string }[] }>;
    /** The next getDisplayMedia() shares this source (null: cancel). */
    choose(id: string | null): Promise<void>;
  };
  /**
   * «Копия в OneDrive»: Microsoft sign-in in the system browser and the app's own OneDrive folder.
   * Every call takes the refresh token (kept in the encrypted vault) and returns the one to keep,
   * since Microsoft may replace it. Results come as data (an error's code would not survive the
   * context bridge): use `cloudApi` below.
   */
  cloud: {
    status(): Promise<{ configured: boolean }>;
    signIn(): Promise<CloudResult<string>>;
    cancel(): Promise<void>;
    list(refresh: string): Promise<CloudResult<{ refresh: string; files: CloudFile[] }>>;
    upload(refresh: string, name: string, data: Uint8Array): Promise<CloudResult<{ refresh: string }>>;
    download(refresh: string, name: string): Promise<CloudResult<{ refresh: string; data: Uint8Array }>>;
    remove(refresh: string, name: string): Promise<CloudResult<{ refresh: string }>>;
    forget(refresh: string): Promise<void>;
  };
  /** A veil:// link the system opened Veil with, once (then null). */
  takeInvite(): Promise<string | null>;
  /** A veil:// link arrived while Veil was running: call takeInvite(). */
  onInvite(callback: () => void): () => void;
  saveFile(name: string, data: Uint8Array): Promise<boolean>;
  server: {
    /** Other computers' Veil servers announced on this network (mDNS), with their ids. */
    discover(): Promise<{ name: string; address: string; id?: string }[]>;
    start(port?: number): Promise<EmbeddedServerStatus>;
    stop(): Promise<EmbeddedServerStatus>;
    status(): Promise<EmbeddedServerStatus>;
    setAutoStart(enabled: boolean, port?: number): Promise<void>;
  };
}

export const bridge: VeilBridge | undefined = (globalThis as { veil?: VeilBridge }).veil;
export const isDesktop = !!bridge;
export const platform = bridge?.platform ?? 'web';

/** The OneDrive calls with errors as exceptions carrying a `code` (CloudErrorCode). */
export interface CloudApi {
  status(): Promise<{ configured: boolean }>;
  signIn(): Promise<string>;
  cancel(): Promise<void>;
  list(refresh: string): Promise<{ refresh: string; files: CloudFile[] }>;
  upload(refresh: string, name: string, data: Uint8Array): Promise<{ refresh: string }>;
  download(refresh: string, name: string): Promise<{ refresh: string; data: Uint8Array }>;
  remove(refresh: string, name: string): Promise<{ refresh: string }>;
  forget(refresh: string): Promise<void>;
}

async function unwrap<T>(call: Promise<CloudResult<T>>): Promise<T> {
  const result = await call;
  if (result.ok) return result.value;
  throw Object.assign(new Error(result.message), { code: result.code });
}

export const cloudApi: CloudApi | null = bridge
  ? {
      status: () => bridge.cloud.status(),
      signIn: () => unwrap(bridge.cloud.signIn()),
      cancel: () => bridge.cloud.cancel(),
      list: (refresh) => unwrap(bridge.cloud.list(refresh)),
      upload: (refresh, name, data) => unwrap(bridge.cloud.upload(refresh, name, data)),
      download: (refresh, name) => unwrap(bridge.cloud.download(refresh, name)),
      remove: (refresh, name) => unwrap(bridge.cloud.remove(refresh, name)),
      forget: (refresh) => bridge.cloud.forget(refresh),
    }
  : null;
