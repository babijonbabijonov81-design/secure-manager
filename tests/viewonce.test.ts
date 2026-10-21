import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { expectOnlyCiphertext, makeUser, messages, testRelay, waitFor, type TestRelay } from './helpers.ts';

let t: TestRelay;
beforeAll(async () => {
  t = await testRelay();
});
afterAll(async () => {
  await t.relay.close();
});

describe('view-once photos and videos (P0-4)', () => {
  it('opens once, then the key and the file are gone on both sides', async () => {
    const alice = await makeUser(t.url, 'alice');
    const bob = await makeUser(t.url, 'bob');
    const contact = await alice.messenger.addContact(bob.username);
    const photo = new TextEncoder().encode('JFIF-фото-с-паспортом-серия-4510');
    await alice.messenger.sendMedia(contact.id, [{ name: 'passport-scan.jpg', mime: 'image/jpeg', data: photo, w: 800, h: 600 }], { once: true });

    const received = await waitFor(() => messages(bob.messenger, alice.id).find((m) => m.once));
    expect(received.once?.k).toBeTruthy();
    const att = received.atts![0];
    expect(att.name).toBe('photo'); // the file name never leaves the sender
    // Stored sealed: the plain photo is nowhere on Bob's disk.
    const stored = await bob.messenger.getAttachment(att.id);
    expect(Buffer.from(stored!).includes(Buffer.from(photo))).toBe(false);
    await expect(bob.messenger.saveToFavorites(alice.id, received.id)).rejects.toMatchObject({ code: 'once_save' });

    const opened = await bob.messenger.openOnce(alice.id, received.id);
    expect(Buffer.from(opened.data).equals(Buffer.from(photo))).toBe(true);
    expect(opened.mime).toBe('image/jpeg');
    expect(await bob.messenger.getAttachment(att.id)).toBeNull();
    const after = messages(bob.messenger, alice.id).find((m) => m.id === received.id)!;
    expect(after.once?.k).toBeUndefined();
    expect(after.once?.opened).toBeGreaterThan(0);
    await expect(bob.messenger.openOnce(alice.id, received.id)).rejects.toMatchObject({ code: 'once_gone' });

    // The sender is told and deletes its copy too.
    const mine = await waitFor(() => messages(alice.messenger, contact.id).find((m) => m.once?.opened));
    expect(mine.once?.k).toBeUndefined();
    expect(await alice.messenger.getAttachment(mine.atts![0].id)).toBeNull();

    expectOnlyCiphertext(t.frames, ['фото-с-паспортом-серия-4510', 'passport-scan']);
    alice.messenger.dispose();
    bob.messenger.dispose();
  });

  it('only one photo or video at a time', async () => {
    const alice = await makeUser(t.url, 'alice');
    const bob = await makeUser(t.url, 'bob');
    const contact = await alice.messenger.addContact(bob.username);
    const file = { name: 'a.txt', mime: 'text/plain', data: new Uint8Array([1, 2, 3]) };
    await expect(alice.messenger.sendMedia(contact.id, [file], { once: true })).rejects.toMatchObject({ code: 'once_kind' });
    alice.messenger.dispose();
    bob.messenger.dispose();
  });
});
