// The bridge exposed by the Electron preload script. In a plain browser (development,
// tests) it is absent and the app falls back to web APIs.

export interface EmbeddedServerStatus {
  running: boolean;
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
  error?: string;
}

export interface NotificationCardData {
  initials: string;
  gradient: string;
  theme: 'dark' | 'light';
  accent: string;
  title: string;
  body: string;
}

export interface VeilBridge {
  platform: 'darwin' | 'win32' | 'linux';
  version: string;
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
  setBadge(count: number): void;
  setTheme(theme: 'dark' | 'light'): void;
  setContentProtection(enabled: boolean): void;
  focus(): void;
  copyText(text: string): void;
  /** PNG bytes. */
  copyImage(png: Uint8Array): void;
  spell: {
    /** Suggestions if the word is misspelled, otherwise null. */
    suggestions(word: string): string[] | null;
    addWord(word: string): void;
    setEnabled(enabled: boolean): void;
  };
  requestMicrophone(): Promise<boolean>;
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
  saveFile(name: string, data: Uint8Array): Promise<boolean>;
  server: {
    start(port?: number): Promise<EmbeddedServerStatus>;
    stop(): Promise<EmbeddedServerStatus>;
    status(): Promise<EmbeddedServerStatus>;
    setAutoStart(enabled: boolean, port?: number): Promise<void>;
  };
}

export const bridge: VeilBridge | undefined = (globalThis as { veil?: VeilBridge }).veil;
export const isDesktop = !!bridge;
export const platform = bridge?.platform ?? 'web';
