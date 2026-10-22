// Storage for the relay: public key directory + offline queues of encrypted envelopes.
// With a data directory everything survives restarts; without one it lives in memory.

import { mkdir, readdir, readFile, rename, rm, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import type { BackupMeta, DeviceRecord, OneTimePreKeyPublic, SignedPreKeyPublic } from './shared/protocol.ts';
import { unb64 } from './shared/wire.ts';

export interface UserRecord {
  userId: string;
  username: string;
  dhKey: string;
  dhSig: string;
  spk: SignedPreKeyPublic;
  opks: OneTimePreKeyPublic[];
  createdAt: number;
  /** HMAC of the recovery email: the address itself is never stored. */
  emailHash?: string;
  /** Base32 TOTP secret when two-factor authentication is on. */
  totp?: string;
  /** Last accepted TOTP time step, so a code cannot be replayed. */
  totpLast?: number;
  backup?: BackupMeta & { size: number };
  /** Computers that signed in (up to 10), with encrypted names. */
  devices?: DeviceRecord[];
  /** Device ids the owner unlinked: sign-in from them is refused. */
  revoked?: string[];
  /** When the @name was changed (last few), to limit how often it can be. */
  renamedAt?: number[];
}

export interface QueuedEnvelope {
  id: string;
  ts: number;
  size: number;
  /** Present in memory mode; in disk mode the bytes are read lazily from `file`. */
  data?: Uint8Array;
  file?: string;
}

export interface StoreLimits {
  maxQueueItems: number;
  maxQueueBytes: number;
  maxOpks: number;
  ttlMs: number;
}

export const DEFAULT_LIMITS: StoreLimits = {
  maxQueueItems: 5000,
  maxQueueBytes: 200 * 1024 * 1024,
  maxOpks: 300,
  ttlMs: 30 * 24 * 60 * 60 * 1000,
};

const hex = (bytes: Uint8Array) => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
// Directory names must be safe on case-insensitive file systems, so ids are hex encoded.
const userDir = (userId: string) => hex(unb64(userId));

export class RelayStore {
  readonly users = new Map<string, UserRecord>();
  readonly usernames = new Map<string, string>();
  readonly queues = new Map<string, QueuedEnvelope[]>();
  readonly limits: StoreLimits;
  private readonly dataDir: string | null;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private saving: Promise<void> = Promise.resolve();
  private counter = 0;
  private readonly memoryBackups = new Map<string, Uint8Array>();
  /** Server secret mixed into email hashes. */
  pepper: Uint8Array = randomBytes(32);

  constructor(dataDir: string | null, limits: Partial<StoreLimits> = {}) {
    this.dataDir = dataDir;
    this.limits = { ...DEFAULT_LIMITS, ...limits };
  }

  async load(): Promise<void> {
    if (!this.dataDir) return;
    await mkdir(join(this.dataDir, 'queue'), { recursive: true });
    await mkdir(join(this.dataDir, 'backups'), { recursive: true });
    try {
      this.pepper = new Uint8Array(await readFile(join(this.dataDir, 'secret.key')));
    } catch {
      await writeFile(join(this.dataDir, 'secret.key'), this.pepper, { mode: 0o600 });
    }
    try {
      const raw = JSON.parse(await readFile(join(this.dataDir, 'users.json'), 'utf8')) as { users: UserRecord[] };
      for (const user of raw.users ?? []) {
        this.users.set(user.userId, user);
        this.usernames.set(user.username, user.userId);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    for (const user of this.users.values()) {
      const dir = join(this.dataDir, 'queue', userDir(user.userId));
      let names: string[] = [];
      try {
        names = (await readdir(dir)).filter((n) => n.endsWith('.bin')).sort();
      } catch {
        continue;
      }
      const queue: QueuedEnvelope[] = [];
      for (const name of names) {
        const [ts, , id, size] = name.slice(0, -4).split('-');
        queue.push({ id, ts: Number(ts), size: Number(size), file: join(dir, name) });
      }
      if (queue.length) this.queues.set(user.userId, queue);
    }
  }

  // ---- users -----------------------------------------------------------------------

  addUser(user: UserRecord): void {
    this.users.set(user.userId, user);
    this.usernames.set(user.username, user.userId);
    this.scheduleSave();
  }

  async removeUser(userId: string): Promise<void> {
    const user = this.users.get(userId);
    if (!user) return;
    this.users.delete(userId);
    this.usernames.delete(user.username);
    this.queues.delete(userId);
    this.memoryBackups.delete(userId);
    this.scheduleSave();
    if (this.dataDir) {
      await rm(join(this.dataDir, 'queue', userDir(userId)), { recursive: true, force: true });
      await rm(join(this.dataDir, 'backups', `${userDir(userId)}.bin`), { force: true });
    }
  }

  /** Moves the user to a new @name; the old one becomes free immediately. */
  renameUser(userId: string, username: string): void {
    const user = this.users.get(userId);
    if (!user) return;
    if (this.usernames.get(user.username) === userId) this.usernames.delete(user.username);
    user.username = username;
    user.renamedAt = [...(user.renamedAt ?? []), Date.now()].slice(-5);
    this.usernames.set(username, userId);
    this.scheduleSave();
  }

  touch(): void {
    this.scheduleSave();
  }

  // ---- encrypted backups -------------------------------------------------------------

  async putBackup(userId: string, meta: BackupMeta, data: Uint8Array): Promise<void> {
    const user = this.users.get(userId);
    if (!user) return;
    if (this.dataDir) {
      const file = join(this.dataDir, 'backups', `${userDir(userId)}.bin`);
      await writeFile(`${file}.tmp`, data);
      await rename(`${file}.tmp`, file);
    } else {
      this.memoryBackups.set(userId, data);
    }
    user.backup = { ...meta, size: data.length };
    this.scheduleSave();
  }

  async getBackup(userId: string): Promise<Uint8Array | null> {
    if (!this.dataDir) return this.memoryBackups.get(userId) ?? null;
    try {
      return new Uint8Array(await readFile(join(this.dataDir, 'backups', `${userDir(userId)}.bin`)));
    } catch {
      return null;
    }
  }

  async deleteBackup(userId: string): Promise<void> {
    const user = this.users.get(userId);
    if (user) delete user.backup;
    this.memoryBackups.delete(userId);
    if (this.dataDir) await rm(join(this.dataDir, 'backups', `${userDir(userId)}.bin`), { force: true });
    this.scheduleSave();
  }

  byUsername(username: string): UserRecord | undefined {
    const userId = this.usernames.get(username);
    return userId ? this.users.get(userId) : undefined;
  }

  takeOneTimePreKey(userId: string): OneTimePreKeyPublic | undefined {
    const user = this.users.get(userId);
    const opk = user?.opks.shift();
    if (opk) this.scheduleSave();
    return opk;
  }

  addPreKeys(userId: string, opks: OneTimePreKeyPublic[] | undefined, spk: SignedPreKeyPublic | undefined): number {
    const user = this.users.get(userId);
    if (!user) return 0;
    if (opks?.length) {
      const known = new Set(user.opks.map((k) => k.id));
      for (const opk of opks) if (!known.has(opk.id)) user.opks.push(opk);
      if (user.opks.length > this.limits.maxOpks) user.opks.splice(0, user.opks.length - this.limits.maxOpks);
    }
    if (spk) user.spk = spk;
    this.scheduleSave();
    return user.opks.length;
  }

  // ---- queues ----------------------------------------------------------------------

  queueOf(userId: string): QueuedEnvelope[] {
    return this.queues.get(userId) ?? [];
  }

  /** Returns false if the recipient's queue is over quota. */
  async enqueue(userId: string, id: string, data: Uint8Array): Promise<QueuedEnvelope | null> {
    const queue = this.queues.get(userId) ?? [];
    const bytes = queue.reduce((sum, item) => sum + item.size, 0);
    if (queue.length >= this.limits.maxQueueItems || bytes + data.length > this.limits.maxQueueBytes) return null;
    const ts = Date.now();
    const item: QueuedEnvelope = { id, ts, size: data.length };
    if (this.dataDir) {
      const dir = join(this.dataDir, 'queue', userDir(userId));
      await mkdir(dir, { recursive: true });
      const seq = String(this.counter++ % 1e9).padStart(9, '0');
      item.file = join(dir, `${ts}-${seq}-${id}-${data.length}.bin`);
      await writeFile(item.file, data);
    } else {
      item.data = data;
    }
    queue.push(item);
    this.queues.set(userId, queue);
    return item;
  }

  async read(item: QueuedEnvelope): Promise<Uint8Array | null> {
    if (item.data) return item.data;
    if (!item.file) return null;
    try {
      return new Uint8Array(await readFile(item.file));
    } catch {
      return null;
    }
  }

  async remove(userId: string, ids: Iterable<string>): Promise<void> {
    const queue = this.queues.get(userId);
    if (!queue) return;
    const drop = new Set(ids);
    const keep: QueuedEnvelope[] = [];
    for (const item of queue) {
      if (!drop.has(item.id)) keep.push(item);
      else if (item.file) await unlink(item.file).catch(() => {});
    }
    if (keep.length) this.queues.set(userId, keep);
    else this.queues.delete(userId);
  }

  async expire(now = Date.now()): Promise<number> {
    let removed = 0;
    for (const [userId, queue] of this.queues) {
      const old = queue.filter((item) => now - item.ts > this.limits.ttlMs).map((item) => item.id);
      if (old.length) {
        removed += old.length;
        await this.remove(userId, old);
      }
    }
    return removed;
  }

  // ---- persistence -----------------------------------------------------------------

  private scheduleSave(): void {
    if (!this.dataDir || this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      void this.flush();
    }, 200);
  }

  async flush(): Promise<void> {
    if (!this.dataDir) return;
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    const dir = this.dataDir;
    const snapshot = JSON.stringify({ users: [...this.users.values()] });
    this.saving = this.saving.then(async () => {
      const tmp = join(dir, `users.json.${process.pid}.tmp`);
      await writeFile(tmp, snapshot);
      await rename(tmp, join(dir, 'users.json'));
    });
    await this.saving;
  }
}
