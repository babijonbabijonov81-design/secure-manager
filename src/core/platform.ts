// The bridge exposed by the Electron preload script. In a plain browser (development,
// tests) it is absent and the app falls back to web APIs.

export interface EmbeddedServerStatus {
  running: boolean;
  port: number;
  addresses: string[];
  error?: string;
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
  notify(options: { title: string; body: string; tag?: string; silent?: boolean }): void;
  onNotificationClick(callback: (tag: string) => void): () => void;
  setBadge(count: number): void;
  setTheme(theme: 'dark' | 'light'): void;
  setContentProtection(enabled: boolean): void;
  focus(): void;
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
