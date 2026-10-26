// The vault on the iPhone: one SQLite table of records the core has already encrypted.
import * as SQLite from 'expo-sqlite';
import type { StorageBackend } from '../../../src/core/storage.ts';

export class SQLiteStorage implements StorageBackend {
  private readonly db: Promise<SQLite.SQLiteDatabase>;

  constructor(name = 'veil.db') {
    this.db = SQLite.openDatabaseAsync(name).then(async (db) => {
      await db.execAsync('PRAGMA journal_mode = WAL; CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY NOT NULL, v BLOB NOT NULL);');
      return db;
    });
  }

  async get(key: string) {
    const row = await (await this.db).getFirstAsync<{ v: Uint8Array }>('SELECT v FROM kv WHERE k = ?', key);
    return row ? new Uint8Array(row.v) : null;
  }
  async set(key: string, value: Uint8Array) {
    await (await this.db).runAsync('INSERT OR REPLACE INTO kv (k, v) VALUES (?, ?)', key, value);
  }
  async delete(key: string) {
    await (await this.db).runAsync('DELETE FROM kv WHERE k = ?', key);
  }
  async list() {
    return (await (await this.db).getAllAsync<{ k: string }>('SELECT k FROM kv')).map((row) => row.k);
  }
  async clear() {
    await (await this.db).runAsync('DELETE FROM kv');
  }
}

export const deviceStorage = (): StorageBackend => new SQLiteStorage();
