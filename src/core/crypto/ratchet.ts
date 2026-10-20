// Double Ratchet, following Signal's specification:
// https://signal.org/docs/specifications/doubleratchet/
//
// Every message is encrypted with a fresh key (forward secrecy), and every reply mixes
// in a new Diffie-Hellman exchange (post-compromise security). The state is a plain
// JSON object; encrypt/decrypt never mutate their input, so a message that fails to
// authenticate leaves the session untouched.

import { b64, concat, u32, unb64 } from '../../../server/src/shared/wire.ts';
import {
  aeadOpen,
  aeadSeal,
  dh,
  generateDH,
  kdf,
  keyPairToJSON,
  mac,
  type KeyPair,
  type KeyPairJSON,
} from './primitives.ts';

const MAX_SKIP = 1000;
const MAX_SKIPPED_TOTAL = 2000;
const ZERO_SALT = new Uint8Array(32);

export interface RatchetState {
  dhs: KeyPairJSON;
  dhr: string | null;
  rk: string;
  cks: string | null;
  ckr: string | null;
  ns: number;
  nr: number;
  pn: number;
  /** Message keys of messages that have not arrived yet, oldest first: [`${dh}:${n}`, key]. */
  skipped: [string, string][];
}

export interface MessageHeader {
  dh: string;
  pn: number;
  n: number;
}

export interface EncryptedMessage {
  header: MessageHeader;
  nonce: Uint8Array;
  ct: Uint8Array;
}

function kdfRootKey(rk: Uint8Array, dhOut: Uint8Array): [Uint8Array, Uint8Array] {
  const out = kdf(dhOut, rk, 'Veil-Ratchet-v1', 64);
  return [out.slice(0, 32), out.slice(32)];
}

function kdfChainKey(ck: Uint8Array): [Uint8Array, Uint8Array] {
  return [mac(ck, Uint8Array.of(0x02)), mac(ck, Uint8Array.of(0x01))];
}

const aeadKey = (mk: Uint8Array) => kdf(mk, ZERO_SALT, 'Veil-MessageKey-v1', 32);

export function encodeHeader(header: MessageHeader): Uint8Array {
  return concat(unb64(header.dh), u32(header.pn), u32(header.n));
}

const clone = (state: RatchetState): RatchetState => ({ ...state, dhs: { ...state.dhs }, skipped: [...state.skipped] });

export function initInitiator(sk: Uint8Array, remoteRatchetKey: Uint8Array): RatchetState {
  const dhs = generateDH();
  const [rk, cks] = kdfRootKey(sk, dh(dhs.priv, remoteRatchetKey));
  return { dhs: keyPairToJSON(dhs), dhr: b64(remoteRatchetKey), rk: b64(rk), cks: b64(cks), ckr: null, ns: 0, nr: 0, pn: 0, skipped: [] };
}

export function initResponder(sk: Uint8Array, ratchetKeyPair: KeyPair): RatchetState {
  return { dhs: keyPairToJSON(ratchetKeyPair), dhr: null, rk: b64(sk), cks: null, ckr: null, ns: 0, nr: 0, pn: 0, skipped: [] };
}

export function ratchetEncrypt(
  input: RatchetState,
  plaintext: Uint8Array,
  ad: Uint8Array,
): { state: RatchetState; message: EncryptedMessage } {
  if (!input.cks) throw new Error('Ratchet: no sending chain yet');
  const state = clone(input);
  const [ck, mk] = kdfChainKey(unb64(state.cks!));
  state.cks = b64(ck);
  const header: MessageHeader = { dh: state.dhs.pub, pn: state.pn, n: state.ns };
  state.ns += 1;
  const { nonce, ct } = aeadSeal(aeadKey(mk), plaintext, concat(ad, encodeHeader(header)));
  return { state, message: { header, nonce, ct } };
}

function validHeader(header: MessageHeader): boolean {
  const okInt = (v: unknown) => Number.isInteger(v) && (v as number) >= 0 && (v as number) <= 0xffffffff;
  if (!header || typeof header.dh !== 'string' || !okInt(header.pn) || !okInt(header.n)) return false;
  try {
    return unb64(header.dh).length === 32;
  } catch {
    return false;
  }
}

function skipMessageKeys(state: RatchetState, until: number): void {
  if (!state.ckr) return;
  if (until - state.nr > MAX_SKIP) throw new Error('Ratchet: too many skipped messages');
  let ck = unb64(state.ckr);
  while (state.nr < until) {
    const [nextCk, mk] = kdfChainKey(ck);
    state.skipped.push([`${state.dhr}:${state.nr}`, b64(mk)]);
    ck = nextCk;
    state.nr += 1;
  }
  state.ckr = b64(ck);
  if (state.skipped.length > MAX_SKIPPED_TOTAL) state.skipped.splice(0, state.skipped.length - MAX_SKIPPED_TOTAL);
}

function dhRatchet(state: RatchetState, header: MessageHeader): void {
  state.pn = state.ns;
  state.ns = 0;
  state.nr = 0;
  state.dhr = header.dh;
  const remote = unb64(header.dh);
  const [rk1, ckr] = kdfRootKey(unb64(state.rk), dh(unb64(state.dhs.priv), remote));
  const next = generateDH();
  const [rk2, cks] = kdfRootKey(rk1, dh(next.priv, remote));
  state.rk = b64(rk2);
  state.ckr = b64(ckr);
  state.cks = b64(cks);
  state.dhs = keyPairToJSON(next);
}

export function ratchetDecrypt(
  input: RatchetState,
  message: EncryptedMessage,
  ad: Uint8Array,
): { state: RatchetState; plaintext: Uint8Array } {
  const { header, nonce, ct } = message;
  if (!validHeader(header)) throw new Error('Ratchet: malformed header');
  const state = clone(input);
  const fullAd = concat(ad, encodeHeader(header));

  const skippedKey = `${header.dh}:${header.n}`;
  const index = state.skipped.findIndex(([id]) => id === skippedKey);
  if (index >= 0) {
    const plaintext = aeadOpen(aeadKey(unb64(state.skipped[index][1])), nonce, ct, fullAd);
    state.skipped.splice(index, 1);
    return { state, plaintext };
  }

  if (header.dh !== state.dhr) {
    skipMessageKeys(state, header.pn);
    dhRatchet(state, header);
  }
  if (header.n < state.nr) throw new Error('Ratchet: message replayed or key already used');
  skipMessageKeys(state, header.n);
  const [ck, mk] = kdfChainKey(unb64(state.ckr!));
  state.ckr = b64(ck);
  state.nr += 1;
  const plaintext = aeadOpen(aeadKey(mk), nonce, ct, fullAd);
  return { state, plaintext };
}
