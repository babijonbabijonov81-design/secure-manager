import { describe, expect, it } from 'vitest';
import { base32Decode, base32Encode, hotp, otpauthUrl, totp, verifyTotp } from '../server/src/shared/totp.ts';
import { utf8 } from '../server/src/shared/wire.ts';

describe('TOTP (Google Authenticator)', () => {
  const secret = utf8('12345678901234567890');

  it('matches the RFC 6238 / RFC 4226 test vectors', () => {
    // RFC 4226 appendix D
    expect(['755224', '287082', '359152', '969429', '338314'].map((_, i) => hotp(secret, i))).toEqual([
      '755224',
      '287082',
      '359152',
      '969429',
      '338314',
    ]);
    // RFC 6238 appendix B (SHA1, 8 digits) at T = 59 s and 1111111109 s
    expect(hotp(secret, 1, 8)).toBe('94287082');
    expect(hotp(secret, Math.floor(1111111109 / 30), 8)).toBe('07081804');
  });

  it('round-trips base32 and verifies codes with clock drift', () => {
    const b32 = base32Encode(secret);
    expect(b32).toBe('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
    expect(base32Decode(b32)).toEqual(secret);
    const now = Date.now();
    const code = totp(secret, now);
    expect(verifyTotp(b32, code, now)).not.toBeNull();
    expect(verifyTotp(b32, code, now + 30_000)).not.toBeNull();
    expect(verifyTotp(b32, code, now + 120_000)).toBeNull();
    expect(verifyTotp(b32, '000000', now) === null || code === '000000').toBe(true);
    expect(otpauthUrl(b32, '@alice')).toContain('otpauth://totp/Veil%3A%40alice?secret=GEZDGNBV');
  });
});
