// «Мост» over the local network: a TCP socket between the two computers, found through mDNS
// (`_veil-bridge._tcp`). This process only moves already-encrypted frames; the handshake and all
// cryptography run in the renderer (src/core/bridge.ts).

import { Bonjour } from 'bonjour-service';
import { connect, createServer, type Server, type Socket } from 'node:net';
import { hostname, networkInterfaces } from 'node:os';

export type Notify = (channel: 'bridge:peer' | 'bridge:data' | 'bridge:closed', value?: Uint8Array) => void;

const MAX_FRAME = 8 * 1024 * 1024;
const SERVICE = 'veil-bridge';

const ipv4 = () =>
  Object.values(networkInterfaces())
    .flat()
    .filter((i) => i && i.family === 'IPv4' && !i.internal)
    .map((i) => i!.address);

/** One side of a LAN bridge: host (listens and announces itself) or guest (connects). */
export class LanBridge {
  private server: Server | null = null;
  private socket: Socket | null = null;
  private bonjour: Bonjour | null = null;
  private readonly notify: Notify;

  constructor(notify: Notify) {
    this.notify = notify;
  }

  /** Length-prefixed frames on a TCP stream. */
  private attach(s: Socket): void {
    this.socket = s;
    s.setNoDelay(true);
    let buffer = Buffer.alloc(0);
    s.on('data', (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length >= 4) {
        const length = buffer.readUInt32BE(0);
        if (length > MAX_FRAME) {
          s.destroy();
          return;
        }
        if (buffer.length < 4 + length) break;
        this.notify('bridge:data', new Uint8Array(buffer.subarray(4, 4 + length)));
        buffer = buffer.subarray(4 + length);
      }
    });
    s.on('close', () => {
      if (this.socket !== s) return;
      this.socket = null;
      this.notify('bridge:closed');
    });
    s.on('error', () => s.destroy());
  }

  /** Old computer: listen on a free port and announce it on the local network. */
  async host(announce = true): Promise<{ port: number; addresses: string[]; name: string }> {
    this.stop();
    const listening = createServer((s) => {
      // One new computer at a time; the next one may try after this one disconnects.
      if (this.socket) return void s.destroy();
      this.attach(s);
      this.notify('bridge:peer');
    });
    this.server = listening;
    await new Promise<void>((resolve, reject) => {
      listening.once('error', reject);
      listening.listen(0, '0.0.0.0', () => resolve());
    });
    const port = (listening.address() as { port: number }).port;
    if (announce) {
      try {
        this.bonjour = new Bonjour();
        this.bonjour.publish({ name: `Veil · ${hostname()}`.slice(0, 60), type: SERVICE, port, txt: { v: '1' }, disableIPv6: true });
      } catch {
        // no multicast on this network: the new computer can still type the address
      }
    }
    return { port, addresses: ipv4(), name: hostname() };
  }

  connect(host: string, port: number): Promise<void> {
    this.stop();
    return new Promise((resolve, reject) => {
      const s = connect({ host, port, timeout: 8000 });
      s.once('connect', () => {
        s.setTimeout(0);
        this.attach(s);
        resolve();
      });
      s.once('timeout', () => {
        s.destroy();
        reject(new Error('Компьютер не отвечает'));
      });
      s.once('error', (error) =>
        reject(new Error((error as NodeJS.ErrnoException).code === 'ECONNREFUSED' ? 'Подключение отклонено' : 'Не удалось подключиться')),
      );
    });
  }

  send(data: Uint8Array): void {
    if (!this.socket || data.length > MAX_FRAME) return;
    const header = Buffer.alloc(4);
    header.writeUInt32BE(data.length);
    this.socket.write(Buffer.concat([header, Buffer.from(data)]));
  }

  /** Drops the current connection; the host keeps listening for the next try. */
  drop(): void {
    const s = this.socket;
    this.socket = null;
    s?.end();
  }

  stop(): void {
    this.socket?.destroy();
    this.socket = null;
    this.server?.close();
    this.server = null;
    this.bonjour?.unpublishAll();
    this.bonjour?.destroy();
    this.bonjour = null;
  }
}

/** New computer: look for old ones on the local network for a couple of seconds. */
export async function discoverBridges(ms = 2500): Promise<{ name: string; host: string; port: number }[]> {
  const found = new Map<string, { name: string; host: string; port: number }>();
  let finder: Bonjour | null = null;
  try {
    finder = new Bonjour();
    const browser = finder.find({ type: SERVICE }, (service) => {
      const host = service.referer?.address ?? service.addresses?.find((a) => a.includes('.'));
      if (host && service.port) found.set(`${host}:${service.port}`, { name: service.name.replace(/^Veil · /, ''), host, port: service.port });
    });
    await new Promise((r) => setTimeout(r, ms));
    browser.stop();
  } catch {
    // multicast unavailable
  } finally {
    finder?.destroy();
  }
  return [...found.values()];
}

// ---- the embedded relay on the local network ----------------------------------------------
//
// «Свой сервер на этом компьютере» announces itself as `_veil-relay._tcp` with its public id, so
// other computers on the same Wi-Fi find it instead of starting a server of their own, and find
// it again after its address changes.

const RELAY_SERVICE = 'veil-relay';
let relayAnnouncer: Bonjour | null = null;

export function announceRelay(port: number, id: string): void {
  stopAnnouncingRelay();
  try {
    relayAnnouncer = new Bonjour();
    relayAnnouncer.publish({ name: `Veil Relay · ${hostname()}`.slice(0, 60), type: RELAY_SERVICE, port, txt: { v: '1', id }, disableIPv6: true });
  } catch {
    // no multicast on this network: the address can still be typed
  }
}

export function stopAnnouncingRelay(): void {
  relayAnnouncer?.unpublishAll();
  relayAnnouncer?.destroy();
  relayAnnouncer = null;
}

export async function discoverRelays(ms = 2000): Promise<{ name: string; address: string; id?: string }[]> {
  const found = new Map<string, { name: string; address: string; id?: string }>();
  let finder: Bonjour | null = null;
  try {
    finder = new Bonjour();
    const browser = finder.find({ type: RELAY_SERVICE }, (service) => {
      const host = service.referer?.address ?? service.addresses?.find((a) => a.includes('.'));
      if (!host || !service.port) return;
      const id = typeof service.txt?.id === 'string' && /^[A-Za-z0-9_-]{16}$/.test(service.txt.id) ? service.txt.id : undefined;
      found.set(`${host}:${service.port}`, { name: service.name.replace(/^Veil Relay · /, ''), address: `${host}:${service.port}`, ...(id ? { id } : {}) });
    });
    await new Promise((r) => setTimeout(r, ms));
    browser.stop();
  } catch {
    // multicast unavailable
  } finally {
    finder?.destroy();
  }
  return [...found.values()];
}
