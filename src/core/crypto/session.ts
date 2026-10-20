// Sessions tie X3DH and the Double Ratchet together and define the inner wire format.
//
// Until the initiator hears back from the peer, every message carries the X3DH header
// ("pre" message), so the peer can set up the session from whichever message arrives
// first. Typing indicators use a separate per-session key ("eph" messages) so that
// signals dropped by the relay never desynchronise the ratchet.

import { b64, concat, pack, unb64, unb64Len, unpack, utf8 } from '../../../server/src/shared/wire.ts';
import { aeadOpen, aeadSeal, kdf, type KeyPair } from './primitives.ts';
import {
  initInitiator,
  initResponder,
  ratchetDecrypt,
  ratchetEncrypt,
  type MessageHeader,
  type RatchetState,
} from './ratchet.ts';
import { x3dhInitiate, x3dhRespond, type IdentityKeys, type PublicIdentity, type RemoteBundle } from './x3dh.ts';

export interface X3DHHeader {
  ek: string;
  spk: number;
  opk?: number;
}

export interface SessionRecord {
  /** The initiator's X3DH ephemeral key: unique per session and known to both sides. */
  id: string;
  ratchet: RatchetState;
  ad: string;
  eph: string;
  pending?: X3DHHeader;
  /** Archived sessions still decrypt late messages but are never used for sending. */
  archived?: boolean;
  createdAt: number;
  usedAt: number;
}

export interface WireHeader {
  k: 'pre' | 'msg' | 'eph';
  sid: string;
  x?: X3DHHeader;
  h?: MessageHeader;
  n: string;
}

const ZERO_SALT = new Uint8Array(32);
const ephemeralKey = (sk: Uint8Array) => b64(kdf(sk, ZERO_SALT, 'Veil-Ephemeral-v1', 32));
const ephemeralAd = (session: SessionRecord) => concat(utf8('veil-eph-v1'), unb64(session.ad), unb64(session.id));

export function createInitiatorSession(me: IdentityKeys, bundle: RemoteBundle): SessionRecord {
  const { sk, ad, ephemeral } = x3dhInitiate(me, bundle);
  const id = b64(ephemeral.pub);
  const now = Date.now();
  return {
    id,
    ratchet: initInitiator(sk, bundle.spkPub),
    ad: b64(ad),
    eph: ephemeralKey(sk),
    pending: { ek: id, spk: bundle.spkId, ...(bundle.opkId !== undefined ? { opk: bundle.opkId } : {}) },
    createdAt: now,
    usedAt: now,
  };
}

export function createResponderSession(
  me: IdentityKeys,
  signedPreKey: KeyPair,
  oneTimePreKey: KeyPair | null,
  sender: PublicIdentity,
  x3dh: X3DHHeader,
): SessionRecord {
  const ek = unb64Len(x3dh.ek, 32);
  if (!ek) throw new Error('Session: bad X3DH header');
  const { sk, ad } = x3dhRespond(me, signedPreKey, oneTimePreKey, sender, ek);
  const now = Date.now();
  return {
    id: x3dh.ek,
    ratchet: initResponder(sk, signedPreKey),
    ad: b64(ad),
    eph: ephemeralKey(sk),
    createdAt: now,
    usedAt: now,
  };
}

export function sessionEncrypt(session: SessionRecord, plaintext: Uint8Array): { session: SessionRecord; wire: Uint8Array } {
  const { state, message } = ratchetEncrypt(session.ratchet, plaintext, unb64(session.ad));
  const header: WireHeader = {
    k: session.pending ? 'pre' : 'msg',
    sid: session.id,
    ...(session.pending ? { x: session.pending } : {}),
    h: message.header,
    n: b64(message.nonce),
  };
  return { session: { ...session, ratchet: state, usedAt: Date.now() }, wire: pack(header, message.ct) };
}

export function sessionDecrypt(
  session: SessionRecord,
  header: WireHeader,
  body: Uint8Array,
): { session: SessionRecord; plaintext: Uint8Array } {
  const nonce = unb64Len(header.n, 24);
  if (!nonce || !header.h) throw new Error('Session: malformed message');
  const { state, plaintext } = ratchetDecrypt(session.ratchet, { header: header.h, nonce, ct: body }, unb64(session.ad));
  // Hearing back from the peer proves they have the session: stop sending X3DH headers.
  const next: SessionRecord = { ...session, ratchet: state, usedAt: Date.now() };
  delete next.pending;
  return { session: next, plaintext };
}

export function ephemeralEncrypt(session: SessionRecord, plaintext: Uint8Array): Uint8Array {
  const { nonce, ct } = aeadSeal(unb64(session.eph), plaintext, ephemeralAd(session));
  const header: WireHeader = { k: 'eph', sid: session.id, n: b64(nonce) };
  return pack(header, ct);
}

export function ephemeralDecrypt(session: SessionRecord, header: WireHeader, body: Uint8Array): Uint8Array {
  const nonce = unb64Len(header.n, 24);
  if (!nonce) throw new Error('Session: malformed signal');
  return aeadOpen(unb64(session.eph), nonce, body, ephemeralAd(session));
}

export function parseWire(wire: Uint8Array): { header: WireHeader; body: Uint8Array } {
  const { header, body } = unpack<WireHeader>(wire);
  if (!['pre', 'msg', 'eph'].includes(header.k) || typeof header.sid !== 'string') throw new Error('Session: unknown message');
  return { header, body };
}
