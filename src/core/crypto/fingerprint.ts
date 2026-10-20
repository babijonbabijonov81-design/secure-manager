// Safety numbers, in the style of Signal: a 60-digit code both people see identically.
// Comparing it (in person or over a call) proves no one has swapped keys in the middle.

import { sha512 } from '@noble/hashes/sha2.js';
import { concat, unb64, utf8 } from '../../../server/src/shared/wire.ts';

const ITERATIONS = 5200;

function fingerprintPart(identity: Uint8Array): string {
  let hash = concat(Uint8Array.of(0, 1), identity, utf8('veil-fingerprint'));
  for (let i = 0; i < ITERATIONS; i++) hash = sha512(concat(hash, identity));
  let digits = '';
  for (let chunk = 0; chunk < 6; chunk++) {
    let value = 0;
    for (let i = 0; i < 5; i++) value = value * 256 + hash[chunk * 5 + i];
    digits += String(value % 100000).padStart(5, '0');
  }
  return digits;
}

const cache = new Map<string, string>();

function cachedPart(userId: string): string {
  let part = cache.get(userId);
  if (!part) {
    part = fingerprintPart(unb64(userId));
    cache.set(userId, part);
  }
  return part;
}

/** 60 digits, identical on both sides regardless of who computes it. */
export function safetyNumber(myUserId: string, theirUserId: string): string {
  return [cachedPart(myUserId), cachedPart(theirUserId)].sort().join('');
}

export function formatSafetyNumber(digits: string): string[] {
  return digits.match(/.{5}/g) ?? [];
}
