// Encryption of everything stored on disk.
//
// A random 256-bit data key encrypts every record; the data key itself is wrapped with
// a key derived from the user's password via scrypt (memory-hard, 128 MiB). Changing
// the password only re-wraps the data key. Each record is bound to its name as AEAD
// associated data, so encrypted records cannot be swapped around on disk.

import { scryptAsync } from '@noble/hashes/scrypt.js';
import { b64, concat, unb64, utf8 } from '../../../server/src/shared/wire.ts';
import { aeadOpen, aeadSeal, random, wipe } from './primitives.ts';

export interface VaultMeta {
  v: 1;
  kdf: { alg: 'scrypt'; N: number; r: number; p: number; salt: string };
  wrapped: { nonce: string; ct: string };
}

export const DEFAULT_KDF = { N: 2 ** 17, r: 8, p: 1 };

async function passwordKey(password: string, params: VaultMeta['kdf'], onProgress?: (p: number) => void) {
  return scryptAsync(utf8(password.normalize('NFKC')), unb64(params.salt), {
    N: params.N,
    r: params.r,
    p: params.p,
    dkLen: 32,
    maxmem: 2 ** 30,
    onProgress,
  });
}

const WRAP_AD = utf8('veil-vault-key-v1');

export async function createVault(
  password: string,
  kdfParams = DEFAULT_KDF,
  onProgress?: (p: number) => void,
): Promise<{ meta: VaultMeta; dataKey: Uint8Array }> {
  const dataKey = random(32);
  const meta = await wrapDataKey(dataKey, password, kdfParams, onProgress);
  return { meta, dataKey };
}

async function wrapDataKey(
  dataKey: Uint8Array,
  password: string,
  kdfParams: { N: number; r: number; p: number },
  onProgress?: (p: number) => void,
): Promise<VaultMeta> {
  const kdf = { alg: 'scrypt' as const, ...kdfParams, salt: b64(random(16)) };
  const key = await passwordKey(password, kdf, onProgress);
  const { nonce, ct } = aeadSeal(key, dataKey, WRAP_AD);
  wipe(key);
  return { v: 1, kdf, wrapped: { nonce: b64(nonce), ct: b64(ct) } };
}

/** Throws `WrongPasswordError` if the password is incorrect. */
export async function unlockVault(meta: VaultMeta, password: string, onProgress?: (p: number) => void): Promise<Uint8Array> {
  const key = await passwordKey(password, meta.kdf, onProgress);
  try {
    return aeadOpen(key, unb64(meta.wrapped.nonce), unb64(meta.wrapped.ct), WRAP_AD);
  } catch {
    throw new WrongPasswordError();
  } finally {
    wipe(key);
  }
}

export async function changeVaultPassword(meta: VaultMeta, oldPassword: string, newPassword: string): Promise<VaultMeta> {
  const dataKey = await unlockVault(meta, oldPassword);
  const { N, r, p } = meta.kdf;
  return wrapDataKey(dataKey, newPassword, { N, r, p });
}

export class WrongPasswordError extends Error {
  constructor() {
    super('Неверный пароль');
    this.name = 'WrongPasswordError';
  }
}

const recordAd = (name: string) => utf8(`veil-record-v1|${name}`);

export function encryptRecord(dataKey: Uint8Array, name: string, plaintext: Uint8Array): Uint8Array {
  const { nonce, ct } = aeadSeal(dataKey, plaintext, recordAd(name));
  return concat(Uint8Array.of(1), nonce, ct);
}

export function decryptRecord(dataKey: Uint8Array, name: string, data: Uint8Array): Uint8Array {
  if (data[0] !== 1 || data.length < 25) throw new Error('Vault: unsupported record');
  return aeadOpen(dataKey, data.subarray(1, 25), data.subarray(25), recordAd(name));
}
