// Key-value storage backends and the encrypted record store built on top of them.

import { fromUtf8, utf8 } from '../../server/src/shared/wire.ts';
import { decryptRecord, encryptRecord, type VaultMeta } from './crypto/vault.ts';
import { bridge } from './platform.ts';

export interface StorageBackend {
  get(key: string): Promise<Uint8Array | null>;
  set(key: string, value: Uint8Array): Promise<void>;
  delete(key: string): Promise<void>;
  list(): Promise<string[]>;
  clear(): Promise<void>;
}

export class MemoryStorage implements StorageBackend {
  readonly data = new Map<string, Uint8Array>();
  async get(key: string) {
    return this.data.get(key)?.slice() ?? null;
  }
  async set(key: string, value: Uint8Array) {
    this.data.set(key, value.slice());
  }
  async delete(key: string) {
    this.data.delete(key);
  }
  async list() {
    return [...this.data.keys()];
  }
  async clear() {
    this.data.clear();
  }
}

/** Browser fallback used when the app runs outside Electron (development and tests). */
export class IndexedDBStorage implements StorageBackend {
  private readonly db: Promise<IDBDatabase>;

  constructor(name: string) {
    this.db = new Promise((resolve, reject) => {
      const request = indexedDB.open(name, 1);
      request.onupgradeneeded = () => request.result.createObjectStore('kv');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  private async run<T>(mode: IDBTransactionMode, fn: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
    const db = await this.db;
    return new Promise((resolve, reject) => {
      const request = fn(db.transaction('kv', mode).objectStore('kv'));
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  async get(key: string) {
    const value = await this.run<Uint8Array | undefined>('readonly', (s) => s.get(key));
    return value ? new Uint8Array(value) : null;
  }
  async set(key: string, value: Uint8Array) {
    await this.run('readwrite', (s) => s.put(value.slice(), key));
  }
  async delete(key: string) {
    await this.run('readwrite', (s) => s.delete(key));
  }
  async list() {
    return (await this.run<IDBValidKey[]>('readonly', (s) => s.getAllKeys())).map(String);
  }
  async clear() {
    await this.run('readwrite', (s) => s.clear());
  }
}

export function defaultStorage(): StorageBackend {
  if (bridge) return bridge.storage;
  const profile = new URLSearchParams(globalThis.location?.search ?? '').get('profile') ?? 'default';
  return new IndexedDBStorage(`veil-${profile}`);
}

const META_KEY = 'meta';

export async function readVaultMeta(backend: StorageBackend): Promise<VaultMeta | null> {
  const raw = await backend.get(META_KEY);
  return raw ? (JSON.parse(fromUtf8(raw)) as VaultMeta) : null;
}

export async function writeVaultMeta(backend: StorageBackend, meta: VaultMeta): Promise<void> {
  await backend.set(META_KEY, utf8(JSON.stringify(meta)));
}

/** Every record is encrypted with the vault data key before it reaches the backend. */
export class SecureStore {
  readonly backend: StorageBackend;
  private dataKey: Uint8Array;
  /** "r." for the real vault, "d." for the empty Veil behind the duress password. */
  readonly prefix: string;

  constructor(backend: StorageBackend, dataKey: Uint8Array, prefix = 'r.') {
    this.backend = backend;
    this.dataKey = dataKey;
    this.prefix = prefix;
  }

  private closed = false;

  private assertOpen(): void {
    if (this.closed) throw new Error('Хранилище заблокировано');
  }

  async getBytes(name: string): Promise<Uint8Array | null> {
    this.assertOpen();
    const raw = await this.backend.get(`${this.prefix}${name}`);
    return raw ? decryptRecord(this.dataKey, name, raw) : null;
  }

  async putBytes(name: string, value: Uint8Array): Promise<void> {
    this.assertOpen();
    await this.backend.set(`${this.prefix}${name}`, encryptRecord(this.dataKey, name, value));
  }

  async getJSON<T>(name: string): Promise<T | null> {
    const bytes = await this.getBytes(name);
    return bytes ? (JSON.parse(fromUtf8(bytes)) as T) : null;
  }

  async putJSON(name: string, value: unknown): Promise<void> {
    await this.putBytes(name, utf8(JSON.stringify(value)));
  }

  async delete(name: string): Promise<void> {
    await this.backend.delete(`${this.prefix}${name}`);
  }

  async names(prefix = ''): Promise<string[]> {
    return (await this.backend.list())
      .filter((key) => key.startsWith(`${this.prefix}${prefix}`))
      .map((key) => key.slice(this.prefix.length));
  }

  /** A copy of the data key (quick unlock keeps it in the system keychain). */
  exportKey(): Uint8Array {
    this.assertOpen();
    return this.dataKey.slice();
  }

  /** Deletes every record of this store (the other vault on the same disk stays). */
  async destroy(): Promise<void> {
    for (const name of await this.names()) await this.delete(name);
  }

  /** Forget the key; the store is unusable afterwards. */
  close(): void {
    this.closed = true;
    this.dataKey.fill(0);
  }
}
