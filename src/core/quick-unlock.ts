// Quick unlock: the vault key, wrapped with a key derived from a short PIN, is kept in the
// system keychain (DPAPI on Windows, libsecret/KWallet on Linux via Electron safeStorage).
// Both are needed to open Veil this way, and five wrong PINs delete the wrapped key, after
// which only the full password works. The counter lives in the app: a program that copies the
// wrapped key can guess offline, which the PIN's length and the slow scrypt are there to slow down.

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

/**
 * A new PIN: 6–12 digits. A 4-digit PIN has only 10⁴ values, so whoever copies the wrapped key off
 * the disk tries them all in moments; 6+ digits and a slow scrypt make that hours to years. PINs
 * made by older versions (4–8 digits) still open Veil, and Settings asks to replace them.
 */
export const PIN_RE = /^\d{6,12}$/;
export const ANY_PIN_RE = /^\d{4,12}$/;
export const MAX_PIN_ATTEMPTS = 5;
/** About a second per guess on a laptop (and 256 MiB of memory, which GPUs do badly). */
export const PIN_KDF = { N: 2 ** 18, r: 8, p: 1 };

/** Made before 2.2.3 (weaker scrypt, maybe 4 digits): Settings suggests a new PIN. */
export const isOldPin = (blob: PinBlob) => blob.kdf.N < PIN_KDF.N;

/** 123456, 111111, 654321 and the like: the first guesses anyone makes. */
export function isTrivialPin(pin: string): boolean {
  return /^(\d)\1+$/.test(pin) || '01234567890123'.includes(pin) || '98765432109876'.includes(pin) || /^(\d\d)\1+$/.test(pin) || /^(\d\d\d)\1+$/.test(pin);
}
const AD = utf8('veil-pin-v1');

async function pinKey(pin: string, kdf: PinBlob['kdf']): Promise<Uint8Array> {
  return scryptAsync(utf8(pin), unb64(kdf.salt), { N: kdf.N, r: kdf.r, p: kdf.p, dkLen: 32, maxmem: 2 ** 29 });
}

export async function wrapWithPin(dataKey: Uint8Array, pin: string, params = PIN_KDF): Promise<PinBlob> {
  if (!PIN_RE.test(pin)) throw new Error('PIN: от 6 до 12 цифр');
  if (isTrivialPin(pin)) throw new Error('Слишком простой PIN');
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
