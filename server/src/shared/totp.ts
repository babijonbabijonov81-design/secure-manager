// Time-based one-time passwords (RFC 6238), compatible with Google Authenticator,
// Microsoft Authenticator, Authy etc.: HMAC-SHA1, 30-second steps, 6 digits.

import { hmac } from '@noble/hashes/hmac.js';
import { sha1 } from '@noble/hashes/legacy.js';

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
export const TOTP_STEP_SECONDS = 30;

export function base32Encode(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(text: string): Uint8Array {
  const clean = text.toUpperCase().replace(/[\s=-]/g, '');
  const out: number[] = [];
  let bits = 0;
  let value = 0;
  for (const char of clean) {
    const index = ALPHABET.indexOf(char);
    if (index < 0) throw new Error('invalid base32');
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Uint8Array.from(out);
}

export const totpCounter = (time = Date.now()) => Math.floor(time / 1000 / TOTP_STEP_SECONDS);

export function hotp(secret: Uint8Array, counter: number, digits = 6): string {
  const message = new Uint8Array(8);
  const view = new DataView(message.buffer);
  view.setUint32(0, Math.floor(counter / 2 ** 32));
  view.setUint32(4, counter >>> 0);
  const digest = hmac(sha1, secret, message);
  const offset = digest[digest.length - 1] & 0x0f;
  const binary =
    ((digest[offset] & 0x7f) << 24) | (digest[offset + 1] << 16) | (digest[offset + 2] << 8) | digest[offset + 3];
  return String(binary % 10 ** digits).padStart(digits, '0');
}

export const totp = (secret: Uint8Array, time = Date.now()) => hotp(secret, totpCounter(time));

/**
 * Returns the matching time step (to reject replays of the same code), or null.
 * Accepts the previous and next step to tolerate clock drift.
 */
export function verifyTotp(secretBase32: string, code: string, time = Date.now(), window = 1): number | null {
  const digits = String(code ?? '').replace(/\s/g, '');
  if (!/^\d{6}$/.test(digits)) return null;
  let secret: Uint8Array;
  try {
    secret = base32Decode(secretBase32);
  } catch {
    return null;
  }
  const now = totpCounter(time);
  for (let delta = -window; delta <= window; delta++) {
    if (hotp(secret, now + delta) === digits) return now + delta;
  }
  return null;
}

export function otpauthUrl(secretBase32: string, account: string, issuer = 'Veil'): string {
  const label = encodeURIComponent(`${issuer}:${account}`);
  return `otpauth://totp/${label}?secret=${secretBase32}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=${TOTP_STEP_SECONDS}`;
}
