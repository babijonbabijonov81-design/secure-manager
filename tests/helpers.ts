// Shared helpers for tests that run real messengers against an in-process relay.
import { expect } from 'vitest';
import { startRelay, type RelayHandle, type RelayOptions } from '../server/src/relay.ts';
import { createAccount, type Messenger } from '../src/core/messenger.ts';
import { MemoryStorage } from '../src/core/storage.ts';

export const FAST_KDF = { N: 2 ** 10, r: 8, p: 1 };

export async function waitFor<T>(fn: () => T | undefined | null | false, timeout = 5000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const value = fn();
    if (value) return value;
    if (Date.now() - start > timeout) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, 20));
  }
}

export interface TestRelay {
  relay: RelayHandle;
  url: string;
  /** Every frame the relay received or sent, as it saw them. */
  frames: Buffer[];
}

export async function testRelay(options: RelayOptions = {}): Promise<TestRelay> {
  const frames: Buffer[] = [];
  const relay = await startRelay({ port: 0, host: '127.0.0.1', dataDir: null, ...options, tap: (_direction, bytes) => frames.push(Buffer.from(bytes)) });
  return { relay, url: `ws://127.0.0.1:${relay.port}`, frames };
}

let counter = 0;
export async function makeUser(url: string, name: string, storage = new MemoryStorage(), displayName = name[0].toUpperCase() + name.slice(1)) {
  const username = `${name}_${process.pid % 1000}_${counter++}`;
  const messenger = await createAccount({ storage, serverUrl: url, username, displayName, password: `${name}-password`, kdf: FAST_KDF });
  await waitFor(() => messenger.getSnapshot().status === 'online');
  return { messenger, storage, username, password: `${name}-password`, id: messenger.getSnapshot().me.userId };
}

export const messages = (m: Messenger, contactId: string) => m.getSnapshot().conversations[contactId] ?? [];
export const lastText = (m: Messenger, contactId: string) => messages(m, contactId).filter((x) => x.dir !== 'system').at(-1)?.text;

/** The marker as it would look inside base64 text, at each of the three byte alignments. */
function base64Needles(bytes: Buffer): Buffer[] {
  const needles: Buffer[] = [];
  for (let shift = 0; shift < 3; shift++) {
    const encoded = Buffer.concat([Buffer.alloc(shift), bytes]).toString('base64');
    const inner = encoded.slice(shift ? 4 : 0, encoded.length - 4);
    if (inner.length >= 8) needles.push(Buffer.from(inner));
  }
  return needles;
}

/** Fails if any frame the relay saw contains one of the markers (UTF-8 as is, or base64-encoded). */
export function expectOnlyCiphertext(frames: Buffer[], markers: string[]): void {
  expect(frames.length).toBeGreaterThan(0);
  for (const marker of markers) {
    const raw = Buffer.from(marker, 'utf8');
    for (const needle of [raw, ...base64Needles(raw)]) {
      for (const frame of frames) {
        if (frame.includes(needle)) throw new Error(`the relay saw «${marker}» in plain form`);
      }
    }
  }
}
