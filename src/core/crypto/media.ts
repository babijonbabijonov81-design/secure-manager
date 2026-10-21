// One extra layer for content that must become unreadable on its own schedule: view-once media
// and time capsules. The content is sealed with a random key (XChaCha20-Poly1305); throwing the
// key away makes every copy of the ciphertext useless, wherever it is stored.

import { concat, utf8 } from '../../../server/src/shared/wire.ts';
import { aeadOpen, aeadSeal, random } from './primitives.ts';

export type SealPurpose = 'once' | 'capsule';

const ad = (purpose: SealPurpose) => utf8(`veil-${purpose}-v1`);

export const newContentKey = () => random(32);

export function sealContent(key: Uint8Array, plaintext: Uint8Array, purpose: SealPurpose): Uint8Array {
  const { nonce, ct } = aeadSeal(key, plaintext, ad(purpose));
  return concat(nonce, ct);
}

/** Throws if the key is wrong or the data was changed. */
export function openContent(key: Uint8Array, sealed: Uint8Array, purpose: SealPurpose): Uint8Array {
  if (sealed.length < 24 + 16) throw new Error('sealed content too short');
  return aeadOpen(key, sealed.subarray(0, 24), sealed.subarray(24), ad(purpose));
}
