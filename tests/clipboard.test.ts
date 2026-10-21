import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SecretClipboard, type ClipboardIO } from '../src/core/secret-clipboard.ts';

function fakeClipboard() {
  const state = { text: '', secretWrites: 0, readable: true };
  const io: ClipboardIO = {
    write: async (text, secret) => {
      state.text = text;
      if (secret) state.secretWrites++;
    },
    read: async () => {
      if (!state.readable) throw new Error('not allowed');
      return state.text;
    },
    clear: async () => {
      state.text = '';
    },
  };
  return { state, io };
}

describe('clipboard auto-clear (P0-5)', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('erases the password after the chosen time', async () => {
    const { state, io } = fakeClipboard();
    const clip = new SecretClipboard(io);
    await clip.copy('wifi-пароль-42', 30);
    expect(state.text).toBe('wifi-пароль-42');
    expect(state.secretWrites).toBe(1);
    expect(clip.clearsAt).toBeGreaterThan(Date.now());
    await vi.advanceTimersByTimeAsync(29_000);
    expect(state.text).toBe('wifi-пароль-42');
    await vi.advanceTimersByTimeAsync(1_000);
    expect(state.text).toBe('');
    expect(clip.clearsAt).toBeNull();
  });

  it('leaves the clipboard alone if something else was copied meanwhile', async () => {
    const { state, io } = fakeClipboard();
    const clip = new SecretClipboard(io);
    await clip.copy('секрет', 15);
    state.text = 'адрес из браузера';
    await vi.advanceTimersByTimeAsync(15_000);
    expect(state.text).toBe('адрес из браузера');
  });

  it('does not erase what it cannot read (Wayland: another window owns the clipboard)', async () => {
    const { state, io } = fakeClipboard();
    const clip = new SecretClipboard(io);
    await clip.copy('секрет', 60);
    state.readable = false;
    expect(await clip.clear()).toBe(false);
    state.readable = true;
    expect(state.text).toBe('секрет');
  });

  it('"не очищать" keeps it, a new copy restarts the timer', async () => {
    const { state, io } = fakeClipboard();
    const clip = new SecretClipboard(io);
    await clip.copy('один', 0);
    await vi.advanceTimersByTimeAsync(3_600_000);
    expect(state.text).toBe('один');
    await clip.copy('два', 30);
    await vi.advanceTimersByTimeAsync(20_000);
    await clip.copy('три', 30);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(state.text).toBe('три');
    await vi.advanceTimersByTimeAsync(10_000);
    expect(state.text).toBe('');
  });
});
