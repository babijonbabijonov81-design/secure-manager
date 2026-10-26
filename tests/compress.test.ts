import { gunzipSync, gzipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { compress, decompress } from '../src/core/compress.ts';

// The iPhone app compresses with fflate, the desktop with CompressionStream: both read each other.
describe('compression between desktop and iPhone', () => {
  const text = new TextEncoder().encode('Привет, Veil! '.repeat(500));

  it('desktop output opens with fflate, and fflate output opens on the desktop', async () => {
    const packed = await compress(text);
    expect(packed[0]).toBe(1);
    expect(gunzipSync(packed.subarray(1))).toEqual(text);
    const fromPhone = new Uint8Array([1, ...gzipSync(text)]);
    expect(await decompress(fromPhone)).toEqual(text);
    expect(await decompress(new Uint8Array([0, 1, 2]))).toEqual(new Uint8Array([1, 2]));
  });
});
