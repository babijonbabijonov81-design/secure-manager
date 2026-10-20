import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startRelay, type RelayHandle } from '../server/src/relay.ts';
import { utf8 } from '../server/src/shared/wire.ts';
import { createAccount, unlock, type Messenger } from '../src/core/messenger.ts';
import { MemoryStorage } from '../src/core/storage.ts';
import { SAVED_ID } from '../src/core/types.ts';

const FAST_KDF = { N: 2 ** 10, r: 8, p: 1 };
let relay: RelayHandle;

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
async function makeUser(name: string) {
  const storage = new MemoryStorage();
  const username = `${name}_${process.pid % 1000}_${counter++}`;
  const password = `${name}-password`;
  const messenger = await createAccount({ storage, serverUrl: `ws://127.0.0.1:${relay.port}`, username, displayName: name, password, kdf: FAST_KDF });
  await waitFor(() => messenger.getSnapshot().status === 'online');
  return { messenger, storage, username, password, id: messenger.getSnapshot().me.userId };
}

const saved = (m: Messenger) => m.getSnapshot().conversations[SAVED_ID] ?? [];
const outbox = (m: Messenger) => (m as unknown as { outbox: unknown[] }).outbox;

beforeAll(async () => {
  relay = await startRelay({ port: 0, host: '127.0.0.1', dataDir: null });
});

afterAll(async () => {
  await relay.close();
});

describe('«Избранное»', () => {
  it('is a local chat with yourself that never goes to the relay', async () => {
    const alice = await makeUser('alice');
    const chat = alice.messenger.getSnapshot().contacts.find((c) => c.id === SAVED_ID)!;
    expect(chat).toMatchObject({ displayName: 'Избранное', pinned: true, unread: 0 });

    await alice.messenger.sendText(SAVED_ID, 'Номер паспорта 1234 567890');
    await alice.messenger.sendMedia(SAVED_ID, [{ name: 'notes.txt', mime: 'text/plain', data: utf8('секрет') }], { caption: 'Файл' });
    expect(saved(alice.messenger).map((m) => m.text)).toEqual(['Номер паспорта 1234 567890', 'Файл']);
    expect(saved(alice.messenger).every((m) => m.dir === 'out' && m.status === undefined)).toBe(true);
    expect(outbox(alice.messenger)).toHaveLength(0);
    expect(relay.store.users.get(alice.id)).toBeDefined();
    expect([...relay.store.users.keys()].every((id) => relay.store.queueOf(id).length === 0)).toBe(true);

    // Your own username opens it; deleting only empties it.
    expect((await alice.messenger.addContact(alice.username)).id).toBe(SAVED_ID);
    await alice.messenger.deleteChat(SAVED_ID);
    expect(alice.messenger.getSnapshot().contacts.some((c) => c.id === SAVED_ID)).toBe(true);
    expect(saved(alice.messenger)).toHaveLength(0);
    alice.messenger.dispose();
  });

  it('saves messages and files from other chats, keeping them after the original is gone', async () => {
    const alice = await makeUser('alice');
    const bob = await makeUser('bob');
    await alice.messenger.addContact(bob.username);
    await alice.messenger.sendMedia(bob.id, [{ name: 'plan.pdf', mime: 'application/pdf', data: utf8('%PDF plan') }], { caption: 'План' });
    const incoming = await waitFor(() => bob.messenger.getSnapshot().conversations[alice.id]?.find((m) => m.text === 'План'));

    await bob.messenger.saveToFavorites(alice.id, incoming.id);
    const copy = saved(bob.messenger).at(-1)!;
    expect(copy).toMatchObject({ dir: 'out', text: 'План', fwd: { name: 'alice' } });
    expect(copy.atts![0].id).not.toBe(incoming.atts![0].id);

    await bob.messenger.deleteMessage(alice.id, incoming.id, false);
    expect(new TextDecoder().decode((await bob.messenger.getAttachment(copy.atts![0].id))!)).toBe('%PDF plan');

    // It is stored in the encrypted vault like any chat.
    await bob.messenger.lock();
    const again = await unlock(bob.storage, bob.password);
    expect(saved(again).map((m) => m.text)).toContain('План');
    alice.messenger.dispose();
    again.dispose();
  });
});
