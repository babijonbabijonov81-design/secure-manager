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
  /**
   * Second slot: the key of the empty Veil opened by the duress password. Always present — filled
   * with random bytes of the same size when no duress password is set — so the file does not tell.
   */
  alt?: { nonce: string; ct: string };
}

/** Random bytes shaped like a wrapped 32-byte key (24-byte nonce, 48-byte ciphertext). */
const randomSlot = () => ({ nonce: b64(random(24)), ct: b64(random(48)) });

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
  kdfParams: { N: number; r: number; p: number; salt?: string },
  onProgress?: (p: number) => void,
): Promise<VaultMeta> {
  const kdf = { alg: 'scrypt' as const, N: kdfParams.N, r: kdfParams.r, p: kdfParams.p, salt: kdfParams.salt ?? b64(random(16)) };
  const key = await passwordKey(password, kdf, onProgress);
  const { nonce, ct } = aeadSeal(key, dataKey, WRAP_AD);
  wipe(key);
  return { v: 1, kdf, wrapped: { nonce: b64(nonce), ct: b64(ct) }, alt: randomSlot() };
}

/**
 * Logging in: one scrypt for whatever password was typed, then both slots are tried. The real
 * password opens 'main', the duress password 'alt'; the time is the same either way.
 */
export async function openVaultSlot(
  meta: VaultMeta,
  password: string,
  onProgress?: (p: number) => void,
): Promise<{ slot: 'main' | 'alt'; dataKey: Uint8Array }> {
  const key = await passwordKey(password, meta.kdf, onProgress);
  const attempt = (slot: { nonce: string; ct: string } | undefined) => {
    if (!slot) return null;
    try {
      return aeadOpen(key, unb64(slot.nonce), unb64(slot.ct), WRAP_AD);
    } catch {
      return null;
    }
  };
  try {
    const main = attempt(meta.wrapped);
    const alt = attempt(meta.alt);
    if (main) return { slot: 'main', dataKey: main };
    if (alt) return { slot: 'alt', dataKey: alt };
    throw new WrongPasswordError();
  } finally {
    wipe(key);
  }
}

/** Puts the duress key into the second slot, under the same salt as the real password. */
export async function setDuressSlot(meta: VaultMeta, duressPassword: string, altKey: Uint8Array): Promise<VaultMeta> {
  const key = await passwordKey(duressPassword, meta.kdf);
  const { nonce, ct } = aeadSeal(key, altKey, WRAP_AD);
  wipe(key);
  return { ...meta, alt: { nonce: b64(nonce), ct: b64(ct) } };
}

/** No duress password: the second slot holds random bytes again. */
export const clearDuressSlot = (meta: VaultMeta): VaultMeta => ({ ...meta, alt: randomSlot() });

/** Vaults from before 2.0 get the random second slot on their next unlock. */
export const withDuressSlot = (meta: VaultMeta): VaultMeta => (meta.alt ? meta : { ...meta, alt: randomSlot() });

/** "Стереть всё": the real slot becomes random too, so the real password stops opening anything. */
export const destroyMainSlot = (meta: VaultMeta): VaultMeta => ({ ...meta, wrapped: randomSlot() });

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

/** Re-wraps the real key only. The salt stays, so the duress slot keeps working. */
export async function changeVaultPassword(meta: VaultMeta, oldPassword: string, newPassword: string): Promise<VaultMeta> {
  const dataKey = await unlockVault(meta, oldPassword);
  const { N, r, p, salt } = meta.kdf;
  const next = await wrapDataKey(dataKey, newPassword, { N, r, p, salt });
  return { ...next, alt: meta.alt ?? next.alt };
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

// ---- server backups -------------------------------------------------------------------
// The backup key is derived from the password with its own salt, so the server-side
// copy can only be opened by someone who knows the password.

const BACKUP_AD = utf8('veil-backup-v1');

export async function deriveBackupKey(
  password: string,
  kdfParams: { N: number; r: number; p: number; salt?: string } = DEFAULT_KDF,
): Promise<{ key: Uint8Array; kdf: VaultMeta['kdf'] }> {
  const kdf = { alg: 'scrypt' as const, N: kdfParams.N, r: kdfParams.r, p: kdfParams.p, salt: kdfParams.salt ?? b64(random(16)) };
  return { key: await passwordKey(password, kdf), kdf };
}

export function sealBackup(key: Uint8Array, plaintext: Uint8Array): { nonce: Uint8Array; ct: Uint8Array } {
  return aeadSeal(key, plaintext, BACKUP_AD);
}

/** Throws `WrongPasswordError` if the key (password) is wrong. */
export function openBackup(key: Uint8Array, nonce: Uint8Array, ct: Uint8Array): Uint8Array {
  try {
    return aeadOpen(key, nonce, ct, BACKUP_AD);
  } catch {
    throw new WrongPasswordError();
  }
}

/** Checks a password against the local vault without changing anything. */
export async function verifyVaultPassword(meta: VaultMeta, password: string): Promise<boolean> {
  try {
    wipe(await unlockVault(meta, password));
    return true;
  } catch {
    return false;
  }
}
