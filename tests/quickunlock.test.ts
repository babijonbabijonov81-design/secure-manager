import { describe, expect, it } from 'vitest';
import { WrongPasswordError } from '../src/core/crypto/vault.ts';
import { isOldPin, PIN_KDF, unwrapWithPin, wrapWithPin } from '../src/core/quick-unlock.ts';

const FAST = { N: 2 ** 10, r: 8, p: 1 };

describe('quick unlock with a PIN (P0-7)', () => {
  it('wraps the vault key so that only the right PIN opens it', async () => {
    const key = crypto.getRandomValues(new Uint8Array(32));
    const blob = await wrapWithPin(key, '482913', FAST);
    expect(JSON.stringify(blob)).not.toContain('482913');
    expect(Buffer.from(await unwrapWithPin(blob, '482913')).equals(Buffer.from(key))).toBe(true);
    await expect(unwrapWithPin(blob, '482914')).rejects.toBeInstanceOf(WrongPasswordError);
  });

  it('takes 6 to 12 digits, refuses obvious PINs, and still opens old 4-digit ones', async () => {
    const key = new Uint8Array(32);
    for (const bad of ['1234', '12345', '12ab56', '1234567890123', '123456', '111111', '654321', '121212', '123123'])
      await expect(wrapWithPin(key, bad, FAST)).rejects.toThrow();
    await expect(wrapWithPin(key, '482913', FAST)).resolves.toBeTruthy();
    await expect(wrapWithPin(key, '482913057721', FAST)).resolves.toBeTruthy();
    // New PINs use the slow scrypt; blobs made before stay readable and are marked as old.
    expect(PIN_KDF.N).toBeGreaterThanOrEqual(2 ** 18);
    expect(isOldPin(await wrapWithPin(key, '482913', FAST))).toBe(true);
  });
});
