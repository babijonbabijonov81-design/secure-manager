// «Мост»: moves the whole account (keys, sessions, chats, «Избранное», files) from one computer to
// another — directly over the local network, or through the relay when there is none.
//
//   old PC (host): ephemeral X25519 pair a, random 8-character code shown on screen
//   new PC (guest): ephemeral X25519 pair b, the code typed in by the person
//   shared     = X25519(a, B)
//   transcript = SHA-256("veil-bridge-v1" ‖ A ‖ B ‖ nonce_host ‖ nonce_guest)
//   keys       = HKDF-SHA256(shared, transcript, "veil-bridge-v1|" ‖ code) → host→guest, guest→host, proof
//   SAS        = 6 digits of HKDF-SHA256(shared, transcript, "veil-bridge-sas"), compared on both screens
//
// Both sides prove they know the code with an HMAC; the host sends nothing until the proof is
// right and the person confirmed the six digits. Data frames are XChaCha20-Poly1305 with the frame
// number in the associated data. See docs/SECURITY.md, «Мост».

import { sha256 } from '@noble/hashes/sha2.js';
import { b64, concat, pack, unb64 as decode64, unpack, utf8 } from '../../server/src/shared/wire.ts';
import { aeadOpen, aeadSeal, dh, equalBytes, generateDH, kdf, mac, random, type KeyPair } from './crypto/primitives.ts';

/** Crockford base32: no I, L, O, U, so the code survives being read aloud or retyped. */
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
export const CODE_LENGTH = 8;
export const ROOM_LENGTH = 4;
const CHUNK = 256 * 1024;
const WINDOW = 8;
const MAX_ATTEMPTS = 3;

export function newCode(length = CODE_LENGTH): string {
  return Array.from(random(length), (b) => ALPHABET[b & 31]).join('');
}

/** "k7qm 2xpa", "K7QM-2XPA", "K7QM2XPA" → "K7QM2XPA"; O→0, I/L→1, U→V. */
export function normalizeCode(input: string): string {
  return input
    .toUpperCase()
    .replace(/[^0-9A-Z]/g, '')
    .replace(/O/g, '0')
    .replace(/[IL]/g, '1')
    .replace(/U/g, 'V');
}

export const formatCode = (code: string) => code.match(/.{1,4}/g)?.join('-') ?? code;

/** Through the relay the code is longer: 4 characters name the room, the other 8 stay secret. */
export function splitRelayCode(code: string): { room: string; secret: string } | null {
  const clean = normalizeCode(code);
  if (clean.length !== ROOM_LENGTH + CODE_LENGTH) return null;
  return { room: clean.slice(0, ROOM_LENGTH), secret: clean.slice(ROOM_LENGTH) };
}

/** A two-way pipe for whole messages: a TCP socket on the local network, or a relay room. */
export interface BridgeChannel {
  send(data: Uint8Array): void;
  onData(callback: (data: Uint8Array) => void): void;
  onClose(callback: () => void): void;
  close(): void;
}

/** Where the host reads the account from (the open vault). */
export interface RecordSource {
  names(): Promise<string[]>;
  get(name: string): Promise<Uint8Array | null>;
}

export class BridgeError extends Error {
  readonly code: 'bad_code' | 'closed' | 'protocol' | 'cancelled';
  constructor(code: BridgeError['code'], message: string) {
    super(message);
    this.code = code;
  }
}

interface Keys {
  send: Uint8Array;
  recv: Uint8Array;
  proof: Uint8Array;
  sas: string;
}

function deriveKeys(role: 'host' | 'guest', own: KeyPair, peer: Uint8Array, hostNonce: Uint8Array, guestNonce: Uint8Array, code: string): Keys {
  const shared = dh(own.priv, peer);
  const [hostPub, guestPub] = role === 'host' ? [own.pub, peer] : [peer, own.pub];
  const transcript = sha256(concat(utf8('veil-bridge-v1'), hostPub, guestPub, hostNonce, guestNonce));
  const okm = kdf(shared, transcript, `veil-bridge-v1|${code}`, 96);
  const sasBytes = kdf(shared, transcript, 'veil-bridge-sas', 4);
  shared.fill(0);
  const sas = String(new DataView(sasBytes.buffer, sasBytes.byteOffset, 4).getUint32(0) % 1_000_000).padStart(6, '0');
  const hostToGuest = okm.slice(0, 32);
  const guestToHost = okm.slice(32, 64);
  return {
    send: role === 'host' ? hostToGuest : guestToHost,
    recv: role === 'host' ? guestToHost : hostToGuest,
    proof: okm.slice(64, 96),
    sas,
  };
}

const PLAIN = 0;
const SEALED = 1;
type Frame = { t: string; [key: string]: unknown };

/** Frame encoding shared by both sides: plain frames during the handshake, sealed ones after. */
class Framer {
  private sendSeq = 0;
  private recvSeq = 0;
  keys: Keys | null = null;

  plain(frame: Frame): Uint8Array {
    return concat(Uint8Array.of(PLAIN), pack(frame));
  }

  sealed(frame: Frame, body?: Uint8Array): Uint8Array {
    const ad = utf8(`veil-bridge-frame|${this.sendSeq++}`);
    const { nonce, ct } = aeadSeal(this.keys!.send, pack(frame, body), ad);
    return concat(Uint8Array.of(SEALED), nonce, ct);
  }

  read(data: Uint8Array): { frame: Frame; body: Uint8Array; sealed: boolean } {
    if (data[0] === PLAIN) {
      const { header, body } = unpack<Frame>(data.subarray(1));
      return { frame: header, body, sealed: false };
    }
    if (data[0] !== SEALED || !this.keys || data.length < 41) throw new BridgeError('protocol', 'Повреждённые данные');
    const ad = utf8(`veil-bridge-frame|${this.recvSeq++}`);
    let plaintext: Uint8Array;
    try {
      plaintext = aeadOpen(this.keys.recv, data.subarray(1, 25), data.subarray(25), ad);
    } catch {
      throw new BridgeError('protocol', 'Данные повреждены или подменены');
    }
    const { header, body } = unpack<Frame>(plaintext);
    return { frame: header, body, sealed: true };
  }
}

const unb64 = (text: unknown): Uint8Array => {
  try {
    return typeof text === 'string' ? decode64(text) : new Uint8Array(0);
  } catch {
    return new Uint8Array(0);
  }
};

export interface BridgeHostEvents {
  /** A new code (after too many wrong ones). */
  onCode?(code: string): void;
  /** A computer connected and proved the code: compare these digits, then call confirm(). */
  onSas?(sas: string): void;
  onProgress?(sent: number, total: number): void;
  /** The new computer imported everything: this one can be wiped now. */
  onDone?(): void;
  onError?(error: BridgeError): void;
}

/** The old computer: shows the code, checks the new one, sends the account after confirmation. */
export class BridgeHost {
  code: string;
  private readonly source: RecordSource;
  private readonly events: BridgeHostEvents;
  private channel: BridgeChannel | null = null;
  private framer = new Framer();
  private keyPair: KeyPair | null = null;
  private nonce = random(16);
  private attempts = 0;
  private verified = false;
  private confirmed = false;
  private acked = 0;
  private ackWaiter: (() => void) | null = null;
  private finished = false;

  constructor(source: RecordSource, events: BridgeHostEvents = {}, code = newCode()) {
    this.source = source;
    this.events = events;
    this.code = code;
  }

  /** A guest connected (one at a time). */
  attach(channel: BridgeChannel): void {
    if (this.channel || this.finished) return channel.close();
    this.channel = channel;
    this.framer = new Framer();
    this.keyPair = generateDH();
    this.nonce = random(16);
    this.verified = false;
    channel.onData((data) => {
      try {
        this.receive(data);
      } catch (error) {
        this.fail(error instanceof BridgeError ? error : new BridgeError('protocol', (error as Error).message));
      }
    });
    channel.onClose(() => {
      if (this.channel !== channel) return;
      this.channel = null;
      if (!this.finished && this.confirmed) this.events.onError?.(new BridgeError('closed', 'Соединение с новым ПК прервалось'));
    });
  }

  private receive(data: Uint8Array): void {
    const { frame, body } = this.framer.read(data);
    const channel = this.channel!;
    switch (frame.t) {
      case 'hello': {
        const guestPub = unb64(frame.pub);
        const guestNonce = unb64(frame.n);
        if (guestPub.length !== 32 || guestNonce.length !== 16) throw new BridgeError('protocol', 'Неверное приветствие');
        this.framer.keys = deriveKeys('host', this.keyPair!, guestPub, this.nonce, guestNonce, this.code);
        channel.send(this.framer.plain({ t: 'welcome', v: 1, pub: b64(this.keyPair!.pub), n: b64(this.nonce) }));
        return;
      }
      case 'proof': {
        const keys = this.framer.keys;
        if (!keys) throw new BridgeError('protocol', 'Нет приветствия');
        if (!equalBytes(unb64(frame.mac), mac(keys.proof, utf8('guest')))) {
          channel.send(this.framer.plain({ t: 'bad' }));
          this.channel = null;
          channel.close();
          if (++this.attempts >= MAX_ATTEMPTS) {
            this.attempts = 0;
            this.code = newCode();
            this.events.onCode?.(this.code);
          }
          return;
        }
        this.verified = true;
        channel.send(this.framer.plain({ t: 'ok', mac: b64(mac(keys.proof, utf8('host'))) }));
        this.events.onSas?.(keys.sas);
        return;
      }
      case 'ack':
        this.acked = Number(frame.n) || 0;
        this.ackWaiter?.();
        return;
      case 'done':
        this.finished = true;
        this.events.onDone?.();
        channel.close();
        return;
      case 'cancel':
        throw new BridgeError('cancelled', 'Перенос отменён на новом ПК');
      default:
        void body;
        throw new BridgeError('protocol', 'Неизвестный кадр');
    }
  }

  /** The person compared the six digits and they match: send everything. */
  async confirm(): Promise<void> {
    if (!this.verified || !this.channel || this.confirmed) return;
    this.confirmed = true;
    const channel = this.channel;
    const names = (await this.source.names()).sort((a, b) => (a === 'account' ? -1 : b === 'account' ? 1 : a.localeCompare(b)));
    const records: [string, Uint8Array][] = [];
    let total = 0;
    for (const name of names) {
      const bytes = await this.source.get(name);
      if (!bytes) continue;
      records.push([name, bytes]);
      total += bytes.length;
    }
    channel.send(this.framer.sealed({ t: 'begin', count: records.length, bytes: total }));
    let sent = 0;
    let chunks = 0;
    for (const [name, bytes] of records) {
      for (let offset = 0; offset < bytes.length || offset === 0; offset += CHUNK) {
        const part = bytes.subarray(offset, offset + CHUNK);
        const last = offset + CHUNK >= bytes.length;
        channel.send(this.framer.sealed({ t: 'rec', name, last }, part));
        sent += part.length;
        chunks++;
        this.events.onProgress?.(sent, total);
        // Flow control: at most WINDOW chunks on the way.
        while (chunks - this.acked > WINDOW) {
          if (this.channel !== channel) throw new BridgeError('closed', 'Соединение с новым ПК прервалось');
          await new Promise<void>((resolve) => {
            this.ackWaiter = resolve;
            setTimeout(resolve, 1000);
          });
        }
        if (last) break;
      }
    }
    channel.send(this.framer.sealed({ t: 'end', chunks }));
  }

  close(): void {
    this.finished = true;
    this.channel?.close();
    this.channel = null;
  }

  private fail(error: BridgeError): void {
    this.channel?.close();
    this.channel = null;
    this.confirmed = false;
    this.events.onError?.(error);
  }
}

export interface BridgeGuestEvents {
  /** The old computer knows the code: show these digits for comparison. */
  onSas?(sas: string): void;
  onProgress?(received: number, total: number): void;
  /** Everything arrived: import it, then call finish(). */
  onRecords?(records: Map<string, Uint8Array>): void;
  onError?(error: BridgeError): void;
}

/** The new computer: proves the code and receives the account. */
export class BridgeGuest {
  private readonly channel: BridgeChannel;
  private readonly code: string;
  private readonly events: BridgeGuestEvents;
  private readonly framer = new Framer();
  private readonly keyPair = generateDH();
  private readonly nonce = random(16);
  private readonly records = new Map<string, Uint8Array[]>();
  private chunks = 0;
  private received = 0;
  private total = 0;
  private trusted = false;
  private done = false;

  constructor(channel: BridgeChannel, code: string, events: BridgeGuestEvents = {}) {
    this.channel = channel;
    this.code = normalizeCode(code);
    this.events = events;
    channel.onData((data) => {
      try {
        this.receive(data);
      } catch (error) {
        this.fail(error instanceof BridgeError ? error : new BridgeError('protocol', (error as Error).message));
      }
    });
    channel.onClose(() => {
      if (!this.done) this.events.onError?.(new BridgeError('closed', 'Соединение со старым ПК прервалось'));
      this.done = true;
    });
  }

  start(): void {
    this.channel.send(this.framer.plain({ t: 'hello', v: 1, pub: b64(this.keyPair.pub), n: b64(this.nonce) }));
  }

  private receive(data: Uint8Array): void {
    const { frame, body, sealed } = this.framer.read(data);
    switch (frame.t) {
      case 'welcome': {
        const hostPub = unb64(frame.pub);
        const hostNonce = unb64(frame.n);
        if (hostPub.length !== 32 || hostNonce.length !== 16) throw new BridgeError('protocol', 'Неверный ответ');
        this.framer.keys = deriveKeys('guest', this.keyPair, hostPub, hostNonce, this.nonce, this.code);
        this.channel.send(this.framer.plain({ t: 'proof', mac: b64(mac(this.framer.keys.proof, utf8('guest'))) }));
        return;
      }
      case 'bad':
        this.done = true;
        throw new BridgeError('bad_code', 'Неверный код. Проверьте его на старом ПК');
      case 'ok':
        if (!this.framer.keys || !equalBytes(unb64(frame.mac), mac(this.framer.keys.proof, utf8('host'))))
          throw new BridgeError('protocol', 'Старый ПК не подтвердил код');
        this.trusted = true;
        this.events.onSas?.(this.framer.keys.sas);
        return;
    }
    if (!sealed || !this.trusted) throw new BridgeError('protocol', 'Неожиданные данные');
    switch (frame.t) {
      case 'begin':
        this.total = Number(frame.bytes) || 0;
        return;
      case 'rec': {
        const name = String(frame.name ?? '');
        if (!name || name.length > 200) throw new BridgeError('protocol', 'Неверная запись');
        const parts = this.records.get(name) ?? [];
        parts.push(body.slice());
        this.records.set(name, parts);
        this.received += body.length;
        this.events.onProgress?.(this.received, this.total);
        if (++this.chunks % (WINDOW / 2) === 0) this.channel.send(this.framer.sealed({ t: 'ack', n: this.chunks }));
        return;
      }
      case 'end': {
        if (Number(frame.chunks) !== this.chunks) throw new BridgeError('protocol', 'Пришли не все данные');
        this.channel.send(this.framer.sealed({ t: 'ack', n: this.chunks }));
        const records = new Map<string, Uint8Array>();
        for (const [name, parts] of this.records) records.set(name, concat(...parts));
        this.records.clear();
        if (!records.has('account')) throw new BridgeError('protocol', 'В переносе нет аккаунта');
        this.events.onRecords?.(records);
        return;
      }
      default:
        throw new BridgeError('protocol', 'Неизвестный кадр');
    }
  }

  /** The import worked: the old computer may wipe itself. */
  finish(): void {
    if (this.done) return;
    this.done = true;
    this.channel.send(this.framer.sealed({ t: 'done' }));
    setTimeout(() => this.channel.close(), 500);
  }

  cancel(): void {
    if (this.done) return;
    this.done = true;
    if (this.framer.keys && this.trusted) this.channel.send(this.framer.sealed({ t: 'cancel' }));
    this.channel.close();
  }

  private fail(error: BridgeError): void {
    this.done = true;
    this.channel.close();
    this.events.onError?.(error);
  }
}

/** Two connected in-memory channels (tests). */
export function channelPair(): [BridgeChannel, BridgeChannel] {
  const make = () => {
    let data: (d: Uint8Array) => void = () => {};
    let close: () => void = () => {};
    return { setData: (cb: typeof data) => (data = cb), setClose: (cb: typeof close) => (close = cb), deliver: (d: Uint8Array) => data(d), closed: () => close() };
  };
  const a = make();
  const b = make();
  let open = true;
  const shut = () => {
    if (!open) return;
    open = false;
    queueMicrotask(() => {
      a.closed();
      b.closed();
    });
  };
  const side = (self: ReturnType<typeof make>, other: ReturnType<typeof make>): BridgeChannel => ({
    // Like a socket: whatever was sent before close() still arrives, in order.
    send: (d) => open && queueMicrotask(() => other.deliver(d.slice())),
    onData: (cb) => self.setData(cb),
    onClose: (cb) => self.setClose(cb),
    close: shut,
  });
  return [side(a, b), side(b, a)];
}
