import { createHmac } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { iceServersFor, startRelay, type RelayHandle } from '../server/src/relay.ts';
import { createAccount, DEFAULT_ICE_SERVERS, snippetOf, unlock, type Messenger } from '../src/core/messenger.ts';
import { MemoryStorage } from '../src/core/storage.ts';
import type { CallSignal, Contact } from '../src/core/types.ts';

const FAST_KDF = { N: 2 ** 10, r: 8, p: 1 };
const SECRET = 'turn-shared-secret';
let relay: RelayHandle;
let plainRelay: RelayHandle;

async function waitFor<T>(fn: () => T | undefined | null | false, timeout = 6000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const value = fn();
    if (value) return value;
    if (Date.now() - start > timeout) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, 20));
  }
}

let counter = 0;
async function makeUser(name: string, server = relay) {
  const storage = new MemoryStorage();
  const username = `${name}_${process.pid % 1000}_${counter++}`;
  const password = `${name}-password`;
  const messenger = await createAccount({ storage, serverUrl: `ws://127.0.0.1:${server.port}`, username, displayName: name, password, kdf: FAST_KDF });
  await waitFor(() => messenger.getSnapshot().status === 'online');
  return { messenger, storage, username, password, id: messenger.getSnapshot().me.userId };
}

/** Collects call signals the way the UI's call manager would receive them. */
function listen(messenger: Messenger, known = true) {
  const signals: { from: string; signal: CallSignal }[] = [];
  messenger.callHandler = (contact: Contact, signal: CallSignal) => {
    signals.push({ from: contact.id, signal });
    return known;
  };
  return signals;
}

async function pair() {
  const alice = await makeUser('alice');
  const bob = await makeUser('bob');
  await alice.messenger.addContact(bob.username);
  await alice.messenger.sendText(bob.id, 'hello');
  await waitFor(() => bob.messenger.getSnapshot().conversations[alice.id]?.some((m) => m.text === 'hello'));
  await bob.messenger.sendText(alice.id, 'hi');
  await waitFor(() => alice.messenger.getSnapshot().conversations[bob.id]?.some((m) => m.text === 'hi'));
  return { alice, bob };
}

beforeAll(async () => {
  relay = await startRelay({ port: 0, host: '127.0.0.1', dataDir: null, ice: { stun: ['stun:turn.example.com:3478'], turn: ['turn:turn.example.com:3478'], secret: SECRET } });
  plainRelay = await startRelay({ port: 0, host: '127.0.0.1', dataDir: null });
});

afterAll(async () => {
  await relay.close();
  await plainRelay.close();
});

describe('call servers', () => {
  it('hands out time-limited TURN credentials (coturn REST API)', async () => {
    const now = Date.parse('2026-10-20T12:00:00Z');
    const [stun, turn] = iceServersFor({ stun: ['stun:a:3478'], turn: ['turn:a:3478'], secret: SECRET }, 'abcdefghijklmnopqrstuvwxyz', now)!;
    expect(stun).toEqual({ urls: ['stun:a:3478'] });
    expect(turn.username).toBe(`${now / 1000 + 86400}:abcdefghijklmnop`);
    expect(turn.credential).toBe(createHmac('sha1', SECRET).update(turn.username!).digest('base64'));
    expect(iceServersFor({ turn: ['turn:a'], username: 'u', credential: 'p' }, 'x')).toEqual([{ urls: ['turn:a'], username: 'u', credential: 'p' }]);
    expect(iceServersFor({ turn: ['turn:a'] }, 'x')).toBeUndefined();
    expect(iceServersFor(undefined, 'x')).toBeUndefined();

    const user = await makeUser('ice');
    const { servers, hasTurn } = user.messenger.iceServers;
    expect(hasTurn).toBe(true);
    const relayed = servers.find((s) => s.urls[0].startsWith('turn:'))!;
    expect(relayed.credential).toBe(createHmac('sha1', SECRET).update(relayed.username!).digest('base64'));
    user.messenger.dispose();

    const plain = await makeUser('plain', plainRelay);
    expect(plain.messenger.iceServers).toEqual({ servers: DEFAULT_ICE_SERVERS, hasTurn: false });
    plain.messenger.dispose();
  });
});

describe('call signalling', () => {
  it('delivers offer, ring, answer and end end-to-end encrypted', async () => {
    const { alice, bob } = await pair();
    const atAlice = listen(alice.messenger);
    const atBob = listen(bob.messenger);

    expect(await alice.messenger.sendCallSignal(bob.id, { k: 'offer', id: 'call-1', sdp: 'v=0 offer' })).toBe('delivered');
    await waitFor(() => atBob.length === 1);
    expect(atBob[0]).toEqual({ from: alice.id, signal: { k: 'offer', id: 'call-1', sdp: 'v=0 offer' } });

    await bob.messenger.sendCallSignal(alice.id, { k: 'ring', id: 'call-1' });
    await bob.messenger.sendCallSignal(alice.id, { k: 'answer', id: 'call-1', sdp: 'v=0 answer' });
    await waitFor(() => atAlice.length === 2);
    expect(atAlice.map((s) => s.signal.k)).toEqual(['ring', 'answer']);

    expect(await alice.messenger.sendCallSignal(bob.id, { k: 'end', id: 'call-1', r: 'hangup' })).toBe('queued');
    await waitFor(() => atBob.length === 2);
    expect(atBob[1].signal).toEqual({ k: 'end', id: 'call-1', r: 'hangup' });

    alice.messenger.logCall(bob.id, 'out', { status: 'done', dur: 42 }, 'call-1');
    const record = alice.messenger.getSnapshot().conversations[bob.id].at(-1)!;
    expect(record.call).toEqual({ status: 'done', dur: 42 });
    expect(snippetOf(record)).toBe('Исходящий звонок');
    alice.messenger.dispose();
    bob.messenger.dispose();
  });

  it('a call to someone offline leaves them a missed call', async () => {
    const { alice, bob } = await pair();
    await bob.messenger.lock();
    await waitFor(() => !alice.messenger.getSnapshot().online[bob.id]);

    expect(await alice.messenger.sendCallSignal(bob.id, { k: 'offer', id: 'call-2', sdp: 'v=0' })).toBe('offline');
    await alice.messenger.sendCallSignal(bob.id, { k: 'end', id: 'call-2', r: 'cancel' });
    alice.messenger.logCall(bob.id, 'out', { status: 'unavailable' }, 'call-2');

    const bob2 = await unlock(bob.storage, bob.password);
    const missed = await waitFor(() => bob2.getSnapshot().conversations[alice.id]?.find((m) => m.call));
    expect(missed).toMatchObject({ dir: 'in', call: { status: 'missed' } });
    expect(snippetOf(missed)).toBe('Пропущенный звонок');
    expect(bob2.getSnapshot().contacts.find((c) => c.id === alice.id)?.unread).toBeGreaterThan(0);
    // Exactly one record: the dropped offer never rang.
    await new Promise((r) => setTimeout(r, 300));
    expect(bob2.getSnapshot().conversations[alice.id].filter((m) => m.call)).toHaveLength(1);
    alice.messenger.dispose();
    bob2.dispose();
  });
});
