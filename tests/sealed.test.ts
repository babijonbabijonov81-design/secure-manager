// Sealed sender: once contacts have each other's delivery key, envelopes go on a connection that
// never logged in, so the relay sees whom a message is for but not who sent it.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { unpack } from '../server/src/shared/wire.ts';
import { SealedSender } from '../src/core/relay-client.ts';
import { lastText, makeUser, testRelay, waitFor, type TestRelay } from './helpers.ts';

let t: TestRelay;
beforeAll(async () => {
  t = await testRelay();
});
afterAll(async () => {
  await t.relay.close();
});

const sent = (frames: Buffer[]) =>
  frames.flatMap((f) => {
    try {
      const { header } = unpack<{ type: string; to?: string }>(new Uint8Array(f));
      return header.type === 'send' || header.type === 'send_sealed' ? [header] : [];
    } catch {
      return [];
    }
  });

describe('sealed sender', () => {
  it('sends to contacts anonymously and locks out a blocked one', async () => {
    const alice = await makeUser(t.url, 'alice');
    const bob = await makeUser(t.url, 'bob');
    await alice.messenger.addContact(bob.username);
    await alice.messenger.sendText(bob.id, 'привет');
    await waitFor(() => lastText(bob.messenger, alice.id) === 'привет');
    await bob.messenger.sendText(alice.id, 'и тебе');
    await waitFor(() => lastText(alice.messenger, bob.id) === 'и тебе');
    await waitFor(() => alice.messenger.getSnapshot().contacts.find((c) => c.id === bob.id)?.accessKey);

    t.frames.length = 0;
    await alice.messenger.sendText(bob.id, 'анонимно');
    await waitFor(() => lastText(bob.messenger, alice.id) === 'анонимно');
    const toBob = sent(t.frames).filter((h) => h.to === bob.id);
    expect(toBob.length).toBeGreaterThan(0);
    // Nothing for Bob went over Alice's logged-in connection.
    expect(toBob.every((h) => h.type === 'send_sealed')).toBe(true);

    // A wrong key or an unknown user get the same refusal.
    const sealed = new SealedSender(() => t.url, () => undefined);
    await expect(sealed.send({ to: bob.id, ak: 'AAAAAAAAAAAAAAAAAAAAAA' }, new Uint8Array(8))).rejects.toMatchObject({ code: 'unauthorized' });
    await expect(sealed.send({ to: 'x'.repeat(43), ak: 'AAAAAAAAAAAAAAAAAAAAAA' }, new Uint8Array(8))).rejects.toMatchObject({ code: 'unauthorized' });
    sealed.close();

    // Bob blocks Alice: his key changes, her old one stops working.
    const oldKey = alice.messenger.getSnapshot().contacts.find((c) => c.id === bob.id)!.accessKey;
    bob.messenger.setBlocked(alice.id, true);
    await new Promise((r) => setTimeout(r, 300));
    t.frames.length = 0;
    await alice.messenger.sendText(bob.id, 'ты где?');
    await waitFor(() => alice.messenger.getSnapshot().contacts.find((c) => c.id === bob.id)?.accessKey !== oldKey);
    expect(alice.messenger.getSnapshot().contacts.find((c) => c.id === bob.id)?.accessKey).toBeUndefined();
  });
});
