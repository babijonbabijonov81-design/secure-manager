// Tunnels: a Veil server at home, behind any NAT, reachable from the internet through a public
// relay (e.g. the one on Render).
//
//   home server ──wss──▶ public relay /tunnel        (outgoing: works behind CGNAT)
//   client      ──wss──▶ public relay /t/<id>/ws     (forwarded as a virtual connection)
//
// The home server proves its key when it registers; the tunnel id is derived from that key, so
// after any restart the address stays the same. Each client connection becomes a virtual
// connection inside the tunnel, which the home server serves with exactly the code it uses for a
// WebSocket (acceptConnection in relay.ts) — including the hello signed with the HOME server's
// key: a client verifies the server behind the tunnel, not just the relay in front of it.
//
// The public relay sees what any Veil server sees (who connects, how big the envelopes are), never
// what is inside them. Limits: tunnels per IP, virtual connections per tunnel, bytes per day.

import { createHash, randomBytes } from 'node:crypto';
import { ed25519 } from '@noble/curves/ed25519.js';
import { WebSocket } from 'ws';
import type { Channel } from './relay.ts';
import { b64, pack, unb64Len, unpack, utf8 } from './shared/wire.ts';

export type TunnelFrame =
  // public relay → home
  | { type: 't_hello'; nonce: string; key: string }
  | { type: 't_ready'; id: string; ip: string }
  | { type: 't_open'; vc: number; ip: string; c: string; sig: string }
  | { type: 't_error'; code: 'quota' | 'limit' | 'auth'; message: string }
  | { type: 't_pong' }
  // both ways
  | { type: 't_data'; vc: number }
  | { type: 't_close'; vc: number; code?: number }
  // home → public relay
  | { type: 't_register'; key: string; sig: string }
  | { type: 't_ping' };

export interface TunnelLimits {
  /** Tunnels open at once from one IP. */
  perIp: number;
  /** Tunnels on this relay in total. */
  maxTunnels: number;
  /** Clients connected through one tunnel at once. */
  connsPerTunnel: number;
  /** Traffic through one tunnel per day, both ways (keeps a free plan within its quota). */
  bytesPerDay: number;
  /** A client connection with no traffic for this long is closed. */
  idleMs: number;
}

export const DEFAULT_TUNNEL_LIMITS: TunnelLimits = {
  perIp: 3,
  maxTunnels: 200,
  connsPerTunnel: 100,
  bytesPerDay: 1024 * 1024 * 1024,
  idleMs: 10 * 60_000,
};

/** The keepalive: Render puts a free service to sleep after 15 minutes without traffic. */
export const TUNNEL_KEEPALIVE_MS = 5 * 60_000;
const DAY_MS = 24 * 60 * 60_000;
const REGISTER_TIMEOUT_MS = 15_000;

export const TUNNEL_ID_RE = /^[a-z2-7]{16}$/;

/** The tunnel's id: from the home server's public key, so it never changes. */
export function tunnelId(publicKey: Uint8Array): string {
  const hash = createHash('sha256').update('veil-tunnel-id-v1').update(publicKey).digest();
  let bits = '';
  for (const byte of hash.subarray(0, 10)) bits += byte.toString(2).padStart(8, '0');
  return bits.replace(/.{5}/g, (chunk) => 'abcdefghijklmnopqrstuvwxyz234567'[parseInt(chunk, 2)]);
}

export const registerStatement = (nonce: string, relayKey: string) => utf8(`veil-tunnel-register-v1|${nonce}|${relayKey}`);
export const openStatement = (id: string, vc: number, ip: string, challenge: string) => utf8(`veil-tunnel-open-v1|${id}|${vc}|${ip}|${challenge}`);

const decode = (raw: unknown): { header: TunnelFrame; body: Uint8Array } | null => {
  try {
    const bytes = raw instanceof Buffer ? new Uint8Array(raw) : new Uint8Array(raw as ArrayBuffer);
    return unpack<TunnelFrame>(bytes);
  } catch {
    return null;
  }
};

// ---- the public relay's side ----------------------------------------------------------------

interface HostedTunnel {
  id: string;
  ws: WebSocket;
  ip: string;
  clients: Map<number, { ws: WebSocket; last: number }>;
  nextVc: number;
  bytes: number;
  dayStart: number;
}

export interface TunnelHost {
  /** A home server connected to /tunnel. */
  acceptTunnel(ws: WebSocket, ip: string): void;
  /** Whether /t/<id>/ws leads anywhere right now. */
  has(id: string): boolean;
  /** A client connected to /t/<id>/ws. */
  acceptClient(ws: WebSocket, ip: string, id: string, challenge: string): void;
  close(): void;
}

export function createTunnelHost(options: { secretKey: Uint8Array; publicKey: Uint8Array; limits?: Partial<TunnelLimits>; log?: (message: string) => void }): TunnelHost {
  const limits = { ...DEFAULT_TUNNEL_LIMITS, ...options.limits };
  const log = options.log ?? (() => {});
  const relayKey = b64(options.publicKey);
  const tunnels = new Map<string, HostedTunnel>();
  const perIp = new Map<string, number>();

  const sendTo = (ws: WebSocket, frame: TunnelFrame, body?: Uint8Array) => {
    if (ws.readyState === WebSocket.OPEN) ws.send(pack(frame, body));
  };

  /** Counts traffic; past the daily limit every client of the tunnel is let go. */
  const spend = (tunnel: HostedTunnel, bytes: number): boolean => {
    const now = Date.now();
    if (now - tunnel.dayStart > DAY_MS) {
      tunnel.dayStart = now;
      tunnel.bytes = 0;
    }
    tunnel.bytes += bytes;
    if (tunnel.bytes <= limits.bytesPerDay) return true;
    sendTo(tunnel.ws, { type: 't_error', code: 'quota', message: 'Туннель исчерпал дневной лимит трафика' });
    for (const [vc, client] of tunnel.clients) {
      client.ws.close(4429, 'tunnel quota');
      tunnel.clients.delete(vc);
    }
    return false;
  };

  const dropTunnel = (tunnel: HostedTunnel) => {
    if (tunnels.get(tunnel.id) === tunnel) tunnels.delete(tunnel.id);
    perIp.set(tunnel.ip, Math.max(0, (perIp.get(tunnel.ip) ?? 1) - 1));
    for (const client of tunnel.clients.values()) client.ws.close(4502, 'tunnel closed');
    tunnel.clients.clear();
  };

  const idle = setInterval(() => {
    const stale = Date.now() - limits.idleMs;
    for (const tunnel of tunnels.values()) {
      for (const [vc, client] of tunnel.clients) {
        if (client.last >= stale) continue;
        client.ws.close(4408, 'idle');
        tunnel.clients.delete(vc);
        sendTo(tunnel.ws, { type: 't_close', vc });
      }
    }
  }, 60_000);
  idle.unref?.();

  return {
    acceptTunnel(ws, ip) {
      const nonce = b64(randomBytes(24));
      let tunnel: HostedTunnel | null = null;
      const timer = setTimeout(() => !tunnel && ws.close(4401, 'no registration'), REGISTER_TIMEOUT_MS);
      sendTo(ws, { type: 't_hello', nonce, key: relayKey });
      ws.on('message', (raw) => {
        const frame = decode(raw);
        if (!frame) return;
        const { header, body } = frame;
        if (!tunnel) {
          if (header.type !== 't_register') return;
          const key = unb64Len(header.key, 32);
          const sig = unb64Len(header.sig, 64);
          let valid = false;
          try {
            valid = !!key && !!sig && ed25519.verify(sig, registerStatement(nonce, relayKey), key);
          } catch {
            valid = false;
          }
          if (!valid) {
            sendTo(ws, { type: 't_error', code: 'auth', message: 'Неверная подпись сервера' });
            ws.close(4401, 'bad signature');
            return;
          }
          const id = tunnelId(key!);
          const previous = tunnels.get(id);
          // The same server reconnecting takes its address back; anyone else waits for limits.
          if (previous) {
            previous.ws.close(4409, 'replaced');
            dropTunnel(previous);
          }
          if ((perIp.get(ip) ?? 0) >= limits.perIp || tunnels.size >= limits.maxTunnels) {
            sendTo(ws, { type: 't_error', code: 'limit', message: 'На этом ретрансляторе нет места для ещё одного туннеля' });
            ws.close(4429, 'too many tunnels');
            return;
          }
          clearTimeout(timer);
          tunnel = { id, ws, ip, clients: new Map(), nextVc: 1, bytes: 0, dayStart: Date.now() };
          tunnels.set(id, tunnel);
          perIp.set(ip, (perIp.get(ip) ?? 0) + 1);
          sendTo(ws, { type: 't_ready', id, ip });
          log(`tunnel ${id} open`);
          return;
        }
        if (header.type === 't_ping') return sendTo(ws, { type: 't_pong' });
        const vc = Number((header as { vc?: unknown }).vc);
        const client = tunnel.clients.get(vc);
        if (!client) return;
        if (header.type === 't_data') {
          if (!spend(tunnel, body.length)) return;
          client.last = Date.now();
          if (client.ws.readyState === WebSocket.OPEN) client.ws.send(body);
        } else if (header.type === 't_close') {
          tunnel.clients.delete(vc);
          client.ws.close(Number(header.code) >= 4000 && Number(header.code) < 5000 ? Number(header.code) : 1000, 'closed');
        }
      });
      ws.on('close', () => {
        clearTimeout(timer);
        if (tunnel) {
          log(`tunnel ${tunnel.id} closed`);
          dropTunnel(tunnel);
        }
      });
    },

    has: (id) => tunnels.has(id),

    acceptClient(ws, ip, id, challenge) {
      const tunnel = tunnels.get(id);
      if (!tunnel) return ws.close(4404, 'no such tunnel');
      if (tunnel.clients.size >= limits.connsPerTunnel) return ws.close(4429, 'tunnel busy');
      if (tunnel.bytes > limits.bytesPerDay && Date.now() - tunnel.dayStart <= DAY_MS) return ws.close(4429, 'tunnel quota');
      const vc = tunnel.nextVc++;
      tunnel.clients.set(vc, { ws, last: Date.now() });
      // Signed by this relay: the home server knows the client's address really came from here.
      const sig = b64(ed25519.sign(openStatement(id, vc, ip, challenge), options.secretKey));
      sendTo(tunnel.ws, { type: 't_open', vc, ip, c: challenge, sig });
      ws.on('message', (raw) => {
        const bytes = raw instanceof Buffer ? new Uint8Array(raw) : new Uint8Array(raw as ArrayBuffer);
        const current = tunnels.get(id);
        if (current !== tunnel || !tunnel.clients.has(vc)) return ws.close(4502, 'tunnel closed');
        if (!spend(tunnel, bytes.length)) return;
        tunnel.clients.get(vc)!.last = Date.now();
        sendTo(tunnel.ws, { type: 't_data', vc }, bytes);
      });
      ws.on('close', () => {
        if (tunnel.clients.delete(vc)) sendTo(tunnel.ws, { type: 't_close', vc });
      });
    },

    close() {
      clearInterval(idle);
      for (const tunnel of [...tunnels.values()]) {
        tunnel.ws.close(1001, 'relay stopping');
        dropTunnel(tunnel);
      }
    },
  };
}

// ---- the home server's side -----------------------------------------------------------------

export interface TunnelStatus {
  state: 'off' | 'connecting' | 'online' | 'retrying';
  /** wss://<public relay>/t/<id>/ws once registered. */
  url?: string;
  /** This computer's public IP as the relay sees it (to tell CGNAT apart). */
  publicIp?: string;
  error?: string;
  /** When the next attempt is due (retrying). */
  retryAt?: number;
  /** The relay's key changed since the last time (it was reinstalled, or it is another one). */
  relayKeyChanged?: boolean;
}

export interface TunnelClientOptions {
  /** wss://public-relay/tunnel */
  url: string;
  secretKey: Uint8Array;
  publicKey: Uint8Array;
  /** Serves a client connection that came through the tunnel (relay.accept). */
  accept(channel: Channel, ip: string, challenge: string): void;
  onStatus(status: TunnelStatus): void;
  /** The relay key seen last time, to notice a change. */
  knownRelayKey?: string;
  onRelayKey?(key: string): void;
  keepaliveMs?: number;
  /** Tests: shorter backoff. */
  minBackoffMs?: number;
  maxBackoffMs?: number;
}

class VirtualChannel implements Channel {
  private closed = false;
  private messageHandlers: ((bytes: Uint8Array, binary: boolean) => void)[] = [];
  private closeHandlers: (() => void)[] = [];

  private readonly vc: number;
  private readonly send_: (frame: TunnelFrame, body?: Uint8Array) => void;
  constructor(vc: number, send: (frame: TunnelFrame, body?: Uint8Array) => void) {
    this.vc = vc;
    this.send_ = send;
  }

  get open() {
    return !this.closed;
  }
  send(bytes: Uint8Array) {
    if (!this.closed) this.send_({ type: 't_data', vc: this.vc }, bytes);
  }
  close(code: number) {
    if (this.closed) return;
    this.send_({ type: 't_close', vc: this.vc, code });
    this.ended();
  }
  terminate() {
    this.close(1000);
  }
  onMessage(callback: (bytes: Uint8Array, binary: boolean) => void) {
    this.messageHandlers.push(callback);
  }
  onClose(callback: () => void) {
    this.closeHandlers.push(callback);
  }
  deliver(bytes: Uint8Array) {
    if (!this.closed) for (const handler of this.messageHandlers) handler(bytes, true);
  }
  ended() {
    if (this.closed) return;
    this.closed = true;
    for (const handler of this.closeHandlers) handler();
  }
}

/**
 * Keeps the tunnel up: registers with the server key, serves virtual connections, sends a
 * keepalive every 5 minutes and reconnects after any drop (exponential backoff with jitter).
 */
export class TunnelClient {
  private ws: WebSocket | null = null;
  private stopped = true;
  private attempt = 0;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private keepalive: ReturnType<typeof setInterval> | null = null;
  private channels = new Map<number, VirtualChannel>();
  private status: TunnelStatus = { state: 'off' };

  private readonly options: TunnelClientOptions;
  constructor(options: TunnelClientOptions) {
    this.options = options;
  }

  get current(): TunnelStatus {
    return this.status;
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.attempt = 0;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.teardown();
    this.setStatus({ state: 'off' });
  }

  private setStatus(status: TunnelStatus) {
    this.status = status;
    this.options.onStatus(status);
  }

  private teardown() {
    if (this.keepalive) clearInterval(this.keepalive);
    this.keepalive = null;
    const ws = this.ws;
    this.ws = null;
    if (ws) {
      ws.removeAllListeners();
      ws.on('error', () => {});
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) ws.terminate();
    }
    for (const channel of this.channels.values()) channel.ended();
    this.channels.clear();
  }

  private retry(error: string) {
    this.teardown();
    if (this.stopped) return;
    const min = this.options.minBackoffMs ?? 1000;
    const max = this.options.maxBackoffMs ?? 5 * 60_000;
    const delay = Math.min(max, min * 2 ** this.attempt++) * (0.75 + Math.random() * 0.5);
    this.setStatus({ state: 'retrying', error, retryAt: Date.now() + delay });
    this.retryTimer = setTimeout(() => this.connect(), delay);
  }

  private connect() {
    if (this.stopped) return;
    this.setStatus({ state: 'connecting' });
    let ws: WebSocket;
    try {
      ws = new WebSocket(this.options.url, { maxPayload: 32 * 1024 * 1024 });
    } catch (error) {
      return this.retry((error as Error).message);
    }
    this.ws = ws;
    let relayKey: Uint8Array | null = null;
    let id = '';
    let alive = true;
    ws.on('pong', () => (alive = true));
    const send = (frame: TunnelFrame, body?: Uint8Array) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(pack(frame, body));
    };
    ws.on('message', (raw) => {
      const frame = decode(raw);
      if (!frame || this.ws !== ws) return;
      const { header, body } = frame;
      switch (header.type) {
        case 't_hello': {
          relayKey = unb64Len(header.key, 32);
          if (!relayKey) return this.retry('Ретранслятор прислал неверный ключ');
          const known = this.options.knownRelayKey;
          if (header.key !== known) this.options.onRelayKey?.(header.key);
          const sig = b64(ed25519.sign(registerStatement(header.nonce, header.key), this.options.secretKey));
          send({ type: 't_register', key: b64(this.options.publicKey), sig });
          (ws as WebSocket & { relayKeyChanged?: boolean }).relayKeyChanged = !!known && known !== header.key;
          return;
        }
        case 't_ready': {
          id = header.id;
          this.attempt = 0;
          const base = new URL(this.options.url);
          base.pathname = `/t/${id}/ws`;
          const changed = (ws as WebSocket & { relayKeyChanged?: boolean }).relayKeyChanged;
          this.setStatus({ state: 'online', url: base.toString(), publicIp: header.ip, ...(changed ? { relayKeyChanged: true } : {}) });
          // App-level keepalive (a sleeping free Render service wakes on traffic), plus pings to
          // notice a dead connection within a minute.
          this.keepalive = setInterval(() => {
            if (!alive) return this.retry('Связь с ретранслятором пропала');
            alive = false;
            ws.ping();
          }, 30_000);
          const appKeepalive = setInterval(() => send({ type: 't_ping' }), this.options.keepaliveMs ?? TUNNEL_KEEPALIVE_MS);
          ws.once('close', () => clearInterval(appKeepalive));
          return;
        }
        case 't_open': {
          if (!relayKey || !id) return;
          let valid = false;
          try {
            valid = ed25519.verify(unb64Len(header.sig, 64) ?? new Uint8Array(64), openStatement(id, header.vc, header.ip, header.c), relayKey);
          } catch {
            valid = false;
          }
          // An address not signed by the relay is not trusted for limits: the connection is refused.
          if (!valid) return send({ type: 't_close', vc: header.vc, code: 4401 });
          const channel = new VirtualChannel(header.vc, send);
          this.channels.set(header.vc, channel);
          channel.onClose(() => this.channels.delete(header.vc));
          this.options.accept(channel, header.ip, header.c);
          return;
        }
        case 't_data':
          this.channels.get(header.vc)?.deliver(body);
          return;
        case 't_close': {
          const channel = this.channels.get(header.vc);
          this.channels.delete(header.vc);
          channel?.ended();
          return;
        }
        case 't_error':
          if (header.code === 'quota') this.setStatus({ ...this.status, error: header.message });
          else return this.retry(header.message);
          return;
        default:
          return;
      }
    });
    ws.on('error', () => {});
    ws.on('close', (code) => {
      if (this.ws !== ws) return;
      this.retry(code === 4429 ? 'Ретранслятор отказал: лимит туннелей' : code === 4409 ? 'Туннель открыт с другого места' : 'Связь с ретранслятором прервалась');
    });
  }
}
