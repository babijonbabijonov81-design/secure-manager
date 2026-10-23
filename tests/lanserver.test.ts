// A server on one computer of the Wi-Fi: «localhost:8787» there, «192.168.…:8787» elsewhere.
// Usernames are one name whatever the case of the letters.
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RelayStore } from '../server/src/store.ts';
import { isLanServer, parseInvite } from '../src/core/invite.ts';
import { createAccount } from '../src/core/messenger.ts';
import { probeServer } from '../src/core/relay-client.ts';
import { MemoryStorage } from '../src/core/storage.ts';
import { FAST_KDF, makeUser, testRelay, waitFor, type TestRelay } from './helpers.ts';

let t: TestRelay;
let other: TestRelay;
beforeAll(async () => {
  t = await testRelay();
  other = await testRelay();
});
afterAll(async () => {
  await t.relay.close();
  await other.relay.close();
});

describe('usernames ignore letter case', () => {
  it('takes, finds and renames regardless of capitals', async () => {
    const anna = await makeUser(t.url, 'anna');
    const boris = await makeUser(t.url, 'boris');
    const shouting = anna.username.toUpperCase();
    const capital = anna.username[0].toUpperCase() + anna.username.slice(1);
    await expect(
      createAccount({ storage: new MemoryStorage(), serverUrl: t.url, username: capital, displayName: 'x', password: 'password-1', kdf: FAST_KDF }),
    ).rejects.toMatchObject({ code: 'username_taken' });
    expect(await boris.messenger.checkUsername(shouting)).toBe('taken');
    expect(await boris.messenger.checkUsername(capital)).toBe('taken');
    await expect(boris.messenger.changeUsername(capital)).rejects.toMatchObject({ code: 'username_taken' });
    expect((await boris.messenger.addContact(shouting)).id).toBe(anna.id);
    expect(await anna.messenger.checkUsername(shouting)).toBe('mine');
  });

  it('merges names that differ only in case when an old data folder is loaded', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'veil-store-'));
    mkdirSync(join(dir, 'queue'), { recursive: true });
    const user = (id: string, username: string) => ({ userId: id, username, dhKey: '', dhSig: '', spks: [], opks: [], createdAt: 1 });
    writeFileSync(join(dir, 'users.json'), JSON.stringify({ users: [user('A'.repeat(43), 'Anna_1'), user('B'.repeat(43), 'anna_1')] }));
    const store = new RelayStore(dir);
    await store.load();
    expect(store.byUsername('anna_1')?.userId).toBe('A'.repeat(43));
    expect(store.users.size).toBe(1);
  });
});

describe('one server, several addresses', () => {
  it('tells the same server by its id', async () => {
    const a = await probeServer(t.url);
    const b = await probeServer(t.url.replace('127.0.0.1', 'localhost'));
    expect(a.id).toMatch(/^[A-Za-z0-9_-]{16}$/);
    expect(b.id).toBe(a.id);
    expect((await probeServer(other.url)).id).not.toBe(a.id);
  });

  it('accepts an invite made under another address of the same server', async () => {
    const host = await makeUser(t.url.replace('127.0.0.1', 'localhost'), 'host');
    const guest = await makeUser(t.url, 'guest');
    await waitFor(() => host.messenger.getSnapshot().me.serverId && guest.messenger.getSnapshot().me.serverId);
    expect(host.messenger.getSnapshot().me.serverId).toBe(guest.messenger.getSnapshot().me.serverId);
    const link = host.messenger.createInvite();
    expect(parseInvite(link)?.serverId).toBe(host.messenger.getSnapshot().me.serverId);
    const contact = await guest.messenger.acceptInvite(link);
    expect(contact.id).toBe(host.id);
    expect(contact.verified).toBe(true);

    // A really different server is still refused, with a clear reason.
    const stranger = await makeUser(other.url, 'stranger');
    await waitFor(() => stranger.messenger.getSnapshot().me.serverId);
    await expect(guest.messenger.acceptInvite(stranger.messenger.createInvite())).rejects.toMatchObject({ code: 'other_server' });
  });

  it('knows which addresses belong to the local network', () => {
    for (const lan of ['localhost:8787', '192.168.1.5:8787', 'ws://10.0.0.2:8787', '172.20.1.1:8787', 'desktop-abc.local:8787', '127.0.0.1:8787'])
      expect(isLanServer(lan)).toBe(true);
    for (const wan of ['veil.onrender.com', 'wss://relay.example.com', '172.32.0.1:8787', '8.8.8.8:8787', '192.169.0.1'])
      expect(isLanServer(wan)).toBe(false);
  });

  it('pins the server key: an impostor with another key cannot hand out contacts', async () => {
    const real = await probeServer(t.url);
    expect(real.key).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const anna = await makeUser(t.url, 'pinned');
    const target = await makeUser(t.url, 'target');
    await waitFor(() => anna.messenger.getSnapshot().me.serverKey);
    expect(anna.messenger.getSnapshot().me.serverKey).toBe(real.key);
    // Lookups are signed by the pinned key.
    expect((await anna.messenger.addContact(target.username)).id).toBe(target.id);

    // «The same server at a new address» — but it is another relay with its own key (no TLS here).
    anna.messenger.moveServer(other.url);
    await waitFor(() => anna.messenger.getSnapshot().serverKeyChanged);
    expect(anna.messenger.getSnapshot().me.serverKey).toBe(real.key);
    await expect(anna.messenger.addContact('anyone_here')).rejects.toMatchObject({ code: 'server_key' });

    // The user says the server was reinstalled: the new key is trusted from now on.
    anna.messenger.trustServerKey();
    expect(anna.messenger.getSnapshot().serverKeyChanged).toBeUndefined();
    expect(anna.messenger.getSnapshot().me.serverKey).toBe((await probeServer(other.url)).key);
    expect(anna.messenger.getSnapshot().securityLog.some((e) => e.kind === 'server_key')).toBe(true);
  });

  it('keeps its key across restarts given the same secret', async () => {
    const { startRelay } = await import('../server/src/relay.ts');
    const secret = new Uint8Array(32).fill(7);
    const first = await startRelay({ port: 0, host: '127.0.0.1', dataDir: null, secret });
    const key1 = (await probeServer(`ws://127.0.0.1:${first.port}`)).key;
    await first.close();
    const second = await startRelay({ port: 0, host: '127.0.0.1', dataDir: null, secret });
    const key2 = (await probeServer(`ws://127.0.0.1:${second.port}`)).key;
    await second.close();
    expect(key1).toBeTruthy();
    expect(key2).toBe(key1);
  });
});
