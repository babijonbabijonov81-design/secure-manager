// Thin wrappers over audited primitives from the noble libraries:
// X25519 (key agreement), Ed25519 (signatures), HKDF/HMAC-SHA256, XChaCha20-Poly1305 (AEAD).

import { xchacha20poly1305 } from '@noble/ciphers/chacha.js';
import { ed25519, x25519 } from '@noble/curves/ed25519.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { hmac } from '@noble/hashes/hmac.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { randomBytes } from '@noble/hashes/utils.js';
import { b64, unb64, utf8 } from '../../../server/src/shared/wire.ts';

export interface KeyPair {
  pub: Uint8Array;
  priv: Uint8Array;
}

export interface KeyPairJSON {
  pub: string;
  priv: string;
}

export const random = (length: number): Uint8Array => randomBytes(length);

export function generateDH(): KeyPair {
  const { secretKey, publicKey } = x25519.keygen();
  return { pub: publicKey, priv: secretKey };
}

export function generateSigning(): KeyPair {
  const { secretKey, publicKey } = ed25519.keygen();
  return { pub: publicKey, priv: secretKey };
}

/** X25519; throws on low-order points (all-zero shared secret). */
export const dh = (priv: Uint8Array, pub: Uint8Array): Uint8Array => x25519.getSharedSecret(priv, pub);

export const sign = (message: Uint8Array, priv: Uint8Array): Uint8Array => ed25519.sign(message, priv);

export function verify(signature: Uint8Array, message: Uint8Array, pub: Uint8Array): boolean {
  try {
    return ed25519.verify(signature, message, pub);
  } catch {
    return false;
  }
}

export const kdf = (ikm: Uint8Array, salt: Uint8Array, info: string, length: number): Uint8Array =>
  hkdf(sha256, ikm, salt, utf8(info), length);

export const mac = (key: Uint8Array, data: Uint8Array): Uint8Array => hmac(sha256, key, data);

export interface Sealed {
  nonce: Uint8Array;
  ct: Uint8Array;
}

export function aeadSeal(key: Uint8Array, plaintext: Uint8Array, ad?: Uint8Array): Sealed {
  const nonce = random(24);
  return { nonce, ct: xchacha20poly1305(key, nonce, ad).encrypt(plaintext) };
}

/** Throws if the ciphertext or associated data was tampered with. */
export function aeadOpen(key: Uint8Array, nonce: Uint8Array, ct: Uint8Array, ad?: Uint8Array): Uint8Array {
  return xchacha20poly1305(key, nonce, ad).decrypt(ct);
}

export function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

export const keyPairToJSON = (kp: KeyPair): KeyPairJSON => ({ pub: b64(kp.pub), priv: b64(kp.priv) });
export const keyPairFromJSON = (kp: KeyPairJSON): KeyPair => ({ pub: unb64(kp.pub), priv: unb64(kp.priv) });

/** Best-effort wipe of key material we no longer need. */
export function wipe(...buffers: (Uint8Array | null | undefined)[]): void {
  for (const buffer of buffers) buffer?.fill(0);
}
