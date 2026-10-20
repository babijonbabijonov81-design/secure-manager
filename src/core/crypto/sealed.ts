// "Sealed sender" envelopes: the outer layer that the relay stores and forwards.
//
// The sender's identity and the Double Ratchet message are encrypted to the recipient's
// identity key with a one-off ephemeral key, so the relay learns neither who wrote the
// envelope nor any ratchet metadata. Plaintext is padded (Padmé) so that the envelope
// size reveals very little about the message length.

import { verifyDhKey } from './x3dh.ts';
import { b64, concat, pack, u32, unb64Len, unpack } from '../../../server/src/shared/wire.ts';
import { aeadOpen, aeadSeal, dh, generateDH, kdf, type KeyPair } from './primitives.ts';

export interface SenderInfo {
  /** Sender userId (Ed25519 identity key). */
  from: string;
  /** Sender X25519 identity key and its signature by `from`. */
  fd: string;
  fs: string;
}

interface EnvelopeHeader {
  v: 1;
  e: string;
  n: string;
}

const INFO = 'Veil-Sealed-v1';

/** Padmé padding (Nikitin et al.): at most ~12% overhead, leaks O(log log L) bits. */
export function padmeLength(length: number): number {
  if (length <= 256) return 256;
  const e = Math.floor(Math.log2(length));
  const s = Math.floor(Math.log2(e)) + 1;
  const mask = 2 ** (e - s) - 1;
  return Math.ceil((length + mask) / (mask + 1)) * (mask + 1);
}

function pad(data: Uint8Array): Uint8Array {
  const total = padmeLength(data.length + 4);
  const out = new Uint8Array(total);
  out.set(u32(data.length), 0);
  out.set(data, 4);
  // The remainder stays zero-filled; it is encrypted together with the payload.
  return out;
}

function unpad(data: Uint8Array): Uint8Array {
  if (data.length < 4) throw new Error('Sealed: bad padding');
  const length = new DataView(data.buffer, data.byteOffset, data.byteLength).getUint32(0, false);
  if (length > data.length - 4) throw new Error('Sealed: bad padding');
  return data.subarray(4, 4 + length);
}

export function sealEnvelope(recipientDhPub: Uint8Array, sender: SenderInfo, wire: Uint8Array): Uint8Array {
  const ephemeral = generateDH();
  const binding = concat(ephemeral.pub, recipientDhPub);
  const key = kdf(dh(ephemeral.priv, recipientDhPub), binding, INFO, 32);
  const { nonce, ct } = aeadSeal(key, pad(pack(sender, wire)), binding);
  const header: EnvelopeHeader = { v: 1, e: b64(ephemeral.pub), n: b64(nonce) };
  return pack(header, ct);
}

export function openEnvelope(myDh: KeyPair, envelope: Uint8Array): { sender: SenderInfo; wire: Uint8Array } {
  const { header, body } = unpack<EnvelopeHeader>(envelope);
  const ephemeralPub = unb64Len(header.e, 32);
  const nonce = unb64Len(header.n, 24);
  if (header.v !== 1 || !ephemeralPub || !nonce) throw new Error('Sealed: unsupported envelope');
  const binding = concat(ephemeralPub, myDh.pub);
  const key = kdf(dh(myDh.priv, ephemeralPub), binding, INFO, 32);
  const inner = unpad(aeadOpen(key, nonce, body, binding));
  const { header: sender, body: wire } = unpack<SenderInfo>(inner);
  const signPub = unb64Len(sender.from, 32);
  const dhPub = unb64Len(sender.fd, 32);
  const dhSig = unb64Len(sender.fs, 64);
  if (!signPub || !dhPub || !dhSig || !verifyDhKey(signPub, dhPub, dhSig)) throw new Error('Sealed: invalid sender keys');
  return { sender, wire: wire.slice() };
}
