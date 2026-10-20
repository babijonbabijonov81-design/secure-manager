// The messenger engine: accounts, contacts, sessions, sending and receiving.
// UI-agnostic; React subscribes through subscribe()/getSnapshot().

import {
  USERNAME_RE,
  type PreKeyBundle,
  type RegisterFrame,
  type UserInfo,
} from '../../server/src/shared/protocol.ts';
import { authStatement, registerExtra } from '../../server/src/shared/protocol.ts';
import { b64, pack, randomId, unb64, unpack } from '../../server/src/shared/wire.ts';
import { safetyNumber } from './crypto/fingerprint.ts';
import { generateDH, keyPairFromJSON, keyPairToJSON, sign } from './crypto/primitives.ts';
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
import { changeVaultPassword, createVault, unlockVault, type VaultMeta } from './crypto/vault.ts';
import { generateIdentity, signPreKey, verifyDhKey, type IdentityKeys } from './crypto/x3dh.ts';
import { RelayClient, RelayRequestError, type ConnectionStatus } from './relay-client.ts';
import { readVaultMeta, SecureStore, writeVaultMeta, type StorageBackend } from './storage.ts';
import {
  DEFAULT_SETTINGS,
  MAX_ATTACHMENT_BYTES,
  type AccountRecord,
  type Attachment,
  type Contact,
  type Content,
  type Message,
  type MessengerSnapshot,
  type OutboxItem,
  type Settings,
  type SystemEvent,
} from './types.ts';

const OPK_BATCH = 100;
const OPK_LOW_WATER = 40;
const SPK_ROTATE_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_SESSIONS_PER_CONTACT = 5;
const MAX_SEEN_IDS = 3000;
const TYPING_TIMEOUT_MS = 6000;

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
  onProgress?(stage: 'keys' | 'register' | 'vault', progress?: number): void;
}

export interface OutgoingFile {
  name: string;
  mime: string;
  data: Uint8Array;
  w?: number;
  h?: number;
}

export class MessengerError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
    this.name = 'MessengerError';
  }
}

export const hasAccount = async (storage: StorageBackend) => !!(await readVaultMeta(storage));

/** Register on the relay and create a fresh encrypted vault. */
export async function createAccount(options: CreateAccountOptions, events: MessengerEvents = {}): Promise<Messenger> {
  const username = options.username.trim().toLowerCase().replace(/^@/, '');
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
  messenger.loadState({ account, settings: { ...DEFAULT_SETTINGS }, contacts: {}, sessions: {}, outbox: [], seen: [] });

  options.onProgress?.('register');
  try {
    await messenger.registerFirstTime();
  } catch (error) {
    messenger.dispose();
    throw error;
  }
  await writeVaultMeta(options.storage, meta);
  messenger.markDirty('account', 'settings', 'contacts', 'sessions', 'outbox', 'seen');
  await messenger.flushNow();
  return messenger;
}

/** Decrypt the local vault and connect. Throws WrongPasswordError on a bad password. */
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
  const [settings, contacts, sessions, outbox, seen] = await Promise.all([
    store.getJSON<Settings>('settings'),
    store.getJSON<Record<string, Contact>>('contacts'),
    store.getJSON<Record<string, SessionRecord[]>>('sessions'),
    store.getJSON<OutboxItem[]>('outbox'),
    store.getJSON<string[]>('seen'),
  ]);
  messenger.loadState({
    account,
    settings: { ...DEFAULT_SETTINGS, ...settings },
    contacts: contacts ?? {},
    sessions: sessions ?? {},
    outbox: outbox ?? [],
    seen: seen ?? [],
  });
  for (const id of Object.keys(contacts ?? {})) {
    const messages = await store.getJSON<Message[]>(`conv.${id}`);
    if (messages) messenger.conversations.set(id, messages);
  }
  messenger.sweepExpired();
  messenger.connect();
  return messenger;
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
}

export class Messenger {
  readonly storage: StorageBackend;
  readonly conversations = new Map<string, Message[]>();
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

  private relay: RelayClient | null = null;
  private status: ConnectionStatus = 'offline';
  private statusError?: string;
  private fatal?: string;
  private typing: Record<string, number> = {};
  private typingTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private lastTypingSent = new Map<string, number>();

  private readonly dirty = new Set<string>();
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private flushing: Promise<void> = Promise.resolve();
  private readonly contactLocks = new Map<string, Promise<unknown>>();
  private pumping = false;
  private readonly inbox: { id: string; ts: number; body: Uint8Array }[] = [];
  private draining = false;
  private sweepTimer: ReturnType<typeof setInterval> | null = null;
  private resolvingContacts = new Map<string, Promise<UserInfo | null>>();

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
    this.identity = {
      sign: keyPairFromJSON(state.account.sign),
      dh: keyPairFromJSON(state.account.dh),
      dhSig: unb64(state.account.dhSig),
    };
    this.sweepTimer = setInterval(() => this.sweepExpired(), 1000);
  }

  /** Used once while creating the account: resolves when the relay accepted us. */
  registerFirstTime(): Promise<void> {
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

  connect(register = false, hooks?: { ready(): void; fatal(code: string, message: string): void }): void {
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
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.listeners.clear();
  }

  async lock(): Promise<void> {
    if (this.locked) return;
    this.locked = true;
    this.relay?.close();
    this.relay = null;
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    for (const timer of this.typingTimers.values()) clearTimeout(timer);
    await this.flushNow();
    this.closed = true;
    this.store.close();
    this.identity.sign.priv.fill(0);
    this.identity.dh.priv.fill(0);
    this.listeners.clear();
  }

  // ---- React integration -------------------------------------------------------------

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = (): MessengerSnapshot => {
    if (!this.snapshot) {
      const contacts = Object.values(this.contacts).sort(
        (a, b) => Number(!!b.pinned) - Number(!!a.pinned) || b.lastActivity - a.lastActivity,
      );
      const typing: Record<string, boolean> = {};
      for (const [id, until] of Object.entries(this.typing)) if (until > Date.now()) typing[id] = true;
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
        settings: this.settings,
        contacts,
        conversations: Object.fromEntries(this.conversations),
        typing,
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
    const username = rawUsername.trim().toLowerCase().replace(/^@/, '');
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
    if (existing) return existing;
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
    this.conversations.delete(contactId);
    this.outbox = this.outbox.filter((item) => item.to !== contactId);
    this.markDirty('contacts', 'sessions', 'outbox', `conv.${contactId}`);
    this.changed();
  }

  async clearChat(contactId: string): Promise<void> {
    const messages = this.conversations.get(contactId) ?? [];
    for (const message of messages) if (message.att) await this.store.delete(`att.${message.att.id}`);
    this.conversations.set(contactId, []);
    this.markDirty(`conv.${contactId}`);
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

  private addSystem(contactId: string, sys: SystemEvent): void {
    const now = Date.now();
    this.addMessage(contactId, { id: randomId(), dir: 'system', ts: now, at: now, sys });
  }

  async sendText(contactId: string, text: string): Promise<void> {
    const body = text.trim();
    if (!body) return;
    const contact = this.requireContact(contactId);
    const now = Date.now();
    const message: Message = {
      id: randomId(),
      dir: 'out',
      text: body,
      ts: now,
      at: now,
      status: 'pending',
      ...(contact.timer ? { timer: contact.timer, expiresAt: now + contact.timer * 1000 } : {}),
    };
    this.addMessage(contactId, message);
    this.updateContact(contactId, { lastActivity: now, draft: undefined });
    await this.deliverMessage(contact, message);
  }

  async sendFile(contactId: string, file: OutgoingFile): Promise<void> {
    if (file.data.length > MAX_ATTACHMENT_BYTES)
      throw new MessengerError('too_large', 'Файл больше 20 МБ — его нельзя отправить');
    const contact = this.requireContact(contactId);
    const now = Date.now();
    const kind = /^image\/(png|jpe?g|gif|webp|avif|bmp)$/.test(file.mime) ? 'image' : 'file';
    const att: Attachment = {
      id: randomId(),
      name: file.name.slice(0, 200),
      mime: file.mime || 'application/octet-stream',
      size: file.data.length,
      kind,
      ...(file.w && file.h ? { w: file.w, h: file.h } : {}),
    };
    await this.store.putBytes(`att.${att.id}`, file.data);
    const message: Message = {
      id: randomId(),
      dir: 'out',
      att,
      ts: now,
      at: now,
      status: 'pending',
      ...(contact.timer ? { timer: contact.timer, expiresAt: now + contact.timer * 1000 } : {}),
    };
    this.addMessage(contactId, message);
    this.updateContact(contactId, { lastActivity: now });
    await this.deliverMessage(contact, message);
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
      p: { n: this.account.displayName },
    };
    let data: Uint8Array | undefined;
    if (message.att) {
      const { id: _id, ...meta } = message.att;
      content.att = meta;
      data = (await this.store.getBytes(`att.${message.att.id}`)) ?? undefined;
      if (!data) {
        this.setStatus(contact.id, [message.id], 'failed');
        return;
      }
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
    const unreported = (this.conversations.get(contactId) ?? []).filter((m) => m.dir === 'in' && !m.readSent && !m.deleted);
    if (!unreported.length) return;
    const ids = unreported.map((m) => m.id);
    this.patchMessages(contactId, new Set(ids), (m) => ({ ...m, readSent: true }));
    if (this.settings.readReceipts && !contact.blocked) void this.sendControl(contact, { t: 'rcpt', k: 'r', ids });
  }

  async deleteMessage(contactId: string, messageId: string, forEveryone: boolean): Promise<void> {
    const message = this.conversations.get(contactId)?.find((m) => m.id === messageId);
    if (!message) return;
    if (message.att) await this.store.delete(`att.${message.att.id}`);
    if (forEveryone && message.dir === 'out') {
      this.patchMessages(contactId, new Set([messageId]), (m) => ({ ...m, text: undefined, att: undefined, deleted: true }));
      await this.sendControl(this.requireContact(contactId), { t: 'del', ids: [messageId] });
    } else {
      this.patchMessages(contactId, new Set([messageId]), () => null);
    }
  }

  async setTimer(contactId: string, seconds: number): Promise<void> {
    const contact = this.requireContact(contactId);
    if (contact.timer === seconds) return;
    this.updateContact(contactId, { timer: seconds });
    this.addSystem(contactId, { kind: 'timer', seconds, by: 'me' });
    await this.sendControl(contact, { t: 'timer', seconds, ts: Date.now() });
  }

  sendTyping(contactId: string, on: boolean): void {
    if (!this.settings.typingIndicators || !this.relay || this.relay.status !== 'online') return;
    const contact = this.contacts[contactId];
    const session = this.sessions[contactId]?.find((s) => !s.archived);
    // Only once the peer has the session (they replied), otherwise they could not read it.
    if (!contact || contact.blocked || !session || session.pending) return;
    const last = this.lastTypingSent.get(contactId) ?? 0;
    if (on && Date.now() - last < 3000) return;
    this.lastTypingSent.set(contactId, on ? Date.now() : 0);
    const envelope = sealEnvelope(unb64(contact.dhKey), this.senderInfo(), ephemeralEncrypt(session, pack({ t: 'typ', on })));
    this.relay.request({ type: 'send', to: contactId, cid: randomId(), ephemeral: true }, envelope).catch(() => {});
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
      if (!session || !this.contacts[contactId]) return;
      const { header: content } = unpack<Content>(ephemeralDecrypt(session, header, body));
      if (content.t === 'typ') this.setTyping(contactId, content.on);
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

  private async handleContent(contact: Contact, content: Content, data: Uint8Array, delivered: Map<string, string[]>) {
    const now = Date.now();
    switch (content.t) {
      case 'msg': {
        const conversation = this.conversations.get(contact.id) ?? [];
        if (typeof content.id !== 'string' || conversation.some((m) => m.id === content.id)) return;
        let att: Attachment | undefined;
        if (content.att && data.length) {
          att = {
            id: randomId(),
            name: String(content.att.name ?? 'file').slice(0, 200),
            mime: String(content.att.mime ?? 'application/octet-stream'),
            size: data.length,
            kind: content.att.kind === 'image' ? 'image' : 'file',
            ...(content.att.w && content.att.h ? { w: Number(content.att.w), h: Number(content.att.h) } : {}),
          };
          await this.store.putBytes(`att.${att.id}`, data);
        }
        const timer = Number(content.timer) || 0;
        const message: Message = {
          id: content.id,
          dir: 'in',
          ts: Number(content.ts) || now,
          at: now,
          ...(typeof content.text === 'string' ? { text: content.text.slice(0, 64_000) } : {}),
          ...(att ? { att } : {}),
          ...(timer > 0 ? { timer, expiresAt: now + timer * 1000 } : {}),
        };
        this.addMessage(contact.id, message);
        this.clearTyping(contact.id);
        const patch: Partial<Contact> = { lastActivity: now, unread: contact.unread + 1 };
        if (content.p?.n && content.p.n !== contact.displayName) patch.displayName = String(content.p.n).slice(0, 64);
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
        const ids = new Set(content.ids.map(String));
        for (const message of this.conversations.get(contact.id) ?? []) {
          if (ids.has(message.id) && message.dir === 'in' && message.att) await this.store.delete(`att.${message.att.id}`);
        }
        this.patchMessages(contact.id, ids, (m) => (m.dir === 'in' ? { ...m, text: undefined, att: undefined, deleted: true } : m));
        return;
      }
      case 'prof':
        if (typeof content.n === 'string' && content.n.trim())
          this.updateContact(contact.id, { displayName: content.n.trim().slice(0, 64) });
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
        if (message.expiresAt && message.expiresAt <= now) {
          if (message.att) void this.store.delete(`att.${message.att.id}`);
        } else keep.push(message);
      }
      this.conversations.set(contactId, keep);
      this.markDirty(`conv.${contactId}`);
      this.changed();
    }
  }

  // ---- profile & settings ----------------------------------------------------------------

  async updateProfile(displayName: string): Promise<void> {
    const name = displayName.trim().slice(0, 64);
    if (!name || name === this.account.displayName) return;
    this.account.displayName = name;
    this.markDirty('account');
    this.changed();
    for (const contact of Object.values(this.contacts)) {
      if (!contact.blocked && this.sessions[contact.id]?.length) void this.sendControl(contact, { t: 'prof', n: name });
    }
  }

  updateSettings(patch: Partial<Settings>): void {
    this.settings = { ...this.settings, ...patch };
    if (patch.typingIndicators === false) this.typing = {};
    this.markDirty('settings');
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
  }

  /** Removes the account from the relay (if reachable) and wipes all local data. */
  async deleteAccount(): Promise<void> {
    if (this.relay?.status === 'online') {
      try {
        await this.relay.request({ type: 'unregister', sig: this.relay.signAction('unregister') });
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
