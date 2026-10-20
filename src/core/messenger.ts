// The messenger engine: accounts, contacts, sessions, sending and receiving.
// UI-agnostic; React subscribes through subscribe()/getSnapshot().

import { sha256 } from '@noble/hashes/sha2.js';
import {
  USERNAME_RE,
  type AccountStatus,
  type BackupMeta,
  type PreKeyBundle,
  type RegisterFrame,
  type UserInfo,
} from '../../server/src/shared/protocol.ts';
import { authStatement, registerExtra } from '../../server/src/shared/protocol.ts';
import { base32Encode, otpauthUrl, verifyTotp } from '../../server/src/shared/totp.ts';
import { b64, concat, fromUtf8, pack, randomId, unb64, unpack, utf8 } from '../../server/src/shared/wire.ts';
import { compress, decompress } from './compress.ts';
import { safetyNumber } from './crypto/fingerprint.ts';
import { generateDH, keyPairFromJSON, keyPairToJSON, random, sign } from './crypto/primitives.ts';
import { openEnvelope, sealEnvelope, type SenderInfo } from './crypto/sealed.ts';
import {
  createInitiatorSession,
  createResponderSession,
  ephemeralDecrypt,
  ephemeralEncrypt,
  parseWire,
  sessionDecrypt,
  sessionEncrypt,
  type SessionRecord,
} from './crypto/session.ts';
import {
  changeVaultPassword,
  createVault,
  deriveBackupKey,
  openBackup,
  sealBackup,
  unlockVault,
  verifyVaultPassword,
  WrongPasswordError,
  type VaultMeta,
} from './crypto/vault.ts';
import { generateIdentity, signPreKey, verifyDhKey, type IdentityKeys } from './crypto/x3dh.ts';
import { anonymousRequest, RelayClient, RelayRequestError, type ConnectionStatus } from './relay-client.ts';
import { readVaultMeta, SecureStore, writeVaultMeta, type StorageBackend } from './storage.ts';
import {
  attachmentsOf,
  DEFAULT_SETTINGS,
  MAX_ALBUM_ITEMS,
  MAX_ATTACHMENT_BYTES,
  type AccountRecord,
  type Attachment,
  type AttachmentKind,
  type AttachmentMeta,
  type Contact,
  type Content,
  type Message,
  type MessengerSnapshot,
  type OutboxItem,
  type ReplyRef,
  type Settings,
  type StickerMeta,
  type SystemEvent,
} from './types.ts';

const OPK_BATCH = 100;
const OPK_LOW_WATER = 40;
const SPK_ROTATE_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_SESSIONS_PER_CONTACT = 5;
const MAX_SEEN_IDS = 3000;
const TYPING_TIMEOUT_MS = 6000;
const ONLINE_GRACE_MS = 150_000;
const HEARTBEAT_MS = 60_000;
const BACKUP_MIN_INTERVAL_MS = 10 * 60 * 1000;
const BACKUP_STALE_MS = 6 * 60 * 60 * 1000;
const BACKUP_MESSAGES_PER_CHAT = 3000;

export interface MessengerEvents {
  /** A new incoming message the UI may want to notify about. */
  onIncoming?(contact: Contact, message: Message): void;
}

export interface CreateAccountOptions {
  storage: StorageBackend;
  serverUrl: string;
  username: string;
  displayName: string;
  password: string;
  kdf?: { N: number; r: number; p: number };
  /** From email recovery: take over the username with brand-new keys. */
  recoveryToken?: string;
  onProgress?(stage: 'keys' | 'register' | 'vault', progress?: number): void;
}

export interface OutgoingFile {
  name: string;
  mime: string;
  data: Uint8Array;
  w?: number;
  h?: number;
  kind?: AttachmentKind;
  dur?: number;
  wave?: number[];
  sticker?: string;
}

/** Result of a successful email (+2FA) check during recovery. */
export interface RecoveryTicket {
  serverUrl: string;
  username: string;
  token: string;
  userId: string;
  backup: (BackupMeta & { size: number }) | null;
  data: Uint8Array;
}

interface BackupPayload {
  v: 1;
  account: AccountRecord;
  settings: Settings;
  contacts: Record<string, Contact>;
  conversations: Record<string, Message[]>;
  createdAt: number;
}

export class MessengerError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
    this.name = 'MessengerError';
  }
}

/** Short text describing a message, for reply quotes and previews. */
export function snippetOf(message: Message): string {
  if (message.text) return message.text.slice(0, 200);
  const atts = attachmentsOf(message);
  const first = atts[0];
  if (!first) return '';
  if (first.kind === 'voice') return '🎤 Голосовое сообщение';
  if (first.kind === 'sticker') return 'Стикер';
  if (first.kind === 'image') return atts.length > 1 ? `📷 ${atts.length} фото` : '📷 Фото';
  return `📎 ${first.name}`;
}

const hex = (bytes: Uint8Array) => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
const cleanEmoji = (value: unknown) => (typeof value === 'string' ? [...value].slice(0, 8).join('') : '');
const cleanUsername = (username: string) => username.trim().toLowerCase().replace(/^@/, '');
const IMAGE_MIME = /^image\/(png|jpe?g|gif|webp|avif|bmp)$/;

export const hasAccount = async (storage: StorageBackend) => !!(await readVaultMeta(storage));

/** Register on the relay and create a fresh encrypted vault. */
export async function createAccount(options: CreateAccountOptions, events: MessengerEvents = {}): Promise<Messenger> {
  const username = cleanUsername(options.username);
  if (!USERNAME_RE.test(username))
    throw new MessengerError('bad_username', 'Имя пользователя: 3–32 символа, латиница, цифры и «_»');
  const displayName = options.displayName.trim() || username;

  options.onProgress?.('keys');
  const identity = generateIdentity();
  const spk = generateDH();
  const now = Date.now();
  const account: AccountRecord = {
    userId: b64(identity.sign.pub),
    username,
    displayName,
    sign: keyPairToJSON(identity.sign),
    dh: keyPairToJSON(identity.dh),
    dhSig: b64(identity.dhSig),
    spks: [{ id: 1, pub: b64(spk.pub), priv: b64(spk.priv), sig: b64(signPreKey(identity.sign.priv, 1, spk.pub)), createdAt: now }],
    opks: {},
    nextOpkId: 1,
    nextSpkId: 2,
    serverUrl: options.serverUrl.trim(),
    createdAt: now,
  };
  generateOneTimePreKeys(account, OPK_BATCH);

  options.onProgress?.('vault', 0);
  const { meta, dataKey } = await createVault(options.password, options.kdf, (p) => options.onProgress?.('vault', p));
  const messenger = new Messenger(options.storage, new SecureStore(options.storage, dataKey), meta, events);
  messenger.loadState({ account, settings: { ...DEFAULT_SETTINGS }, contacts: {}, sessions: {}, outbox: [], seen: [], stickers: [] });

  options.onProgress?.('register');
  try {
    await messenger.registerFirstTime(options.recoveryToken);
  } catch (error) {
    messenger.dispose();
    throw error;
  }
  await writeVaultMeta(options.storage, meta);
  messenger.markDirty('account', 'settings', 'contacts', 'sessions', 'outbox', 'seen', 'stickers');
  await messenger.flushNow();
  return messenger;
}

/**
 * Decrypt the local vault. Throws WrongPasswordError on a bad password.
 * With two-factor authentication the messenger stays offline until `completeTotp()`.
 */
export async function unlock(
  storage: StorageBackend,
  password: string,
  events: MessengerEvents = {},
  onProgress?: (p: number) => void,
): Promise<Messenger> {
  const meta = await readVaultMeta(storage);
  if (!meta) throw new MessengerError('no_account', 'Аккаунт не найден');
  const dataKey = await unlockVault(meta, password, onProgress);
  const store = new SecureStore(storage, dataKey);
  const account = await store.getJSON<AccountRecord>('account');
  if (!account) throw new MessengerError('corrupt', 'Данные повреждены');
  const messenger = new Messenger(storage, store, meta, events);
  const [settings, contacts, sessions, outbox, seen, stickers] = await Promise.all([
    store.getJSON<Settings>('settings'),
    store.getJSON<Record<string, Contact>>('contacts'),
    store.getJSON<Record<string, SessionRecord[]>>('sessions'),
    store.getJSON<OutboxItem[]>('outbox'),
    store.getJSON<string[]>('seen'),
    store.getJSON<StickerMeta[]>('stickers'),
  ]);
  messenger.loadState({
    account,
    settings: { ...DEFAULT_SETTINGS, ...settings },
    contacts: contacts ?? {},
    sessions: sessions ?? {},
    outbox: outbox ?? [],
    seen: seen ?? [],
    stickers: stickers ?? [],
  });
  for (const id of Object.keys(contacts ?? {})) {
    const messages = await store.getJSON<Message[]>(`conv.${id}`);
    // v1.0 left "message deleted" placeholders behind; deleted messages now vanish completely.
    if (messages) messenger.conversations.set(id, messages.filter((m) => !m.deleted));
  }
  messenger.sweepExpired();
  if (account.totp) messenger.needsTotp = true;
  else messenger.connect();
  return messenger;
}

// ---- account recovery ----------------------------------------------------------------------

/** Step 1: the relay emails a code if the username and email match. */
export async function startRecovery(serverUrl: string, username: string, email: string): Promise<void> {
  await anonymousRequest(serverUrl, { type: 'recover_start', username: cleanUsername(username), email: email.trim() });
}

/** Step 2: email code (+ authenticator code) → recovery ticket with the encrypted backup. */
export async function verifyRecovery(serverUrl: string, username: string, code: string, totp?: string): Promise<RecoveryTicket> {
  const { data, body } = await anonymousRequest<{ token: string; userId: string; backup: RecoveryTicket['backup'] }>(serverUrl, {
    type: 'recover_finish',
    username: cleanUsername(username),
    code: code.trim(),
    ...(totp ? { totp: totp.trim() } : {}),
  });
  return { serverUrl, username: cleanUsername(username), token: data.token, userId: data.userId, backup: data.backup, data: body };
}

/** Step 3a: decrypt the server backup with the password and continue on this device. */
export async function restoreAccount(
  options: { storage: StorageBackend; ticket: RecoveryTicket; password: string; kdf?: { N: number; r: number; p: number } },
  events: MessengerEvents = {},
): Promise<Messenger> {
  const { ticket, password, storage } = options;
  if (!ticket.backup) throw new MessengerError('no_backup', 'На сервере нет резервной копии этого аккаунта');
  const { key, kdf } = await deriveBackupKey(password, ticket.backup.kdf);
  const plaintext = await decompress(openBackup(key, unb64(ticket.backup.nonce), ticket.data));
  const payload = JSON.parse(fromUtf8(plaintext)) as BackupPayload;
  if (payload.v !== 1 || payload.account?.userId !== ticket.userId) throw new MessengerError('corrupt', 'Резервная копия повреждена');

  const { meta, dataKey } = await createVault(password, options.kdf);
  const messenger = new Messenger(storage, new SecureStore(storage, dataKey), meta, events);
  const account: AccountRecord = {
    ...payload.account,
    serverUrl: ticket.serverUrl,
    ...(payload.account.recovery
      ? { recovery: { ...payload.account.recovery, key: b64(key), kdf: { N: kdf.N, r: kdf.r, p: kdf.p, salt: kdf.salt } } }
      : {}),
  };
  messenger.loadState({
    account,
    settings: { ...DEFAULT_SETTINGS, ...payload.settings },
    contacts: payload.contacts ?? {},
    sessions: {},
    outbox: [],
    seen: [],
    stickers: [],
  });
  const conversations = payload.conversations ?? {};
  for (const [id, messages] of Object.entries(conversations)) messenger.conversations.set(id, messages);
  messenger.helloPending = true;
  await writeVaultMeta(storage, meta);
  messenger.markDirty('account', 'settings', 'contacts', 'sessions', 'outbox', 'seen', 'stickers', ...Object.keys(conversations).map((id) => `conv.${id}`));
  await messenger.flushNow();
  messenger.connect();
  return messenger;
}

/** Step 3b (password forgotten): keep the username but start over with new keys. */
export function resetAccount(
  options: Omit<CreateAccountOptions, 'serverUrl' | 'username' | 'recoveryToken'> & { ticket: RecoveryTicket },
  events: MessengerEvents = {},
): Promise<Messenger> {
  const { ticket, ...rest } = options;
  return createAccount({ ...rest, serverUrl: ticket.serverUrl, username: ticket.username, recoveryToken: ticket.token }, events);
}

function generateOneTimePreKeys(account: AccountRecord, count: number) {
  const created: { id: number; pub: string }[] = [];
  for (let i = 0; i < count; i++) {
    const id = account.nextOpkId++;
    const kp = generateDH();
    account.opks[id] = keyPairToJSON(kp);
    created.push({ id, pub: b64(kp.pub) });
  }
  return created;
}

interface LoadedState {
  account: AccountRecord;
  settings: Settings;
  contacts: Record<string, Contact>;
  sessions: Record<string, SessionRecord[]>;
  outbox: OutboxItem[];
  seen: string[];
  stickers: StickerMeta[];
}

export interface SendOptions {
  /** Id of the message being replied to. */
  replyTo?: string;
}

export class Messenger {
  readonly storage: StorageBackend;
  readonly conversations = new Map<string, Message[]>();
  /** Two-factor authentication: the authenticator code is still required to go online. */
  needsTotp = false;
  /** After restoring from a backup: open fresh sessions with every contact. */
  helloPending = false;
  private readonly store: SecureStore;
  private meta: VaultMeta;
  private readonly events: MessengerEvents;

  private account!: AccountRecord;
  private identity!: IdentityKeys;
  private settings!: Settings;
  private contacts: Record<string, Contact> = {};
  private sessions: Record<string, SessionRecord[]> = {};
  private outbox: OutboxItem[] = [];
  private seen: string[] = [];
  private seenSet = new Set<string>();
  private stickers: StickerMeta[] = [];

  private relay: RelayClient | null = null;
  private status: ConnectionStatus = 'offline';
  private statusError?: string;
  private fatal?: string;
  private typing: Record<string, number> = {};
  private typingTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private lastTypingSent = new Map<string, number>();
  /** Contacts currently online: until when (our clock) and when we last heard from them. */
  private online: Record<string, { until: number; last: number }> = {};
  private lastHeartbeat = 0;

  private readonly dirty = new Set<string>();
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private flushing: Promise<void> = Promise.resolve();
  private readonly contactLocks = new Map<string, Promise<unknown>>();
  private pumping = false;
  private readonly inbox: { id: string; ts: number; body: Uint8Array }[] = [];
  private draining = false;
  private tickTimer: ReturnType<typeof setInterval> | null = null;
  private backupTimer: ReturnType<typeof setTimeout> | null = null;
  private backingUp = false;
  private resolvingContacts = new Map<string, Promise<UserInfo | null>>();
  private pendingTotpSecret: string | null = null;
  private pendingRecovery: { email: string; key: Uint8Array; kdf: { N: number; r: number; p: number; salt: string } } | null = null;
  private recoveryToken: string | undefined;

  private listeners = new Set<() => void>();
  private snapshot: MessengerSnapshot | null = null;
  private notifyQueued = false;
  private locked = false;
  /** Set once the vault key is gone: nothing may be written after that. */
  private closed = false;

  constructor(storage: StorageBackend, store: SecureStore, meta: VaultMeta, events: MessengerEvents) {
    this.storage = storage;
    this.store = store;
    this.meta = meta;
    this.events = events;
  }

  // ---- lifecycle ---------------------------------------------------------------------

  loadState(state: LoadedState): void {
    this.account = state.account;
    this.settings = state.settings;
    this.contacts = state.contacts;
    this.sessions = state.sessions;
    this.outbox = state.outbox;
    this.seen = state.seen;
    this.seenSet = new Set(state.seen);
    this.stickers = state.stickers;
    this.identity = {
      sign: keyPairFromJSON(state.account.sign),
      dh: keyPairFromJSON(state.account.dh),
      dhSig: unb64(state.account.dhSig),
    };
    this.tickTimer = setInterval(() => this.tick(), 1000);
  }

  /** Used once while creating the account: resolves when the relay accepted us. */
  registerFirstTime(recoveryToken?: string): Promise<void> {
    this.recoveryToken = recoveryToken;
    return new Promise((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        this.relay?.close();
        reject(new MessengerError('timeout', 'Сервер не отвечает. Проверьте адрес сервера.'));
      }, 20_000);
      this.connect(true, {
        ready: () => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          this.recoveryToken = undefined;
          resolve();
        },
        fatal: (code, message) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          this.relay?.close();
          reject(new MessengerError(code, message));
        },
      });
    });
  }

  /** Second factor at unlock: checks the authenticator code, then goes online. */
  completeTotp(code: string): boolean {
    if (!this.needsTotp) return true;
    if (!this.account.totp || verifyTotp(this.account.totp, code) === null) return false;
    this.needsTotp = false;
    this.connect();
    this.changed();
    return true;
  }

  connect(register = false, hooks?: { ready(): void; fatal(code: string, message: string): void }): void {
    if (this.locked) return;
    this.relay?.close();
    this.fatal = undefined;
    let pendingHooks = hooks;
    const relay = new RelayClient({
      url: this.account.serverUrl,
      userId: this.account.userId,
      signPriv: this.identity.sign.priv,
      register,
      buildRegistration: (nonce) => this.buildRegistration(nonce),
      onStatus: (status, error) => {
        this.status = status;
        this.statusError = status === 'online' ? undefined : error;
        if (status !== 'online') this.online = {};
        this.changed();
      },
      onReady: (frame) => {
        pendingHooks?.ready();
        pendingHooks = undefined;
        void this.afterReady(frame.opkCount, frame.spkId);
      },
      onMessage: (id, ts, body) => {
        this.inbox.push({ id, ts, body });
        void this.drainInbox();
      },
      onPrekeysLow: (count) => void this.refillPreKeys(count),
      onFatal: (code, message) => {
        if (pendingHooks) {
          pendingHooks.fatal(code, message);
          pendingHooks = undefined;
        } else {
          this.fatal = message;
          this.changed();
        }
      },
    });
    this.relay = relay;
    relay.connect();
  }

  /** Stops timers and the connection without touching storage. */
  dispose(): void {
    this.locked = true;
    this.closed = true;
    this.relay?.close();
    this.relay = null;
    this.stopTimers();
    this.listeners.clear();
  }

  async lock(): Promise<void> {
    if (this.locked) return;
    this.announcePresence('off');
    this.locked = true;
    this.relay?.close();
    this.relay = null;
    this.stopTimers();
    for (const timer of this.typingTimers.values()) clearTimeout(timer);
    await this.flushNow();
    this.closed = true;
    this.store.close();
    this.identity.sign.priv.fill(0);
    this.identity.dh.priv.fill(0);
    this.listeners.clear();
  }

  private stopTimers(): void {
    if (this.tickTimer) clearInterval(this.tickTimer);
    if (this.flushTimer) clearTimeout(this.flushTimer);
    if (this.backupTimer) clearTimeout(this.backupTimer);
    this.tickTimer = this.flushTimer = this.backupTimer = null;
  }

  // ---- React integration -------------------------------------------------------------

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = (): MessengerSnapshot => {
    if (!this.snapshot) {
      const now = Date.now();
      const contacts = Object.values(this.contacts).sort(
        (a, b) => Number(!!b.pinned) - Number(!!a.pinned) || b.lastActivity - a.lastActivity,
      );
      const typing: Record<string, boolean> = {};
      for (const [id, until] of Object.entries(this.typing)) if (until > now) typing[id] = true;
      const online: Record<string, boolean> = {};
      for (const [id, state] of Object.entries(this.online)) if (state.until > now) online[id] = true;
      this.snapshot = {
        status: this.status,
        statusError: this.statusError,
        fatal: this.fatal,
        me: {
          userId: this.account.userId,
          username: this.account.username,
          displayName: this.account.displayName,
          serverUrl: this.account.serverUrl,
        },
        security: {
          totp: !!this.account.totp,
          recoveryEmail: this.account.recovery?.email,
          lastBackupAt: this.account.recovery?.lastBackupAt || undefined,
        },
        settings: this.settings,
        contacts,
        conversations: Object.fromEntries(this.conversations),
        typing,
        online,
        stickers: this.stickers,
      };
    }
    return this.snapshot;
  };

  private changed(): void {
    this.snapshot = null;
    if (this.notifyQueued) return;
    this.notifyQueued = true;
    queueMicrotask(() => {
      this.notifyQueued = false;
      for (const listener of this.listeners) listener();
    });
  }

  // ---- persistence -------------------------------------------------------------------

  markDirty(...names: string[]): void {
    if (this.closed) return;
    for (const name of names) this.dirty.add(name);
    if (!this.flushTimer) this.flushTimer = setTimeout(() => void this.flushNow(), 300);
  }

  async flushNow(): Promise<void> {
    if (this.closed) return;
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    const names = [...this.dirty];
    this.dirty.clear();
    const write = async () => {
      for (const name of names) {
        if (name === 'account') await this.store.putJSON(name, this.account);
        else if (name === 'settings') await this.store.putJSON(name, this.settings);
        else if (name === 'contacts') await this.store.putJSON(name, this.contacts);
        else if (name === 'sessions') await this.store.putJSON(name, this.sessions);
        else if (name === 'outbox') await this.store.putJSON(name, this.outbox);
        else if (name === 'seen') await this.store.putJSON(name, this.seen);
        else if (name === 'stickers') await this.store.putJSON(name, this.stickers);
        else if (name.startsWith('conv.')) {
          const messages = this.conversations.get(name.slice(5));
          if (messages) await this.store.putJSON(name, messages);
          else await this.store.delete(name);
        }
      }
    };
    this.flushing = this.flushing.then(write, write);
    await this.flushing;
  }

  /** Runs every second: disappearing messages, presence expiry and heartbeats. */
  private tick(): void {
    this.sweepExpired();
    const now = Date.now();
    for (const [id, state] of Object.entries(this.online)) {
      if (state.until > now) continue;
      delete this.online[id];
      if (this.contacts[id] && !this.contacts[id].presenceHidden) this.updateContact(id, { lastSeen: state.last });
      this.changed();
    }
    if (now - this.lastHeartbeat > HEARTBEAT_MS && this.relay?.status === 'online') {
      this.lastHeartbeat = now;
      // Keep contacts who are online now up to date that we are still here.
      if (this.settings.lastSeen === 'everyone') {
        for (const id of Object.keys(this.online)) void this.sendEphemeral(id, { t: 'pres', s: 'on' });
      }
    }
  }

  // ---- registration & prekeys ----------------------------------------------------------

  private async buildRegistration(nonce: string): Promise<RegisterFrame> {
    const missing = OPK_BATCH - Object.keys(this.account.opks).length;
    if (missing > 0) {
      generateOneTimePreKeys(this.account, missing);
      this.markDirty('account');
      await this.flushNow();
    }
    const spk = this.account.spks[0];
    const frame = {
      username: this.account.username,
      dhKey: b64(this.identity.dh.pub),
      spk: { id: spk.id, pub: spk.pub, sig: spk.sig },
    };
    return {
      type: 'register',
      userId: this.account.userId,
      dhSig: this.account.dhSig,
      opks: Object.entries(this.account.opks)
        .slice(0, OPK_BATCH)
        .map(([id, kp]) => ({ id: Number(id), pub: kp.pub })),
      sig: b64(sign(authStatement(nonce, 'register', registerExtra(frame)), this.identity.sign.priv)),
      ...(this.recoveryToken ? { recoveryToken: this.recoveryToken } : {}),
      ...frame,
    };
  }

  private async afterReady(opkCount: number, spkId: number | null): Promise<void> {
    try {
      const newest = this.account.spks[0];
      if (Date.now() - newest.createdAt > SPK_ROTATE_MS || spkId !== newest.id) await this.rotateSignedPreKey();
      if (opkCount < OPK_LOW_WATER) await this.refillPreKeys(opkCount);
      await this.pumpOutbox();
      await this.retryUnsent();
      if (this.helloPending) {
        this.helloPending = false;
        for (const contact of Object.values(this.contacts)) if (!contact.blocked) void this.sendControl(contact, { t: 'hi' });
      }
      this.announcePresence('on', true);
      const recovery = this.account.recovery;
      if (recovery && Date.now() - recovery.lastBackupAt > BACKUP_STALE_MS) void this.backupNow().catch(() => {});
    } catch (error) {
      console.warn('post-login maintenance failed', error);
    }
  }

  private async rotateSignedPreKey(): Promise<void> {
    const newest = this.account.spks[0];
    if (Date.now() - newest.createdAt > SPK_ROTATE_MS) {
      const id = this.account.nextSpkId++;
      const kp = generateDH();
      this.account.spks.unshift({
        id,
        pub: b64(kp.pub),
        priv: b64(kp.priv),
        sig: b64(signPreKey(this.identity.sign.priv, id, kp.pub)),
        createdAt: Date.now(),
      });
      this.account.spks = this.account.spks.slice(0, 3);
      this.markDirty('account');
      await this.flushNow();
    }
    const spk = this.account.spks[0];
    await this.relay?.request({ type: 'prekeys', spk: { id: spk.id, pub: spk.pub, sig: spk.sig } });
  }

  private refilling = false;
  private async refillPreKeys(count: number): Promise<void> {
    if (this.refilling) return;
    this.refilling = true;
    try {
      const opks = generateOneTimePreKeys(this.account, Math.max(0, OPK_BATCH - count));
      if (!opks.length) return;
      this.markDirty('account');
      await this.flushNow();
      await this.relay?.request({ type: 'prekeys', opks });
    } finally {
      this.refilling = false;
    }
  }

  // ---- contacts ------------------------------------------------------------------------

  async addContact(rawUsername: string): Promise<Contact> {
    const username = cleanUsername(rawUsername);
    if (!USERNAME_RE.test(username)) throw new MessengerError('bad_username', 'Неверное имя пользователя');
    if (username === this.account.username) throw new MessengerError('self', 'Это ваш собственный аккаунт');
    if (!this.relay) throw new MessengerError('offline', 'Нет соединения с сервером');
    let info: UserInfo;
    try {
      info = await this.relay.request<UserInfo>({ type: 'lookup', username });
    } catch (error) {
      if (error instanceof RelayRequestError && error.code === 'not_found')
        throw new MessengerError('not_found', `Пользователь @${username} не найден`);
      throw error;
    }
    this.checkUserInfo(info);
    const existing = this.contacts[info.userId];
    if (existing) {
      if (existing.archived) this.updateContact(existing.id, { archived: false });
      return this.contacts[info.userId];
    }
    const contact = this.createContact(info, info.username);
    // Someone else used to have this username: make the change visible.
    const clash = Object.values(this.contacts).find((c) => c.username === info.username && c.id !== info.userId);
    if (clash) {
      contact.keyWarning = true;
      this.addSystem(contact.id, { kind: 'keychange' });
    }
    return contact;
  }

  private checkUserInfo(info: UserInfo): void {
    const signPub = unb64(info.userId);
    if (signPub.length !== 32 || !verifyDhKey(signPub, unb64(info.dhKey), unb64(info.dhSig)))
      throw new MessengerError('bad_keys', 'Сервер вернул неверные ключи');
  }

  private createContact(info: UserInfo, displayName: string): Contact {
    const now = Date.now();
    const contact: Contact = {
      id: info.userId,
      username: info.username,
      displayName: displayName || info.username,
      dhKey: info.dhKey,
      dhSig: info.dhSig,
      verified: false,
      blocked: false,
      createdAt: now,
      lastActivity: now,
      unread: 0,
      timer: 0,
    };
    this.contacts[contact.id] = contact;
    this.conversations.set(contact.id, this.conversations.get(contact.id) ?? []);
    this.markDirty('contacts', `conv.${contact.id}`);
    this.scheduleBackup();
    this.changed();
    return contact;
  }

  private updateContact(id: string, patch: Partial<Contact>): Contact | undefined {
    const current = this.contacts[id];
    if (!current) return undefined;
    const next = { ...current, ...patch };
    this.contacts[id] = next;
    this.markDirty('contacts');
    this.changed();
    return next;
  }

  setVerified(contactId: string, verified: boolean): void {
    if (!this.contacts[contactId]) return;
    this.updateContact(contactId, { verified, keyWarning: false });
    this.addSystem(contactId, { kind: 'verified', value: verified });
  }

  setBlocked(contactId: string, blocked: boolean): void {
    this.updateContact(contactId, { blocked });
  }

  setPinned(contactId: string, pinned: boolean): void {
    this.updateContact(contactId, { pinned });
  }

  setMuted(contactId: string, muted: boolean): void {
    this.updateContact(contactId, { muted });
  }

  setArchived(contactId: string, archived: boolean): void {
    this.updateContact(contactId, { archived, ...(archived ? { pinned: false } : {}) });
  }

  setDraft(contactId: string, draft: string): void {
    if (this.contacts[contactId] && (this.contacts[contactId].draft ?? '') !== draft) {
      this.contacts[contactId] = { ...this.contacts[contactId], draft: draft || undefined };
      this.markDirty('contacts');
      this.changed();
    }
  }

  safetyNumber(contactId: string): string {
    return safetyNumber(this.account.userId, contactId);
  }

  async deleteChat(contactId: string): Promise<void> {
    await this.clearChat(contactId);
    delete this.contacts[contactId];
    delete this.sessions[contactId];
    delete this.online[contactId];
    this.conversations.delete(contactId);
    this.outbox = this.outbox.filter((item) => item.to !== contactId);
    this.markDirty('contacts', 'sessions', 'outbox', `conv.${contactId}`);
    this.scheduleBackup();
    this.changed();
  }

  async clearChat(contactId: string): Promise<void> {
    const messages = this.conversations.get(contactId) ?? [];
    for (const message of messages) await this.deleteAttachments(message);
    this.conversations.set(contactId, []);
    this.markDirty(`conv.${contactId}`);
    this.scheduleBackup();
    this.changed();
  }

  /** Archive the current session; the next message starts a fresh X3DH handshake. */
  resetSession(contactId: string): void {
    const list = this.sessions[contactId];
    if (!list) return;
    this.sessions[contactId] = list.map((s) => ({ ...s, archived: true }));
    this.markDirty('sessions');
    this.addSystem(contactId, { kind: 'reset' });
  }

  // ---- messages ------------------------------------------------------------------------

  private addMessage(contactId: string, message: Message): void {
    const list = this.conversations.get(contactId) ?? [];
    this.conversations.set(contactId, [...list, message]);
    this.markDirty(`conv.${contactId}`);
    this.scheduleBackup();
    this.changed();
  }

  private patchMessages(contactId: string, ids: Set<string>, patch: (m: Message) => Message | null): void {
    const list = this.conversations.get(contactId);
    if (!list) return;
    let touched = false;
    const next: Message[] = [];
    for (const message of list) {
      if (!ids.has(message.id)) {
        next.push(message);
        continue;
      }
      const updated = patch(message);
      if (updated !== message) touched = true;
      if (updated) next.push(updated);
    }
    if (touched) {
      this.conversations.set(contactId, next);
      this.markDirty(`conv.${contactId}`);
      this.changed();
    }
  }

  /** Removes messages without a trace, including quotes of them in replies. */
  private async eraseMessages(contactId: string, ids: Set<string>): Promise<void> {
    const list = this.conversations.get(contactId) ?? [];
    for (const message of list) if (ids.has(message.id)) await this.deleteAttachments(message);
    this.patchMessages(contactId, ids, () => null);
    const quoting = new Set(list.filter((m) => m.reply && ids.has(m.reply.id)).map((m) => m.id));
    this.patchMessages(contactId, quoting, (m) => {
      const { reply: _reply, ...rest } = m;
      return rest;
    });
    this.scheduleBackup();
  }

  private async deleteAttachments(message: Message): Promise<void> {
    for (const att of attachmentsOf(message)) await this.store.delete(`att.${att.id}`);
  }

  private addSystem(contactId: string, sys: SystemEvent): void {
    const now = Date.now();
    this.addMessage(contactId, { id: randomId(), dir: 'system', ts: now, at: now, sys });
  }

  private replyRef(contactId: string, replyTo: string | undefined): ReplyRef | undefined {
    if (!replyTo) return undefined;
    const quoted = this.conversations.get(contactId)?.find((m) => m.id === replyTo && m.dir !== 'system');
    return quoted ? { id: quoted.id, text: snippetOf(quoted), out: quoted.dir === 'out' } : undefined;
  }

  private newOutgoing(contact: Contact, fields: Partial<Message>, replyTo?: string): Message {
    const now = Date.now();
    const reply = this.replyRef(contact.id, replyTo);
    return {
      id: randomId(),
      dir: 'out',
      ts: now,
      at: now,
      status: 'pending',
      ...fields,
      ...(reply ? { reply } : {}),
      ...(contact.timer ? { timer: contact.timer, expiresAt: now + contact.timer * 1000 } : {}),
    };
  }

  async sendText(contactId: string, text: string, options: SendOptions = {}): Promise<void> {
    const body = text.trim();
    if (!body) return;
    const contact = this.requireContact(contactId);
    const message = this.newOutgoing(contact, { text: body }, options.replyTo);
    this.addMessage(contactId, message);
    this.updateContact(contactId, { lastActivity: message.ts, draft: undefined });
    await this.deliverMessage(contact, message);
  }

  /**
   * Sends photos/files with an optional caption. Pictures form an album; anything over
   * the size or count limit is split into several messages.
   */
  async sendMedia(contactId: string, files: OutgoingFile[], options: SendOptions & { caption?: string } = {}): Promise<void> {
    const contact = this.requireContact(contactId);
    for (const file of files) {
      if (file.data.length > MAX_ATTACHMENT_BYTES) throw new MessengerError('too_large', `«${file.name}» больше 20 МБ`);
    }
    const groups: OutgoingFile[][] = [];
    let current: OutgoingFile[] = [];
    let size = 0;
    for (const file of files) {
      const alone = file.kind === 'voice' || file.kind === 'sticker';
      if (current.length && (alone || current.length >= MAX_ALBUM_ITEMS || size + file.data.length > MAX_ATTACHMENT_BYTES)) {
        groups.push(current);
        current = [];
        size = 0;
      }
      current.push(file);
      size += file.data.length;
      if (alone) {
        groups.push(current);
        current = [];
        size = 0;
      }
    }
    if (current.length) groups.push(current);
    const caption = options.caption?.trim();
    if (!groups.length) {
      if (caption) await this.sendText(contactId, caption, options);
      return;
    }

    for (const [index, group] of groups.entries()) {
      const atts: Attachment[] = [];
      for (const file of group) {
        const att: Attachment = {
          id: randomId(),
          name: (file.name || 'file').slice(0, 200),
          mime: file.mime || 'application/octet-stream',
          size: file.data.length,
          kind: file.kind ?? (IMAGE_MIME.test(file.mime) ? 'image' : 'file'),
          ...(file.w && file.h ? { w: file.w, h: file.h } : {}),
          ...(file.dur ? { dur: Math.round(file.dur * 10) / 10 } : {}),
          ...(file.wave ? { wave: file.wave.slice(0, 64).map((v) => Math.max(0, Math.min(31, Math.round(v)))) } : {}),
          ...(file.sticker ? { sticker: file.sticker } : {}),
        };
        await this.store.putBytes(`att.${att.id}`, file.data);
        atts.push(att);
      }
      const first = index === 0;
      const message = this.newOutgoing(contact, { atts, ...(first && caption ? { text: caption } : {}) }, first ? options.replyTo : undefined);
      this.addMessage(contactId, message);
      this.updateContact(contactId, { lastActivity: message.ts });
      await this.deliverMessage(contact, message);
    }
  }

  /** Kept for callers sending one file. */
  sendFile(contactId: string, file: OutgoingFile, options: SendOptions = {}): Promise<void> {
    return this.sendMedia(contactId, [file], options);
  }

  sendVoice(contactId: string, voice: { data: Uint8Array; mime: string; dur: number; wave: number[] }, options: SendOptions = {}) {
    const ext = voice.mime.includes('ogg') ? 'ogg' : 'webm';
    return this.sendMedia(contactId, [{ name: `voice.${ext}`, kind: 'voice', ...voice }], options);
  }

  async sendSticker(contactId: string, stickerId: string, options: SendOptions = {}): Promise<void> {
    const meta = this.stickers.find((s) => s.id === stickerId);
    const data = meta ? await this.store.getBytes(`stk.${stickerId}`) : null;
    if (!meta || !data) throw new MessengerError('no_sticker', 'Стикер не найден');
    await this.sendMedia(contactId, [{ name: 'sticker', mime: meta.mime, data, w: meta.w, h: meta.h, kind: 'sticker', sticker: meta.id }], options);
  }

  async getAttachment(id: string): Promise<Uint8Array | null> {
    return this.store.getBytes(`att.${id}`);
  }

  private async deliverMessage(contact: Contact, message: Message): Promise<void> {
    const content: Content = {
      t: 'msg',
      id: message.id,
      ts: message.ts,
      ...(message.text ? { text: message.text } : {}),
      ...(message.timer ? { timer: message.timer } : {}),
      ...(message.reply ? { r: { id: message.reply.id, s: message.reply.text, a: message.reply.out ? 'me' : 'you' } } : {}),
      p: { n: this.account.displayName },
    };
    let data: Uint8Array | undefined;
    const atts = attachmentsOf(message);
    if (atts.length) {
      const parts: Uint8Array[] = [];
      const metas: AttachmentMeta[] = [];
      for (const att of atts) {
        const bytes = await this.store.getBytes(`att.${att.id}`);
        if (!bytes) {
          this.setStatus(contact.id, [message.id], 'failed');
          return;
        }
        const { id: _id, ...meta } = att;
        parts.push(bytes);
        metas.push({ ...meta, len: bytes.length });
      }
      content.atts = metas;
      // v1.0 clients only understand a single `att`.
      if (metas.length === 1) {
        const { len: _len, ...single } = metas[0];
        content.att = single;
      }
      data = concat(...parts);
    }
    try {
      await this.encryptAndQueue(contact, content, data, [message.id]);
    } catch (error) {
      if (error instanceof RelayRequestError && (error.code === 'offline' || error.code === 'timeout')) return; // retried on reconnect
      console.warn('send failed', error);
      this.setStatus(contact.id, [message.id], 'failed');
    }
  }

  /** Resend messages that never made it into the outbox (e.g. we were offline). */
  private async retryUnsent(): Promise<void> {
    const queued = new Set(this.outbox.flatMap((item) => item.msgIds));
    for (const [contactId, messages] of this.conversations) {
      const contact = this.contacts[contactId];
      if (!contact || contact.blocked) continue;
      for (const message of messages) {
        if (message.dir === 'out' && message.status === 'pending' && !queued.has(message.id)) {
          await this.deliverMessage(contact, message);
        }
      }
    }
  }

  async retryMessage(contactId: string, messageId: string): Promise<void> {
    const contact = this.requireContact(contactId);
    const message = this.conversations.get(contactId)?.find((m) => m.id === messageId);
    if (!message || message.status !== 'failed') return;
    this.setStatus(contactId, [messageId], 'pending', true);
    await this.deliverMessage(contact, { ...message, status: 'pending' });
  }

  private async sendControl(contact: Contact, content: Content): Promise<void> {
    try {
      await this.encryptAndQueue(contact, content, undefined, []);
    } catch (error) {
      console.warn('control message not sent', error);
    }
  }

  private withContactLock<T>(contactId: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.contactLocks.get(contactId) ?? Promise.resolve();
    const run = previous.then(fn, fn);
    this.contactLocks.set(
      contactId,
      run.catch(() => {}),
    );
    return run;
  }

  private encryptAndQueue(contact: Contact, content: Content, data: Uint8Array | undefined, msgIds: string[]) {
    return this.withContactLock(contact.id, async () => {
      const session = await this.ensureSession(contact);
      const { session: next, wire } = sessionEncrypt(session, pack(content, data));
      this.storeSession(contact.id, next, false);
      const envelope = sealEnvelope(unb64(this.contacts[contact.id]?.dhKey ?? contact.dhKey), this.senderInfo(), wire);
      this.outbox.push({ qid: randomId(), to: contact.id, env: b64(envelope), msgIds });
      this.markDirty('sessions', 'outbox');
      // The ratchet state must be on disk before the ciphertext leaves the device.
      await this.flushNow();
      void this.pumpOutbox();
    });
  }

  private senderInfo(): SenderInfo {
    return { from: this.account.userId, fd: b64(this.identity.dh.pub), fs: this.account.dhSig };
  }

  private async ensureSession(contact: Contact): Promise<SessionRecord> {
    const current = this.sessions[contact.id]?.find((s) => !s.archived);
    if (current) return current;
    if (!this.relay) throw new RelayRequestError('offline', 'Нет соединения');
    const bundle = await this.relay.request<PreKeyBundle>({ type: 'bundle', userId: contact.id });
    if (bundle.userId !== contact.id) throw new MessengerError('bad_keys', 'Сервер вернул чужие ключи');
    this.checkUserInfo(bundle);
    if (bundle.dhKey !== contact.dhKey) this.updateContact(contact.id, { dhKey: bundle.dhKey, dhSig: bundle.dhSig });
    const session = createInitiatorSession(this.identity, {
      signPub: unb64(bundle.userId),
      dhPub: unb64(bundle.dhKey),
      dhSig: unb64(bundle.dhSig),
      spkId: bundle.spk.id,
      spkPub: unb64(bundle.spk.pub),
      spkSig: unb64(bundle.spk.sig),
      ...(bundle.opk ? { opkId: bundle.opk.id, opkPub: unb64(bundle.opk.pub) } : {}),
    });
    this.storeSession(contact.id, session, true);
    return session;
  }

  /** Saves a session; `promote` makes it the one used for sending (unless archived). */
  private storeSession(contactId: string, session: SessionRecord, promote: boolean): void {
    const others = (this.sessions[contactId] ?? []).filter((s) => s.id !== session.id);
    const index = (this.sessions[contactId] ?? []).findIndex((s) => s.id === session.id);
    let next: SessionRecord[];
    if (promote && !session.archived) next = [session, ...others];
    else if (index >= 0) next = [...others.slice(0, index), session, ...others.slice(index)];
    else next = [...others, session];
    this.sessions[contactId] = next.slice(0, MAX_SESSIONS_PER_CONTACT);
    this.markDirty('sessions');
  }

  private async pumpOutbox(): Promise<void> {
    if (this.pumping || !this.relay || this.relay.status !== 'online') return;
    this.pumping = true;
    try {
      while (this.outbox.length && this.relay?.status === 'online') {
        const item = this.outbox[0];
        try {
          await this.relay.request({ type: 'send', to: item.to, cid: item.qid }, unb64(item.env));
          this.outbox.shift();
          this.setStatus(item.to, item.msgIds, 'sent');
        } catch (error) {
          if (error instanceof RelayRequestError && (error.code === 'offline' || error.code === 'timeout')) break;
          if (error instanceof RelayRequestError && error.code === 'rate_limited') {
            await new Promise((r) => setTimeout(r, 2000));
            continue;
          }
          this.outbox.shift();
          this.setStatus(item.to, item.msgIds, 'failed');
        }
        this.markDirty('outbox');
      }
    } finally {
      this.pumping = false;
    }
  }

  private setStatus(contactId: string, ids: string[], status: Message['status'], force = false): void {
    if (!ids.length) return;
    const rank = { failed: 0, pending: 1, sent: 2, delivered: 3, read: 4 } as const;
    this.patchMessages(contactId, new Set(ids), (m) => {
      if (m.dir !== 'out') return m;
      if (!force && m.status && status && m.status !== 'failed' && rank[m.status] >= rank[status]) return m;
      return { ...m, status };
    });
  }

  markRead(contactId: string): void {
    const contact = this.contacts[contactId];
    if (!contact) return;
    if (contact.unread) this.updateContact(contactId, { unread: 0 });
    const unreported = (this.conversations.get(contactId) ?? []).filter((m) => m.dir === 'in' && !m.readSent);
    if (!unreported.length) return;
    const ids = unreported.map((m) => m.id);
    this.patchMessages(contactId, new Set(ids), (m) => ({ ...m, readSent: true }));
    if (this.settings.readReceipts && !contact.blocked) void this.sendControl(contact, { t: 'rcpt', k: 'r', ids });
  }

  /** Deleting never leaves a "message deleted" trace — on either side. */
  async deleteMessage(contactId: string, messageId: string, forEveryone: boolean): Promise<void> {
    const message = this.conversations.get(contactId)?.find((m) => m.id === messageId);
    if (!message) return;
    await this.eraseMessages(contactId, new Set([messageId]));
    if (forEveryone && message.dir === 'out' && this.contacts[contactId] && !this.contacts[contactId].blocked) {
      await this.sendControl(this.contacts[contactId], { t: 'del', ids: [messageId] });
    }
  }

  /** Toggles my reaction: the same emoji again removes it. */
  async react(contactId: string, messageId: string, emoji: string): Promise<void> {
    const contact = this.requireContact(contactId);
    const message = this.conversations.get(contactId)?.find((m) => m.id === messageId);
    if (!message || message.dir === 'system') return;
    const next = message.reactions?.me === emoji ? '' : cleanEmoji(emoji);
    this.patchMessages(contactId, new Set([messageId]), (m) => ({ ...m, reactions: { ...m.reactions, me: next || undefined } }));
    await this.sendControl(contact, { t: 'react', id: messageId, e: next });
  }

  async setTimer(contactId: string, seconds: number): Promise<void> {
    const contact = this.requireContact(contactId);
    if (contact.timer === seconds) return;
    this.updateContact(contactId, { timer: seconds });
    this.addSystem(contactId, { kind: 'timer', seconds, by: 'me' });
    await this.sendControl(contact, { t: 'timer', seconds, ts: Date.now() });
  }

  /** A session the peer is known to have (they replied), usable for ephemeral signals. */
  private confirmedSession(contactId: string): SessionRecord | null {
    const session = this.sessions[contactId]?.find((s) => !s.archived);
    return session && !session.pending ? session : null;
  }

  /** Typing/presence signals: never queued by the relay, never touch the ratchet. */
  private async sendEphemeral(contactId: string, content: Content): Promise<boolean> {
    const contact = this.contacts[contactId];
    const session = this.confirmedSession(contactId);
    if (!this.relay || this.relay.status !== 'online' || !contact || contact.blocked || !session) return false;
    const envelope = sealEnvelope(unb64(contact.dhKey), this.senderInfo(), ephemeralEncrypt(session, pack(content)));
    try {
      const result = await this.relay.request<{ delivered?: boolean }>({ type: 'send', to: contactId, cid: randomId(), ephemeral: true }, envelope);
      return !!result?.delivered;
    } catch {
      return false;
    }
  }

  sendTyping(contactId: string, on: boolean): void {
    if (!this.settings.typingIndicators) return;
    const last = this.lastTypingSent.get(contactId) ?? 0;
    if (on && Date.now() - last < 3000) return;
    this.lastTypingSent.set(contactId, on ? Date.now() : 0);
    void this.sendEphemeral(contactId, { t: 'typ', on });
  }

  // ---- presence ------------------------------------------------------------------------

  /** Tells contacts we came online (asking for their status) or are leaving. */
  private announcePresence(state: 'on' | 'off', ask = false): void {
    if (!this.relay || this.relay.status !== 'online') return;
    const hidden = this.settings.lastSeen === 'nobody';
    for (const contact of Object.values(this.contacts)) {
      if (contact.blocked) continue;
      if (state === 'off' && !this.online[contact.id]) continue;
      const content: Content = hidden ? { t: 'pres', s: 'hidden', ...(ask ? { ask: 1 } : {}) } : { t: 'pres', s: state, ...(ask ? { ask: 1 } : {}) };
      void this.sendEphemeral(contact.id, content);
    }
  }

  private markOnline(contactId: string): void {
    const contact = this.contacts[contactId];
    if (!contact || contact.presenceHidden) return;
    const now = Date.now();
    const wasOnline = !!this.online[contactId];
    this.online[contactId] = { until: now + ONLINE_GRACE_MS, last: now };
    if (!wasOnline) this.changed();
  }

  private handlePresence(contact: Contact, content: Extract<Content, { t: 'pres' }>): void {
    const now = Date.now();
    if (content.s === 'hidden') {
      delete this.online[contact.id];
      if (!contact.presenceHidden || contact.lastSeen) this.updateContact(contact.id, { presenceHidden: true, lastSeen: undefined });
      this.changed();
    } else if (content.s === 'off') {
      delete this.online[contact.id];
      this.updateContact(contact.id, { lastSeen: now, presenceHidden: false });
    } else {
      if (contact.presenceHidden) this.updateContact(contact.id, { presenceHidden: false });
      this.markOnline(contact.id);
    }
    if (content.ask) {
      const hidden = this.settings.lastSeen === 'nobody';
      void this.sendEphemeral(contact.id, { t: 'pres', s: hidden ? 'hidden' : 'on' });
    }
  }

  // ---- receiving -----------------------------------------------------------------------

  private async drainInbox(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      while (this.inbox.length && !this.locked) {
        const batch = this.inbox.splice(0, this.inbox.length);
        const acks: string[] = [];
        const delivered = new Map<string, string[]>();
        for (const item of batch) {
          if (!this.seenSet.has(item.id)) {
            try {
              await this.handleEnvelope(item.body, delivered);
            } catch (error) {
              console.warn('dropping undecryptable envelope', error);
            }
            this.remember(item.id);
          }
          acks.push(item.id);
        }
        await this.flushNow();
        this.relay?.ack(acks);
        for (const [contactId, ids] of delivered) {
          const contact = this.contacts[contactId];
          if (contact) void this.sendControl(contact, { t: 'rcpt', k: 'd', ids });
        }
      }
    } finally {
      this.draining = false;
    }
  }

  private remember(id: string): void {
    this.seen.push(id);
    this.seenSet.add(id);
    if (this.seen.length > MAX_SEEN_IDS) {
      for (const old of this.seen.splice(0, this.seen.length - MAX_SEEN_IDS)) this.seenSet.delete(old);
    }
    this.markDirty('seen');
  }

  private async handleEnvelope(envelope: Uint8Array, delivered: Map<string, string[]>): Promise<void> {
    const { sender, wire } = openEnvelope(this.identity.dh, envelope);
    const contactId = sender.from;
    if (contactId === this.account.userId) return;
    if (this.contacts[contactId]?.blocked) return;
    const { header, body } = parseWire(wire);
    const list = this.sessions[contactId] ?? [];

    if (header.k === 'eph') {
      const session = list.find((s) => s.id === header.sid);
      const contact = this.contacts[contactId];
      if (!session || !contact) return;
      const { header: content } = unpack<Content>(ephemeralDecrypt(session, header, body));
      if (content.t === 'typ') {
        this.markOnline(contactId);
        this.setTyping(contactId, content.on);
      } else if (content.t === 'pres') this.handlePresence(contact, content);
      return;
    }

    let session = list.find((s) => s.id === header.sid);
    let consumedOpk: string | null = null;
    if (!session) {
      if (header.k !== 'pre' || !header.x) throw new Error('message for an unknown session');
      const spk = this.account.spks.find((k) => k.id === header.x!.spk);
      if (!spk) throw new Error('unknown signed prekey');
      let opk = null;
      if (header.x.opk !== undefined) {
        const stored = this.account.opks[header.x.opk];
        if (!stored) throw new Error('one-time prekey already used');
        opk = keyPairFromJSON(stored);
        consumedOpk = String(header.x.opk);
      }
      session = createResponderSession(
        this.identity,
        { pub: unb64(spk.pub), priv: unb64(spk.priv) },
        opk,
        { signPub: unb64(sender.from), dhPub: unb64(sender.fd) },
        header.x,
      );
    }

    const { session: next, plaintext } = sessionDecrypt(session, header, body);
    if (consumedOpk) {
      // Forward secrecy for the first message: the one-time prekey is destroyed after use.
      delete this.account.opks[consumedOpk];
      this.markDirty('account');
    }
    this.storeSession(contactId, next, true);

    const { header: content, body: data } = unpack<Content>(plaintext);
    let contact = this.contacts[contactId];
    if (!contact) {
      const info = await this.resolveContact(contactId);
      contact = this.createContact(
        { userId: contactId, username: info?.username ?? '', dhKey: sender.fd, dhSig: sender.fs },
        content.t === 'msg' && content.p?.n ? content.p.n : (info?.username ?? 'Неизвестный'),
      );
    } else if (contact.dhKey !== sender.fd) {
      contact = this.updateContact(contactId, { dhKey: sender.fd, dhSig: sender.fs })!;
    }
    this.markOnline(contactId);
    await this.handleContent(contact, content, data, delivered);
  }

  private resolveContact(userId: string): Promise<UserInfo | null> {
    let pending = this.resolvingContacts.get(userId);
    if (!pending) {
      pending = (this.relay?.request<UserInfo>({ type: 'resolve', userId }) ?? Promise.reject(new Error('offline'))).catch(
        () => null,
      );
      this.resolvingContacts.set(userId, pending);
      void pending.finally(() => this.resolvingContacts.delete(userId));
    }
    return pending;
  }

  /** Splits the message body into the attachments described by the sender. */
  private async receiveAttachments(content: Extract<Content, { t: 'msg' }>, data: Uint8Array): Promise<Attachment[]> {
    const metas: Partial<AttachmentMeta>[] = Array.isArray(content.atts)
      ? content.atts.slice(0, MAX_ALBUM_ITEMS)
      : content.att && data.length
        ? [{ ...content.att, len: data.length }]
        : [];
    const atts: Attachment[] = [];
    let offset = 0;
    for (const meta of metas) {
      const len = Number(meta.len);
      if (!Number.isInteger(len) || len <= 0 || offset + len > data.length) break;
      const bytes = data.subarray(offset, offset + len);
      offset += len;
      const kind: AttachmentKind = (['image', 'file', 'voice', 'sticker'] as const).includes(meta.kind as AttachmentKind)
        ? (meta.kind as AttachmentKind)
        : 'file';
      const w = Number(meta.w);
      const h = Number(meta.h);
      const att: Attachment = {
        id: randomId(),
        name: String(meta.name ?? 'file').slice(0, 200),
        mime: String(meta.mime ?? 'application/octet-stream').slice(0, 100),
        size: len,
        kind,
        ...(w > 0 && h > 0 && w < 100_000 && h < 100_000 ? { w, h } : {}),
        ...(kind === 'voice' && Number(meta.dur) > 0 ? { dur: Math.min(3600, Number(meta.dur)) } : {}),
        ...(kind === 'voice' && Array.isArray(meta.wave)
          ? { wave: meta.wave.slice(0, 64).map((v) => Math.max(0, Math.min(31, Number(v) || 0))) }
          : {}),
        ...(kind === 'sticker' && typeof meta.sticker === 'string' && /^[0-9a-f]{16,64}$/.test(meta.sticker)
          ? { sticker: meta.sticker }
          : {}),
      };
      await this.store.putBytes(`att.${att.id}`, bytes.slice());
      atts.push(att);
    }
    return atts;
  }

  private async handleContent(contact: Contact, content: Content, data: Uint8Array, delivered: Map<string, string[]>) {
    const now = Date.now();
    switch (content.t) {
      case 'msg': {
        const conversation = this.conversations.get(contact.id) ?? [];
        if (typeof content.id !== 'string' || conversation.some((m) => m.id === content.id)) return;
        const atts = await this.receiveAttachments(content, data);
        const timer = Number(content.timer) || 0;
        const reply =
          content.r && typeof content.r.id === 'string'
            ? { id: content.r.id, text: String(content.r.s ?? '').slice(0, 300), out: content.r.a === 'you' }
            : undefined;
        const message: Message = {
          id: content.id,
          dir: 'in',
          ts: Number(content.ts) || now,
          at: now,
          ...(typeof content.text === 'string' ? { text: content.text.slice(0, 64_000) } : {}),
          ...(atts.length ? { atts } : {}),
          ...(reply ? { reply } : {}),
          ...(timer > 0 ? { timer, expiresAt: now + timer * 1000 } : {}),
        };
        this.addMessage(contact.id, message);
        this.clearTyping(contact.id);
        const patch: Partial<Contact> = { lastActivity: now, unread: contact.unread + 1 };
        if (content.p?.n && content.p.n !== contact.displayName) patch.displayName = String(content.p.n).slice(0, 64);
        // Like Telegram: a new message brings an archived (not muted) chat back.
        if (contact.archived && !contact.muted) patch.archived = false;
        const updated = this.updateContact(contact.id, patch)!;
        delivered.set(contact.id, [...(delivered.get(contact.id) ?? []), message.id]);
        if (!updated.muted) this.events.onIncoming?.(updated, message);
        return;
      }
      case 'rcpt':
        if (Array.isArray(content.ids)) this.setStatus(contact.id, content.ids, content.k === 'r' ? 'read' : 'delivered');
        return;
      case 'typ':
        this.setTyping(contact.id, !!content.on);
        return;
      case 'timer': {
        const seconds = Math.max(0, Number(content.seconds) || 0);
        if (seconds === contact.timer) return;
        this.updateContact(contact.id, { timer: seconds });
        this.addSystem(contact.id, { kind: 'timer', seconds, by: 'them' });
        return;
      }
      case 'del': {
        if (!Array.isArray(content.ids)) return;
        // Only their own messages, and without leaving any placeholder behind.
        const theirs = new Set(
          (this.conversations.get(contact.id) ?? []).filter((m) => m.dir === 'in' && content.ids.includes(m.id)).map((m) => m.id),
        );
        if (theirs.size) await this.eraseMessages(contact.id, theirs);
        return;
      }
      case 'react': {
        if (typeof content.id !== 'string') return;
        const emoji = cleanEmoji(content.e);
        this.patchMessages(contact.id, new Set([content.id]), (m) =>
          m.dir === 'system' ? m : { ...m, reactions: { ...m.reactions, them: emoji || undefined } },
        );
        return;
      }
      case 'pres':
        this.handlePresence(contact, content);
        return;
      case 'hi':
        return;
      case 'prof':
        if (typeof content.n === 'string' && content.n.trim()) this.updateContact(contact.id, { displayName: content.n.trim().slice(0, 64) });
        return;
    }
  }

  private setTyping(contactId: string, on: boolean): void {
    if (!this.settings.typingIndicators) return;
    clearTimeout(this.typingTimers.get(contactId));
    if (!on) return this.clearTyping(contactId);
    this.typing[contactId] = Date.now() + TYPING_TIMEOUT_MS;
    this.typingTimers.set(
      contactId,
      setTimeout(() => this.clearTyping(contactId), TYPING_TIMEOUT_MS),
    );
    this.changed();
  }

  private clearTyping(contactId: string): void {
    if (!(contactId in this.typing)) return;
    delete this.typing[contactId];
    this.changed();
  }

  sweepExpired(): void {
    const now = Date.now();
    for (const [contactId, messages] of this.conversations) {
      if (!messages.some((m) => m.expiresAt && m.expiresAt <= now)) continue;
      const keep: Message[] = [];
      for (const message of messages) {
        if (message.expiresAt && message.expiresAt <= now) void this.deleteAttachments(message);
        else keep.push(message);
      }
      this.conversations.set(contactId, keep);
      this.markDirty(`conv.${contactId}`);
      this.changed();
    }
  }

  // ---- stickers ---------------------------------------------------------------------------

  async addSticker(data: Uint8Array, mime: string, w: number, h: number): Promise<StickerMeta> {
    const id = hex(sha256(data)).slice(0, 32);
    const existing = this.stickers.find((s) => s.id === id);
    if (existing) return existing;
    await this.store.putBytes(`stk.${id}`, data);
    const meta: StickerMeta = { id, mime, w, h, addedAt: Date.now() };
    this.stickers = [meta, ...this.stickers];
    this.markDirty('stickers');
    this.changed();
    return meta;
  }

  async removeSticker(id: string): Promise<void> {
    this.stickers = this.stickers.filter((s) => s.id !== id);
    await this.store.delete(`stk.${id}`);
    this.markDirty('stickers');
    this.changed();
  }

  getSticker(id: string): Promise<Uint8Array | null> {
    return this.store.getBytes(`stk.${id}`);
  }

  /** Saves a sticker someone sent into my own collection. */
  async saveSticker(att: Attachment): Promise<StickerMeta> {
    const data = await this.getAttachment(att.id);
    if (!data) throw new MessengerError('no_sticker', 'Стикер недоступен');
    return this.addSticker(data, att.mime, att.w ?? 512, att.h ?? 512);
  }

  // ---- profile & settings ----------------------------------------------------------------

  async updateProfile(displayName: string): Promise<void> {
    const name = displayName.trim().slice(0, 64);
    if (!name || name === this.account.displayName) return;
    this.account.displayName = name;
    this.markDirty('account');
    this.scheduleBackup();
    this.changed();
    for (const contact of Object.values(this.contacts)) {
      if (!contact.blocked && this.sessions[contact.id]?.length) void this.sendControl(contact, { t: 'prof', n: name });
    }
  }

  updateSettings(patch: Partial<Settings>): void {
    const before = this.settings.lastSeen;
    this.settings = { ...this.settings, ...patch };
    if (patch.typingIndicators === false) this.typing = {};
    if (patch.lastSeen && patch.lastSeen !== before) this.announcePresence('on');
    this.markDirty('settings');
    this.scheduleBackup();
    this.changed();
  }

  setServerUrl(url: string): void {
    this.account.serverUrl = url.trim();
    this.markDirty('account');
    this.changed();
    this.connect();
  }

  reconnect(): void {
    this.connect();
  }

  async changePassword(oldPassword: string, newPassword: string): Promise<void> {
    const meta = await changeVaultPassword(this.meta, oldPassword, newPassword);
    await writeVaultMeta(this.storage, meta);
    this.meta = meta;
    // The server backup is encrypted with the password too: re-key and upload it again.
    if (this.account.recovery) {
      const { key, kdf } = await deriveBackupKey(newPassword);
      this.account.recovery = { ...this.account.recovery, key: b64(key), kdf: { N: kdf.N, r: kdf.r, p: kdf.p, salt: kdf.salt } };
      this.markDirty('account');
      await this.flushNow();
      await this.backupNow().catch(() => {});
    }
  }

  // ---- two-factor authentication -------------------------------------------------------------

  async accountStatus(): Promise<AccountStatus> {
    if (!this.relay) throw new RelayRequestError('offline', 'Нет соединения с сервером');
    return this.relay.request<AccountStatus>({ type: 'account_status' });
  }

  /** Step 1: a new secret for the authenticator app (shown as a QR code). */
  beginTotpSetup(): { secret: string; url: string } {
    // Reuse a pending secret so a re-rendered dialog never shows a different QR code.
    const secret = this.pendingTotpSecret ?? base32Encode(random(20));
    this.pendingTotpSecret = secret;
    return { secret, url: otpauthUrl(secret, `@${this.account.username}`) };
  }

  /** Step 2: the first code from the app proves it was set up correctly. */
  async confirmTotpSetup(code: string): Promise<void> {
    const secret = this.pendingTotpSecret;
    if (!secret) throw new MessengerError('no_setup', 'Начните настройку заново');
    if (verifyTotp(secret, code) === null) throw new MessengerError('bad_totp', 'Неверный код. Проверьте время на телефоне');
    if (!this.relay) throw new RelayRequestError('offline', 'Нет соединения с сервером');
    await this.relay.request({ type: 'totp_set', secret, code: code.trim() });
    this.account.totp = secret;
    this.pendingTotpSecret = null;
    this.markDirty('account');
    await this.flushNow();
    this.scheduleBackup();
    this.changed();
  }

  async disableTotp(code: string): Promise<void> {
    if (!this.account.totp) return;
    if (verifyTotp(this.account.totp, code) === null) throw new MessengerError('bad_totp', 'Неверный код из приложения');
    if (!this.relay) throw new RelayRequestError('offline', 'Нет соединения с сервером');
    await this.relay.request({ type: 'totp_disable', code: code.trim() });
    delete this.account.totp;
    this.markDirty('account');
    await this.flushNow();
    this.scheduleBackup();
    this.changed();
  }

  // ---- recovery email & server backup ---------------------------------------------------------

  /** Step 1: the password encrypts the backup; the relay emails a confirmation code. */
  async setRecoveryEmail(email: string, password: string): Promise<void> {
    if (!(await verifyVaultPassword(this.meta, password))) throw new WrongPasswordError();
    if (!this.relay) throw new RelayRequestError('offline', 'Нет соединения с сервером');
    const { key, kdf } = await deriveBackupKey(password);
    this.pendingRecovery = { email: email.trim(), key, kdf: { N: kdf.N, r: kdf.r, p: kdf.p, salt: kdf.salt } };
    await this.relay.request({ type: 'email_set', email: email.trim() });
  }

  /** Step 2: confirm the code, then upload the first backup. */
  async confirmRecoveryEmail(code: string): Promise<void> {
    const pending = this.pendingRecovery;
    if (!pending) throw new MessengerError('no_setup', 'Укажите почту заново');
    if (!this.relay) throw new RelayRequestError('offline', 'Нет соединения с сервером');
    await this.relay.request({ type: 'email_confirm', code: code.trim() });
    this.account.recovery = { email: pending.email, key: b64(pending.key), kdf: pending.kdf, lastBackupAt: 0 };
    this.pendingRecovery = null;
    this.markDirty('account');
    await this.flushNow();
    await this.backupNow();
  }

  async removeRecoveryEmail(totp?: string): Promise<void> {
    if (!this.relay) throw new RelayRequestError('offline', 'Нет соединения с сервером');
    await this.relay.request({ type: 'email_remove', ...(totp ? { totp } : {}) });
    delete this.account.recovery;
    this.markDirty('account');
    await this.flushNow();
    this.changed();
  }

  private scheduleBackup(): void {
    const recovery = this.account?.recovery;
    if (!recovery || this.backupTimer || this.closed) return;
    const wait = Math.max(30_000, recovery.lastBackupAt + BACKUP_MIN_INTERVAL_MS - Date.now());
    this.backupTimer = setTimeout(() => {
      this.backupTimer = null;
      void this.backupNow().catch(() => {});
    }, wait);
  }

  /** Encrypts keys, contacts and message text with the backup key and uploads them. */
  async backupNow(): Promise<void> {
    const recovery = this.account.recovery;
    if (!recovery || this.backingUp || this.closed) return;
    if (!this.relay || this.relay.status !== 'online') throw new RelayRequestError('offline', 'Нет соединения с сервером');
    this.backingUp = true;
    try {
      const conversations: Record<string, Message[]> = {};
      for (const [id, messages] of this.conversations) {
        conversations[id] = messages.filter((m) => !m.expiresAt).slice(-BACKUP_MESSAGES_PER_CHAT);
      }
      const payload: BackupPayload = {
        v: 1,
        account: { ...this.account, recovery: { ...recovery, key: '' } },
        settings: this.settings,
        contacts: this.contacts,
        conversations,
        createdAt: Date.now(),
      };
      const { nonce, ct } = sealBackup(unb64(recovery.key), await compress(utf8(JSON.stringify(payload))));
      const meta: BackupMeta = { v: 1, kdf: recovery.kdf, nonce: b64(nonce), updatedAt: Date.now() };
      await this.relay.request({ type: 'backup_put', meta }, ct);
      if (this.account.recovery) this.account.recovery = { ...this.account.recovery, lastBackupAt: Date.now() };
      this.markDirty('account');
      this.changed();
    } finally {
      this.backingUp = false;
    }
  }

  /** Removes the account from the relay (if reachable) and wipes all local data. */
  async deleteAccount(totp?: string): Promise<void> {
    if (this.account.totp && (!totp || verifyTotp(this.account.totp, totp) === null))
      throw new MessengerError('bad_totp', 'Введите верный код из приложения-аутентификатора');
    if (this.relay?.status === 'online') {
      try {
        await this.relay.request({ type: 'unregister', sig: this.relay.signAction('unregister'), ...(totp ? { totp } : {}) });
      } catch (error) {
        console.warn('could not unregister', error);
      }
    }
    await this.lock();
    await this.storage.clear();
  }

  private requireContact(contactId: string): Contact {
    const contact = this.contacts[contactId];
    if (!contact) throw new MessengerError('no_contact', 'Контакт не найден');
    if (contact.blocked) throw new MessengerError('blocked', 'Контакт заблокирован');
    return contact;
  }
}
