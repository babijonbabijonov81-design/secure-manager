import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startRelay, type RelayHandle } from '../server/src/relay.ts';
import { utf8 } from '../server/src/shared/wire.ts';
import { WrongPasswordError } from '../src/core/crypto/vault.ts';
import { createAccount, unlock, type Messenger } from '../src/core/messenger.ts';
import { MemoryStorage } from '../src/core/storage.ts';

const FAST_KDF = { N: 2 ** 10, r: 8, p: 1 };
let relay: RelayHandle;
let url: string;

async function waitFor<T>(fn: () => T | undefined | null | false, timeout = 5000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const value = fn();
    if (value) return value;
    if (Date.now() - start > timeout) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, 20));
  }
}

let counter = 0;
async function makeUser(name: string, storage = new MemoryStorage()) {
  const username = `${name}_${process.pid % 1000}_${counter++}`;
  const messenger = await createAccount({
    storage,
    serverUrl: url,
    username,
    displayName: name[0].toUpperCase() + name.slice(1),
    password: `${name}-password`,
    kdf: FAST_KDF,
  });
  await waitFor(() => messenger.getSnapshot().status === 'online');
  return { messenger, storage, username, password: `${name}-password` };
}

const messages = (m: Messenger, contactId: string) => m.getSnapshot().conversations[contactId] ?? [];
const lastText = (m: Messenger, contactId: string) => messages(m, contactId).filter((x) => x.dir !== 'system').at(-1)?.text;

beforeAll(async () => {
  relay = await startRelay({ port: 0, host: '127.0.0.1', dataDir: null });
  url = `ws://127.0.0.1:${relay.port}`;
});

afterAll(async () => {
  await relay.close();
});

describe('messenger end-to-end', () => {
  it('rejects a taken username', async () => {
    const alice = await makeUser('alice');
    await expect(
      createAccount({ storage: new MemoryStorage(), serverUrl: url, username: alice.username, displayName: 'X', password: 'x', kdf: FAST_KDF }),
    ).rejects.toMatchObject({ code: 'username_taken' });
    alice.messenger.dispose();
  });

  it('exchanges messages, receipts, typing and profile names', async () => {
    const alice = await makeUser('alice');
    const bob = await makeUser('bob');
    const contact = await alice.messenger.addContact(`@${bob.username}`);
    expect(contact.username).toBe(bob.username);

    await alice.messenger.sendText(contact.id, 'Привет, Боб! 👋');
    const aliceId = alice.messenger.getSnapshot().me.userId;
    await waitFor(() => lastText(bob.messenger, aliceId) === 'Привет, Боб! 👋');
    const bobView = bob.messenger.getSnapshot().contacts.find((c) => c.id === aliceId)!;
    expect(bobView.username).toBe(alice.username);
    expect(bobView.displayName).toBe('Alice');
    expect(bobView.unread).toBe(1);

    // delivered receipt
    await waitFor(() => messages(alice.messenger, contact.id).at(-1)?.status === 'delivered');
    // read receipt
    bob.messenger.markRead(aliceId);
    await waitFor(() => messages(alice.messenger, contact.id).at(-1)?.status === 'read');

    await bob.messenger.sendText(aliceId, 'Привет! Всё зашифровано?');
    await waitFor(() => lastText(alice.messenger, contact.id) === 'Привет! Всё зашифровано?');

    // Typing indicators work once both sides have the session.
    alice.messenger.sendTyping(contact.id, true);
    await waitFor(() => bob.messenger.getSnapshot().typing[aliceId]);
    alice.messenger.sendTyping(contact.id, false);
    await waitFor(() => !bob.messenger.getSnapshot().typing[aliceId]);

    // Safety numbers match on both sides.
    expect(alice.messenger.safetyNumber(contact.id)).toBe(bob.messenger.safetyNumber(aliceId));

    // Rapid-fire messages arrive in order.
    for (let i = 0; i < 20; i++) void alice.messenger.sendText(contact.id, `msg ${i}`);
    await waitFor(() => lastText(bob.messenger, aliceId) === 'msg 19');
    const texts = messages(bob.messenger, aliceId).map((m) => m.text).filter((t) => t?.startsWith('msg '));
    expect(texts).toEqual(Array.from({ length: 20 }, (_, i) => `msg ${i}`));

    await alice.messenger.updateProfile('Алиса');
    await waitFor(() => bob.messenger.getSnapshot().contacts.find((c) => c.id === aliceId)?.displayName === 'Алиса');

    alice.messenger.dispose();
    bob.messenger.dispose();
  });

  it('the relay only ever stores ciphertext', async () => {
    const alice = await makeUser('alice');
    const bob = await makeUser('bob');
    const contact = await alice.messenger.addContact(bob.username);
    const bobId = bob.messenger.getSnapshot().me.userId;
    await bob.messenger.lock(); // offline: the envelope stays queued on the relay

    const secret = 'top-secret-плейнтекст-1234567890';
    await alice.messenger.sendText(contact.id, secret);
    await waitFor(() => messages(alice.messenger, contact.id).at(-1)?.status === 'sent');

    const queue = relay.store.queueOf(bobId);
    expect(queue.length).toBeGreaterThan(0);
    const needle = Buffer.from(utf8(secret));
    for (const item of queue) {
      const data = Buffer.from((await relay.store.read(item))!);
      expect(data.includes(needle)).toBe(false);
      expect(data.includes(Buffer.from(alice.username))).toBe(false);
      expect(data.includes(Buffer.from('Alice'))).toBe(false);
    }

    // Offline delivery: Bob unlocks later and gets the message; the relay forgets it.
    await expect(unlock(bob.storage, 'wrong')).rejects.toBeInstanceOf(WrongPasswordError);
    const bob2 = await unlock(bob.storage, bob.password);
    const aliceId = alice.messenger.getSnapshot().me.userId;
    await waitFor(() => lastText(bob2, aliceId) === secret);
    await waitFor(() => relay.store.queueOf(bobId).length === 0);

    alice.messenger.dispose();
    bob2.dispose();
  });

  it('persists sessions across restarts and keeps talking', async () => {
    const alice = await makeUser('alice');
    const bob = await makeUser('bob');
    const contact = await alice.messenger.addContact(bob.username);
    const aliceId = alice.messenger.getSnapshot().me.userId;
    await alice.messenger.sendText(contact.id, 'one');
    await waitFor(() => lastText(bob.messenger, aliceId) === 'one');
    await bob.messenger.sendText(aliceId, 'two');
    await waitFor(() => lastText(alice.messenger, contact.id) === 'two');

    await alice.messenger.lock();
    await bob.messenger.lock();
    const alice2 = await unlock(alice.storage, alice.password);
    const bob2 = await unlock(bob.storage, bob.password);
    await waitFor(() => alice2.getSnapshot().status === 'online' && bob2.getSnapshot().status === 'online');
    expect(messages(alice2, contact.id).map((m) => m.text)).toEqual(['one', 'two']);

    await alice2.sendText(contact.id, 'three');
    await waitFor(() => lastText(bob2, aliceId) === 'three');
    await bob2.sendText(aliceId, 'four');
    await waitFor(() => lastText(alice2, contact.id) === 'four');

    alice2.dispose();
    bob2.dispose();
  });

  it('converges when both people start the conversation at the same time', async () => {
    const alice = await makeUser('alice');
    const bob = await makeUser('bob');
    const toBob = await alice.messenger.addContact(bob.username);
    const toAlice = await bob.messenger.addContact(alice.username);
    await Promise.all([alice.messenger.sendText(toBob.id, 'hi from alice'), bob.messenger.sendText(toAlice.id, 'hi from bob')]);
    await waitFor(() => lastText(bob.messenger, toAlice.id) === 'hi from alice');
    await waitFor(() => lastText(alice.messenger, toBob.id) === 'hi from bob');
    for (let round = 0; round < 3; round++) {
      await alice.messenger.sendText(toBob.id, `a${round}`);
      await waitFor(() => lastText(bob.messenger, toAlice.id) === `a${round}`);
      await bob.messenger.sendText(toAlice.id, `b${round}`);
      await waitFor(() => lastText(alice.messenger, toBob.id) === `b${round}`);
    }
    alice.messenger.dispose();
    bob.messenger.dispose();
  });

  it('sends files, disappearing messages and deletes for everyone', async () => {
    const alice = await makeUser('alice');
    const bob = await makeUser('bob');
    const contact = await alice.messenger.addContact(bob.username);
    const aliceId = alice.messenger.getSnapshot().me.userId;

    const file = new Uint8Array(300_000).map((_, i) => i % 251);
    await alice.messenger.sendFile(contact.id, { name: 'photo.png', mime: 'image/png', data: file, w: 640, h: 480 });
    const received = await waitFor(() => messages(bob.messenger, aliceId).find((m) => m.atts?.length));
    expect(received.atts![0]).toMatchObject({ name: 'photo.png', kind: 'image', size: file.length, w: 640, h: 480 });
    const bytes = await bob.messenger.getAttachment(received.atts![0].id);
    expect(Buffer.from(bytes!).equals(Buffer.from(file))).toBe(true);

    await alice.messenger.setTimer(contact.id, 1);
    await waitFor(() => bob.messenger.getSnapshot().contacts.find((c) => c.id === aliceId)?.timer === 1);
    await alice.messenger.sendText(contact.id, 'self-destruct');
    await waitFor(() => lastText(bob.messenger, aliceId) === 'self-destruct');
    await waitFor(() => !messages(bob.messenger, aliceId).some((m) => m.text === 'self-destruct'), 4000);
    await waitFor(() => !messages(alice.messenger, contact.id).some((m) => m.text === 'self-destruct'), 4000);
    await alice.messenger.setTimer(contact.id, 0);

    await alice.messenger.sendText(contact.id, 'oops');
    const oops = await waitFor(() => messages(bob.messenger, aliceId).find((m) => m.text === 'oops'));
    const mine = messages(alice.messenger, contact.id).find((m) => m.text === 'oops')!;
    await alice.messenger.deleteMessage(contact.id, mine.id, true);
    // The message disappears completely on both sides: no "deleted" placeholder.
    await waitFor(() => !messages(bob.messenger, aliceId).some((m) => m.id === oops.id));
    expect(messages(alice.messenger, contact.id).some((m) => m.id === mine.id)).toBe(false);

    alice.messenger.dispose();
    bob.messenger.dispose();
  });

  it('recovers when a session is reset', async () => {
    const alice = await makeUser('alice');
    const bob = await makeUser('bob');
    const contact = await alice.messenger.addContact(bob.username);
    const aliceId = alice.messenger.getSnapshot().me.userId;
    await alice.messenger.sendText(contact.id, 'before');
    await waitFor(() => lastText(bob.messenger, aliceId) === 'before');
    alice.messenger.resetSession(contact.id);
    await alice.messenger.sendText(contact.id, 'after reset');
    await waitFor(() => lastText(bob.messenger, aliceId) === 'after reset');
    await bob.messenger.sendText(aliceId, 'reply');
    await waitFor(() => lastText(alice.messenger, contact.id) === 'reply');
    alice.messenger.dispose();
    bob.messenger.dispose();
  });

  it('re-registers automatically if the relay lost its data', async () => {
    const bob = await makeUser('bob');
    const bobId = bob.messenger.getSnapshot().me.userId;
    await relay.store.removeUser(bobId);
    bob.messenger.reconnect();
    await waitFor(() => relay.store.users.has(bobId) && bob.messenger.getSnapshot().status === 'online');
    const alice = await makeUser('alice');
    const contact = await alice.messenger.addContact(bob.username);
    await alice.messenger.sendText(contact.id, 'still works');
    expect(contact.id).toBe(bobId);
    await waitFor(() => lastText(bob.messenger, alice.messenger.getSnapshot().me.userId) === 'still works');
    alice.messenger.dispose();
    bob.messenger.dispose();
  });
});
