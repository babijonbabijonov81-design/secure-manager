import { describe, expect, it } from 'vitest';
import { WrongPasswordError } from '../src/core/crypto/vault.ts';
import { unwrapWithPin, wrapWithPin } from '../src/core/quick-unlock.ts';

const FAST = { N: 2 ** 10, r: 8, p: 1 };

describe('quick unlock with a PIN (P0-7)', () => {
  it('wraps the vault key so that only the right PIN opens it', async () => {
    const key = crypto.getRandomValues(new Uint8Array(32));
    const blob = await wrapWithPin(key, '482913', FAST);
    expect(JSON.stringify(blob)).not.toContain('482913');
    expect(Buffer.from(await unwrapWithPin(blob, '482913')).equals(Buffer.from(key))).toBe(true);
    await expect(unwrapWithPin(blob, '482914')).rejects.toBeInstanceOf(WrongPasswordError);
  });

  it('accepts 4 to 8 digits only', async () => {
    const key = new Uint8Array(32);
    await expect(wrapWithPin(key, '123', FAST)).rejects.toThrow();
    await expect(wrapWithPin(key, '12ab', FAST)).rejects.toThrow();
    await expect(wrapWithPin(key, '123456789', FAST)).rejects.toThrow();
    await expect(wrapWithPin(key, '1234', FAST)).resolves.toBeTruthy();
  });
});
