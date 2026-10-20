import { beforeAll, describe, expect, it } from 'vitest';

// A stand-in for Electron's spellchecker (Windows/macOS use the system dictionaries).
const dictionary: Record<string, string[]> = {
  превет: ['привет', 'привит'],
  Превет: ['Привет'],
  карова: ['корова'],
  teh: ['the'],
  абвгд: ['совсем другое'],
  спосибо: ['спасибо'],
};

let autocorrect: (word: string) => string | null;
let ignoreWord: (word: string) => void;

beforeAll(async () => {
  (globalThis as { veil?: unknown }).veil = {
    spell: { suggestions: (word: string) => dictionary[word] ?? null, addWord() {}, setEnabled() {} },
  };
  ({ autocorrect, ignoreWord } = await import('../src/renderer/src/lib/text.ts'));
});

describe('autocorrect', () => {
  it('fixes close typos and keeps capitalisation', () => {
    expect(autocorrect('превет')).toBe('привет');
    expect(autocorrect('Превет')).toBe('Привет');
    expect(autocorrect('карова')).toBe('корова');
    expect(autocorrect('спосибо')).toBe('спасибо');
  });

  it('leaves correct, short, technical or far-off words alone', () => {
    expect(autocorrect('привет')).toBeNull();
    expect(autocorrect('teh')).toBe('the');
    expect(autocorrect('ok')).toBeNull();
    expect(autocorrect('абвгд')).toBeNull();
    expect(autocorrect('NASA')).toBeNull();
    expect(autocorrect('v1.2')).toBeNull();
  });

  it('respects words the user reverted', () => {
    ignoreWord('карова');
    expect(autocorrect('карова')).toBeNull();
  });
});
