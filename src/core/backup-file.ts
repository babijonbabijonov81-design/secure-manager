// «Резервная копия .veil»: the whole account in one file, encrypted with a separate backup
// password, that restores on any computer — Windows to Linux and back.
//
//   file  = "VEILBAK1\n" ‖ header JSON ‖ "\n" ‖ chunks
//   key   = scrypt(backup password, header.salt, N = 2^17, r = 8, p = 1)
//   chunk = nonce(24) ‖ length(u32) ‖ XChaCha20-Poly1305(key, 1 MiB of gzip(records), AD = "veil-file-v1|i|last")
//
// Chunk numbers and the "last" flag are in the associated data, so chunks cannot be reordered,
// dropped or cut off without the file failing to open. Ratchet sessions are not included: after
// a restore the device starts fresh sessions with every contact, like the server backup.

import { scryptAsync } from '@noble/hashes/scrypt.js';
import { b64, concat, fromUtf8, unb64, utf8 } from '../../server/src/shared/wire.ts';
import { compress, decompress } from './compress.ts';
import { aeadOpen, aeadSeal, random, wipe } from './crypto/primitives.ts';
import { WrongPasswordError } from './crypto/vault.ts';

const MAGIC = 'VEILBAK1\n';
const CHUNK = 1024 * 1024;
const KDF = { N: 2 ** 17, r: 8, p: 1 };

export interface BackupHeader {
  v: 1;
  kdf: { N: number; r: number; p: number; salt: string };
  createdAt: number;
  /** Shown before the password is typed: no names, just how much is inside. */
  records: number;
}

/**
 * Records that never go into a .veil file: ratchet and sender-key state, delivery bookkeeping, and
 * the OneDrive sign-in with its copy key.
 */
export const BACKUP_SKIPPED = new Set(['sessions', 'outbox', 'seen', 'gkeys', 'cloud']);

const key = (password: string, kdf: BackupHeader['kdf']) =>
  scryptAsync(utf8(password.normalize('NFKC')), unb64(kdf.salt), { N: kdf.N, r: kdf.r, p: kdf.p, dkLen: 32, maxmem: 2 ** 30 });

function packRecords(records: Map<string, Uint8Array>): Uint8Array {
  const parts: Uint8Array[] = [];
  for (const [name, data] of records) {
    const nameBytes = utf8(name);
    const head = new Uint8Array(6);
    const view = new DataView(head.buffer);
    view.setUint16(0, nameBytes.length);
    view.setUint32(2, data.length);
    parts.push(head, nameBytes, data);
  }
  return concat(...parts);
}

function unpackRecords(data: Uint8Array): Map<string, Uint8Array> {
  const records = new Map<string, Uint8Array>();
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let offset = 0;
  while (offset < data.length) {
    if (offset + 6 > data.length) throw new Error('bad backup');
    const nameLength = view.getUint16(offset);
    const length = view.getUint32(offset + 2);
    offset += 6;
    const name = fromUtf8(data.subarray(offset, offset + nameLength));
    offset += nameLength;
    if (offset + length > data.length) throw new Error('bad backup');
    records.set(name, data.slice(offset, offset + length));
    offset += length;
  }
  return records;
}

export async function createBackupFile(records: Map<string, Uint8Array>, password: string, kdfParams = KDF): Promise<Uint8Array> {
  const { key: k, kdf } = await backupKey(password, kdfParams);
  try {
    return await sealBackupFile(records, k, kdf);
  } finally {
    wipe(k);
  }
}

/**
 * The key of a .veil file, derived once (for «Копия в OneDrive», which is written every day
 * without asking for the password again; the key stays inside the encrypted vault).
 */
export async function backupKey(password: string, kdfParams = KDF): Promise<{ key: Uint8Array; kdf: BackupHeader['kdf'] }> {
  const kdf = { ...kdfParams, salt: b64(random(16)) };
  return { key: await key(password, kdf), kdf };
}

/** The same file as createBackupFile, opened with the same password; every chunk has a fresh random nonce. */
export async function sealBackupFile(records: Map<string, Uint8Array>, k: Uint8Array, kdf: BackupHeader['kdf']): Promise<Uint8Array> {
  const header: BackupHeader = { v: 1, kdf, createdAt: Date.now(), records: records.size };
  const body = await compress(packRecords(records));
  const chunks: Uint8Array[] = [];
  const count = Math.max(1, Math.ceil(body.length / CHUNK));
  for (let i = 0; i < count; i++) {
    const part = body.subarray(i * CHUNK, (i + 1) * CHUNK);
    const { nonce, ct } = aeadSeal(k, part, utf8(`veil-file-v1|${i}|${i === count - 1 ? 1 : 0}`));
    const length = new Uint8Array(4);
    new DataView(length.buffer).setUint32(0, ct.length);
    chunks.push(nonce, length, ct);
  }
  return concat(utf8(MAGIC), utf8(JSON.stringify(header)), utf8('\n'), ...chunks);
}

/** Reads the header without the password (to say what the file is). Throws if it is not a .veil file. */
export function readBackupHeader(file: Uint8Array): { header: BackupHeader; body: Uint8Array } {
  if (fromUtf8(file.subarray(0, MAGIC.length)) !== MAGIC) throw new Error('Это не резервная копия Veil');
  const end = file.indexOf(10, MAGIC.length);
  if (end < 0) throw new Error('Файл повреждён');
  const header = JSON.parse(fromUtf8(file.subarray(MAGIC.length, end))) as BackupHeader;
  if (header.v !== 1 || !header.kdf?.salt) throw new Error('Неподдерживаемая версия копии');
  return { header, body: file.subarray(end + 1) };
}

/** Throws WrongPasswordError for a wrong backup password or a damaged file. */
export async function openBackupFile(file: Uint8Array, password: string): Promise<Map<string, Uint8Array>> {
  const { header, body } = readBackupHeader(file);
  const k = await key(password, header.kdf);
  const parts: Uint8Array[] = [];
  try {
    let offset = 0;
    for (let i = 0; offset < body.length; i++) {
      const nonce = body.subarray(offset, offset + 24);
      const length = new DataView(body.buffer, body.byteOffset + offset + 24, 4).getUint32(0);
      const ct = body.subarray(offset + 28, offset + 28 + length);
      offset += 28 + length;
      const last = offset >= body.length;
      parts.push(aeadOpen(k, nonce, ct, utf8(`veil-file-v1|${i}|${last ? 1 : 0}`)));
    }
  } catch {
    throw new WrongPasswordError();
  } finally {
    wipe(k);
  }
  return unpackRecords(await decompress(concat(...parts)));
}
