import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { startRelay } from '../server/src/relay.ts';
import { createAccount, unlock } from '../src/core/messenger.ts';
import { normalizeServerUrl } from '../src/core/relay-client.ts';
import { MemoryStorage } from '../src/core/storage.ts';

const FAST_KDF = { N: 2 ** 10, r: 8, p: 1 };

async function waitFor(fn: () => unknown, timeout = 5000) {
  const start = Date.now();
  while (!fn()) {
    if (Date.now() - start > timeout) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, 20));
  }
}

describe('relay', () => {
  it('normalizes server addresses', () => {
    expect(normalizeServerUrl('localhost:8787')).toBe('ws://localhost:8787/ws');
    expect(normalizeServerUrl('192.168.1.5:8787')).toBe('ws://192.168.1.5:8787/ws');
    expect(normalizeServerUrl('relay.example.com')).toBe('wss://relay.example.com/ws');
    expect(normalizeServerUrl('https://veil.onrender.com/')).toBe('wss://veil.onrender.com/ws');
    expect(normalizeServerUrl('wss://x.dev/ws')).toBe('wss://x.dev/ws');
  });

  it('keeps accounts and queued envelopes across restarts when using a data directory', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'veil-relay-'));
    try {
      let relay = await startRelay({ port: 0, host: '127.0.0.1', dataDir: dir });
      const url = `ws://127.0.0.1:${relay.port}`;
      const aliceStorage = new MemoryStorage();
      const bobStorage = new MemoryStorage();
      const alice = await createAccount({ storage: aliceStorage, serverUrl: url, username: 'persist_alice', displayName: 'A', password: 'a', kdf: FAST_KDF });
      const bob = await createAccount({ storage: bobStorage, serverUrl: url, username: 'persist_bob', displayName: 'B', password: 'b', kdf: FAST_KDF });
      await waitFor(() => alice.getSnapshot().status === 'online');
      const contact = await alice.addContact('persist_bob');
      await bob.lock();
      await alice.sendText(contact.id, 'survives restart');
      await waitFor(() => alice.getSnapshot().conversations[contact.id]?.at(-1)?.status === 'sent');
      alice.dispose();
      await relay.close();

      relay = await startRelay({ port: 0, host: '127.0.0.1', dataDir: dir });
      expect(relay.store.byUsername('persist_bob')).toBeTruthy();
      const bobUrl = `ws://127.0.0.1:${relay.port}`;
      const bob2 = await unlock(bobStorage, 'b');
      bob2.setServerUrl(bobUrl);
      await waitFor(() => Object.values(bob2.getSnapshot().conversations).some((m) => m.at(-1)?.text === 'survives restart'));
      await waitFor(() => relay.store.queueOf(contact.id).length === 0);
      bob2.dispose();
      await relay.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('client address behind a proxy', () => {
  it('ignores X-Forwarded-For unless proxies are trusted, and then takes the address the proxy added', async () => {
    const { clientAddress } = await import('../server/src/relay.ts');
    expect(clientAddress('6.6.6.6', '10.0.0.5', 0)).toBe('10.0.0.5');
    // The client wrote «6.6.6.6» itself; the proxy appended the real 203.0.113.7.
    expect(clientAddress('6.6.6.6, 203.0.113.7', '10.0.0.5', 1)).toBe('203.0.113.7');
    expect(clientAddress('203.0.113.7, 198.51.100.1', '10.0.0.5', 2)).toBe('203.0.113.7');
    expect(clientAddress(undefined, '10.0.0.5', 1)).toBe('10.0.0.5');
  });
});
