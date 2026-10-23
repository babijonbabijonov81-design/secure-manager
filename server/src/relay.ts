// Veil relay: a small WebSocket server that forwards end-to-end encrypted envelopes.
//
// What the relay knows: usernames, public keys, and "some envelope of N bytes is queued
// for user X". What it never knows: message contents, attachments, display names,
// contact lists, or who sent an envelope (the sender is sealed inside the envelope).

import { createHash, createHmac, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { ed25519 } from '@noble/curves/ed25519.js';
import { WebSocketServer, type WebSocket } from 'ws';
import {
  ACCESS_KEY_BYTES,
  authStatement,
  dhKeyStatement,
  EMAIL_RE,
  MAX_BACKUP_BYTES,
  MAX_ENVELOPE_BYTES,
  MAX_FRAME_BYTES,
  MAX_OPKS_PER_UPLOAD,
  BRIDGE_ROOM_RE,
  DEVICE_ID_RE,
  PROTOCOL_VERSION,
  registerExtra,
  SERVER_CHALLENGE_RE,
  serverProofStatement,
  signedPreKeyStatement,
  userBindingStatement,
  USERNAME_RE,
  type AccountStatus,
  type BackupMeta,
  type ClientFrame,
  type DeviceHello,
  type ErrorCode,
  type IceServer,
  type OneTimePreKeyPublic,
  type RegisterFrame,
  type SealedSendFrame,
  type ServerFrame,
  type SignedPreKeyPublic,
  type UserInfo,
} from './shared/protocol.ts';
import { verifyTotp } from './shared/totp.ts';
import { b64, pack, unb64Len, unpack } from './shared/wire.ts';
import { codeEmail, type Mailer } from './mailer.ts';
import { RelayStore, type StoreLimits, type UserRecord } from './store.ts';

export interface RelayOptions {
  port?: number;
  host?: string;
  /** Directory for persistent data; null keeps everything in memory. */
  dataDir?: string | null;
  name?: string;
  limits?: Partial<StoreLimits>;
  log?: (message: string) => void;
  /** Sends verification and recovery codes; without it email features are unavailable. */
  mailer?: Mailer | null;
  /** STUN/TURN servers handed to clients for calls. */
  ice?: IceOptions;
  /** Tests: every WebSocket frame exactly as the relay sees it, in both directions. */
  tap?: (direction: 'in' | 'out', bytes: Uint8Array) => void;
  /** New accounts per IP address and hour (default 20). */
  registrationsPerHour?: number;
  /**
   * Proxies in front of the relay (Render, nginx) that add X-Forwarded-For: the client's address
   * is taken from that many hops from the right. 0 (default): the header is ignored, since anyone
   * could send it and get around the limits per IP.
   */
  trustProxy?: number;
  /** SERVER_SECRET: the server's secret (and so its key and id) for servers without a data folder. */
  secret?: Uint8Array;
}

/**
 * The client's IP. Each trusted proxy appends the address it saw to X-Forwarded-For, so the real
 * one is `hops` entries from the right; what the client wrote itself further left is ignored.
 */
export function clientAddress(header: string | string[] | undefined, socket: string | undefined, hops: number): string {
  const direct = socket || 'unknown';
  if (!hops || !header) return direct;
  const list = (Array.isArray(header) ? header.join(',') : header)
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);
  return list[list.length - hops] ?? direct;
}

export interface IceOptions {
  stun?: string[];
  turn?: string[];
  /** coturn `static-auth-secret`: clients get time-limited credentials (TURN REST API). */
  secret?: string;
  /** Fixed TURN credentials, if no secret is used. */
  username?: string;
  credential?: string;
}

const TURN_CREDENTIAL_TTL_S = 24 * 60 * 60;

/** ICE servers for one client. With a shared secret, credentials expire after a day. */
export function iceServersFor(options: IceOptions | undefined, userId: string, now = Date.now()): IceServer[] | undefined {
  if (!options) return undefined;
  const servers: IceServer[] = [];
  if (options.stun?.length) servers.push({ urls: options.stun });
  if (options.turn?.length) {
    if (options.secret) {
      const username = `${Math.floor(now / 1000) + TURN_CREDENTIAL_TTL_S}:${userId.slice(0, 16)}`;
      const credential = createHmac('sha1', options.secret).update(username).digest('base64');
      servers.push({ urls: options.turn, username, credential });
    } else if (options.username && options.credential) {
      servers.push({ urls: options.turn, username: options.username, credential: options.credential });
    }
  }
  return servers.length ? servers : undefined;
}

export interface RelayHandle {
  port: number;
  server: Server;
  store: RelayStore;
  close(): Promise<void>;
}

const LOW_PREKEYS = 20;
const LOOKUP_WINDOW_MS = 60_000;
const LOOKUPS_PER_WINDOW = 120;
const SENDS_PER_WINDOW = 1200;
const REGISTRATIONS_PER_HOUR = 20;
const RENAMES_PER_DAY = 3;
const OPK_REPEAT_MS = 10 * 60_000;
const CODE_TTL_MS = 15 * 60 * 1000;
const CODE_ATTEMPTS = 5;
const EMAILS_PER_HOUR = 5;
const TOKEN_TTL_MS = 30 * 60 * 1000;

interface PendingCode {
  code: string;
  expires: number;
  attempts: number;
  emailHash: string;
}

const sameCode = (a: string, b: string) => {
  const x = Buffer.from(String(a).replace(/\s/g, ''));
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

function validBackupMeta(meta: unknown): meta is BackupMeta {
  const m = meta as BackupMeta;
  return (
    !!m &&
    m.v === 1 &&
    !!m.kdf &&
    [m.kdf.N, m.kdf.r, m.kdf.p].every((n) => Number.isInteger(n) && n > 0 && n <= 2 ** 22) &&
    !!unb64Len(m.kdf.salt, 16) &&
    !!unb64Len(m.nonce, 24) &&
    Number.isFinite(m.updatedAt)
  );
}

interface Connection {
  ws: WebSocket;
  ip: string;
  nonce: string;
  userId: string | null;
  /** The computer this account signed in from (Settings → «Устройства»). */
  deviceId?: string;
  /** An anonymous connection taking part in a bridge room (account transfer). */
  bridge?: BridgeRoom;
  alive: boolean;
  sends: Bucket;
}

interface BridgeRoom {
  room: string;
  host: Connection;
  guest?: Connection;
  bytes: number;
  timer: ReturnType<typeof setTimeout>;
}

const MAX_DEVICES = 10;
const MAX_REVOKED = 50;
const BRIDGE_TTL_MS = 30 * 60 * 1000;
const BRIDGE_MAX_BYTES = 2 * 1024 * 1024 * 1024;
const BRIDGE_JOINS_PER_WINDOW = 30;

class Bucket {
  private count = 0;
  private windowStart = Date.now();
  private readonly limit: number;
  private readonly windowMs: number;
  constructor(limit: number, windowMs: number) {
    this.limit = limit;
    this.windowMs = windowMs;
  }
  take(): boolean {
    const now = Date.now();
    if (now - this.windowStart > this.windowMs) {
      this.windowStart = now;
      this.count = 0;
    }
    return ++this.count <= this.limit;
  }
}

class RelayError extends Error {
  readonly code: ErrorCode;
  constructor(code: ErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

const fail = (code: ErrorCode, message: string): never => {
  throw new RelayError(code, message);
};

const verifySig = (sig: unknown, message: Uint8Array, publicKey: Uint8Array): boolean => {
  const sigBytes = unb64Len(sig, 64);
  if (!sigBytes) return false;
  try {
    return ed25519.verify(sigBytes, message, publicKey);
  } catch {
    return false;
  }
};

function validSignedPreKey(signKey: Uint8Array, spk: SignedPreKeyPublic | undefined): spk is SignedPreKeyPublic {
  if (!spk || !Number.isInteger(spk.id) || spk.id < 0 || spk.id > 0xffffffff) return false;
  const pub = unb64Len(spk.pub, 32);
  return !!pub && verifySig(spk.sig, signedPreKeyStatement(spk.id, pub), signKey);
}

function validOneTimePreKeys(opks: unknown): opks is OneTimePreKeyPublic[] {
  return (
    Array.isArray(opks) &&
    opks.length <= MAX_OPKS_PER_UPLOAD &&
    opks.every((k) => k && Number.isInteger(k.id) && k.id >= 0 && k.id <= 0xffffffff && !!unb64Len(k.pub, 32))
  );
}


const statusPage = (name: string) => `<!doctype html>
<html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${name}</title>
<style>
  body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0c0a09;color:#f4efe9;font:16px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}
  .card{max-width:520px;padding:40px;border-radius:24px;background:#151210;border:1px solid #2e2723}
  .mark{width:56px;height:56px;margin-bottom:16px}
  h1{margin:0 0 8px;font-size:26px;color:#f4efe9}
  .ok{display:inline-flex;gap:8px;align-items:center;color:#3ddc97;font-weight:600}
  .dot{width:10px;height:10px;border-radius:50%;background:#3ddc97}
  p{color:#c9c0b6} code{background:#1d1916;padding:2px 8px;border-radius:6px}
</style></head><body><div class="card">
<svg class="mark" viewBox="0 0 48 48" aria-hidden="true"><rect width="48" height="48" rx="10.56" fill="#1a1411"/><g transform="translate(7.2 7.2) scale(0.7)"><path d="M7 9 Q19 10 24 39 Q11 29 7 9 Z" fill="#ff7a45"/><path d="M41 9 Q29 10 24 39 Q37 29 41 9 Z" fill="#3ddc97" opacity="0.92"/><circle cx="24" cy="14" r="4.2" fill="#f4efe9"/></g></svg>
<h1>${name}</h1><div class="ok"><span class="dot"></span>Сервер работает</div>
<p>Это ретранслятор мессенджера Veil. Он пересылает только зашифрованные сообщения и не может их прочитать.</p>
<p>Укажите адрес этой страницы в приложении Veil в поле «Сервер».</p>
</div></body></html>`;

export async function startRelay(options: RelayOptions = {}): Promise<RelayHandle> {
  const name = options.name ?? 'Veil Relay';
  const log = options.log ?? (() => {});
  const store = new RelayStore(options.dataDir ?? null, options.limits, options.secret);
  await store.load();
  // The server vouches for «@name has this key» with its own key: a fake server on the same Wi-Fi
  // cannot hand out somebody else's keys under a pinned server key.
  const publicInfo = (user: UserRecord): UserInfo => {
    const info = { userId: user.userId, username: user.username, dhKey: user.dhKey, dhSig: user.dhSig };
    return { ...info, ssig: b64(ed25519.sign(userBindingStatement(info), store.serverSecretKey)) };
  };
  // Lookups count per account and per IP, not per connection (reconnecting does not reset them).
  const lookupBuckets = new Map<string, Bucket>();
  const lookupAllowed = (conn: Connection): boolean => {
    for (const key of [`u:${conn.userId}`, `ip:${conn.ip}`]) {
      let bucket = lookupBuckets.get(key);
      if (!bucket) lookupBuckets.set(key, (bucket = new Bucket(LOOKUPS_PER_WINDOW, LOOKUP_WINDOW_MS)));
      if (!bucket.take()) return false;
    }
    return true;
  };
  // One-time prekeys: one per asker and contact every 10 minutes, so nobody drains them by asking.
  const opkGiven = new Map<string, number>();

  const online = new Map<string, Set<Connection>>();
  const connections = new Map<WebSocket, Connection>();
  const registrations = new Map<string, Bucket>();
  // Client-side ids of recently accepted envelopes, so a retried send is not queued twice.
  const recentSends = new Map<string, Map<string, { id: string; ts: number }>>();
  const mailer = options.mailer ?? null;
  const emailPending = new Map<string, PendingCode>(); // by userId
  const recoverPending = new Map<string, PendingCode>(); // by username
  const recoveryTokens = new Map<string, { username: string; expires: number }>();
  const mailBuckets = new Map<string, Bucket>();

  const bridgeRooms = new Map<string, BridgeRoom>();
  const bridgeBuckets = new Map<string, Bucket>();

  /** Records the computer a sign-in comes from; refuses computers the owner unlinked. */
  const checkDevice = (conn: Connection, user: UserRecord, device: DeviceHello | undefined) => {
    if (!device || typeof device.id !== 'string' || !DEVICE_ID_RE.test(device.id)) return;
    if (user.revoked?.includes(device.id)) fail('device_revoked', 'Этот компьютер отвязан от аккаунта');
    const label = typeof device.label === 'string' && device.label.length <= 512 ? device.label : undefined;
    const now = Date.now();
    const list = (user.devices ?? []).filter((d) => d.id !== device.id);
    const previous = user.devices?.find((d) => d.id === device.id);
    user.devices = [{ id: device.id, ...(label ? { label } : {}), first: previous?.first ?? now, last: now }, ...list].slice(0, MAX_DEVICES);
    conn.deviceId = device.id;
    store.touch();
  };

  const closeBridge = (room: BridgeRoom, reason: Connection | null) => {
    if (bridgeRooms.get(room.room) !== room) return;
    bridgeRooms.delete(room.room);
    clearTimeout(room.timer);
    for (const side of [room.host, room.guest]) {
      if (!side) continue;
      side.bridge = undefined;
      if (side !== reason) send(side, { type: 'bridge_closed' });
    }
  };

  /** Anonymous: two computers meet in a room and the relay pipes encrypted frames between them. */
  const handleBridge = (conn: Connection, frame: Extract<ClientFrame, { type: 'bridge_open' | 'bridge_join' | 'bridge_data' }>, body: Uint8Array) => {
    if (frame.type === 'bridge_data') {
      const room = conn.bridge;
      const peer = room && (room.host === conn ? room.guest : room.host);
      if (!room || !peer) fail('not_found', 'Второй компьютер не подключён');
      room!.bytes += body.length;
      if (room!.bytes > BRIDGE_MAX_BYTES) {
        closeBridge(room!, null);
        fail('too_large', 'Слишком большой перенос через сервер');
      }
      send(peer!, { type: 'bridge_data' }, body);
      return;
    }
    const bucket = bridgeBuckets.get(conn.ip) ?? new Bucket(BRIDGE_JOINS_PER_WINDOW, 10 * 60 * 1000);
    bridgeBuckets.set(conn.ip, bucket);
    if (!bucket.take()) fail('rate_limited', 'Слишком много попыток, подождите');
    const name = String(frame.room ?? '').toUpperCase();
    if (!BRIDGE_ROOM_RE.test(name) || conn.bridge) fail('bad_request', 'Неверная комната');
    if (frame.type === 'bridge_open') {
      if (bridgeRooms.has(name)) fail('bad_request', 'Комната занята');
      const room: BridgeRoom = { room: name, host: conn, bytes: 0, timer: setTimeout(() => closeBridge(room, null), BRIDGE_TTL_MS) };
      bridgeRooms.set(name, room);
      conn.bridge = room;
      send(conn, { type: 'result', reqId: frame.reqId, data: { room: name } });
      return;
    }
    const room = bridgeRooms.get(name);
    if (!room || room.guest) fail('not_found', 'Компьютер с таким кодом не найден');
    room!.guest = conn;
    conn.bridge = room;
    send(conn, { type: 'result', reqId: frame.reqId, data: { room: name } });
    send(room!.host, { type: 'bridge_peer' });
    send(conn, { type: 'bridge_peer' });
  };

  const emailHash = (email: string) => createHmac('sha256', store.pepper).update(email.trim().toLowerCase()).digest('base64url');
  const newCode = () => String(randomInt(0, 1_000_000)).padStart(6, '0');
  const takeMailBudget = (key: string) => {
    const bucket = mailBuckets.get(key) ?? new Bucket(EMAILS_PER_HOUR, 3_600_000);
    mailBuckets.set(key, bucket);
    if (!bucket.take()) fail('rate_limited', 'Слишком много писем, попробуйте через час');
  };
  const sendCode = async (to: string, code: string, purpose: 'confirm' | 'recover') => {
    if (!mailer) fail('mail_unavailable', 'Сервер не настроен для отправки писем');
    try {
      await mailer!({ to, ...codeEmail(code, purpose) });
    } catch (error) {
      log(`mail error: ${(error as Error).message}`);
      fail('mail_unavailable', 'Не удалось отправить письмо. Проверьте настройки почты на сервере');
    }
  };
  /** Checks a 2FA code and burns its time step so it cannot be reused. */
  const totpOk = (user: UserRecord, code: unknown): boolean => {
    if (!user.totp) return true;
    const step = verifyTotp(user.totp, String(code ?? ''));
    if (step === null || step <= (user.totpLast ?? -1)) return false;
    user.totpLast = step;
    store.touch();
    return true;
  };
  const checkCode = (pending: PendingCode | undefined, code: unknown): PendingCode => {
    if (!pending || pending.expires < Date.now() || pending.attempts >= CODE_ATTEMPTS)
      fail('bad_code', 'Код устарел — запросите новый');
    pending!.attempts++;
    if (!sameCode(String(code ?? ''), pending!.code)) fail('bad_code', 'Неверный код из письма');
    return pending!;
  };
  const accountStatus = (user: UserRecord): AccountStatus => ({
    email: !!user.emailHash,
    totp: !!user.totp,
    backup: user.backup ? { size: user.backup.size, updatedAt: user.backup.updatedAt } : null,
    mail: !!mailer,
  });

  const http = createServer((req: IncomingMessage, res: ServerResponse) => {
    const path = (req.url ?? '/').split('?')[0];
    if (req.method === 'GET' && path === '/health') {
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify({ ok: true, name, version: PROTOCOL_VERSION }));
    } else if (req.method === 'GET' && (path === '/' || path === '/index.html')) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(statusPage(name));
    } else {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('not found');
    }
  });

  const wss = new WebSocketServer({ server: http, path: '/ws', maxPayload: MAX_FRAME_BYTES });

  const send = (conn: Connection, frame: ServerFrame, body?: Uint8Array) => {
    if (conn.ws.readyState !== conn.ws.OPEN) return;
    const bytes = pack(frame, body);
    options.tap?.('out', bytes);
    conn.ws.send(bytes);
  };

  const sendError = (conn: Connection, code: ErrorCode, message: string, reqId?: string) =>
    send(conn, { type: 'error', code, message, ...(reqId ? { reqId } : {}) });

  const deliverQueued = async (conn: Connection) => {
    if (!conn.userId) return;
    for (const item of [...store.queueOf(conn.userId)]) {
      const data = await store.read(item);
      if (data) send(conn, { type: 'msg', id: item.id, ts: item.ts }, data);
      else await store.remove(conn.userId, [item.id]);
    }
  };

  const goOnline = async (conn: Connection, user: UserRecord) => {
    conn.userId = user.userId;
    // One active connection per account: a newer login replaces older ones.
    const existing = online.get(user.userId);
    if (existing) for (const old of existing) old.ws.close(4001, 'replaced');
    online.set(user.userId, new Set([conn]));
    send(conn, {
      type: 'ready',
      userId: user.userId,
      username: user.username,
      opkCount: user.opks.length,
      spkId: user.spk?.id ?? null,
      queued: store.queueOf(user.userId).length,
      ice: iceServersFor(options.ice, user.userId),
    });
    await deliverQueued(conn);
  };

  const handleRegister = async (conn: Connection, frame: RegisterFrame) => {
    const bucket = registrations.get(conn.ip) ?? new Bucket(options.registrationsPerHour ?? REGISTRATIONS_PER_HOUR, 3_600_000);
    registrations.set(conn.ip, bucket);
    if (!bucket.take()) fail('rate_limited', 'Слишком много регистраций, попробуйте позже');

    const username = typeof frame.username === 'string' ? frame.username.toLowerCase() : '';
    if (!USERNAME_RE.test(username)) fail('bad_request', 'Недопустимое имя пользователя');
    const signKey = unb64Len(frame.userId, 32);
    const dhKey = unb64Len(frame.dhKey, 32);
    if (!signKey || !dhKey) fail('bad_request', 'Неверный формат ключей');
    if (!verifySig(frame.sig, authStatement(conn.nonce, 'register', registerExtra({ ...frame, username })), signKey!))
      fail('unauthorized', 'Неверная подпись');
    if (!verifySig(frame.dhSig, dhKeyStatement(dhKey!), signKey!)) fail('bad_request', 'Неверная подпись ключа');
    if (!validSignedPreKey(signKey!, frame.spk)) fail('bad_request', 'Неверный подписанный предключ');
    if (!validOneTimePreKeys(frame.opks)) fail('bad_request', 'Неверные одноразовые предключи');

    let taken = store.byUsername(username);
    let inherited: Pick<UserRecord, 'emailHash' | 'totp' | 'totpLast'> = {};
    if (taken && taken.userId !== frame.userId && frame.recoveryToken) {
      // Account reset after email (+2FA) recovery: new keys take over the username.
      const token = recoveryTokens.get(frame.recoveryToken);
      if (!token || token.username !== username || token.expires < Date.now()) fail('bad_code', 'Срок восстановления истёк');
      recoveryTokens.delete(frame.recoveryToken);
      inherited = { emailHash: taken.emailHash, totp: taken.totp, totpLast: taken.totpLast };
      for (const old of online.get(taken.userId) ?? []) old.ws.close(4002, 'deleted');
      await store.removeUser(taken.userId);
      log(`account reset @${username}`);
      taken = undefined;
    }
    if (taken && taken.userId !== frame.userId) fail('username_taken', 'Это имя пользователя уже занято');
    const previous = store.users.get(frame.userId);
    if (previous && previous.username !== username) store.usernames.delete(previous.username);

    const user: UserRecord = {
      userId: frame.userId,
      username,
      dhKey: frame.dhKey,
      dhSig: frame.dhSig,
      spk: { id: frame.spk.id, pub: frame.spk.pub, sig: frame.spk.sig },
      opks: frame.opks.map((k) => ({ id: k.id, pub: k.pub })).slice(0, store.limits.maxOpks),
      createdAt: previous?.createdAt ?? Date.now(),
      ...inherited,
      ...(previous?.emailHash ? { emailHash: previous.emailHash } : {}),
      ...(previous?.totp ? { totp: previous.totp, totpLast: previous.totpLast } : {}),
      ...(previous?.backup ? { backup: previous.backup } : {}),
      ...(previous?.userId === frame.userId && previous.devices ? { devices: previous.devices } : {}),
      ...(previous?.userId === frame.userId && previous.revoked ? { revoked: previous.revoked } : {}),
    };
    checkDevice(conn, user, frame.device);
    store.addUser(user);
    log(`registered @${username}`);
    await goOnline(conn, user);
  };

  const handleAuth = async (conn: Connection, frame: { userId: string; sig: string; device?: DeviceHello }) => {
    const signKey = unb64Len(frame.userId, 32);
    if (!signKey) fail('bad_request', 'Неверный идентификатор');
    const user = store.users.get(frame.userId);
    if (!user) fail('unknown_user', 'Аккаунт не найден на сервере');
    if (!verifySig(frame.sig, authStatement(conn.nonce, 'auth'), signKey!)) fail('unauthorized', 'Неверная подпись');
    checkDevice(conn, user!, frame.device);
    await goOnline(conn, user!);
  };

  /** Queues an envelope (unless this client id was seen) and pushes it to the recipient's devices. */
  const deliver = async (to: string, body: Uint8Array, cid: string, seen: Map<string, { id: string; ts: number }>) => {
    const duplicate = cid ? seen.get(cid) : undefined;
    if (duplicate) return duplicate;
    const id = randomBytes(12).toString('hex');
    const item = await store.enqueue(to, id, body.slice());
    if (!item) fail('quota', 'Очередь получателя переполнена');
    if (cid) {
      seen.set(cid, { id, ts: item!.ts });
      if (seen.size > 1000) seen.delete(seen.keys().next().value!);
    }
    for (const target of online.get(to) ?? []) send(target, { type: 'msg', id, ts: item!.ts }, body);
    return { id, ts: item!.ts };
  };

  // Sealed sends: per IP (the sender is unknown) and per recipient.
  const sealedBuckets = new Map<string, Bucket>();
  const sealedAllowed = (key: string, limit: number) => {
    let bucket = sealedBuckets.get(key);
    if (!bucket) sealedBuckets.set(key, (bucket = new Bucket(limit, LOOKUP_WINDOW_MS)));
    return bucket.take();
  };
  const sealedSeen = new Map<string, Map<string, { id: string; ts: number }>>();

  /** An envelope from someone who is not logged in on this connection: the server never learns who. */
  const handleSealedSend = async (conn: Connection, frame: SealedSendFrame, body: Uint8Array) => {
    if (!sealedAllowed(`ip:${conn.ip}`, SENDS_PER_WINDOW) || !sealedAllowed(`to:${frame.to}`, SENDS_PER_WINDOW))
      fail('rate_limited', 'Слишком много сообщений');
    if (body.length === 0) fail('bad_request', 'Пустое сообщение');
    if (body.length > MAX_ENVELOPE_BYTES) fail('too_large', 'Сообщение слишком большое');
    const user = store.users.get(String(frame.to));
    const key = unb64Len(frame.ak, ACCESS_KEY_BYTES);
    const expected = user?.accessHash ? unb64Len(user.accessHash, 32) : null;
    // One answer for «no such user» and «wrong key»: the server does not confirm who exists.
    if (!user || !key || !expected || !timingSafeEqual(createHash('sha256').update(key).digest(), expected)) fail('unauthorized', 'Нет доступа');
    if (frame.ephemeral) {
      const id = randomBytes(12).toString('hex');
      const recipients = online.get(frame.to);
      for (const target of recipients ?? []) send(target, { type: 'msg', id, ts: Date.now() }, body);
      send(conn, { type: 'result', reqId: frame.reqId, data: { id, delivered: !!recipients?.size } });
      return;
    }
    const seen = sealedSeen.get(frame.to) ?? new Map<string, { id: string; ts: number }>();
    sealedSeen.set(frame.to, seen);
    const cid = typeof frame.cid === 'string' ? frame.cid.slice(0, 64) : '';
    send(conn, { type: 'result', reqId: frame.reqId, data: await deliver(frame.to, body, cid, seen) });
  };

  const handleRecovery = async (conn: Connection, frame: Extract<ClientFrame, { type: 'recover_start' | 'recover_finish' }>) => {
    const username = String(frame.username ?? '').toLowerCase().replace(/^@/, '');
    if (frame.type === 'recover_start') {
      const email = String(frame.email ?? '').trim();
      if (!USERNAME_RE.test(username) || !EMAIL_RE.test(email)) fail('bad_request', 'Проверьте имя пользователя и почту');
      if (!mailer) fail('mail_unavailable', 'Сервер не настроен для отправки писем');
      takeMailBudget(`ip:${conn.ip}`);
      const user = store.byUsername(username);
      // Same answer whether or not the pair matches, so accounts cannot be probed.
      if (user?.emailHash && user.emailHash === emailHash(email)) {
        takeMailBudget(`user:${user.userId}`);
        const code = newCode();
        recoverPending.set(username, { code, expires: Date.now() + CODE_TTL_MS, attempts: 0, emailHash: user.emailHash });
        await sendCode(email, code, 'recover');
        log(`recovery code sent for @${username}`);
      }
      send(conn, { type: 'result', reqId: frame.reqId, data: { sent: true } });
      return;
    }
    const user = store.byUsername(username);
    const pending = recoverPending.get(username);
    checkCode(user && pending?.emailHash === user.emailHash ? pending : undefined, frame.code);
    if (user!.totp) {
      if (!frame.totp) fail('totp_required', 'Введите код из Google Authenticator');
      if (!totpOk(user!, frame.totp)) fail('bad_totp', 'Неверный код из Google Authenticator');
    }
    recoverPending.delete(username);
    const token = b64(randomBytes(24));
    recoveryTokens.set(token, { username, expires: Date.now() + TOKEN_TTL_MS });
    const backup = user!.backup ? await store.getBackup(user!.userId) : null;
    send(
      conn,
      {
        type: 'result',
        reqId: frame.reqId,
        data: { token, userId: user!.userId, backup: backup && user!.backup ? { ...user!.backup } : null },
      },
      backup ?? undefined,
    );
  };

  const handleRequest = async (conn: Connection, frame: ClientFrame, body: Uint8Array) => {
    const userId = conn.userId!;
    switch (frame.type) {
      case 'ack': {
        if (!Array.isArray(frame.ids)) fail('bad_request', 'ids required');
        await store.remove(userId, frame.ids.filter((id) => typeof id === 'string'));
        return;
      }
      case 'ping':
        send(conn, { type: 'pong' });
        return;
      case 'lookup': {
        if (!lookupAllowed(conn)) fail('rate_limited', 'Слишком много запросов');
        const user = store.byUsername(String(frame.username ?? '').toLowerCase().replace(/^@/, ''));
        if (!user) fail('not_found', 'Пользователь не найден');
        send(conn, { type: 'result', reqId: frame.reqId, data: publicInfo(user!) });
        return;
      }
      case 'resolve': {
        if (!lookupAllowed(conn)) fail('rate_limited', 'Слишком много запросов');
        const user = store.users.get(frame.userId);
        if (!user) fail('not_found', 'Пользователь не найден');
        send(conn, { type: 'result', reqId: frame.reqId, data: publicInfo(user!) });
        return;
      }
      case 'bundle': {
        if (!lookupAllowed(conn)) fail('rate_limited', 'Слишком много запросов');
        const user = store.users.get(frame.userId);
        if (!user) fail('not_found', 'Пользователь не найден');
        const askKey = `${userId}>${frame.userId}`;
        const recently = (opkGiven.get(askKey) ?? 0) > Date.now() - OPK_REPEAT_MS;
        const opk = recently ? undefined : store.takeOneTimePreKey(frame.userId);
        if (opk) opkGiven.set(askKey, Date.now());
        send(conn, { type: 'result', reqId: frame.reqId, data: { ...publicInfo(user!), spk: user!.spk, opk } });
        const remaining = user!.opks.length;
        if (remaining < LOW_PREKEYS) {
          for (const owner of online.get(frame.userId) ?? []) send(owner, { type: 'prekeys_low', count: remaining });
        }
        return;
      }
      case 'send': {
        if (!conn.sends.take()) fail('rate_limited', 'Слишком много сообщений');
        if (body.length === 0) fail('bad_request', 'Пустое сообщение');
        if (body.length > MAX_ENVELOPE_BYTES) fail('too_large', 'Сообщение слишком большое');
        if (!store.users.has(frame.to)) fail('not_found', 'Получатель не найден');
        const recipients = online.get(frame.to);
        if (frame.ephemeral) {
          // Ephemeral signals (typing indicators) are never stored.
          const id = randomBytes(12).toString('hex');
          for (const target of recipients ?? []) send(target, { type: 'msg', id, ts: Date.now() }, body);
          send(conn, { type: 'result', reqId: frame.reqId, data: { id, delivered: !!recipients?.size } });
          return;
        }
        const cid = typeof frame.cid === 'string' ? frame.cid.slice(0, 64) : '';
        const seen = recentSends.get(userId) ?? new Map<string, { id: string; ts: number }>();
        recentSends.set(userId, seen);
        send(conn, { type: 'result', reqId: frame.reqId, data: await deliver(frame.to, body, cid, seen) });
        return;
      }
      case 'access_set': {
        const hash = unb64Len(frame.hash, 32);
        if (!hash) fail('bad_request', 'Неверный ключ доставки');
        store.users.get(userId)!.accessHash = frame.hash;
        store.touch();
        send(conn, { type: 'result', reqId: frame.reqId, data: { ok: true } });
        return;
      }
      case 'prekeys': {
        const signKey = unb64Len(userId, 32)!;
        if (frame.opks !== undefined && !validOneTimePreKeys(frame.opks)) fail('bad_request', 'Неверные предключи');
        if (frame.spk !== undefined && !validSignedPreKey(signKey, frame.spk)) fail('bad_request', 'Неверный предключ');
        const count = store.addPreKeys(userId, frame.opks, frame.spk);
        send(conn, { type: 'result', reqId: frame.reqId, data: { opkCount: count } });
        return;
      }
      case 'username_check': {
        if (!lookupAllowed(conn)) fail('rate_limited', 'Слишком много запросов');
        const wanted = String(frame.username ?? '').toLowerCase().replace(/^@/, '');
        const owner = store.byUsername(wanted);
        send(conn, { type: 'result', reqId: frame.reqId, data: { valid: USERNAME_RE.test(wanted), free: !owner || owner.userId === userId } });
        return;
      }
      case 'username_set': {
        const wanted = String(frame.username ?? '').toLowerCase().replace(/^@/, '');
        if (!USERNAME_RE.test(wanted)) fail('bad_request', 'Имя: от 3 до 32 символов — латинские буквы, цифры и _');
        const user = store.users.get(userId)!;
        if (user.username === wanted) fail('bad_request', 'Это уже ваше имя пользователя');
        const owner = store.byUsername(wanted);
        if (owner && owner.userId !== userId) fail('username_taken', 'Это имя пользователя уже занято');
        const day = Date.now() - 86_400_000;
        if ((user.renamedAt ?? []).filter((t) => t > day).length >= RENAMES_PER_DAY)
          fail('rate_limited', `Имя можно менять не чаще ${RENAMES_PER_DAY} раз в сутки`);
        // A recovery code sent to the old name must not work for whoever takes it next.
        recoverPending.delete(user.username);
        store.renameUser(userId, wanted);
        log(`username changed`);
        send(conn, { type: 'result', reqId: frame.reqId, data: { username: wanted } });
        return;
      }
      case 'account_status': {
        send(conn, { type: 'result', reqId: frame.reqId, data: accountStatus(store.users.get(userId)!) });
        return;
      }
      case 'email_set': {
        const email = String(frame.email ?? '').trim();
        if (!EMAIL_RE.test(email)) fail('bad_request', 'Неверный адрес почты');
        if (!mailer) fail('mail_unavailable', 'Сервер не настроен для отправки писем');
        takeMailBudget(`user:${userId}`);
        const code = newCode();
        emailPending.set(userId, { code, expires: Date.now() + CODE_TTL_MS, attempts: 0, emailHash: emailHash(email) });
        await sendCode(email, code, 'confirm');
        send(conn, { type: 'result', reqId: frame.reqId, data: { sent: true } });
        return;
      }
      case 'email_confirm': {
        const pending = checkCode(emailPending.get(userId), frame.code);
        const user = store.users.get(userId)!;
        user.emailHash = pending.emailHash;
        emailPending.delete(userId);
        store.touch();
        send(conn, { type: 'result', reqId: frame.reqId, data: accountStatus(user) });
        return;
      }
      case 'email_remove': {
        const user = store.users.get(userId)!;
        if (!totpOk(user, frame.totp)) fail('bad_totp', 'Неверный код из Google Authenticator');
        delete user.emailHash;
        await store.deleteBackup(userId);
        send(conn, { type: 'result', reqId: frame.reqId, data: accountStatus(user) });
        return;
      }
      case 'totp_set': {
        const user = store.users.get(userId)!;
        if (user.totp) fail('bad_request', 'Двухфакторная аутентификация уже включена');
        const secret = String(frame.secret ?? '');
        if (!/^[A-Z2-7]{16,64}$/.test(secret)) fail('bad_request', 'Неверный секрет');
        const step = verifyTotp(secret, frame.code);
        if (step === null) fail('bad_totp', 'Неверный код из Google Authenticator');
        user.totp = secret;
        user.totpLast = step!;
        store.touch();
        send(conn, { type: 'result', reqId: frame.reqId, data: accountStatus(user) });
        return;
      }
      case 'totp_disable': {
        const user = store.users.get(userId)!;
        if (!user.totp) fail('bad_request', 'Двухфакторная аутентификация выключена');
        if (!totpOk(user, frame.code)) fail('bad_totp', 'Неверный код из Google Authenticator');
        delete user.totp;
        delete user.totpLast;
        store.touch();
        send(conn, { type: 'result', reqId: frame.reqId, data: accountStatus(user) });
        return;
      }
      case 'backup_put': {
        if (!validBackupMeta(frame.meta)) fail('bad_request', 'Неверная резервная копия');
        if (!body.length || body.length > MAX_BACKUP_BYTES) fail('too_large', 'Резервная копия слишком большая');
        const meta: BackupMeta = { v: 1, kdf: frame.meta.kdf, nonce: frame.meta.nonce, updatedAt: Date.now() };
        await store.putBackup(userId, meta, body.slice());
        send(conn, { type: 'result', reqId: frame.reqId, data: accountStatus(store.users.get(userId)!) });
        return;
      }
      case 'unregister': {
        const signKey = unb64Len(userId, 32)!;
        if (!verifySig(frame.sig, authStatement(conn.nonce, 'unregister'), signKey)) fail('unauthorized', 'Неверная подпись');
        if (!totpOk(store.users.get(userId)!, frame.totp)) fail('bad_totp', 'Неверный код из Google Authenticator');
        await store.removeUser(userId);
        recentSends.delete(userId);
        log('account deleted');
        send(conn, { type: 'result', reqId: frame.reqId, data: { deleted: true } });
        conn.ws.close(4002, 'deleted');
        return;
      }
      case 'devices': {
        const user = store.users.get(userId)!;
        const live = new Set([...(online.get(userId) ?? [])].map((c) => c.deviceId));
        const devices = (user.devices ?? []).map((d) => ({ ...d, online: live.has(d.id) }));
        send(conn, { type: 'result', reqId: frame.reqId, data: { devices, current: conn.deviceId ?? null } });
        return;
      }
      case 'device_revoke': {
        const user = store.users.get(userId)!;
        const id = String(frame.id ?? '');
        if (!DEVICE_ID_RE.test(id)) fail('bad_request', 'Неверное устройство');
        if (id === conn.deviceId) fail('bad_request', 'Этот компьютер отвязать нельзя — отвязывайте с другого');
        user.devices = (user.devices ?? []).filter((d) => d.id !== id);
        user.revoked = [id, ...(user.revoked ?? []).filter((r) => r !== id)].slice(0, MAX_REVOKED);
        store.touch();
        for (const other of online.get(userId) ?? []) if (other.deviceId === id) other.ws.close(4003, 'revoked');
        send(conn, { type: 'result', reqId: frame.reqId, data: { revoked: true } });
        return;
      }
      case 'device_signout': {
        // «Выйти из аккаунта» on this computer: it leaves the list but is not barred from signing in again.
        const user = store.users.get(userId)!;
        if (conn.deviceId) {
          user.devices = (user.devices ?? []).filter((d) => d.id !== conn.deviceId);
          store.touch();
        }
        send(conn, { type: 'result', reqId: frame.reqId, data: { signedOut: true } });
        conn.ws.close(1000, 'signed out');
        return;
      }
      default:
        fail('bad_request', 'Неизвестный тип запроса');
    }
  };

  wss.on('connection', (ws, req) => {
    const conn: Connection = {
      ws,
      ip: clientAddress(req.headers['x-forwarded-for'], req.socket.remoteAddress, options.trustProxy ?? 0),
      nonce: b64(randomBytes(32)),
      userId: null,
      alive: true,
      sends: new Bucket(SENDS_PER_WINDOW, LOOKUP_WINDOW_MS),
    };
    connections.set(ws, conn);
    ws.on('pong', () => (conn.alive = true));

    // Frames from one connection are handled strictly in order.
    let chain = Promise.resolve();
    ws.on('message', (raw, isBinary) => {
      chain = chain.then(async () => {
        let reqId: string | undefined;
        try {
          if (!isBinary) fail('bad_request', 'Ожидается бинарный кадр');
          const bytes = raw instanceof Buffer ? new Uint8Array(raw) : new Uint8Array(raw as ArrayBuffer);
          options.tap?.('in', bytes);
          const { header, body } = unpack<ClientFrame>(bytes);
          reqId = typeof (header as { reqId?: unknown }).reqId === 'string' ? (header as { reqId: string }).reqId : undefined;
          if (!conn.userId) {
            if (header.type === 'register') await handleRegister(conn, header);
            else if (header.type === 'auth') await handleAuth(conn, header);
            else if (header.type === 'recover_start' || header.type === 'recover_finish') await handleRecovery(conn, header);
            else if (header.type === 'bridge_open' || header.type === 'bridge_join' || header.type === 'bridge_data') handleBridge(conn, header, body);
            else if (header.type === 'send_sealed') await handleSealedSend(conn, header, body);
            else if (header.type === 'ping') send(conn, { type: 'pong' });
            else fail('unauthorized', 'Требуется вход');
            return;
          }
          await handleRequest(conn, header, body);
        } catch (error) {
          if (error instanceof RelayError) sendError(conn, error.code, error.message, reqId);
          else {
            log(`error: ${(error as Error).message}`);
            sendError(conn, 'server_error', 'Внутренняя ошибка сервера', reqId);
          }
        }
      });
    });

    ws.on('close', () => {
      connections.delete(ws);
      if (conn.bridge) closeBridge(conn.bridge, conn);
      if (!conn.userId) return;
      const device = conn.deviceId ? store.users.get(conn.userId)?.devices?.find((d) => d.id === conn.deviceId) : undefined;
      if (device) {
        device.last = Date.now();
        store.touch();
      }
      const set = online.get(conn.userId);
      set?.delete(conn);
      if (set && set.size === 0) online.delete(conn.userId);
    });

    const challenge = new URL(req.url ?? '/', 'http://relay').searchParams.get('c');
    send(conn, {
      type: 'hello',
      nonce: conn.nonce,
      version: PROTOCOL_VERSION,
      name,
      id: store.serverId,
      key: b64(store.serverPublicKey),
      ...(challenge && SERVER_CHALLENGE_RE.test(challenge) ? { proof: b64(ed25519.sign(serverProofStatement(challenge), store.serverSecretKey)) } : {}),
    });
  });

  const heartbeat = setInterval(() => {
    for (const conn of connections.values()) {
      if (!conn.alive) {
        conn.ws.terminate();
        continue;
      }
      conn.alive = false;
      conn.ws.ping();
    }
  }, 30_000);
  const janitor = setInterval(() => {
    void store.expire();
    // Old rate-limit counters: their windows are long over.
    lookupBuckets.clear();
    sealedBuckets.clear();
    for (const to of sealedSeen.keys()) if (!store.users.has(to)) sealedSeen.delete(to);
    const stale = Date.now() - OPK_REPEAT_MS;
    for (const [key, at] of opkGiven) if (at < stale) opkGiven.delete(key);
  }, 60 * 60 * 1000);
  heartbeat.unref?.();
  janitor.unref?.();

  await new Promise<void>((resolve, reject) => {
    http.once('error', reject);
    http.listen(options.port ?? 8787, options.host ?? '0.0.0.0', () => resolve());
  });
  const address = http.address();
  const port = typeof address === 'object' && address ? address.port : (options.port ?? 8787);
  log(`${name} listening on :${port}`);

  return {
    port,
    server: http,
    store,
    async close() {
      clearInterval(heartbeat);
      clearInterval(janitor);
      for (const ws of wss.clients) ws.terminate();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      await new Promise<void>((resolve) => http.close(() => resolve()));
      await store.flush();
    },
  };
}
