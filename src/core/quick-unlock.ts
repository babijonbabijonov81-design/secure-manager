// Quick unlock: the vault key, wrapped with a key derived from a short PIN, is kept in the
// system keychain (DPAPI on Windows, libsecret/KWallet on Linux via Electron safeStorage).
// Both are needed to open Veil this way, and five wrong PINs delete the wrapped key, after
// which only the full password works.

import { scryptAsync } from '@noble/hashes/scrypt.js';
import { b64, unb64, utf8 } from '../../server/src/shared/wire.ts';
import { aeadOpen, aeadSeal, random, wipe } from './crypto/primitives.ts';
import { WrongPasswordError } from './crypto/vault.ts';

export interface PinBlob {
  v: 1;
  kdf: { N: number; r: number; p: number; salt: string };
  nonce: string;
  ct: string;
}

export const PIN_RE = /^\d{4,8}$/;
export const MAX_PIN_ATTEMPTS = 5;
const PIN_KDF = { N: 2 ** 16, r: 8, p: 1 };
const AD = utf8('veil-pin-v1');

async function pinKey(pin: string, kdf: PinBlob['kdf']): Promise<Uint8Array> {
  return scryptAsync(utf8(pin), unb64(kdf.salt), { N: kdf.N, r: kdf.r, p: kdf.p, dkLen: 32, maxmem: 2 ** 28 });
}

export async function wrapWithPin(dataKey: Uint8Array, pin: string, params = PIN_KDF): Promise<PinBlob> {
  if (!PIN_RE.test(pin)) throw new Error('PIN: от 4 до 8 цифр');
  const kdf = { ...params, salt: b64(random(16)) };
  const key = await pinKey(pin, kdf);
  const { nonce, ct } = aeadSeal(key, dataKey, AD);
  wipe(key);
  return { v: 1, kdf, nonce: b64(nonce), ct: b64(ct) };
}

/** Throws WrongPasswordError for a wrong PIN. */
export async function unwrapWithPin(blob: PinBlob, pin: string): Promise<Uint8Array> {
  const key = await pinKey(pin, blob.kdf);
  try {
    return aeadOpen(key, unb64(blob.nonce), unb64(blob.ct), AD);
  } catch {
    throw new WrongPasswordError();
  } finally {
    wipe(key);
  }
}
