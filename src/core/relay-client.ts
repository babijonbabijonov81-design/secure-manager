// WebSocket client for the relay: authentication, requests, reconnects, heartbeats.

import {
  authStatement,
  type AuthFrame,
  type DeviceHello,
  type ErrorCode,
  type RecoveryHold,
  type RegisterFrame,
  type RequestFrame,
  type SealedSendFrame,
  type ServerFrame,
  serverProofStatement,
} from '../../server/src/shared/protocol.ts';
import { b64, pack, randomId, unb64, unpack } from '../../server/src/shared/wire.ts';
import { random, sign, verify } from './crypto/primitives.ts';

export type ConnectionStatus = 'connecting' | 'online' | 'offline';

export class RelayRequestError extends Error {
  readonly code: ErrorCode | 'timeout' | 'offline';
  constructor(code: RelayRequestError['code'], message: string) {
    super(message);
    this.code = code;
    this.name = 'RelayRequestError';
  }
}

type ReadyFrame = Extract<ServerFrame, { type: 'ready' }>;

export interface RelayClientOptions {
  url: string;
  userId: string;
  signPriv: Uint8Array;
  /** Start by registering instead of logging in (new account or server lost our data). */
  register: boolean;
  buildRegistration(nonce: string): Promise<RegisterFrame>;
  onStatus(status: ConnectionStatus, error?: string): void;
  onReady(frame: ReadyFrame): void;
  onMessage(id: string, ts: number, body: Uint8Array): void;
  onPrekeysLow(count: number): void;
  /** Someone started restoring this account by email (see RecoveryHold). */
  onRecoveryHold?(hold: RecoveryHold): void;
  /** Errors that stop reconnecting, e.g. a taken username or another device took over. */
  onFatal(code: string, message: string): void;
  /** This computer, for Settings → «Устройства» (only when the feature is on). */
  device?(): DeviceHello | undefined;
  /** The server key pinned for this account: a server that cannot prove it gets no login. */
  expectKey?(): string | undefined;
  /** The server showed another key (or none): the connection stops until the user decides. */
  onKeyMismatch?(key: string | null): void;
}

/** Accepts "host:port", "https://host", "wss://host/ws"… and returns the WebSocket URL. */
export function normalizeServerUrl(input: string): string {
  let value = input.trim();
  if (!value) throw new Error('Укажите адрес сервера');
  if (!/^[a-z]+:\/\//i.test(value)) {
    const local = /^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|\[::1\])/i.test(value);
    value = `${local ? 'ws' : 'wss'}://${value}`;
  }
  const url = new URL(value);
  if (url.protocol === 'http:') url.protocol = 'ws:';
  else if (url.protocol === 'https:') url.protocol = 'wss:';
  else if (url.protocol !== 'ws:' && url.protocol !== 'wss:') throw new Error('Неподдерживаемый адрес сервера');
  if (url.pathname === '/' || url.pathname === '') url.pathname = '/ws';
  url.hash = '';
  return url.toString().replace(/\/$/, '');
}

/** The WebSocket URL with a fresh random challenge the server must sign in its hello. */
export function withChallenge(input: string): { url: string; challenge: string } {
  const challenge = b64(random(18));
  const url = new URL(normalizeServerUrl(input));
  url.searchParams.set('c', challenge);
  return { url: url.toString(), challenge };
}

/** The server's key, if its hello carries a valid signature of our challenge (newer servers). */
export function provenServerKey(hello: Extract<ServerFrame, { type: 'hello' }>, challenge: string): string | undefined {
  if (!hello.key || !hello.proof) return undefined;
  try {
    const key = unb64(hello.key);
    return key.length === 32 && verify(unb64(hello.proof), serverProofStatement(challenge), key) ? hello.key : undefined;
  } catch {
    return undefined;
  }
}

/** Opens a connection just long enough to read the server greeting. */
export function probeServer(input: string, timeoutMs = 6000): Promise<{ name: string; version: number; id?: string; key?: string }> {
  return new Promise((resolve, reject) => {
    let url: string;
    let challenge: string;
    try {
      ({ url, challenge } = withChallenge(input));
    } catch (error) {
      reject(error);
      return;
    }
    const ws = new WebSocket(url);
    ws.binaryType = 'arraybuffer';
    const timer = setTimeout(() => {
      ws.close();
      reject(new Error('Сервер не отвечает'));
    }, timeoutMs);
    ws.onmessage = (event) => {
      clearTimeout(timer);
      try {
        const { header } = unpack<ServerFrame>(new Uint8Array(event.data as ArrayBuffer));
        if (header.type !== 'hello') throw new Error('Это не сервер Veil');
        const key = provenServerKey(header, challenge);
        resolve({ name: header.name, version: header.version, ...(header.id ? { id: header.id } : {}), ...(key ? { key } : {}) });
      } catch (error) {
        reject(error);
      } finally {
        ws.close();
      }
    };
    ws.onerror = () => {
      clearTimeout(timer);
      reject(new Error('Не удалось подключиться к серверу'));
    };
  });
}

/**
 * One request on a fresh, not logged-in connection (used for account recovery).
 * Resolves with the result payload and any binary body.
 */
export function anonymousRequest<T>(
  input: string,
  frame: Record<string, unknown>,
  timeoutMs = 30_000,
): Promise<{ data: T; body: Uint8Array }> {
  return new Promise((resolve, reject) => {
    let ws: WebSocket;
    try {
      ws = new WebSocket(normalizeServerUrl(input));
    } catch (error) {
      reject(error);
      return;
    }
    ws.binaryType = 'arraybuffer';
    const reqId = randomId(9);
    const timer = setTimeout(() => {
      ws.close();
      reject(new RelayRequestError('timeout', 'Сервер не отвечает'));
    }, timeoutMs);
    const finish = (fn: () => void) => {
      clearTimeout(timer);
      ws.close();
      fn();
    };
    ws.onmessage = (event) => {
      try {
        const { header, body } = unpack<ServerFrame>(new Uint8Array(event.data as ArrayBuffer));
        if (header.type === 'hello') ws.send(pack({ ...frame, reqId }));
        else if (header.type === 'result' && header.reqId === reqId) finish(() => resolve({ data: header.data as T, body: body.slice() }));
        else if (header.type === 'error') finish(() => reject(new RelayRequestError(header.code, header.message)));
      } catch (error) {
        finish(() => reject(error));
      }
    };
    ws.onerror = () => finish(() => reject(new RelayRequestError('offline', 'Не удалось подключиться к серверу')));
  });
}

const REQUEST_TIMEOUT_MS = 30_000;
const PING_INTERVAL_MS = 25_000;
const FATAL_CODES = new Set(['username_taken', 'replaced', 'deleted', 'device_revoked', 'invite_required']);

export class RelayClient {
  status: ConnectionStatus = 'offline';
  /** The server's stable id from its hello (absent on older servers). */
  serverId: string | undefined;
  /** The server's key, proven by signing this connection's challenge (newer servers). */
  serverKey: string | undefined;
  private challenge = '';
  private ws: WebSocket | null = null;
  private readonly options: RelayClientOptions;
  private register: boolean;
  private nonce = '';
  private closed = false;
  private attempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private lastFrameAt = 0;
  private readonly pending = new Map<
    string,
    { resolve(value: unknown): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }
  >();

  constructor(options: RelayClientOptions) {
    this.options = options;
    this.register = options.register;
  }

  connect(): void {
    this.closed = false;
    this.open();
  }

  close(): void {
    this.closed = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.teardown();
    this.setStatus('offline');
  }

  /** Closes and waits (briefly) until the server has the connection closed too. */
  closeAndWait(timeoutMs = 1000): Promise<void> {
    const ws = this.ws;
    const done =
      ws && ws.readyState === WebSocket.OPEN
        ? new Promise<void>((resolve) => {
            const timer = setTimeout(resolve, timeoutMs);
            ws.addEventListener('close', () => {
              clearTimeout(timer);
              resolve();
            });
          })
        : Promise.resolve();
    this.close();
    return done;
  }

  /** Signs a statement bound to the current connection (used for account deletion). */
  signAction(action: 'unregister'): string {
    return b64(sign(authStatement(this.nonce, action), this.options.signPriv));
  }

  request<T>(frame: DistributiveOmit<RequestFrame, 'reqId'>, body?: Uint8Array): Promise<T> {
    if (this.status !== 'online' || !this.ws) {
      return Promise.reject(new RelayRequestError('offline', 'Нет соединения с сервером'));
    }
    const reqId = randomId(9);
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(reqId);
        reject(new RelayRequestError('timeout', 'Сервер не ответил вовремя'));
      }, REQUEST_TIMEOUT_MS);
      this.pending.set(reqId, { resolve: resolve as (value: unknown) => void, reject, timer });
      this.ws!.send(pack({ ...frame, reqId }, body));
    });
  }

  ack(ids: string[]): void {
    if (ids.length && this.ws?.readyState === WebSocket.OPEN) this.ws.send(pack({ type: 'ack', ids }));
  }

  private open(): void {
    this.teardown();
    this.setStatus('connecting');
    let ws: WebSocket;
    try {
      const { url, challenge } = withChallenge(this.options.url);
      this.challenge = challenge;
      ws = new WebSocket(url);
    } catch (error) {
      this.setStatus('offline', (error as Error).message);
      this.scheduleReconnect();
      return;
    }
    ws.binaryType = 'arraybuffer';
    this.ws = ws;
    ws.onmessage = (event) => {
      if (this.ws !== ws) return;
      this.lastFrameAt = Date.now();
      if (!(event.data instanceof ArrayBuffer)) return;
      try {
        const { header, body } = unpack<ServerFrame>(new Uint8Array(event.data));
        void this.handle(header, body);
      } catch {
        // ignore malformed frames
      }
    };
    ws.onclose = (event) => {
      if (this.ws !== ws) return;
      this.teardown();
      if (event.code === 4001) {
        this.closed = true;
        this.setStatus('offline');
        this.options.onFatal('replaced', 'Аккаунт открыт на другом устройстве');
        return;
      }
      if (event.code === 4003) {
        this.closed = true;
        this.setStatus('offline');
        this.options.onFatal('device_revoked', 'Этот компьютер отвязан от аккаунта');
        return;
      }
      if (event.code === 4002) {
        this.closed = true;
        this.setStatus('offline');
        return;
      }
      this.setStatus('offline');
      this.scheduleReconnect();
    };
    ws.onerror = () => {
      // onclose follows and handles reconnecting
    };
  }

  private async handle(frame: ServerFrame, body: Uint8Array): Promise<void> {
    switch (frame.type) {
      case 'hello': {
        this.nonce = frame.nonce;
        this.serverId = frame.id;
        this.serverKey = provenServerKey(frame, this.challenge);
        const expected = this.options.expectKey?.();
        if (expected && this.serverKey !== expected) {
          // Not the server this account knows: no signature with our key goes to it, no retries.
          this.closed = true;
          this.teardown();
          this.setStatus('offline', 'Ключ сервера не совпадает с запомненным');
          this.options.onKeyMismatch?.(this.serverKey ?? null);
          return;
        }
        const message = this.register
          ? await this.options.buildRegistration(frame.nonce)
          : ({
              type: 'auth',
              userId: this.options.userId,
              sig: b64(sign(authStatement(frame.nonce, 'auth'), this.options.signPriv)),
              ...(this.options.device?.() ? { device: this.options.device()! } : {}),
            } satisfies AuthFrame);
        this.ws?.send(pack(message));
        return;
      }
      case 'recovery_hold':
        this.options.onRecoveryHold?.(frame.hold);
        return;
      case 'ready':
        this.register = false;
        this.attempt = 0;
        this.setStatus('online');
        this.startPing();
        this.options.onReady(frame);
        return;
      case 'msg':
        this.options.onMessage(frame.id, frame.ts, body.slice());
        return;
      case 'result': {
        const waiter = this.pending.get(frame.reqId);
        if (waiter) {
          clearTimeout(waiter.timer);
          this.pending.delete(frame.reqId);
          waiter.resolve(frame.data);
        }
        return;
      }
      case 'error': {
        if (frame.reqId && this.pending.has(frame.reqId)) {
          const waiter = this.pending.get(frame.reqId)!;
          clearTimeout(waiter.timer);
          this.pending.delete(frame.reqId);
          waiter.reject(new RelayRequestError(frame.code, frame.message));
          return;
        }
        if (this.status !== 'online') {
          if (frame.code === 'unknown_user') {
            // The server no longer knows this account (e.g. it was reset): register again.
            this.register = true;
            this.open();
            return;
          }
          if (FATAL_CODES.has(frame.code)) {
            this.closed = true;
            this.teardown();
            this.setStatus('offline', frame.message);
            this.options.onFatal(frame.code, frame.message);
            return;
          }
          this.teardown();
          this.setStatus('offline', frame.message);
          this.scheduleReconnect();
        }
        return;
      }
      case 'prekeys_low':
        this.options.onPrekeysLow(frame.count);
        return;
      case 'pong':
        return;
    }
  }

  private startPing(): void {
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = setInterval(() => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
      if (Date.now() - this.lastFrameAt > PING_INTERVAL_MS * 2.5) {
        this.ws.close();
        return;
      }
      this.ws.send(pack({ type: 'ping' }));
    }, PING_INTERVAL_MS);
  }

  private scheduleReconnect(): void {
    if (this.closed) return;
    const delay = Math.min(30_000, 1000 * 2 ** this.attempt) * (0.75 + Math.random() * 0.5);
    this.attempt = Math.min(this.attempt + 1, 6);
    this.reconnectTimer = setTimeout(() => this.open(), delay);
  }

  private teardown(): void {
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = null;
    const ws = this.ws;
    this.ws = null;
    if (ws) {
      ws.onmessage = ws.onclose = ws.onerror = null;
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) ws.close();
    }
    for (const [, waiter] of this.pending) {
      clearTimeout(waiter.timer);
      waiter.reject(new RelayRequestError('offline', 'Соединение потеряно'));
    }
    this.pending.clear();
  }

  private setStatus(status: ConnectionStatus, error?: string): void {
    if (this.status === status && !error) return;
    this.status = status;
    this.options.onStatus(status, error);
  }
}

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/**
 * Sealed sender, delivered anonymously: a second connection that never logs in. Envelopes for
 * contacts who gave me their delivery key go here, so the server sees whom they are for but not
 * who sent them. It opens on demand, checks the server's key like the main connection, and
 * closes when idle.
 */
export class SealedSender {
  private ws: WebSocket | null = null;
  private ready: Promise<WebSocket> | null = null;
  private readonly pending = new Map<string, { resolve(data: unknown): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>();
  private idle: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly url: () => string,
    /** The pinned server key: a server that cannot prove it gets nothing. */
    private readonly expectKey: () => string | undefined,
  ) {}

  async send<T>(frame: Omit<SealedSendFrame, 'reqId' | 'type'>, body: Uint8Array): Promise<T> {
    const ws = await this.open();
    const reqId = randomId(9);
    this.touch();
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(reqId);
        reject(new RelayRequestError('timeout', 'Сервер не отвечает'));
      }, REQUEST_TIMEOUT_MS);
      this.pending.set(reqId, { resolve: resolve as (data: unknown) => void, reject, timer });
      ws.send(pack({ type: 'send_sealed', reqId, ...frame }, body));
    });
  }

  close(): void {
    if (this.idle) clearTimeout(this.idle);
    this.idle = null;
    this.ws?.close();
    this.ws = null;
    this.ready = null;
    for (const waiter of this.pending.values()) {
      clearTimeout(waiter.timer);
      waiter.reject(new RelayRequestError('offline', 'Соединение закрыто'));
    }
    this.pending.clear();
  }

  private touch(): void {
    if (this.idle) clearTimeout(this.idle);
    this.idle = setTimeout(() => this.close(), SEALED_IDLE_MS);
  }

  private open(): Promise<WebSocket> {
    if (this.ready) return this.ready;
    this.ready = new Promise<WebSocket>((resolve, reject) => {
      let target: { url: string; challenge: string };
      try {
        target = withChallenge(this.url());
      } catch (error) {
        this.ready = null;
        reject(error);
        return;
      }
      const ws = new WebSocket(target.url);
      ws.binaryType = 'arraybuffer';
      this.ws = ws;
      let greeted = false;
      ws.onmessage = (event) => {
        let frame: ServerFrame;
        try {
          frame = unpack<ServerFrame>(new Uint8Array(event.data as ArrayBuffer)).header;
        } catch {
          return;
        }
        if (frame.type === 'hello') {
          const expected = this.expectKey();
          if (expected && provenServerKey(frame, target.challenge) !== expected) {
            this.close();
            reject(new RelayRequestError('unauthorized', 'Сервер не подтвердил свой ключ'));
            return;
          }
          greeted = true;
          resolve(ws);
          return;
        }
        const reqId = (frame as { reqId?: string }).reqId;
        const waiter = reqId ? this.pending.get(reqId) : undefined;
        if (!waiter || !reqId) return;
        clearTimeout(waiter.timer);
        this.pending.delete(reqId);
        if (frame.type === 'result') waiter.resolve(frame.data);
        else if (frame.type === 'error') waiter.reject(new RelayRequestError(frame.code, frame.message));
      };
      ws.onclose = () => {
        if (this.ws === ws) this.close();
        if (!greeted) reject(new RelayRequestError('offline', 'Не удалось подключиться к серверу'));
      };
    });
    return this.ready;
  }
}

const SEALED_IDLE_MS = 60_000;
