// The messenger engine: accounts, contacts, sessions, sending and receiving.
// UI-agnostic; React subscribes through subscribe()/getSnapshot().

import { sha256 } from '@noble/hashes/sha2.js';
import {
  USERNAME_RE,
  type AccountStatus,
  type BackupMeta,
  type DeviceHello,
  type DeviceRecord,
  type IceServer,
  type PreKeyBundle,
  type RegisterFrame,
  type UserInfo,
} from '../../server/src/shared/protocol.ts';
import { ACCESS_KEY_BYTES, authStatement, registerExtra, userBindingStatement, type RecoveryHold } from '../../server/src/shared/protocol.ts';
import { base32Encode, otpauthUrl, verifyTotp } from '../../server/src/shared/totp.ts';
import { b64, concat, fromUtf8, pack, randomId, unb64, unpack, utf8 } from '../../server/src/shared/wire.ts';
import { BACKUP_SKIPPED, backupKey, createBackupFile, openBackupFile, sealBackupFile, type BackupHeader } from './backup-file.ts';
import { compress, decompress } from './compress.ts';
import { safetyNumber } from './crypto/fingerprint.ts';
import { newContentKey, openContent, sealContent } from './crypto/media.ts';
import { aeadOpen, aeadSeal, equalBytes, generateDH, kdf, keyPairFromJSON, keyPairToJSON, random, sign, verify } from './crypto/primitives.ts';
import { openEnvelope, sealEnvelope, type SenderInfo } from './crypto/sealed.ts';
import { chainFrom, distributionOf, newSenderChain, senderDecrypt, senderEncrypt, type GroupWire, type SenderChain } from './crypto/sender-keys.ts';
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
  clearDuressSlot,
  createVault,
  deriveBackupKey,
  destroyMainSlot,
  openBackup,
  openVaultSlot,
  sealBackup,
  setDuressSlot,
  verifyVaultPassword,
  withDuressSlot,
  WrongPasswordError,
  type VaultMeta,
} from './crypto/vault.ts';
import { generateIdentity, signPreKey, verifyDhKey, type IdentityKeys } from './crypto/x3dh.ts';
import { INVITE_DAYS, inviteAddresses, inviteLink, MAX_INVITES, newInviteToken, parseInvite, serverKey, type Invite } from './invite.ts';
import { canApply, describeChange, groupChatId, isGroupChat, MAX_GROUP_MEMBERS, withoutMember, type GroupMember, type GroupRole, type GroupState } from './groups.ts';
import { cleanPreview } from './link-preview.ts';
import { searchMessages, type SearchFilter, type SearchHit } from './search.ts';
import { anonymousRequest, probeServer, RelayClient, RelayRequestError, SealedSender, type ConnectionStatus } from './relay-client.ts';
import { readVaultMeta, SecureStore, writeVaultMeta, type StorageBackend } from './storage.ts';
import type { RecordSource } from './bridge.ts';
import type { CloudApi } from './platform.ts';
import {
  attachmentsOf,
  DEFAULT_SETTINGS,
  MAX_ALBUM_ITEMS,
  MAX_ATTACHMENT_BYTES,
  type AccountRecord,
  type Attachment,
  type AttachmentKind,
  type AttachmentMeta,
  type CallRecord,
  type CallSignal,
  type Contact,
  type LinkPreview,
  isSavedChat,
  normalizeSettings,
  SAVED_ID,
  type Content,
  type Message,
  type MessengerSnapshot,
  type NoteKind,
  type PresenceKind,
  type SecurityEvent,
  type SecurityEventKind,
  sharesWith,
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
const DAY_MS = 24 * 60 * 60 * 1000;

export interface MessengerEvents {
  /** A new incoming message the UI may want to notify about. */
  onIncoming?(contact: Contact, message: Message): void;
  /** A contact's identity key changed (the chat was kept, the verified mark removed). */
  onKeyChange?(contact: Contact): void;
  /** A temporary note in «Избранное» burns within a day. */
  onNoteReminder?(message: Message): void;
}

/** Receives call signals; returns false if it knows nothing about that call. */
export type CallHandler = (contact: Contact, signal: CallSignal) => boolean;

/** Used when the relay does not announce its own STUN/TURN servers. */
export const DEFAULT_ICE_SERVERS: IceServer[] = [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun.cloudflare.com:3478'] }];
/** A call offer that waited longer than this in the relay queue is stale. */
const CALL_OFFER_TTL_MS = 60_000;

export interface CreateAccountOptions {
  storage: StorageBackend;
  serverUrl: string;
  username: string;
  displayName: string;
  password: string;
  kdf?: { N: number; r: number; p: number };
  /** From email recovery: take over the username with brand-new keys. */
  recoveryToken?: string;
  /** From a veil:// invite: the registration token (invite-only servers) and the server's key. */
  inviteToken?: string;
  serverKey?: string;
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
const CALL_TITLES: Record<CallRecord['status'], [string, string]> = {
  done: ['Исходящий звонок', 'Входящий звонок'],
  missed: ['Без ответа', 'Пропущенный звонок'],
  declined: ['Звонок отклонён', 'Отклонённый звонок'],
  cancelled: ['Отменённый звонок', 'Пропущенный звонок'],
  busy: ['Линия занята', 'Пропущенный звонок'],
  failed: ['Звонок не удался', 'Звонок не удался'],
  unavailable: ['Не в сети', 'Пропущенный звонок'],
};

/** "Исходящий звонок", "Пропущенный звонок"… */
export function callTitle(message: Message): string {
  return message.call ? CALL_TITLES[message.call.status]?.[message.dir === 'out' ? 0 : 1] ?? 'Звонок' : '';
}

export function snippetOf(message: Message): string {
  if (message.call) return callTitle(message);
  if (message.capsule && !message.text) return 'Капсула времени';
  if (message.once) return isVideo(attachmentsOf(message)[0]?.mime) ? 'Видео · один просмотр' : 'Фото · один просмотр';
  // A password never shows up in previews, quotes or search.
  if (message.note?.kind === 'password') return message.note.title ? `Пароль · ${message.note.title}` : 'Пароль';
  if (message.text) return message.text.slice(0, 200);
  const atts = attachmentsOf(message);
  const first = atts[0];
  if (!first) return '';
  if (first.kind === 'voice') return first.dur ? `Голосовое · ${formatSeconds(first.dur)}` : 'Голосовое';
  if (first.kind === 'sticker') return 'Стикер';
  if (first.kind === 'image') return atts.length > 1 ? `Фото · ${atts.length}` : 'Фото';
  return `Файл · ${first.name}`;
}

const isVideo = (mime: string | undefined) => !!mime?.startsWith('video/');
/** Photos and videos can be sent "view once". */
export const canSendOnce = (mime: string) => IMAGE_MIME.test(mime) || /^video\/(mp4|webm|ogg|quicktime)$/.test(mime);

const formatSeconds = (seconds: number) => {
  const s = Math.max(0, Math.round(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

const unb64Safe = (value: string): Uint8Array | null => {
  try {
    return unb64(value);
  } catch {
    return null;
  }
};
const hex = (bytes: Uint8Array) => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
const cleanEmoji = (value: unknown) => (typeof value === 'string' ? [...value].slice(0, 8).join('') : '');
const cleanUsername = (username: string) => username.trim().toLowerCase().replace(/^@/, '');
const IMAGE_MIME = /^image\/(png|jpe?g|gif|webp|avif|bmp)$/;

let thisDevice: { id: string; name: string } | null = null;
/** Set once at start-up by the app: this installation's random id and the computer's name. */
export function setThisDevice(device: { id: string; name: string }): void {
  thisDevice = device;
}

/** «Копия в OneDrive» (the desktop app's main process; absent in the browser version). */
export type CloudTransport = Pick<CloudApi, 'signIn' | 'upload' | 'remove' | 'forget'>;
let cloudTransport: CloudTransport | null = null;
export function setCloudTransport(transport: CloudTransport | null): void {
  cloudTransport = transport;
}

/** Kept in the vault only, never in a .veil file or the server backup. */
interface CloudRecord {
  v: 1;
  /** Microsoft refresh token: lets Veil write to its own OneDrive folder. */
  refresh: string;
  /** veil-<random>.veil: says nothing about the account. */
  file: string;
  /** Key of the copy, derived from the copy password (which Veil does not keep). */
  key: string;
  kdf: BackupHeader['kdf'];
  lastAt?: number;
  size?: number;
  error?: string;
}

/** A server key as people compare it: «3F2A 91C0 7B1E 44D2». */
export const fingerprintOf = (key: string) =>
  [...sha256(utf8(key)).subarray(0, 8)]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
    .toUpperCase()
    .replace(/(.{4})(?=.)/g, '$1 ');

/** serverKeyChanged when the server proved no key at all. */
const NO_KEY = 'none';

const randomName = () => [...random(12)].map((b) => 'abcdefghijklmnopqrstuvwxyz234567'[b & 31]).join('');

const CLOUD_EVERY_MS = 24 * 60 * 60 * 1000;
const CLOUD_RETRY_MS = 60 * 60 * 1000;
export const CLOUD_PASSWORD_MIN = 10;

/** A computer of this account in Settings → «Устройства». */
export interface DeviceInfo {
  id: string;
  name: string;
  first: number;
  last: number;
  online: boolean;
  current: boolean;
}

const DEVICE_AD = utf8('veil-device-v1');

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
    // Known from the invite: the very first connection must already prove it.
    ...(options.serverKey ? { serverKey: options.serverKey } : {}),
    createdAt: now,
  };
  generateOneTimePreKeys(account, OPK_BATCH);

  options.onProgress?.('vault', 0);
  const { meta, dataKey } = await createVault(options.password, options.kdf, (p) => options.onProgress?.('vault', p));
  const messenger = new Messenger(options.storage, new SecureStore(options.storage, dataKey), meta, events);
  messenger.loadState({ account, settings: { ...DEFAULT_SETTINGS }, contacts: {}, sessions: {}, outbox: [], seen: [], stickers: [] });

  options.onProgress?.('register');
  messenger.registrationInvite = options.inviteToken;
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
  let meta = await readVaultMeta(storage);
  if (!meta) throw new MessengerError('no_account', 'Аккаунт не найден');
  const started = Date.now();
  const { slot, dataKey } = await openVaultSlot(meta, password, onProgress);
  // Both ways in take as long as the slower one usually does, so timing says nothing.
  const kdfMs = Date.now() - started;
  const pad = async () => {
    const left = started + kdfMs * 1.3 - Date.now();
    if (left > 0) await new Promise((r) => setTimeout(r, left));
  };
  if (slot === 'main') {
    if (!meta.alt) {
      meta = withDuressSlot(meta);
      await writeVaultMeta(storage, meta);
    }
    const messenger = await openVault(storage, meta, dataKey, events);
    await pad();
    return messenger;
  }
  // The duress password: the empty Veil, after erasing the real one if that was chosen.
  const decoy = new SecureStore(storage, dataKey, DECOY_PREFIX);
  const wipe = !!(await decoy.getJSON<{ wipe?: boolean }>('duress'))?.wipe;
  if (wipe) {
    await new SecureStore(storage, new Uint8Array(32)).destroy();
    meta = destroyMainSlot(meta);
    await writeVaultMeta(storage, meta);
  }
  const messenger = await openVault(storage, meta, dataKey, events, DECOY_PREFIX);
  messenger.wipedReal = wipe;
  await pad();
  return messenger;
}

/** Quick unlock: the vault key came from the system keychain (behind a PIN or a fingerprint). */
export async function unlockWithKey(storage: StorageBackend, dataKey: Uint8Array, events: MessengerEvents = {}): Promise<Messenger> {
  const meta = await readVaultMeta(storage);
  if (!meta) throw new MessengerError('no_account', 'Аккаунт не найден');
  try {
    return await openVault(storage, meta, dataKey.slice(), events);
  } catch (error) {
    // A PIN set up inside the empty Veil opens the empty Veil.
    if (error instanceof WrongPasswordError) return openVault(storage, meta, dataKey.slice(), events, DECOY_PREFIX);
    throw error;
  }
}

/**
 * «Мост», new computer: the records received from the old one become a vault protected by the
 * password chosen here, then the account opens and goes online from this computer.
 */
export async function importAccount(
  options: { storage: StorageBackend; password: string; records: Map<string, Uint8Array>; kdf?: { N: number; r: number; p: number }; from?: string },
  events: MessengerEvents = {},
): Promise<Messenger> {
  if (await readVaultMeta(options.storage)) throw new MessengerError('exists', 'На этом компьютере уже есть аккаунт Veil');
  const { meta, dataKey } = await createVault(options.password, options.kdf);
  const store = new SecureStore(options.storage, dataKey);
  for (const [name, bytes] of options.records) {
    if (!/^[\w.:-]{1,200}$/.test(name)) continue;
    await store.putBytes(name, bytes);
  }
  if (!(await store.getJSON<AccountRecord>('account'))) throw new MessengerError('corrupt', 'Перенос неполный: нет аккаунта');
  await writeVaultMeta(options.storage, meta);
  const messenger = await openVault(options.storage, meta, dataKey.slice(), events);
  messenger.logSecurity('transfer_in', options.from);
  return messenger;
}

/**
 * The first address from an invite where the server answers and, if the invite names the
 * server's key, proves it. Null: none of them works from here.
 */
export async function findInviteServer(invite: Invite): Promise<{ address: string; key?: string } | null> {
  for (const address of inviteAddresses(invite)) {
    try {
      const probe = await probeServer(address, 5000);
      if (invite.serverKey && probe.key !== invite.serverKey) continue;
      return { address, ...(probe.key ? { key: probe.key } : {}) };
    } catch {
      // not reachable from here: try the next one
    }
  }
  return null;
}

const DECOY_PREFIX = 'd.';

async function openVault(storage: StorageBackend, meta: VaultMeta, dataKey: Uint8Array, events: MessengerEvents, prefix = 'r.', hello = false): Promise<Messenger> {
  const store = new SecureStore(storage, dataKey, prefix);
  let account: AccountRecord | null;
  try {
    account = await store.getJSON<AccountRecord>('account');
  } catch {
    throw new WrongPasswordError();
  }
  if (!account) throw new MessengerError('corrupt', 'Данные повреждены');
  const messenger = new Messenger(storage, store, meta, events);
  messenger.decoy = prefix === DECOY_PREFIX;
  // The duress flag came with a backup or «Мост», but the empty Veil it points to did not.
  if (!messenger.decoy && account.duress && !(await new SecureStore(storage, new Uint8Array(32), DECOY_PREFIX).names()).includes('account')) {
    delete account.duress;
  }
  const [settings, contacts, sessions, outbox, seen, stickers, seclog, gkeys] = await Promise.all([
    store.getJSON<Settings>('settings'),
    store.getJSON<Record<string, Contact>>('contacts'),
    store.getJSON<Record<string, SessionRecord[]>>('sessions'),
    store.getJSON<OutboxItem[]>('outbox'),
    store.getJSON<string[]>('seen'),
    store.getJSON<StickerMeta[]>('stickers'),
    store.getJSON<SecurityEvent[]>('seclog'),
    store.getJSON<Record<string, GroupKeys>>('gkeys'),
  ]);
  messenger.loadState({
    account,
    settings: normalizeSettings(settings),
    contacts: contacts ?? {},
    sessions: sessions ?? {},
    outbox: outbox ?? [],
    seen: seen ?? [],
    stickers: stickers ?? [],
    seclog: seclog ?? [],
    gkeys: gkeys ?? {},
  });
  for (const id of Object.keys(contacts ?? {})) {
    const messages = await store.getJSON<Message[]>(`conv.${id}`);
    // v1.0 left "message deleted" placeholders behind; deleted messages now vanish completely.
    if (messages) messenger.conversations.set(id, messages.filter((m) => !m.deleted));
  }
  if (!messenger.decoy) await messenger.loadCloud();
  messenger.sweepExpired();
  messenger.helloPending = hello;
  if (account.totp) messenger.needsTotp = true;
  else messenger.connect();
  return messenger;
}

/**
 * Restores a .veil file on this computer, protected by a new Veil password. Sessions start fresh
 * with every contact, as after a server restore.
 */
export async function restoreBackupFile(
  options: { storage: StorageBackend; file: Uint8Array; backupPassword: string; password: string; kdf?: { N: number; r: number; p: number } },
  events: MessengerEvents = {},
): Promise<Messenger> {
  if (await readVaultMeta(options.storage)) throw new MessengerError('exists', 'На этом компьютере уже есть аккаунт Veil');
  const records = await openBackupFile(options.file, options.backupPassword);
  const accountBytes = records.get('account');
  if (!accountBytes) throw new MessengerError('corrupt', 'В копии нет аккаунта');
  // The server backup key came from the old password, the empty Veil is not in the file.
  const { recovery: _recovery, duress: _duress, ...account } = JSON.parse(fromUtf8(accountBytes)) as AccountRecord;
  records.set('account', utf8(JSON.stringify(account)));
  const { meta, dataKey } = await createVault(options.password, options.kdf);
  const store = new SecureStore(options.storage, dataKey);
  for (const [name, bytes] of records) {
    if (BACKUP_SKIPPED.has(name) || !/^[\w.:-]{1,200}$/.test(name)) continue;
    await store.putBytes(name, bytes);
  }
  await writeVaultMeta(options.storage, meta);
  const messenger = await openVault(options.storage, meta, dataKey.slice(), events, 'r.', true);
  messenger.logSecurity('backup_import');
  return messenger;
}

// ---- account recovery ----------------------------------------------------------------------

/** Step 1: the relay emails a code if the username and email match. */
export async function startRecovery(serverUrl: string, username: string, email: string): Promise<void> {
  await anonymousRequest(serverUrl, { type: 'recover_start', username: cleanUsername(username), email: email.trim() });
}

/** Step 2: email code (+ authenticator code) → recovery ticket with the encrypted backup. */
/**
 * Recovery by email alone waits (7 days by default) so the owner can object: the server hands out
 * a claim instead of a ticket. Keep it on this device and claim after `readyAt`.
 */
export interface RecoveryWait {
  serverUrl: string;
  username: string;
  readyAt: number;
  claim: string;
}

type TicketData = { token: string; userId: string; backup: RecoveryTicket['backup'] };

/** Step 2: email code (+ authenticator code) → a recovery ticket, or a wait without an authenticator. */
export async function verifyRecovery(serverUrl: string, username: string, code: string, totp?: string): Promise<RecoveryTicket | RecoveryWait> {
  const { data, body } = await anonymousRequest<TicketData | { hold: { readyAt: number; claim: string } }>(serverUrl, {
    type: 'recover_finish',
    username: cleanUsername(username),
    code: code.trim(),
    ...(totp ? { totp: totp.trim() } : {}),
  });
  if ('hold' in data) return { serverUrl, username: cleanUsername(username), readyAt: data.hold.readyAt, claim: data.hold.claim };
  return { serverUrl, username: cleanUsername(username), token: data.token, userId: data.userId, backup: data.backup, data: body };
}

/** Step 2b, after the wait: the claim becomes a recovery ticket (unless the owner cancelled). */
export async function claimRecovery(wait: RecoveryWait): Promise<RecoveryTicket> {
  const { data, body } = await anonymousRequest<TicketData>(wait.serverUrl, { type: 'recover_claim', username: wait.username, claim: wait.claim });
  return { serverUrl: wait.serverUrl, username: wait.username, token: data.token, userId: data.userId, backup: data.backup, data: body };
}

export const isRecoveryWait = (value: RecoveryTicket | RecoveryWait): value is RecoveryWait => 'claim' in value;

/** The waiting recovery, kept on this device (not in a vault: there is none yet). */
const WAIT_KEY = 'recovery.wait';
export async function savedRecoveryWait(storage: StorageBackend): Promise<RecoveryWait | null> {
  const raw = await storage.get(WAIT_KEY);
  try {
    return raw ? (JSON.parse(fromUtf8(raw)) as RecoveryWait) : null;
  } catch {
    return null;
  }
}
export const saveRecoveryWait = (storage: StorageBackend, wait: RecoveryWait | null) =>
  wait ? storage.set(WAIT_KEY, utf8(JSON.stringify(wait))) : storage.delete(WAIT_KEY);

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
    settings: normalizeSettings(payload.settings),
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

interface GroupKeys {
  mine?: SenderChain;
  /** Members who already have my current chain. */
  sent: string[];
  /** Each member's chains, newest first (the previous one for messages still on the way). */
  peers: Record<string, SenderChain[]>;
  /** Group messages that came before their sender key, kept for a while. */
  pending?: { from: string; wire: string; at: number }[];
  /** When I last asked a member for their sender key. */
  asked?: Record<string, number>;
}

interface GroupWireHeader extends GroupWire {
  k: 'grp';
  g: string;
}

interface LoadedState {
  account: AccountRecord;
  settings: Settings;
  contacts: Record<string, Contact>;
  sessions: Record<string, SessionRecord[]>;
  outbox: OutboxItem[];
  seen: string[];
  stickers: StickerMeta[];
  seclog?: SecurityEvent[];
  gkeys?: Record<string, GroupKeys>;
}

export interface SendOptions {
  /** Id of the message being replied to. */
  replyTo?: string;
  /** Scheduled send: deliver at this time (ms). */
  at?: number;
  /** Time capsule: deliver now, open at this time (ms). */
  capsule?: number;
  /** A link preview the sender made for a link in the text. */
  preview?: LinkPreview;
}

export interface MediaOptions extends SendOptions {
  caption?: string;
  /** One photo or video that opens once, then disappears on both sides. */
  once?: boolean;
}

export class Messenger {
  readonly storage: StorageBackend;
  readonly conversations = new Map<string, Message[]>();
  /** Two-factor authentication: the authenticator code is still required to go online. */
  needsTotp = false;
  /** After restoring from a backup: open fresh sessions with every contact. */
  helloPending = false;
  /** Set by the UI that runs WebRTC. */
  callHandler: CallHandler | null = null;
  /** The empty Veil behind the duress password: never connects, finds nobody. */
  decoy = false;
  /** The duress password just erased the real vault (the app drops quick unlock too). */
  wipedReal = false;
  private relayIce: IceServer[] | undefined;
  private endedCalls = new Set<string>();
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
  private seclog: SecurityEvent[] = [];
  /** Sender keys per group: my chain, who has it, the other members' chains, early messages. */
  private gkeys: Record<string, GroupKeys> = {};

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
  private cloud: CloudRecord | null = null;
  /** A key the server showed that differs from the pinned one (no TLS): see pinServerKey. */
  private serverKeyChanged: string | null = null;
  /** The registration token from an invite, for the first registration on an invite-only server. */
  registrationInvite: string | undefined;
  /** A recovery of this account by email that waits for its time (see noteRecoveryHold). */
  private recoveryHold: RecoveryHold | null = null;
  /** Sends to contacts with a delivery key without logging in (sealed sender). */
  private sealed: SealedSender | null = null;
  private cloudBusy = false;
  private cloudTriedAt = 0;
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
    this.seclog = state.seclog ?? [];
    this.gkeys = state.gkeys ?? {};
    this.identity = {
      sign: keyPairFromJSON(state.account.sign),
      dh: keyPairFromJSON(state.account.dh),
      dhSig: unb64(state.account.dhSig),
    };
    this.tickTimer = setInterval(() => this.tick(), 1000);
    this.ensureSavedChat();
  }

  /** «Избранное» exists for every account, pinned on top the first time it appears. */
  private ensureSavedChat(): void {
    if (!this.contacts[SAVED_ID]) {
      const now = Date.now();
      this.contacts[SAVED_ID] = {
        id: SAVED_ID,
        username: '',
        displayName: 'Избранное',
        dhKey: this.account.dh.pub,
        dhSig: this.account.dhSig,
        verified: true,
        blocked: false,
        createdAt: now,
        lastActivity: now,
        unread: 0,
        timer: 0,
        pinned: true,
      };
      this.markDirty('contacts');
    }
    if (!this.conversations.has(SAVED_ID)) this.conversations.set(SAVED_ID, []);
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
    if (this.locked || this.bridgePaused) return;
    if (this.decoy) {
      // Looks online, talks to nobody: the real account's messages wait on the relay.
      this.status = 'online';
      this.changed();
      return;
    }
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
        this.relayIce = Array.isArray(frame.ice) ? frame.ice : undefined;
        const serverId = this.relay?.serverId;
        if (serverId && serverId !== this.account.serverId) {
          this.account.serverId = serverId;
          this.markDirty('account');
          this.snapshot = null;
        }
        this.pinServerKey(this.relay?.serverKey);
        this.noteRecoveryHold(frame.recoveryHold);
        pendingHooks?.ready();
        pendingHooks = undefined;
        void this.afterReady(frame.opkCount, frame.spkId);
      },
      onMessage: (id, ts, body) => {
        this.inbox.push({ id, ts, body });
        void this.drainInbox();
      },
      onPrekeysLow: (count) => void this.refillPreKeys(count),
      onRecoveryHold: (hold) => this.noteRecoveryHold(hold),
      expectKey: () => this.account.serverKey,
      onKeyMismatch: (key) => {
        this.serverKeyChanged = key ?? NO_KEY;
        this.changed();
      },
      device: () => this.deviceHello(),
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
    this.sealed?.close();
    this.sealed = null;
    this.stopTimers();
    this.listeners.clear();
  }

  async lock(): Promise<void> {
    if (this.locked) return;
    // «Offline» to contacts without my delivery key goes on the logged-in connection before it
    // closes; to the others on the anonymous one, but only once the server has this one closed —
    // otherwise they could hear «offline» while the server still delivers to this device.
    const sealed = this.presenceTargets('off').filter((t) => this.contacts[t.id]?.accessKey);
    const direct = this.presenceTargets('off').filter((t) => !this.contacts[t.id]?.accessKey);
    const later = <T>(work: Promise<T>) => Promise.race([work, new Promise((r) => setTimeout(r, 1500))]);
    await later(Promise.all(direct.map((t) => this.sendEphemeral(t.id, t.content))));
    if (this.locked) return;
    this.locked = true;
    await this.relay?.closeAndWait();
    this.relay = null;
    await later(Promise.all(sealed.map((t) => this.sendEphemeral(t.id, t.content, true))));
    this.sealed?.close();
    this.sealed = null;
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
          ...(this.account.serverId ? { serverId: this.account.serverId } : {}),
          ...(this.account.serverKey ? { serverKey: this.account.serverKey } : {}),
          createdAt: this.account.createdAt,
        },
        security: {
          totp: !!this.account.totp,
          recoveryEmail: this.account.recovery?.email,
          lastBackupAt: this.account.recovery?.lastBackupAt || undefined,
          ...(this.account.duress ? { duress: { wipe: this.account.duress.wipe } } : {}),
          hiddenChats: !!this.account.hiddenChats,
        },
        ...(this.decoy ? { decoy: true } : {}),
        ...(this.serverKeyChanged ? { serverKeyChanged: true } : {}),
        ...(this.serverKeyChanged && this.serverKeyChanged !== NO_KEY ? { serverKeyOffered: fingerprintOf(this.serverKeyChanged) } : {}),
        ...(this.recoveryHold ? { recoveryHold: this.recoveryHold } : {}),
        ...(this.cloud
          ? { cloud: { lastAt: this.cloud.lastAt, size: this.cloud.size, error: this.cloud.error, ...(this.cloudBusy ? { busy: true } : {}) } }
          : {}),
        settings: this.settings,
        contacts,
        conversations: Object.fromEntries(this.conversations),
        typing,
        online,
        stickers: this.stickers,
        securityLog: this.seclog,
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
        else if (name === 'seclog') await this.store.putJSON(name, this.seclog);
        else if (name === 'gkeys') await this.store.putJSON(name, this.gkeys);
        else if (name === 'cloud') {
          if (this.cloud) await this.store.putJSON(name, this.cloud);
          else await this.store.delete(name);
        }
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
    if (this.cloud && !this.cloudBusy && now - (this.cloud.lastAt ?? 0) > CLOUD_EVERY_MS && now - this.cloudTriedAt > CLOUD_RETRY_MS) {
      void this.cloudUploadNow().catch(() => {});
    }
    this.remindNotes(now);
    this.processTimed(now);
    for (const [id, state] of Object.entries(this.online)) {
      if (state.until > now) continue;
      delete this.online[id];
      if (this.contacts[id] && !this.contacts[id].presenceHidden && this.shares(id, 'online')) this.updateContact(id, { lastSeen: state.last });
      this.changed();
    }
    if (now - this.lastHeartbeat > HEARTBEAT_MS && this.relay?.status === 'online') {
      this.lastHeartbeat = now;
      // Keep contacts who are online now up to date that we are still here.
      for (const id of Object.keys(this.online)) if (this.shares(id, 'online')) void this.sendEphemeral(id, { t: 'pres', s: 'on' });
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
      ...(this.registrationInvite ? { invite: this.registrationInvite } : {}),
      ...(this.deviceHello() ? { device: this.deviceHello()! } : {}),
      ...frame,
    };
  }

  private async afterReady(opkCount: number, spkId: number | null): Promise<void> {
    try {
      const newest = this.account.spks[0];
      if (Date.now() - newest.createdAt > SPK_ROTATE_MS || spkId !== newest.id) await this.rotateSignedPreKey();
      if (opkCount < OPK_LOW_WATER) await this.refillPreKeys(opkCount);
      await this.publishAccessKey();
      await this.pumpOutbox();
      await this.retryUnsent();
      if (this.helloPending) {
        this.helloPending = false;
        for (const contact of Object.values(this.contacts)) if (!contact.blocked) void this.sendControl(contact, { t: 'hi' });
      }
      void this.announcePresence('on', true);
      void this.checkNewDevices();
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
    // Your own name opens «Избранное», like in Telegram.
    if (username === this.account.username) return this.contacts[SAVED_ID];
    if (this.decoy) {
      await new Promise((r) => setTimeout(r, 300 + Math.random() * 400));
      throw new MessengerError('not_found', `Пользователь @${username} не найден`);
    }
    return this.addFromInfo(await this.lookupUser(username));
  }

  /**
   * A known @name now points to another account. Either the old owner renamed themselves
   * (they still exist under a new name: nothing about their key changed) or their account
   * was reset (a new key: the chat moves over with a warning).
   */
  private async renamedOrReset(previous: Contact): Promise<boolean> {
    const now = await this.resolveContact(previous.id);
    if (!now || now.userId !== previous.id || now.username === previous.username) return false;
    this.updateContact(previous.id, { username: now.username });
    return true;
  }

  private async refreshUsername(contactId: string): Promise<void> {
    const info = await this.resolveContact(contactId);
    const contact = this.contacts[contactId];
    if (info && contact && info.userId === contactId && info.username !== contact.username) this.updateContact(contactId, { username: info.username });
  }

  /** Settings → «Имя пользователя»: is this @name free on the server? */
  async checkUsername(raw: string): Promise<'free' | 'taken' | 'invalid' | 'mine'> {
    const username = cleanUsername(raw);
    if (!USERNAME_RE.test(username)) return 'invalid';
    if (username === this.account.username) return 'mine';
    if (!this.relay || this.relay.status !== 'online') throw new MessengerError('offline', 'Нет соединения с сервером');
    const result = await this.relay.request<{ valid: boolean; free: boolean }>({ type: 'username_check', username });
    return !result.valid ? 'invalid' : result.free ? 'free' : 'taken';
  }

  /**
   * Takes a new @name if nobody has it. Keys, chats and contacts stay; contacts learn the new
   * name from the server. The old name is released at once and someone else may take it.
   */
  async changeUsername(raw: string): Promise<void> {
    const username = cleanUsername(raw);
    if (this.decoy) throw new MessengerError('decoy', 'Недоступно');
    if (!USERNAME_RE.test(username)) throw new MessengerError('bad_username', 'Имя: от 3 до 32 символов — латинские буквы, цифры и _');
    if (username === this.account.username) return;
    if (!this.relay || this.relay.status !== 'online') throw new MessengerError('offline', 'Нет соединения с сервером');
    try {
      await this.relay.request({ type: 'username_set', username });
    } catch (error) {
      if (error instanceof RelayRequestError) throw new MessengerError(error.code, error.message);
      throw error;
    }
    const before = this.account.username;
    this.account.username = username;
    this.markDirty('account');
    this.scheduleBackup();
    this.logSecurity('username_change', `@${before} → @${username}`);
    this.changed();
    for (const contact of Object.values(this.contacts)) {
      if (!contact.blocked && !contact.group && this.sessions[contact.id]?.length) void this.sendControl(contact, { t: 'prof', ...this.myProfile(contact), u: 1 });
    }
  }

  /**
   * The server's key is pinned on first contact. Later a server that cannot sign our challenge
   * with it gets no login at all (RelayClient.expectKey): TLS proves only the address, and a tunnel
   * address belongs to the public relay, not to the server behind it. The user decides in
   * Settings → Сервер (trustServerKey) — e.g. after reinstalling a server without SERVER_SECRET.
   */
  private pinServerKey(key: string | undefined): void {
    if (!key) return;
    if (!this.account.serverKey) {
      this.account.serverKey = key;
      this.markDirty('account');
      this.changed();
    }
    if (this.serverKeyChanged && key === this.account.serverKey) {
      this.serverKeyChanged = null;
      this.changed();
    }
  }


  /**
   * Someone is restoring this account by email and will get the @name at `readyAt` unless I cancel.
   * Shown as a red banner and written to the security log once per attempt.
   */
  private noteRecoveryHold(hold: RecoveryHold | undefined): void {
    const before = this.recoveryHold;
    this.recoveryHold = hold ?? null;
    if (hold && before?.requestedAt !== hold.requestedAt) this.logSecurity('recovery_hold', new Date(hold.readyAt).toLocaleString('ru-RU'));
    if (hold || before) this.changed();
  }

  /** «Это не я»: the waiting recovery is called off on the server. */
  async cancelRecovery(): Promise<void> {
    if (!this.relay) throw new RelayRequestError('offline', 'Нет соединения с сервером');
    await this.relay.request({ type: 'recovery_cancel' });
    this.recoveryHold = null;
    this.logSecurity('recovery_cancel');
    this.changed();
  }

  /** Settings → Сервер: the server was really reinstalled — trust its new key. */
  trustServerKey(): void {
    const key = this.serverKeyChanged;
    if (!key) return;
    // A server with no key at all (an old version): the pin is dropped, the next key is pinned.
    if (key === NO_KEY) delete this.account.serverKey;
    else this.account.serverKey = key;
    this.serverKeyChanged = null;
    this.markDirty('account');
    this.logSecurity('server_key', key === NO_KEY ? 'сервер без ключа' : fingerprintOf(key));
    this.changed();
    this.connect();
  }


  /** «@name has this key» must come signed by the pinned server key. */
  private checkVouched(info: UserInfo): void {
    if (this.serverKeyChanged)
      throw new MessengerError('server_key', 'Ключ сервера изменился. Пока вы не проверите это в Настройки → Сервер, новых собеседников не добавить');
    const pinned = this.account.serverKey;
    if (!pinned) return;
    let ok = false;
    try {
      ok = !!info.ssig && verify(unb64(info.ssig), userBindingStatement(info), unb64(pinned));
    } catch {
      ok = false;
    }
    if (!ok) throw new MessengerError('server_key', 'Сервер не подтвердил ключ собеседника своей подписью — возможно, это подмена сервера');
  }

  private async lookupUser(username: string): Promise<UserInfo> {
    if (!this.relay) throw new MessengerError('offline', 'Нет соединения с сервером');
    // Not even the question goes to a server whose key is in doubt.
    if (this.serverKeyChanged) this.checkVouched({ userId: '', username, dhKey: '', dhSig: '' });
    let info: UserInfo;
    try {
      info = await this.relay.request<UserInfo>({ type: 'lookup', username });
    } catch (error) {
      if (error instanceof RelayRequestError && error.code === 'not_found')
        throw new MessengerError('not_found', `Пользователь @${username} не найден`);
      throw error;
    }
    this.checkUserInfo(info);
    this.checkVouched(info);
    return info;
  }

  private async addFromInfo(info: UserInfo): Promise<Contact> {
    const existing = this.contacts[info.userId];
    if (existing) {
      if (existing.archived || existing.groupOnly) this.updateContact(existing.id, { archived: false, groupOnly: undefined });
      return this.contacts[info.userId];
    }
    // The username now belongs to a different key (account reset, or someone in the middle).
    const previous = Object.values(this.contacts).find((c) => c.username === info.username && c.id !== info.userId && !isSavedChat(c.id));
    if (previous && !(await this.renamedOrReset(previous))) return this.replaceIdentity(previous, info);
    return this.createContact(info, info.username);
  }

  /**
   * A known username came back with a new identity key. The chat stays where it was, but the
   * "verified" mark is gone, a red line explains why, and old sessions are dropped.
   */
  private replaceIdentity(previous: Contact, info: Pick<UserInfo, 'userId' | 'username' | 'dhKey' | 'dhSig'>): Contact {
    const now = Date.now();
    const contact: Contact = {
      ...previous,
      id: info.userId,
      username: info.username,
      dhKey: info.dhKey,
      dhSig: info.dhSig,
      verified: false,
      verifiedAt: undefined,
      keyWarning: true,
      lastActivity: now,
    };
    delete this.contacts[previous.id];
    delete this.sessions[previous.id];
    delete this.online[previous.id];
    delete this.typing[previous.id];
    this.contacts[contact.id] = contact;
    this.conversations.set(contact.id, this.conversations.get(previous.id) ?? []);
    this.conversations.delete(previous.id);
    // Anything still queued was encrypted for the old key and can never be read by the new one.
    const stale = this.outbox.filter((item) => item.to === previous.id).flatMap((item) => item.msgIds);
    this.outbox = this.outbox.filter((item) => item.to !== previous.id);
    this.markDirty('contacts', 'sessions', 'outbox', `conv.${previous.id}`, `conv.${contact.id}`);
    this.setStatus(contact.id, stale, 'failed', true);
    this.addSystem(contact.id, { kind: 'keychange' });
    this.logSecurity('key_change', contact.displayName);
    this.events.onKeyChange?.(contact);
    this.changed();
    return contact;
  }

  /** «Не отправлять, пока не сверю»: true while sending to this contact is on hold. */
  isHeld(contactId: string): boolean {
    const contact = this.contacts[contactId];
    return !!contact?.keyWarning && this.settings.holdUntilVerified && this.settings.features.keyGuard !== false;
  }

  private requireSendable(contactId: string): Contact {
    const contact = this.requireContact(contactId);
    if (this.isHeld(contactId))
      throw new MessengerError('key_changed', 'Ключ собеседника изменился. Сверьте код безопасности, чтобы отправить сообщение');
    // Replying to a stranger accepts the request.
    if (contact.request) {
      this.acceptRequest(contactId);
      return this.contacts[contactId];
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
    this.updateContact(contactId, { verified, keyWarning: false, verifiedAt: verified ? Date.now() : undefined, verifiedBy: verified ? 'code' : undefined });
    this.addSystem(contactId, { kind: 'verified', value: verified });
  }

  /**
   * «Слова-сверка»: the two words in a call matched (the contact counts as verified, by voice) or
   * did not (the verified mark goes, a red line says the call may have been intercepted).
   */
  confirmCallWords(contactId: string, match: boolean): void {
    if (!this.contacts[contactId] || isSavedChat(contactId)) return;
    if (match) this.updateContact(contactId, { verified: true, keyWarning: false, verifiedAt: Date.now(), verifiedBy: 'call' });
    else this.updateContact(contactId, { verified: false, verifiedAt: undefined, verifiedBy: undefined });
    this.addSystem(contactId, { kind: 'callwords', match });
  }

  /**
   * «Поиск по всей переписке»: only in this device's decrypted memory. Hidden chats are left out
   * unless they are open right now.
   */
  search(query: string, filter: SearchFilter = 'all', options: { hidden?: boolean } = {}): SearchHit[] {
    if (this.settings.features.search === false) return [];
    return searchMessages(this.conversations, query, filter, (id) => {
      const contact = this.contacts[id];
      return !contact || (!!contact.hidden && !options.hidden);
    });
  }

  /** «Голосовые в текст»: keeps the text recognised on this device next to the voice message. */
  setTranscript(contactId: string, messageId: string, text: string): void {
    const clean = text.trim().slice(0, 20_000);
    this.patchMessages(contactId, new Set([messageId]), (m) => (attachmentsOf(m).some((a) => a.kind === 'voice') ? { ...m, transcript: clean } : m));
  }

  // ---- groups (features.groups) ------------------------------------------------------------

  private groupsOn(): boolean {
    return this.settings.features.groups !== false && !this.decoy;
  }

  private requireGroups(): void {
    if (this.settings.features.groups === false) throw new MessengerError('disabled', 'Группы выключены в настройках');
    if (this.decoy) throw new MessengerError('decoy', 'Недоступно');
  }

  private selfMember(role: GroupRole): GroupMember {
    return { id: this.account.userId, username: this.account.username, name: this.account.displayName, role, dh: this.account.dh.pub, ds: this.account.dhSig };
  }

  private memberOf(contact: Contact, role: GroupRole = 'member'): GroupMember {
    return { id: contact.id, username: contact.username, name: contact.displayName, role, dh: contact.dhKey, ds: contact.dhSig };
  }

  /** A member I may not know yet: known only through the group, not in the chat list. */
  private memberContact(m: GroupMember): Contact {
    const known = this.contacts[m.id];
    if (known) return known;
    const contact = this.createContact({ userId: m.id, username: m.username, dhKey: m.dh, dhSig: m.ds }, m.name);
    return this.updateContact(contact.id, { groupOnly: true })!;
  }

  private keysOf(groupId: string): GroupKeys {
    return (this.gkeys[groupId] ??= { sent: [], peers: {} });
  }

  private requireGroup(chatId: string): GroupState & { left?: boolean } {
    const group = this.contacts[chatId]?.group;
    if (!group) throw new MessengerError('not_group', 'Группа не найдена');
    if (group.left) throw new MessengerError('left', 'Вы больше не в этой группе');
    return group;
  }

  private nameIn(group: GroupState, id: string): string {
    if (id === this.account.userId) return 'Вы';
    return this.contacts[id] && !this.contacts[id].groupOnly ? this.contacts[id].displayName : (group.members.find((m) => m.id === id)?.name ?? 'Участник');
  }

  /** A new group with me as the owner and these contacts as members. */
  async createGroup(name: string, contactIds: string[]): Promise<Contact> {
    this.requireGroups();
    const title = name.trim().slice(0, 64);
    if (!title) throw new MessengerError('name', 'Введите название группы');
    const people = [...new Set(contactIds)]
      .map((id) => this.contacts[id])
      .filter((c): c is Contact => !!c && !c.group && !isSavedChat(c.id) && !c.blocked && c.id !== this.account.userId);
    if (!people.length) throw new MessengerError('members', 'Выберите хотя бы одного участника');
    if (people.length + 1 > MAX_GROUP_MEMBERS) throw new MessengerError('members', `В группе может быть до ${MAX_GROUP_MEMBERS} человек`);
    const state: GroupState = { id: randomId(12), name: title, v: 1, members: [this.selfMember('owner'), ...people.map((c) => this.memberOf(c))] };
    const chat = this.storeGroup(state);
    this.addSystem(chat.id, { kind: 'group', what: 'created', value: title });
    await this.broadcastGroup(state, state.members);
    return this.contacts[chat.id];
  }

  private storeGroup(state: GroupState, left = false): Contact {
    const id = groupChatId(state.id);
    for (const m of state.members) if (m.id !== this.account.userId) this.memberContact(m);
    const existing = this.contacts[id];
    if (existing) return this.updateContact(id, { displayName: state.name, group: { ...state, ...(left ? { left: true } : {}) } })!;
    const now = Date.now();
    const chat: Contact = {
      id,
      username: '',
      displayName: state.name,
      dhKey: '',
      dhSig: '',
      verified: false,
      blocked: false,
      createdAt: now,
      lastActivity: now,
      unread: 0,
      timer: 0,
      group: { ...state, ...(left ? { left: true } : {}) },
    };
    this.contacts[id] = chat;
    this.conversations.set(id, this.conversations.get(id) ?? []);
    this.markDirty('contacts', `conv.${id}`);
    this.changed();
    return chat;
  }

  /** The group as it is now, privately to each of these members (sent through the pairwise sessions). */
  private async broadcastGroup(state: GroupState, to: GroupMember[]): Promise<void> {
    for (const m of to) {
      if (m.id === this.account.userId) continue;
      await this.sendControl(this.memberContact(m), { t: 'gst', g: state });
    }
  }

  /** My change: checked by the same rules as everyone else's, applied, then sent to all. */
  private async changeGroup(chatId: string, change: (next: GroupState) => void, alsoTell: GroupMember[] = []): Promise<void> {
    this.requireGroups();
    const current = this.requireGroup(chatId);
    const { left: _left, ...plain } = current;
    const next: GroupState = { ...plain, v: current.v + 1, members: current.members.map((m) => ({ ...m })) };
    change(next);
    if (!canApply(plain, next, this.account.userId, this.account.userId)) throw new MessengerError('forbidden', 'Недостаточно прав для этого изменения');
    await this.applyGroupState(this.account.userId, next);
    await this.broadcastGroup(next, [...next.members, ...alsoTell]);
  }

  async addGroupMembers(chatId: string, contactIds: string[]): Promise<void> {
    const group = this.requireGroup(chatId);
    const fresh = [...new Set(contactIds)]
      .map((id) => this.contacts[id])
      .filter((c): c is Contact => !!c && !c.group && !isSavedChat(c.id) && !c.blocked && !group.members.some((m) => m.id === c.id));
    if (!fresh.length) return;
    if (group.members.length + fresh.length > MAX_GROUP_MEMBERS) throw new MessengerError('members', `В группе может быть до ${MAX_GROUP_MEMBERS} человек`);
    await this.changeGroup(chatId, (next) => next.members.push(...fresh.map((c) => this.memberOf(c))));
  }

  async removeGroupMember(chatId: string, memberId: string): Promise<void> {
    const removed = this.requireGroup(chatId).members.find((m) => m.id === memberId);
    if (!removed || memberId === this.account.userId) return;
    await this.changeGroup(chatId, (next) => (next.members = next.members.filter((m) => m.id !== memberId)), [removed]);
  }

  /** Owner only: make an admin or a member, or hand the group over (I become an admin). */
  async setGroupRole(chatId: string, memberId: string, role: GroupRole): Promise<void> {
    await this.changeGroup(chatId, (next) => {
      const target = next.members.find((m) => m.id === memberId);
      if (!target || memberId === this.account.userId) return;
      if (role === 'owner') for (const m of next.members) if (m.role === 'owner') m.role = 'admin';
      target.role = role;
    });
  }

  async renameGroup(chatId: string, name: string): Promise<void> {
    const title = name.trim().slice(0, 64);
    if (!title) throw new MessengerError('name', 'Введите название группы');
    await this.changeGroup(chatId, (next) => (next.name = title));
  }

  /** Leave: everyone drops me and starts new sender keys; the chat stays here, read-only. */
  async leaveGroup(chatId: string): Promise<void> {
    const group = this.requireGroup(chatId);
    for (const m of group.members) if (m.id !== this.account.userId) await this.sendControl(this.memberContact(m), { t: 'gleave', g: group.id });
    this.updateContact(chatId, { group: { ...group, left: true } });
    delete this.gkeys[group.id];
    this.markDirty('gkeys');
    this.addSystem(chatId, { kind: 'group', what: 'left', who: 'Вы' });
  }

  /** A group change from `senderId` (or mine): applied only if the rules allow it. */
  private async applyGroupState(senderId: string, next: GroupState): Promise<boolean> {
    const chatId = groupChatId(typeof next?.id === 'string' ? next.id : '');
    const stored = this.contacts[chatId]?.group;
    const { left: wasLeft, ...current } = stored ?? ({} as GroupState & { left?: boolean });
    const base = stored && !wasLeft ? (current as GroupState) : undefined;
    if (stored && next?.v <= stored.v) return false;
    if (!canApply(base, next, senderId, this.account.userId)) return false;
    const inGroup = next.members.some((m) => m.id === this.account.userId);
    const by = this.nameIn(base ?? next, senderId);
    this.storeGroup(next, !inGroup);
    if (!base) {
      if (senderId !== this.account.userId) this.addSystem(chatId, { kind: 'group', what: 'joined', by, value: next.name });
      // Added by someone I never talked to: the group is a request too.
      const adder = this.contacts[senderId];
      if (senderId !== this.account.userId && (!adder || adder.groupOnly || adder.request) && this.settings.features.requests !== false)
        this.updateContact(chatId, { request: true });
      return true;
    }
    const change = describeChange(base, next);
    for (const m of change.added) this.addSystem(chatId, { kind: 'group', what: 'added', by, who: this.nameIn(next, m.id) });
    for (const m of change.removed) this.addSystem(chatId, { kind: 'group', what: 'removed', by, who: m.id === this.account.userId ? 'вас' : this.nameIn(base, m.id) });
    for (const m of change.roles) this.addSystem(chatId, { kind: 'group', what: 'role', by, who: this.nameIn(next, m.id), value: m.role });
    if (change.renamed) this.addSystem(chatId, { kind: 'group', what: 'renamed', by, value: next.name });
    if (!inGroup) delete this.gkeys[next.id];
    else if (change.removed.length) this.rotateSenderKey(next.id, change.removed.map((m) => m.id));
    this.markDirty('gkeys');
    return true;
  }

  /** Someone left on their own. */
  private memberLeft(senderId: string, groupId: unknown): void {
    if (typeof groupId !== 'string') return;
    const chatId = groupChatId(groupId);
    const group = this.contacts[chatId]?.group;
    if (!group || group.left) return;
    const { left: _left, ...plain } = group;
    const next = withoutMember(plain, senderId);
    if (!next) return;
    const who = this.nameIn(plain, senderId);
    this.storeGroup(next);
    this.addSystem(chatId, { kind: 'group', what: 'left', who });
    this.rotateSenderKey(groupId, [senderId]);
  }

  /** After someone is out: a new chain of mine, and theirs forgotten, so they read nothing new. */
  private rotateSenderKey(groupId: string, gone: string[]): void {
    const keys = this.keysOf(groupId);
    keys.mine = undefined;
    keys.sent = [];
    for (const id of gone) delete keys.peers[id];
    keys.pending = keys.pending?.filter((p) => !gone.includes(p.from));
    this.markDirty('gkeys');
  }

  /** Encrypts once with my sender key; each member gets the same ciphertext in their own sealed envelope. */
  private async deliverGroup(chat: Contact, content: Content, data: Uint8Array | undefined, msgIds: string[]): Promise<void> {
    const group = chat.group;
    if (!group || group.left || !this.groupsOn()) {
      this.setStatus(chat.id, msgIds, 'failed');
      return;
    }
    if (content.t === 'msg') content.g = group.id;
    await this.withContactLock(chat.id, async () => {
      const keys = this.keysOf(group.id);
      if (!keys.mine) {
        keys.mine = newSenderChain();
        keys.sent = [];
      }
      const others = group.members.filter((m) => m.id !== this.account.userId);
      for (const m of others) {
        if (keys.sent.includes(m.id)) continue;
        try {
          await this.encryptAndQueue(this.memberContact(m), { t: 'skd', g: group.id, ...distributionOf(keys.mine) }, undefined, []);
          keys.sent.push(m.id);
        } catch (error) {
          console.warn('sender key not sent', error);
        }
      }
      const { chain, wire, ct } = senderEncrypt(keys.mine, pack(content, data), group.id, this.account.userId);
      keys.mine = chain;
      const inner = pack({ k: 'grp', g: group.id, ...wire } satisfies GroupWireHeader, ct);
      for (const m of others) {
        const envelope = sealEnvelope(unb64(m.dh), this.senderInfo(), inner);
        this.outbox.push({ qid: randomId(), to: m.id, env: b64(envelope), msgIds, chat: chat.id });
      }
      if (!others.length) this.setStatus(chat.id, msgIds, 'sent');
      this.markDirty('gkeys', 'outbox');
      // My chain must be on disk before its ciphertext leaves the device.
      await this.flushNow();
      void this.pumpOutbox();
    });
  }

  private receiveSenderKey(contact: Contact, content: Extract<Content, { t: 'skd' }>): void {
    if (!this.groupsOn() || typeof content.g !== 'string') return;
    const group = this.contacts[groupChatId(content.g)]?.group;
    if (!group || group.left || !group.members.some((m) => m.id === contact.id)) return;
    const chain = chainFrom(content);
    if (!chain) return;
    const keys = this.keysOf(content.g);
    const known = keys.peers[contact.id] ?? [];
    if (known.some((c) => c.id === chain.id)) return;
    keys.peers[contact.id] = [chain, ...known].slice(0, 2);
    this.markDirty('gkeys');
    // Messages that came before the key.
    const waiting = (keys.pending ?? []).filter((p) => p.from === contact.id);
    keys.pending = (keys.pending ?? []).filter((p) => p.from !== contact.id);
    for (const p of waiting) {
      const { header, body } = unpack<GroupWireHeader>(unb64(p.wire));
      void this.handleGroupWire(p.from, header, body).catch(() => {});
    }
  }

  /** A member lost my key (a restored backup, a new device): they get my current chain. */
  private async resendSenderKey(contact: Contact, groupId: unknown): Promise<void> {
    if (!this.groupsOn() || typeof groupId !== 'string') return;
    const group = this.contacts[groupChatId(groupId)]?.group;
    const keys = this.gkeys[groupId];
    if (!group || group.left || !keys?.mine || !group.members.some((m) => m.id === contact.id)) return;
    await this.sendControl(contact, { t: 'skd', g: groupId, ...distributionOf(keys.mine) });
    if (!keys.sent.includes(contact.id)) keys.sent.push(contact.id);
    this.markDirty('gkeys');
  }

  private async handleGroupWire(senderId: string, header: GroupWireHeader, body: Uint8Array): Promise<void> {
    if (!this.groupsOn() || typeof header.g !== 'string') return;
    const chat = this.contacts[groupChatId(header.g)];
    const group = chat?.group;
    if (!group || group.left) return;
    const member = group.members.find((m) => m.id === senderId);
    if (!member) return;
    const keys = this.keysOf(header.g);
    const chains = keys.peers[senderId] ?? [];
    const chain = chains.find((c) => c.id === header.cid);
    if (!chain) {
      // Their key is still on the way (or was lost): keep the message a while and ask for it.
      keys.pending = [...(keys.pending ?? []).filter((p) => Date.now() - p.at < 7 * DAY_MS), { from: senderId, wire: b64(pack(header, body)), at: Date.now() }].slice(-50);
      this.markDirty('gkeys');
      const asked = keys.asked?.[senderId] ?? 0;
      if (Date.now() - asked > 60_000) {
        keys.asked = { ...keys.asked, [senderId]: Date.now() };
        void this.sendControl(this.memberContact(member), { t: 'skreq', g: header.g });
      }
      return;
    }
    const { chain: next, plaintext } = senderDecrypt(chain, header, body, header.g, senderId);
    keys.peers[senderId] = chains.map((c) => (c.id === next.id ? next : c));
    this.markDirty('gkeys');
    const { header: content, body: data } = unpack<Content>(plaintext);
    if (content.t !== 'msg' || content.g !== header.g || typeof content.id !== 'string') return;
    const conversation = this.conversations.get(chat.id) ?? [];
    if (conversation.some((m) => m.id === content.id)) return;
    const now = Date.now();
    const atts = await this.receiveAttachments(content, data);
    const reply = content.r && typeof content.r.id === 'string' ? { id: content.r.id, text: String(content.r.s ?? '').slice(0, 300), out: false } : undefined;
    const message: Message = {
      id: content.id,
      dir: 'in',
      ts: Number(content.ts) || now,
      at: now,
      from: senderId,
      ...(typeof content.text === 'string' ? { text: content.text.slice(0, 64_000) } : {}),
      ...(cleanPreview(content.pv, content.text) ? { preview: cleanPreview(content.pv, content.text) } : {}),
      ...(atts.length ? { atts } : {}),
      ...(reply ? { reply } : {}),
    };
    this.addMessage(chat.id, message);
    // Their own name, as with a direct message.
    const sender = this.contacts[senderId];
    if (sender && typeof content.p?.n === 'string' && content.p.n.trim() && content.p.n !== sender.displayName) this.updateContact(senderId, { displayName: content.p.n.trim().slice(0, 64) });
    if (sender && content.p?.ak) this.learnAccessKey(senderId, content.p.ak);
    const updated = this.updateContact(chat.id, { lastActivity: now, unread: chat.unread + 1, ...(chat.archived && !chat.muted ? { archived: false } : {}) })!;
    if (!updated.muted) this.events.onIncoming?.(updated, message);
  }

  /** «Щит» of a group: how many of the other members I have verified. */
  groupVerified(chatId: string): { verified: number; total: number } {
    const group = this.contacts[chatId]?.group;
    if (!group) return { verified: 0, total: 0 };
    const others = group.members.filter((m) => m.id !== this.account.userId);
    return { verified: others.filter((m) => this.contacts[m.id]?.verified && this.contacts[m.id].id === m.id).length, total: others.length };
  }

  // ---- veil:// invites (features.invites) -------------------------------------------------

  /** A new invite link with my identity key and a one-time token (valid 7 days). */
  /** `addresses`: more ways to this server (tunnel, external); `registration`: a token for a newcomer. */
  createInvite(extra: { addresses?: string[]; registration?: string } = {}): string {
    if (this.settings.features.invites === false) throw new MessengerError('disabled', 'Приглашения выключены в настройках');
    const now = Date.now();
    const token = newInviteToken();
    const active = (this.account.invites ?? []).filter((i) => i.exp > now);
    this.account.invites = [...active, { t: token, exp: now + INVITE_DAYS * DAY_MS }].slice(-MAX_INVITES);
    this.markDirty('account');
    return inviteLink({
      username: this.account.username,
      userId: this.account.userId,
      server: this.account.serverUrl,
      serverId: this.account.serverId,
      serverKey: this.account.serverKey,
      ...(extra.addresses?.length ? { addresses: extra.addresses } : {}),
      ...(extra.registration ? { registration: extra.registration } : {}),
      token,
    });
  }

  /**
   * A registration token for someone new (invite-only servers; up to 5 a day). The owner of a
   * server on this computer gets them from the app instead, without the limit.
   */
  async mintRegistration(): Promise<string> {
    if (!this.relay) throw new RelayRequestError('offline', 'Нет соединения с сервером');
    const { token } = await this.relay.request<{ token: string }>({ type: 'invite_mint' });
    return token;
  }

  /**
   * Opens someone's invite: the key the server returns must be the key in the link, otherwise
   * the contact is not added (the server or someone in the middle swapped it).
   */
  async acceptInvite(link: string): Promise<Contact> {
    if (this.settings.features.invites === false) throw new MessengerError('disabled', 'Приглашения выключены в настройках');
    const invite = parseInvite(link);
    if (!invite) throw new MessengerError('bad_invite', 'Это не приглашение Veil или ссылка повреждена');
    if (invite.userId === this.account.userId) throw new MessengerError('own_invite', 'Это ваше собственное приглашение');
    // One server has many addresses (localhost on its own computer, 192.168.… for the others):
    // its id says whether it is the same one. Without ids, a different address is only a guess.
    const sameId =
      (!!invite.serverKey && invite.serverKey === this.account.serverKey) || (!!invite.serverId && invite.serverId === this.account.serverId);
    const otherAddress = !!invite.server && serverKey(invite.server) !== serverKey(this.account.serverUrl);
    const otherServer = () =>
      new MessengerError('other_server', `Приглашение для сервера ${invite.server}, а ваш аккаунт — на ${serverKey(this.account.serverUrl)}`);
    if (otherAddress && !sameId && (invite.serverKey || invite.serverId) && (this.account.serverKey || this.account.serverId)) throw otherServer();
    if (this.decoy) return this.addContact(invite.username);
    // Compared before anything is stored: a swapped key must not replace a known contact's key.
    let info: UserInfo;
    try {
      info = await this.lookupUser(invite.username);
    } catch (error) {
      if (otherAddress && !sameId && (error as MessengerError).code === 'not_found') throw otherServer();
      throw error;
    }
    if (info.userId !== invite.userId) {
      this.logSecurity('invite_mismatch', `@${invite.username}`);
      throw new MessengerError(
        'invite_mismatch',
        'Ключ не совпадает с приглашением. Возможно, его подменили по дороге — не пишите туда ничего важного и сверьте код безопасности при встрече',
      );
    }
    const contact = await this.addFromInfo(info);
    if (!contact.verified || contact.verifiedBy !== 'invite') this.markInvited(contact.id, 'me');
    // My name (as with a first message) and the token: the inviter sees who came and verifies me.
    await this.sendControl(this.contacts[contact.id], { t: 'prof', ...this.myProfile(this.contacts[contact.id]) });
    if (invite.token) await this.sendControl(this.contacts[contact.id], { t: 'inv', tok: invite.token });
    return this.contacts[contact.id];
  }

  private markInvited(contactId: string, by: 'me' | 'them'): void {
    this.updateContact(contactId, { verified: true, keyWarning: false, verifiedAt: Date.now(), verifiedBy: 'invite' });
    this.addSystem(contactId, { kind: 'invite', by });
  }

  /** My invite came back: the token is used up and this contact counts as verified. */
  private redeemInvite(contact: Contact, token: unknown): void {
    if (typeof token !== 'string' || this.settings.features.invites === false) return;
    const now = Date.now();
    const invites = this.account.invites ?? [];
    const match = invites.find((i) => i.exp > now && equalBytes(utf8(i.t), utf8(token)));
    this.account.invites = invites.filter((i) => i !== match && i.exp > now);
    this.markDirty('account');
    if (!match || isSavedChat(contact.id)) return;
    this.markInvited(contact.id, 'them');
    // I invited them myself: not a stranger's request.
    if (this.contacts[contact.id]?.request) this.acceptRequest(contact.id);
    else void this.sendControl(contact, { t: 'prof', ...this.myProfile(contact) });
  }

  private shares(contactId: string, kind: PresenceKind): boolean {
    const contact = this.contacts[contactId];
    return !!contact && sharesWith(this.settings, contact, kind);
  }

  /** Per-contact «в сети» / «прочитано» / «печатает»; undefined goes back to the global setting. */
  setContactPrivacy(contactId: string, patch: Partial<Record<PresenceKind, boolean | undefined>>): void {
    const contact = this.contacts[contactId];
    if (!contact) return;
    const privacy = { ...contact.privacy, ...patch };
    for (const key of Object.keys(privacy) as PresenceKind[]) if (privacy[key] === undefined) delete privacy[key];
    this.updateContact(contactId, { privacy: Object.keys(privacy).length ? privacy : undefined });
    if ('online' in patch) {
      if (!this.shares(contactId, 'online')) delete this.online[contactId];
      void this.sendEphemeral(contactId, { t: 'pres', s: this.shares(contactId, 'online') ? 'on' : 'hidden', ask: 1 });
    }
    if ('typing' in patch && !this.shares(contactId, 'typing')) this.clearTyping(contactId);
  }

  /** «Вуаль» for one chat (when it is on only for selected chats). */
  setVeil(contactId: string, veil: boolean): void {
    this.updateContact(contactId, { veil: veil || undefined });
  }

  /** Takes the contact's new key without comparing codes: the warning goes, the chat stays unverified. */
  acceptKeyChange(contactId: string): void {
    this.updateContact(contactId, { keyWarning: false });
  }

  setBlocked(contactId: string, blocked: boolean): void {
    this.updateContact(contactId, { blocked });
    if (blocked) void this.rotateAccessKey();
  }

  /**
   * A blocked person keeps my old delivery key: a new one goes to the server and, inside encrypted
   * messages, to everyone else, so they can go on writing without logging in.
   */
  private async rotateAccessKey(): Promise<void> {
    if (this.decoy || !this.account.accessKey) return;
    this.account.accessKey = b64(random(ACCESS_KEY_BYTES));
    this.markDirty('account');
    await this.publishAccessKey();
    for (const contact of Object.values(this.contacts)) {
      if (contact.blocked || contact.group || isSavedChat(contact.id) || !this.sessions[contact.id]?.length) continue;
      void this.sendControl(contact, { t: 'prof', ...this.myProfile(contact) });
    }
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

  /** 60 digits for a person; empty for «Избранное» and groups (each member has their own). */
  safetyNumber(contactId: string): string {
    if (isSavedChat(contactId) || isGroupChat(contactId)) return '';
    return safetyNumber(this.account.userId, contactId);
  }

  async deleteChat(contactId: string): Promise<void> {
    if (this.contacts[contactId]?.group && !this.contacts[contactId].group!.left) await this.leaveGroup(contactId);
    if (this.contacts[contactId]?.group) delete this.gkeys[this.contacts[contactId].group!.id];
    await this.clearChat(contactId);
    if (isSavedChat(contactId)) return; // «Избранное» stays, just empty
    delete this.contacts[contactId];
    delete this.sessions[contactId];
    delete this.online[contactId];
    this.conversations.delete(contactId);
    this.outbox = this.outbox.filter((item) => item.to !== contactId && item.chat !== contactId);
    this.markDirty('contacts', 'sessions', 'outbox', 'gkeys', `conv.${contactId}`);
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
      // Nothing is sent from «Избранное», so there is no delivery status.
      ...(isSavedChat(contact.id) ? {} : { status: 'pending' as const }),
      ...fields,
      ...(reply ? { reply } : {}),
      ...(contact.timer ? { timer: contact.timer, expiresAt: now + contact.timer * 1000 } : {}),
    };
  }

  async sendText(contactId: string, text: string, options: SendOptions = {}): Promise<void> {
    const body = text.trim();
    if (!body) return;
    const contact = this.requireSendable(contactId);
    const now = Date.now();
    if (options.capsule && contact.group) throw new MessengerError('group', 'В группах капсул времени нет');
    if (options.capsule && options.capsule > now + 60_000 && !isSavedChat(contactId)) {
      // The text is sealed with a key only this side has until the date comes.
      const key = newContentKey();
      const ct = b64(sealContent(key, utf8(body), 'capsule'));
      const message = this.newOutgoing(contact, { text: body, capsule: { at: options.capsule, k: b64(key), ct } }, options.replyTo);
      key.fill(0);
      this.addMessage(contactId, message);
      this.updateContact(contactId, { lastActivity: message.ts, draft: undefined });
      await this.deliverMessage(contact, message);
      return;
    }
    if (options.at && options.at > now + 30_000 && !isSavedChat(contactId)) {
      // Waits here, in the encrypted vault, until its time.
      const message = this.newOutgoing(contact, { text: body, status: 'scheduled', schedule: { at: options.at } }, options.replyTo);
      this.addMessage(contactId, message);
      this.updateContact(contactId, { draft: undefined });
      return;
    }
    const preview = this.settings.features.linkPreviews !== false && this.settings.linkPreviews ? cleanPreview(options.preview, body) : undefined;
    const message = this.newOutgoing(contact, { text: body, ...(preview ? { preview } : {}) }, options.replyTo);
    this.addMessage(contactId, message);
    this.updateContact(contactId, { lastActivity: message.ts, draft: undefined });
    await this.deliverMessage(contact, message);
  }

  /** A scheduled message goes now (or is cancelled with deleteMessage). */
  async sendScheduledNow(contactId: string, messageId: string): Promise<void> {
    const message = this.conversations.get(contactId)?.find((m) => m.id === messageId && m.status === 'scheduled');
    if (message) await this.releaseScheduled(contactId, message, Date.now(), false);
  }

  private async releaseScheduled(contactId: string, message: Message, now: number, late: boolean): Promise<void> {
    const contact = this.contacts[contactId];
    if (!contact || contact.blocked || this.isHeld(contactId)) return;
    const updated: Message = { ...message, status: 'pending', ts: now, schedule: { at: message.schedule?.at ?? now, ...(late ? { late: true } : {}) } };
    // Disappearing timers count from the moment it is really sent.
    if (updated.timer) updated.expiresAt = now + updated.timer * 1000;
    // It moves to the end of the chat, where it is sent.
    this.patchMessages(contactId, new Set([message.id]), () => null);
    this.addMessage(contactId, updated);
    this.updateContact(contactId, { lastActivity: now });
    await this.deliverMessage(contact, updated);
  }

  private lastTimedScan = 0;
  /**
   * Scheduled messages whose time came (a computer that was off sends them at start, marked late),
   * capsule keys to send, and received capsules to open.
   */
  private processTimed(now: number): void {
    if (now - this.lastTimedScan < 5000 || this.locked) return;
    this.lastTimedScan = now;
    for (const [contactId, list] of this.conversations) {
      if (isSavedChat(contactId)) continue;
      for (const message of list) {
        if (message.status === 'scheduled' && message.schedule && message.schedule.at <= now) {
          void this.releaseScheduled(contactId, message, now, now - message.schedule.at > 120_000);
        } else if (message.capsule && message.capsule.at <= now) {
          if (message.dir === 'out' && message.capsule.k && !message.capsule.sent && message.status !== 'pending' && message.status !== 'failed') {
            const contact = this.contacts[contactId];
            if (!contact || contact.blocked) continue;
            this.patchMessages(contactId, new Set([message.id]), (m) => ({ ...m, capsule: { ...m.capsule!, sent: true } }));
            void this.sendControl(contact, { t: 'capkey', id: message.id, k: message.capsule.k });
          } else if (message.dir === 'in' && message.capsule.k && !message.capsule.opened) this.openCapsule(contactId, message);
        }
      }
    }
  }

  private openCapsule(contactId: string, message: Message): void {
    const capsule = message.capsule!;
    let text: string;
    try {
      text = fromUtf8(openContent(unb64(capsule.k!), unb64(capsule.ct ?? ''), 'capsule')).slice(0, 64_000);
    } catch {
      return;
    }
    this.patchMessages(contactId, new Set([message.id]), (m) => ({ ...m, text, capsule: { at: capsule.at, opened: true } }));
  }

  /**
   * Sends photos/files with an optional caption. Pictures form an album; anything over
   * the size or count limit is split into several messages.
   */
  async sendMedia(contactId: string, files: OutgoingFile[], options: MediaOptions = {}): Promise<void> {
    const contact = this.requireSendable(contactId);
    for (const file of files) {
      if (file.data.length > MAX_ATTACHMENT_BYTES) throw new MessengerError('too_large', `«${file.name}» больше 20 МБ`);
    }
    if (options.once && contact.group) throw new MessengerError('group', 'В группах нет фото «на один просмотр»');
    if (options.once) return this.sendOnce(contact, files, options);
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

  /**
   * View-once: the photo or video is sealed with a fresh key that travels inside the end-to-end
   * message. Neither side can open it again after the recipient has seen it.
   */
  private async sendOnce(contact: Contact, files: OutgoingFile[], options: MediaOptions): Promise<void> {
    const file = files[0];
    if (files.length !== 1 || !canSendOnce(file.mime)) throw new MessengerError('once_kind', 'Один раз можно открыть только одно фото или видео');
    if (isSavedChat(contact.id)) throw new MessengerError('once_saved', 'В «Избранное» нельзя отправить фото на один просмотр');
    const key = newContentKey();
    const sealed = sealContent(key, file.data, 'once');
    const att: Attachment = {
      id: randomId(),
      name: isVideo(file.mime) ? 'video' : 'photo',
      mime: file.mime,
      size: sealed.length,
      kind: IMAGE_MIME.test(file.mime) ? 'image' : 'file',
      ...(file.w && file.h ? { w: file.w, h: file.h } : {}),
    };
    await this.store.putBytes(`att.${att.id}`, sealed);
    const caption = options.caption?.trim();
    const message = this.newOutgoing(contact, { atts: [att], once: { k: b64(key) }, ...(caption ? { text: caption } : {}) }, options.replyTo);
    key.fill(0);
    this.addMessage(contact.id, message);
    this.updateContact(contact.id, { lastActivity: message.ts });
    await this.deliverMessage(contact, message);
  }

  /**
   * Opens a received view-once photo or video. It is decrypted into memory only; the key and the
   * stored file are deleted right away, and the sender is told to delete theirs.
   */
  async openOnce(contactId: string, messageId: string): Promise<{ data: Uint8Array; mime: string }> {
    const message = this.conversations.get(contactId)?.find((m) => m.id === messageId);
    const att = message ? attachmentsOf(message)[0] : undefined;
    if (!message || message.dir !== 'in' || !message.once?.k || !att) throw new MessengerError('once_gone', 'Это фото уже открывали');
    const sealed = await this.store.getBytes(`att.${att.id}`);
    if (!sealed) throw new MessengerError('once_gone', 'Это фото уже открывали');
    const key = unb64(message.once.k);
    let data: Uint8Array;
    try {
      data = openContent(key, sealed, 'once');
    } finally {
      key.fill(0);
    }
    await this.store.delete(`att.${att.id}`);
    this.patchMessages(contactId, new Set([messageId]), (m) => ({ ...m, once: { opened: Date.now() } }));
    const contact = this.contacts[contactId];
    if (contact && !contact.blocked) void this.sendControl(contact, { t: 'viewed', id: messageId });
    return { data, mime: att.mime };
  }

  /**
   * Copies a message (text and files) into «Избранное». The files are copied too, so the note
   * survives even if the original message is deleted or disappears.
   */
  async saveToFavorites(contactId: string, messageId: string): Promise<void> {
    const source = this.conversations.get(contactId)?.find((m) => m.id === messageId);
    if (!source || source.dir === 'system' || source.call) return;
    if (source.once) throw new MessengerError('once_save', 'Фото на один просмотр нельзя сохранить');
    const atts: Attachment[] = [];
    for (const att of attachmentsOf(source)) {
      const bytes = await this.store.getBytes(`att.${att.id}`);
      if (!bytes) continue;
      const copy = { ...att, id: randomId() };
      await this.store.putBytes(`att.${copy.id}`, bytes);
      atts.push(copy);
    }
    if (!source.text && !atts.length) throw new MessengerError('empty', 'Файл ещё не загружен');
    const author = source.dir === 'out' ? this.account.displayName : (this.contacts[contactId]?.displayName ?? '');
    const now = Date.now();
    this.addMessage(SAVED_ID, {
      id: randomId(),
      dir: 'out',
      ts: now,
      at: now,
      ...(source.text ? { text: source.text } : {}),
      ...(atts.length ? { atts } : {}),
      ...(isSavedChat(contactId) ? {} : { fwd: { name: author, ts: source.ts } }),
    });
    this.updateContact(SAVED_ID, { lastActivity: now, archived: false });
  }

  /**
   * A note, password or link in «Избранное». With `burnDays` it is a temporary note: deleted for
   * good after that many days, with a reminder a day before.
   */
  addNote(input: { text: string; kind?: NoteKind; title?: string; burnDays?: number }): Message {
    const text = input.kind === 'password' ? input.text : input.text.trim();
    if (!text) throw new MessengerError('empty', 'Пустая заметка');
    const kind: NoteKind = input.kind ?? (/^https?:\/\/\S+$/i.test(text) ? 'link' : 'note');
    const now = Date.now();
    const days = Number(input.burnDays) || 0;
    const message: Message = {
      id: randomId(),
      dir: 'out',
      ts: now,
      at: now,
      text: text.slice(0, 64_000),
      note: { kind, ...(input.title?.trim() ? { title: input.title.trim().slice(0, 120) } : {}) },
      ...(days > 0 ? { expiresAt: now + days * DAY_MS } : {}),
    };
    this.addMessage(SAVED_ID, message);
    this.updateContact(SAVED_ID, { lastActivity: now, archived: false });
    return message;
  }

  /** Temporary notes get one reminder a day before they burn (a one-day note: halfway). */
  private remindNotes(now: number): void {
    const due = (this.conversations.get(SAVED_ID) ?? []).filter(
      (m) => m.note && m.expiresAt && !m.note.reminded && m.expiresAt - now < Math.min(DAY_MS, (m.expiresAt - m.ts) / 2),
    );
    if (!due.length) return;
    this.patchMessages(SAVED_ID, new Set(due.map((m) => m.id)), (m) => ({ ...m, note: { ...m.note!, reminded: true } }));
    for (const message of due) this.events.onNoteReminder?.(message);
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
    if (isSavedChat(contact.id)) return;
    const content: Content = {
      t: 'msg',
      id: message.id,
      ts: message.ts,
      ...(message.text && !message.capsule ? { text: message.text } : {}),
      ...(message.capsule?.ct ? { cap: { at: message.capsule.at, ct: message.capsule.ct } } : {}),
      ...(message.preview ? { pv: message.preview } : {}),
      ...(message.timer ? { timer: message.timer } : {}),
      ...(message.reply ? { r: { id: message.reply.id, s: message.reply.text, a: message.reply.out ? 'me' : 'you' } } : {}),
      ...(message.once?.k ? { once: { k: message.once.k } } : {}),
      p: this.myProfile(contact),
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
      if (contact.group) await this.deliverGroup(contact, content, data, [message.id]);
      else await this.encryptAndQueue(contact, content, data, [message.id]);
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
    const contact = this.requireSendable(contactId);
    const message = this.conversations.get(contactId)?.find((m) => m.id === messageId);
    if (!message || message.status !== 'failed') return;
    this.setStatus(contactId, [messageId], 'pending', true);
    await this.deliverMessage(contact, { ...message, status: 'pending' });
  }

  private async sendControl(contact: Contact, content: Content): Promise<void> {
    if (isSavedChat(contact.id) || contact.group) return;
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

  /**
   * Hands an envelope to the server. To a contact who gave me their delivery key it goes on the
   * anonymous connection, so the server does not see that it is from me; otherwise (a first
   * message, an older contact) it goes on my logged-in connection as before.
   */
  private async transmit<T>(to: string, frame: { cid: string; ephemeral?: boolean }, body: Uint8Array): Promise<T> {
    const ak = this.contacts[to]?.accessKey;
    if (ak && !this.decoy) {
      this.sealed ??= new SealedSender(
        () => this.account.serverUrl,
        () => this.account.serverKey,
      );
      try {
        return await this.sealed.send<T>({ to, ak, ...frame }, body);
      } catch (error) {
        const code = error instanceof RelayRequestError ? error.code : 'offline';
        // A key that no longer opens their door: forget it until they send the new one.
        if (code === 'unauthorized') this.updateContact(to, { accessKey: undefined });
        else if (code !== 'offline' && code !== 'timeout') throw error;
      }
    }
    if (!this.relay) throw new RelayRequestError('offline', 'Нет соединения с сервером');
    return this.relay.request<T>({ type: 'send', to, ...frame }, body);
  }

  /** My delivery key: made once, its hash told to the server on every login (it may have lost it). */
  private async publishAccessKey(): Promise<void> {
    if (this.decoy || !this.relay) return;
    if (!this.account.accessKey) {
      this.account.accessKey = b64(random(ACCESS_KEY_BYTES));
      this.markDirty('account');
    }
    await this.relay.request({ type: 'access_set', hash: b64(sha256(unb64(this.account.accessKey))) }).catch(() => {});
  }

  /** Their delivery key, from inside an encrypted message. */
  private learnAccessKey(contactId: string, ak: unknown): void {
    if (typeof ak !== 'string' || ak === this.contacts[contactId]?.accessKey) return;
    try {
      if (unb64(ak).length !== ACCESS_KEY_BYTES) return;
    } catch {
      return;
    }
    this.updateContact(contactId, { accessKey: ak });
  }

  /** What goes with my profile to a contact: the name, and the delivery key unless they are blocked. */
  private myProfile(contact: Contact | undefined): { n: string; ak?: string } {
    const ak = this.account.accessKey;
    return { n: this.account.displayName, ...(ak && contact && !contact.blocked && !contact.request ? { ak } : {}) };
  }

  private async pumpOutbox(): Promise<void> {
    if (this.pumping || !this.relay || this.relay.status !== 'online') return;
    this.pumping = true;
    try {
      while (this.outbox.length && this.relay?.status === 'online') {
        const item = this.outbox[0];
        try {
          await this.transmit(item.to, { cid: item.qid }, unb64(item.env));
          this.outbox.shift();
          this.setStatus(item.chat ?? item.to, item.msgIds, 'sent');
        } catch (error) {
          if (error instanceof RelayRequestError && (error.code === 'offline' || error.code === 'timeout')) break;
          if (error instanceof RelayRequestError && error.code === 'rate_limited') {
            await new Promise((r) => setTimeout(r, 2000));
            continue;
          }
          this.outbox.shift();
          this.setStatus(item.chat ?? item.to, item.msgIds, 'failed');
        }
        this.markDirty('outbox');
      }
    } finally {
      this.pumping = false;
    }
  }

  private setStatus(contactId: string, ids: string[], status: Message['status'], force = false): void {
    if (!ids.length) return;
    const rank = { scheduled: 0, failed: 0, pending: 1, sent: 2, delivered: 3, read: 4 } as const;
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
    if (this.shares(contactId, 'read') && !contact.blocked && !contact.request) void this.sendControl(contact, { t: 'rcpt', k: 'r', ids });
  }

  /** «Принять»: the stranger becomes a contact — they get my name and delivery key, receipts flow. */
  acceptRequest(contactId: string): void {
    const contact = this.contacts[contactId];
    if (!contact?.request) return;
    const accepted = this.updateContact(contactId, { request: undefined })!;
    if (accepted.group) return;
    void this.sendControl(accepted, { t: 'prof', ...this.myProfile(accepted) });
    // What came while it was a request is reported delivered now; «прочитано» follows when read.
    const ids = (this.conversations.get(contactId) ?? []).filter((m) => m.dir === 'in').map((m) => m.id);
    if (ids.length) void this.sendControl(accepted, { t: 'rcpt', k: 'd', ids });
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
    const contact = this.requireSendable(contactId);
    const message = this.conversations.get(contactId)?.find((m) => m.id === messageId);
    if (!message || message.dir === 'system' || message.call) return;
    const next = message.reactions?.me === emoji ? '' : cleanEmoji(emoji);
    this.patchMessages(contactId, new Set([messageId]), (m) => ({ ...m, reactions: { ...m.reactions, me: next || undefined } }));
    await this.sendControl(contact, { t: 'react', id: messageId, e: next });
  }

  async setTimer(contactId: string, seconds: number): Promise<void> {
    const contact = this.requireContact(contactId);
    if (contact.group) throw new MessengerError('group', 'В группах исчезающих сообщений пока нет');
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
  /** `loggedOut`: the logged-in connection is already closed; only a sealed send can go. */
  private async sendEphemeral(contactId: string, content: Content, loggedOut = false): Promise<boolean> {
    const contact = this.contacts[contactId];
    const session = this.confirmedSession(contactId);
    if (isSavedChat(contactId) || isGroupChat(contactId)) return false;
    if (!contact || contact.blocked || !session) return false;
    if (loggedOut ? !contact.accessKey : !this.relay || this.relay.status !== 'online') return false;
    const envelope = sealEnvelope(unb64(contact.dhKey), this.senderInfo(), ephemeralEncrypt(session, pack(content)));
    try {
      const result = await this.transmit<{ delivered?: boolean }>(contactId, { cid: randomId(), ephemeral: true }, envelope);
      return !!result?.delivered;
    } catch {
      return false;
    }
  }

  sendTyping(contactId: string, on: boolean): void {
    if (!this.shares(contactId, 'typing')) return;
    const last = this.lastTypingSent.get(contactId) ?? 0;
    if (on && Date.now() - last < 3000) return;
    this.lastTypingSent.set(contactId, on ? Date.now() : 0);
    void this.sendEphemeral(contactId, { t: 'typ', on });
  }

  // ---- calls ---------------------------------------------------------------------------

  /** STUN/TURN servers for calls: the relay's own, or public STUN. */
  get iceServers(): { servers: IceServer[]; hasTurn: boolean } {
    const servers = this.relayIce?.length ? this.relayIce : DEFAULT_ICE_SERVERS;
    return { servers, hasTurn: servers.some((s) => s.urls.some((u) => /^turns?:/.test(u))) };
  }

  /**
   * Sends a call signal. Offers and answers go as ephemeral signals (dropped if the peer is
   * offline, so nobody gets a stale ringing call); `end` is queued, so a caller who gave up
   * still leaves a missed call behind.
   */
  async sendCallSignal(contactId: string, signal: CallSignal): Promise<'delivered' | 'offline' | 'queued'> {
    const contact = signal.k === 'offer' ? this.requireSendable(contactId) : this.requireContact(contactId);
    if (isSavedChat(contactId)) throw new MessengerError('saved', 'В «Избранное» позвонить нельзя');
    if (contact.blocked) throw new MessengerError('blocked', 'Пользователь заблокирован');
    if (!this.relay || this.relay.status !== 'online') throw new MessengerError('offline', 'Нет соединения с сервером');
    const content: Content = { t: 'call', ts: Date.now(), ...signal };
    if (signal.k !== 'end' && this.confirmedSession(contactId)) return (await this.sendEphemeral(contactId, content)) ? 'delivered' : 'offline';
    await this.sendControl(contact, content);
    return 'queued';
  }

  /** Adds a call to the chat history (local only, never sent). */
  logCall(contactId: string, dir: 'in' | 'out', call: CallRecord, callId?: string): void {
    const contact = this.contacts[contactId];
    if (!contact) return;
    if (callId) this.endedCalls.add(callId);
    const now = Date.now();
    const message: Message = { id: randomId(), dir, ts: now, at: now, call, ...(dir === 'in' ? { readSent: true } : {}) };
    this.addMessage(contactId, message);
    const missed = dir === 'in' && call.status !== 'done' && call.status !== 'declined';
    const patch: Partial<Contact> = { lastActivity: now };
    if (missed) {
      patch.unread = contact.unread + 1;
      if (contact.archived && !contact.muted) patch.archived = false;
    }
    const updated = this.updateContact(contactId, patch)!;
    if (missed && !updated.muted) this.events.onIncoming?.(updated, message);
  }

  private handleCall(contact: Contact, content: Extract<Content, { t: 'call' }>, queued: boolean): void {
    const id = typeof content.id === 'string' && content.id.length <= 64 ? content.id : '';
    if (!id) return;
    // A stranger's call does not ring: it shows up as a missed call in the request.
    if (contact.request) {
      if (content.k === 'offer' && !this.endedCalls.has(id)) this.logCall(contact.id, 'in', { status: 'missed' }, id);
      return;
    }
    let signal: CallSignal;
    switch (content.k) {
      case 'offer':
      case 'answer': {
        if (typeof content.sdp !== 'string' || content.sdp.length > 20_000) return;
        // An offer that sat in the queue (the peer was offline) is not a ringing call any more.
        if (content.k === 'offer' && queued && Math.abs(Date.now() - (Number(content.ts) || 0)) > CALL_OFFER_TTL_MS) return;
        signal = content.k === 'offer' && content.v === 1 ? { k: 'offer', id, sdp: content.sdp, v: 1 } : { k: content.k, id, sdp: content.sdp };
        break;
      }
      case 'media':
        signal = { k: 'media', id, cam: content.cam === true, scr: content.scr === true };
        break;
      case 'ring':
        signal = { k: 'ring', id };
        break;
      case 'end': {
        const reasons = ['hangup', 'decline', 'busy', 'cancel', 'timeout', 'failed'] as const;
        signal = { k: 'end', id, r: reasons.includes(content.r) ? content.r : 'hangup' };
        break;
      }
      default:
        return;
    }
    if (signal.k === 'offer' && this.endedCalls.has(id)) return;
    const known = this.callHandler?.(contact, signal) ?? false;
    // A caller gave up before we saw the offer (we were offline): leave a missed call.
    if (!known && signal.k === 'end' && (signal.r === 'cancel' || signal.r === 'timeout') && !this.endedCalls.has(id)) {
      this.logCall(contact.id, 'in', { status: 'missed' }, id);
    }
  }

  // ---- presence ------------------------------------------------------------------------

  /** Tells contacts we came online (asking for their status) or are leaving. */
  /** Who hears that I am online / offline now, and what (hidden → «recently»). */
  private presenceTargets(state: 'on' | 'off', ask = false): { id: string; content: Content }[] {
    if (!this.relay || this.relay.status !== 'online') return [];
    const targets: { id: string; content: Content }[] = [];
    for (const contact of Object.values(this.contacts)) {
      // People I only share a group with do not learn when I am online.
      if (contact.blocked || contact.groupOnly || contact.group || contact.request) continue;
      if (state === 'off' && !this.online[contact.id]) continue;
      const hidden = !this.shares(contact.id, 'online');
      const content: Content = hidden ? { t: 'pres', s: 'hidden', ...(ask ? { ask: 1 } : {}) } : { t: 'pres', s: state, ...(ask ? { ask: 1 } : {}) };
      targets.push({ id: contact.id, content });
    }
    return targets;
  }

  private announcePresence(state: 'on' | 'off', ask = false): Promise<unknown> {
    return Promise.all(this.presenceTargets(state, ask).map((t) => this.sendEphemeral(t.id, t.content)));
  }


  private markOnline(contactId: string): void {
    const contact = this.contacts[contactId];
    if (!contact || contact.presenceHidden || !this.shares(contactId, 'online')) return;
    const now = Date.now();
    const wasOnline = !!this.online[contactId];
    this.online[contactId] = { until: now + ONLINE_GRACE_MS, last: now };
    if (!wasOnline) this.changed();
  }

  private handlePresence(contact: Contact, content: Extract<Content, { t: 'pres' }>): void {
    const now = Date.now();
    const mine = this.shares(contact.id, 'online');
    if (!mine) {
      // Reciprocity: I hide «в сети» from them, so I do not see theirs either.
    } else if (content.s === 'hidden') {
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
    if (content.ask && !contact.request) void this.sendEphemeral(contact.id, { t: 'pres', s: mine ? 'on' : 'hidden' });
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
    // Nobody can write into «Избранное», and our own envelopes are ignored.
    if (contactId === this.account.userId || isSavedChat(contactId)) return;
    if (this.contacts[contactId]?.blocked) return;
    const peek = unpack<{ k?: string }>(wire);
    if (peek.header.k === 'grp') return this.handleGroupWire(contactId, peek.header as GroupWireHeader, peek.body);
    const { header, body } = parseWire(wire);
    const list = this.sessions[contactId] ?? [];

    if (header.k === 'eph') {
      const session = list.find((s) => s.id === header.sid);
      const contact = this.contacts[contactId];
      if (!session || !contact) return;
      const { header: content } = unpack<Content>(ephemeralDecrypt(session, header, body));
      // A stranger's «typing» and «online» say nothing to me; a call does not ring (handleCall).
      if (contact.request && content.t !== 'call') return;
      if (content.t === 'typ') {
        this.markOnline(contactId);
        this.setTyping(contactId, content.on);
      } else if (content.t === 'pres') this.handlePresence(contact, content);
      else if (content.t === 'call') this.handleCall(contact, content, false);
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
      const fresh = { userId: contactId, username: info?.username ?? '', dhKey: sender.fd, dhSig: sender.fs };
      const previous = info?.username
        ? Object.values(this.contacts).find((c) => c.username === info.username && c.id !== contactId && !isSavedChat(c.id))
        : undefined;
      contact = previous && !(await this.renamedOrReset(previous))
        ? this.replaceIdentity(previous, fresh)
        : this.createContact(fresh, content.t === 'msg' && content.p?.n ? content.p.n : (info?.username ?? 'Неизвестный'));
      // Someone from a group I am in: no chat in the list until we talk directly.
      if (!previous && ['skd', 'skreq', 'gst', 'gleave'].includes(content.t)) contact = this.updateContact(contactId, { groupOnly: true })!;
      // A stranger writes first: «Запрос на переписку» until I accept or reply.
      else if (!previous && this.settings.features.requests !== false) contact = this.updateContact(contactId, { request: true })!;
    } else if (contact.dhKey !== sender.fd) {
      contact = this.updateContact(contactId, { dhKey: sender.fd, dhSig: sender.fs })!;
    }
    this.markOnline(contactId);
    await this.handleContent(contact, content, data, delivered);
  }

  private resolveContact(userId: string): Promise<UserInfo | null> {
    let pending = this.resolvingContacts.get(userId);
    if (!pending) {
      pending = (this.relay?.request<UserInfo>({ type: 'resolve', userId }) ?? Promise.reject(new Error('offline')))
        .then((info) => {
          this.checkVouched(info);
          return info;
        })
        .catch(() => null);
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
        const cap =
          content.cap && typeof content.cap.ct === 'string' && content.cap.ct.length < 100_000 && Number(content.cap.at) > 0
            ? { at: Number(content.cap.at), ct: content.cap.ct }
            : undefined;
        const onceKey = typeof content.once?.k === 'string' && unb64Safe(content.once.k)?.length === 32 ? content.once.k : undefined;
        if (content.once && (!onceKey || atts.length !== 1)) {
          for (const att of atts) await this.store.delete(`att.${att.id}`);
          return;
        }
        const message: Message = {
          id: content.id,
          dir: 'in',
          ts: Number(content.ts) || now,
          at: now,
          ...(typeof content.text === 'string' && !cap ? { text: content.text.slice(0, 64_000) } : {}),
          ...(cap ? { capsule: cap } : {}),
          ...(!cap && cleanPreview(content.pv, content.text) ? { preview: cleanPreview(content.pv, content.text) } : {}),
          ...(atts.length ? { atts } : {}),
          ...(reply ? { reply } : {}),
          ...(timer > 0 ? { timer, expiresAt: now + timer * 1000 } : {}),
          ...(onceKey ? { once: { k: onceKey } } : {}),
        };
        this.addMessage(contact.id, message);
        this.clearTyping(contact.id);
        const patch: Partial<Contact> = { lastActivity: now, unread: contact.unread + 1, ...(contact.groupOnly ? { groupOnly: undefined } : {}) };
        if (content.p?.n && content.p.n !== contact.displayName) patch.displayName = String(content.p.n).slice(0, 64);
        if (content.p?.ak) this.learnAccessKey(contact.id, content.p.ak);
        // Like Telegram: a new message brings an archived (not muted) chat back.
        if (contact.archived && !contact.muted) patch.archived = false;
        const updated = this.updateContact(contact.id, patch)!;
        // A stranger does not learn that the message arrived (or that I exist and am online).
        if (!updated.request) delivered.set(contact.id, [...(delivered.get(contact.id) ?? []), message.id]);
        if (!updated.muted) this.events.onIncoming?.(updated, message);
        return;
      }
      case 'rcpt':
        // Reciprocity: without sending «прочитано» myself, I only learn «доставлено».
        if (Array.isArray(content.ids)) this.setStatus(contact.id, content.ids, content.k === 'r' && this.shares(contact.id, 'read') ? 'read' : 'delivered');
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
      case 'capkey': {
        if (typeof content.id !== 'string' || typeof content.k !== 'string' || unb64Safe(content.k)?.length !== 32) return;
        const sealed = this.conversations.get(contact.id)?.find((m) => m.id === content.id && m.dir === 'in' && m.capsule && !m.capsule.opened);
        if (!sealed) return;
        this.patchMessages(contact.id, new Set([sealed.id]), (m) => ({ ...m, capsule: { ...m.capsule!, k: content.k } }));
        // Opens now if its date has come on this computer's clock too, otherwise at that time.
        const updated = this.conversations.get(contact.id)?.find((m) => m.id === sealed.id);
        if (updated && updated.capsule!.at <= Date.now() + 5 * 60_000) this.openCapsule(contact.id, updated);
        return;
      }
      case 'inv':
        this.redeemInvite(contact, content.tok);
        return;
      case 'skd':
        this.receiveSenderKey(contact, content);
        return;
      case 'skreq':
        await this.resendSenderKey(contact, content.g);
        return;
      case 'gst':
        if (this.groupsOn()) await this.applyGroupState(contact.id, content.g);
        return;
      case 'gleave':
        if (this.groupsOn()) this.memberLeft(contact.id, content.g);
        return;
      case 'viewed': {
        if (typeof content.id !== 'string') return;
        const mine = this.conversations.get(contact.id)?.find((m) => m.id === content.id && m.dir === 'out' && m.once);
        if (!mine || mine.once?.opened) return;
        await this.deleteAttachments(mine);
        this.patchMessages(contact.id, new Set([mine.id]), (m) => ({ ...m, once: { opened: Date.now() } }));
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
      case 'call':
        this.handleCall(contact, content, true);
        return;
      case 'prof':
        if (typeof content.n === 'string' && content.n.trim()) this.updateContact(contact.id, { displayName: content.n.trim().slice(0, 64) });
        this.learnAccessKey(contact.id, content.ak);
        // The new @name is taken from the server, never from the message itself.
        if (content.u === 1) await this.refreshUsername(contact.id);
        return;
    }
  }

  private setTyping(contactId: string, on: boolean): void {
    if (!this.shares(contactId, 'typing')) return;
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
      if (!contact.blocked && this.sessions[contact.id]?.length) void this.sendControl(contact, { t: 'prof', ...this.myProfile(contact), n: name });
    }
  }

  updateSettings(patch: Partial<Settings>): void {
    const before = this.settings.lastSeen;
    this.settings = { ...this.settings, ...patch };
    if (patch.typingIndicators === false) this.typing = {};
    if (patch.lastSeen && patch.lastSeen !== before) {
      if (patch.lastSeen === 'nobody') for (const id of Object.keys(this.online)) if (!this.shares(id, 'online')) delete this.online[id];
      void this.announcePresence('on', true);
    }
    this.markDirty('settings');
    this.scheduleBackup();
    this.changed();
  }

  /** Another server: its key is pinned anew on the first connection. */
  setServerUrl(url: string): void {
    delete this.account.serverKey;
    delete this.account.serverId;
    this.serverKeyChanged = null;
    this.moveServer(url);
  }

  /** The same server under a new address (its key stays pinned and is checked again). */
  moveServer(url: string): void {
    this.account.serverUrl = url.trim();
    this.markDirty('account');
    this.changed();
    this.connect();
  }

  reconnect(): void {
    this.connect();
  }

  // ---- «Устройства» -------------------------------------------------------------------------

  /** Key for computer names on the relay: only this account can read them. */
  private deviceKey(): Uint8Array {
    return kdf(this.identity.sign.priv, new Uint8Array(32), 'veil-device-label-v1', 32);
  }

  /** This computer for the relay, only while «Мост» (features.bridge) is on. */
  private deviceHello(): DeviceHello | undefined {
    if (!thisDevice || this.settings?.features?.bridge === false) return undefined;
    const { nonce, ct } = aeadSeal(this.deviceKey(), utf8(thisDevice.name.slice(0, 120)), DEVICE_AD);
    return { id: thisDevice.id, label: b64(concat(nonce, ct)) };
  }

  async listDevices(): Promise<DeviceInfo[]> {
    if (this.decoy) return [{ id: thisDevice?.id ?? 'this', name: thisDevice?.name ?? 'Этот компьютер', first: this.account.createdAt, last: Date.now(), online: true, current: true }];
    if (!this.relay) throw new RelayRequestError('offline', 'Нет соединения с сервером');
    const { devices, current } = await this.relay.request<{ devices: DeviceRecord[]; current: string | null }>({ type: 'devices' });
    const key = this.deviceKey();
    return devices.map((d) => {
      let name = 'Компьютер';
      try {
        const raw = unb64(d.label ?? '');
        name = fromUtf8(aeadOpen(key, raw.subarray(0, 24), raw.subarray(24), DEVICE_AD));
      } catch {
        // label missing or from an older version
      }
      return { id: d.id, name, first: d.first, last: d.last, online: !!d.online || d.id === current, current: d.id === current };
    });
  }

  /** «Отвязать»: the relay stops accepting sign-ins from that computer. */
  async revokeDevice(id: string): Promise<void> {
    if (!this.relay) throw new RelayRequestError('offline', 'Нет соединения с сервером');
    const name = (await this.listDevices().catch(() => [])).find((d) => d.id === id)?.name;
    await this.relay.request({ type: 'device_revoke', id });
    this.logSecurity('device_revoked', name);
  }

  // ---- «Мост»: moving the account to another computer ------------------------------------

  private bridgePaused = false;

  /**
   * Stops talking to the relay (so no message is consumed here during the move), saves
   * everything and gives read access to every record of the vault.
   */
  async bridgeSource(): Promise<RecordSource> {
    this.bridgePaused = true;
    void this.announcePresence('off');
    this.relay?.close();
    this.relay = null;
    this.status = 'offline';
    this.changed();
    await this.flushNow();
    return { names: () => this.store.names(), get: (name) => this.store.getBytes(name) };
  }

  /** The move was cancelled: back online. */
  resumeAfterBridge(): void {
    if (!this.bridgePaused) return;
    this.bridgePaused = false;
    this.connect();
  }

  /** The new computer has everything: wipe this one. */
  async wipeAfterBridge(): Promise<void> {
    this.bridgePaused = false;
    await this.lock();
    await this.storage.clear();
  }

  /** Checks the vault password without changing anything (e.g. before turning on quick unlock). */
  async checkPassword(password: string): Promise<boolean> {
    if (!this.decoy) return verifyVaultPassword(this.meta, password);
    try {
      const opened = await openVaultSlot(this.meta, password);
      opened.dataKey.fill(0);
      return opened.slot === 'alt';
    } catch {
      return false;
    }
  }

  // ---- «Резервная копия .veil» ----------------------------------------------------------------

  /** The whole account (without ratchet sessions) as one file encrypted with `password`. */
  async exportBackupFile(password: string, kdf?: { N: number; r: number; p: number }): Promise<Uint8Array> {
    if (password.length < 8) throw new MessengerError('short', 'Пароль копии — не короче 8 символов');
    await this.flushNow();
    const records = new Map<string, Uint8Array>();
    for (const name of await this.store.names()) {
      if (BACKUP_SKIPPED.has(name)) continue;
      const bytes = await this.store.getBytes(name);
      if (bytes) records.set(name, bytes);
    }
    const file = await createBackupFile(records, password, kdf);
    this.updateSettings({ backupFileAt: Date.now() });
    this.logSecurity('backup_export');
    return file;
  }

  // ---- «Копия в OneDrive» ---------------------------------------------------------------------
  //
  // The same .veil file as above, written to Veil's own folder in the user's OneDrive once a day.
  // It is encrypted here with a key derived from a separate copy password before it leaves; the
  // password is not kept. Microsoft sees an encrypted file, its size and when it changes.

  /** Called when the vault opens. */
  async loadCloud(): Promise<void> {
    this.cloud = await this.store.getJSON<CloudRecord>('cloud');
  }

  private requireCloud(): CloudTransport {
    if (!cloudTransport) throw new MessengerError('no_cloud', 'Копия в OneDrive есть только в приложении для компьютера');
    if (this.decoy) throw new MessengerError('no_cloud', 'Сейчас недоступно');
    return cloudTransport;
  }

  /** Step 1: Microsoft's sign-in page in the browser. Resolves to the refresh token for step 2. */
  cloudSignIn(): Promise<string> {
    return this.requireCloud().signIn();
  }

  /**
   * Step 2: the copy password (not the Veil password, not kept), then the first upload. `file` keeps
   * the name of a copy this account was restored from.
   */
  async enableCloud(refresh: string, password: string, options: { file?: string; kdf?: { N: number; r: number; p: number } } = {}): Promise<void> {
    this.requireCloud();
    if (password.normalize('NFKC').length < CLOUD_PASSWORD_MIN)
      throw new MessengerError('short', `Пароль копии — не короче ${CLOUD_PASSWORD_MIN} символов`);
    const { key, kdf } = await backupKey(password, options.kdf);
    const file = options.file && /^veil-[a-z0-9]{6,40}\.veil$/.test(options.file) ? options.file : `veil-${randomName()}.veil`;
    this.cloud = { v: 1, refresh, file, key: b64(key), kdf };
    key.fill(0);
    this.markDirty('cloud');
    await this.flushNow();
    this.logSecurity('cloud_on');
    this.changed();
    await this.cloudUploadNow();
  }

  /** Writes the copy now. Failures are kept for the settings («Не получилось: …») and thrown. */
  async cloudUploadNow(): Promise<void> {
    const cloud = this.cloud;
    if (!cloud || this.cloudBusy || this.closed || this.decoy) return;
    const transport = this.requireCloud();
    this.cloudBusy = true;
    this.cloudTriedAt = Date.now();
    this.changed();
    try {
      await this.flushNow();
      const records = new Map<string, Uint8Array>();
      for (const name of await this.store.names()) {
        if (BACKUP_SKIPPED.has(name)) continue;
        const bytes = await this.store.getBytes(name);
        if (bytes) records.set(name, bytes);
      }
      const key = unb64(cloud.key);
      const data = await sealBackupFile(records, key, cloud.kdf);
      key.fill(0);
      const { refresh } = await transport.upload(cloud.refresh, cloud.file, data);
      if (this.cloud !== cloud) return;
      this.cloud = { ...cloud, refresh, lastAt: Date.now(), size: data.length, error: undefined };
    } catch (error) {
      if (this.cloud === cloud) this.cloud = { ...cloud, error: (error as Error).message || 'Не получилось' };
      throw error;
    } finally {
      this.cloudBusy = false;
      if (!this.closed) {
        this.markDirty('cloud');
        this.changed();
      }
    }
  }

  /** Stops the daily copy; with `removeCopy` the file in OneDrive is deleted too. */
  async disableCloud(removeCopy: boolean): Promise<void> {
    const cloud = this.cloud;
    if (!cloud) return;
    const transport = this.requireCloud();
    if (removeCopy) await transport.remove(cloud.refresh, cloud.file);
    void transport.forget(cloud.refresh);
    this.cloud = null;
    this.markDirty('cloud');
    await this.flushNow();
    this.logSecurity('cloud_off');
    this.changed();
  }

  // ---- «Журнал безопасности» -------------------------------------------------------------------

  /** Adds an event to the local, encrypted security log (features.securityLog). */
  logSecurity(kind: SecurityEventKind, detail?: string): void {
    if (this.settings?.features?.securityLog === false || this.closed || this.decoy) return;
    this.seclog = [{ id: randomId(), ts: Date.now(), kind, ...(detail ? { detail: detail.slice(0, 120) } : {}) }, ...this.seclog].slice(0, 500);
    this.markDirty('seclog');
    this.changed();
  }

  /** After unlocking: how, and how many wrong passwords came before (counted outside the vault). */
  recordLogin(method: 'password' | 'pin' | 'fingerprint', failedBefore = 0): void {
    if (failedBefore > 0) this.logSecurity('login_failed', String(failedBefore));
    this.logSecurity('login', method);
  }

  /** New computers on the account since the last look (from the relay's device list). */
  private async checkNewDevices(): Promise<void> {
    if (this.settings.features.securityLog === false || this.settings.features.bridge === false) return;
    try {
      const devices = await this.listDevices();
      const known = new Set(this.account.knownDevices ?? []);
      const fresh = devices.filter((d) => !known.has(d.id));
      if (!fresh.length) return;
      // The very first look only learns the list.
      if (this.account.knownDevices) for (const d of fresh) if (!d.current) this.logSecurity('device_new', d.name);
      this.account.knownDevices = devices.map((d) => d.id).slice(0, 20);
      this.markDirty('account');
    } catch {
      // offline or an old relay
    }
  }

  // ---- hidden chats ---------------------------------------------------------------------------

  private async secretHash(value: string, salt: string): Promise<string> {
    const { scryptAsync } = await import('@noble/hashes/scrypt.js');
    return b64(await scryptAsync(utf8(value.normalize('NFKC')), unb64(salt), { N: 2 ** 14, r: 8, p: 1, dkLen: 32 }));
  }

  /** Sets (or changes) the secret phrase and the PIN for hidden chats. */
  async setupHiddenChats(phrase: string, pin: string): Promise<void> {
    if (phrase.trim().length < 4) throw new MessengerError('short', 'Секретная фраза — не короче 4 символов');
    if (!/^\d{4,8}$/.test(pin)) throw new MessengerError('pin', 'PIN — от 4 до 8 цифр');
    const salt = b64(random(16));
    this.account.hiddenChats = { salt, phrase: await this.secretHash(phrase.trim().toLowerCase(), salt), pin: await this.secretHash(pin, salt) };
    this.markDirty('account');
    await this.flushNow();
    this.changed();
  }

  /** Typed into the search: is it the secret phrase? (Nothing else about hidden chats leaks.) */
  async isHiddenPhrase(text: string): Promise<boolean> {
    const config = this.account.hiddenChats;
    if (!config || text.trim().length < 4) return false;
    return (await this.secretHash(text.trim().toLowerCase(), config.salt)) === config.phrase;
  }

  async checkHiddenPin(pin: string): Promise<boolean> {
    const config = this.account.hiddenChats;
    return !!config && (await this.secretHash(pin, config.salt)) === config.pin;
  }

  setHidden(contactId: string, hidden: boolean): void {
    if (isSavedChat(contactId) || (hidden && !this.account.hiddenChats)) return;
    this.updateContact(contactId, { hidden: hidden || undefined, pinned: hidden ? false : this.contacts[contactId]?.pinned });
  }

  /** Turning hidden chats off brings every hidden chat back into the list. */
  async disableHiddenChats(): Promise<void> {
    for (const contact of Object.values(this.contacts)) if (contact.hidden) this.updateContact(contact.id, { hidden: undefined });
    delete this.account.hiddenChats;
    this.markDirty('account');
    await this.flushNow();
    this.changed();
  }

  // ---- duress password ----------------------------------------------------------------------

  /**
   * Sets the duress password: it opens an empty Veil with this name and fresh keys that never
   * connects to the relay. With `wipe`, typing it also erases this real vault for good.
   */
  async enableDuress(password: string, options: { wipe: boolean }): Promise<void> {
    if (this.decoy) throw new MessengerError('decoy', 'Недоступно');
    if (password.length < 8) throw new MessengerError('short', 'Аварийный пароль — не короче 8 символов');
    if (await verifyVaultPassword(this.meta, password)) throw new MessengerError('same', 'Аварийный пароль должен отличаться от настоящего');
    const key = random(32);
    const store = new SecureStore(this.storage, key, DECOY_PREFIX);
    await store.destroy();
    const identity = generateIdentity();
    const spk = generateDH();
    const now = Date.now();
    const account: AccountRecord = {
      userId: b64(identity.sign.pub),
      username: this.account.username,
      displayName: this.account.displayName,
      sign: keyPairToJSON(identity.sign),
      dh: keyPairToJSON(identity.dh),
      dhSig: b64(identity.dhSig),
      spks: [{ id: 1, pub: b64(spk.pub), priv: b64(spk.priv), sig: b64(signPreKey(identity.sign.priv, 1, spk.pub)), createdAt: now }],
      opks: {},
      nextOpkId: 1,
      nextSpkId: 2,
      serverUrl: this.account.serverUrl,
      createdAt: this.account.createdAt,
    };
    await store.putJSON('account', account);
    await store.putJSON('settings', normalizeSettings({ theme: this.settings.theme }));
    await store.putJSON('contacts', {});
    await store.putJSON('duress', { wipe: options.wipe });
    this.meta = await setDuressSlot(this.meta, password, key);
    key.fill(0);
    await writeVaultMeta(this.storage, this.meta);
    this.account.duress = { wipe: options.wipe, at: now };
    this.logSecurity('duress_on', options.wipe ? 'со стиранием' : undefined);
    this.markDirty('account');
    await this.flushNow();
    this.changed();
  }

  async disableDuress(): Promise<void> {
    if (this.decoy) return;
    await new SecureStore(this.storage, new Uint8Array(32), DECOY_PREFIX).destroy();
    this.meta = clearDuressSlot(this.meta);
    await writeVaultMeta(this.storage, this.meta);
    delete this.account.duress;
    this.logSecurity('duress_off');
    this.markDirty('account');
    await this.flushNow();
    this.changed();
  }

  /** A copy of the vault key, to be kept in the system keychain for quick unlock. */
  quickUnlockKey(): Uint8Array {
    return this.store.exportKey();
  }

  async changePassword(oldPassword: string, newPassword: string): Promise<void> {
    if (this.decoy) {
      // The empty Veil changes "its" password: the duress slot, not the real one.
      const opened = await openVaultSlot(this.meta, oldPassword);
      opened.dataKey.fill(0);
      if (opened.slot !== 'alt') throw new WrongPasswordError();
      const key = this.store.exportKey();
      this.meta = await setDuressSlot(this.meta, newPassword, key);
      key.fill(0);
      await writeVaultMeta(this.storage, this.meta);
      return;
    }
    const meta = await changeVaultPassword(this.meta, oldPassword, newPassword);
    await writeVaultMeta(this.storage, meta);
    this.meta = meta;
    this.logSecurity('password_change');
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
    if (this.decoy) return { email: false, totp: false, backup: null, mail: true };
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
    this.logSecurity('totp_on');
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
    this.logSecurity('totp_off');
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
    this.logSecurity('email_on', pending.email);
    this.markDirty('account');
    await this.flushNow();
    await this.backupNow();
  }

  async removeRecoveryEmail(totp?: string): Promise<void> {
    if (!this.relay) throw new RelayRequestError('offline', 'Нет соединения с сервером');
    await this.relay.request({ type: 'email_remove', ...(totp ? { totp } : {}) });
    delete this.account.recovery;
    this.logSecurity('email_off');
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
        conversations[id] = messages.filter((m) => !m.expiresAt && !m.once).slice(-BACKUP_MESSAGES_PER_CHAT);
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
    if (this.decoy) throw new MessengerError('offline', 'Сервер не отвечает. Попробуйте позже');
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

  /**
   * «Выйти из аккаунта» on this device: the account stays on the server and on the other devices,
   * this one leaves «Устройства» and forgets everything. With recovery by email the server copy is
   * refreshed first, so signing in again brings the chats back.
   */
  async signOut(): Promise<void> {
    if (this.decoy) throw new MessengerError('offline', 'Сервер не отвечает. Попробуйте позже');
    if (this.relay?.status === 'online') {
      if (this.account.recovery) await this.backupNow().catch(() => {});
      if (this.cloud) await this.cloudUploadNow().catch(() => {});
      try {
        await this.relay.request({ type: 'device_signout' });
      } catch {
        // an older server: the device stays in the list until it is unlinked from another one
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
