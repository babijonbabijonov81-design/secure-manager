import { describe, expect, it } from 'vitest';
import { callWords, sdpFingerprint } from '../src/core/call-words.ts';
import { WORDS_RU } from '../src/core/words-ru.ts';

const fp = (byte: string) => `sha-256 ${Array(32).fill(byte).join(':')}`;

describe('call verification words (P1-2)', () => {
  it('the dictionary has 2048 distinct short Russian nouns', () => {
    expect(WORDS_RU.length).toBe(2048);
    expect(new Set(WORDS_RU).size).toBe(2048);
    for (const w of WORDS_RU) expect(w).toMatch(/^[а-я]{4,8}$/);
  });

  it('both sides get the same two words, whoever called', () => {
    const words = callWords(fp('AB'), fp('CD'));
    expect(callWords(fp('CD'), fp('AB'))).toEqual(words);
    expect(words.every((w) => WORDS_RU.includes(w))).toBe(true);
  });

  it('a different certificate on one side changes the words', () => {
    const honest = callWords(fp('AB'), fp('CD'));
    const attacked = callWords(fp('AB'), fp('EE'));
    expect(attacked).not.toEqual(honest);
  });

  it('reads the fingerprint from an SDP', () => {
    const sdp = 'v=0\r\no=- 1 2 IN IP4 127.0.0.1\r\na=fingerprint:SHA-256 ab:cd:ef\r\na=setup:actpass\r\n';
    expect(sdpFingerprint(sdp)).toBe('sha-256 AB:CD:EF');
    expect(sdpFingerprint('v=0')).toBeNull();
  });
});
