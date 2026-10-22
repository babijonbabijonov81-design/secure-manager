// Смена имени пользователя: free or taken, rate limit, contacts learn the new name from the
// server, and someone who takes the old name is never mistaken for the old owner.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { expectOnlyCiphertext, makeUser, testRelay, waitFor, type TestRelay } from './helpers.ts';

let t: TestRelay;
beforeAll(async () => {
  t = await testRelay();
});
afterAll(async () => {
  await t.relay.close();
});

describe('changing the username', () => {
  it('checks, changes, tells contacts and frees the old name safely', async () => {
    const alice = await makeUser(t.url, 'alice');
    const bob = await makeUser(t.url, 'bob');
    const carol = await makeUser(t.url, 'carol');
    await bob.messenger.addContact(alice.username);
    await bob.messenger.sendText(alice.id, 'привет');
    await waitFor(() => alice.messenger.getSnapshot().contacts.some((c) => c.id === bob.id));
    await alice.messenger.sendText(bob.id, 'привет!');
    await waitFor(() => bob.messenger.getSnapshot().conversations[alice.id]?.length >= 2);

    const fresh = `al_${Date.now().toString(36)}`;
    expect(await alice.messenger.checkUsername(alice.username)).toBe('mine');
    expect(await alice.messenger.checkUsername('x!')).toBe('invalid');
    expect(await alice.messenger.checkUsername(carol.username)).toBe('taken');
    expect(await alice.messenger.checkUsername(fresh)).toBe('free');
    await expect(alice.messenger.changeUsername(carol.username)).rejects.toMatchObject({ code: 'username_taken' });

    const old = alice.username;
    await alice.messenger.changeUsername(fresh);
    expect(alice.messenger.getSnapshot().me.username).toBe(fresh);
    // Bob's contact gets the new name from the server.
    await waitFor(() => bob.messenger.getSnapshot().contacts.find((c) => c.id === alice.id)?.username === fresh);
    expect(alice.messenger.getSnapshot().securityLog.some((e) => e.kind === 'username_change')).toBe(true);

    // Carol takes the old name. Bob looking it up gets Carol — and Alice's chat is untouched.
    await carol.messenger.changeUsername(old);
    const found = await bob.messenger.addContact(old);
    expect(found.id).toBe(carol.id);
    const aliceForBob = bob.messenger.getSnapshot().contacts.find((c) => c.id === alice.id)!;
    expect(aliceForBob.keyWarning).toBeFalsy();
    expect(aliceForBob.username).toBe(fresh);

    // At most three changes a day.
    await alice.messenger.changeUsername(`${fresh}b`);
    await alice.messenger.changeUsername(`${fresh}c`);
    await expect(alice.messenger.changeUsername(`${fresh}d`)).rejects.toMatchObject({ code: 'rate_limited' });
    expectOnlyCiphertext(t.frames, ['привет!']);
    for (const u of [alice, bob, carol]) u.messenger.dispose();
  });

  it('still recognises a real account reset under the same name', async () => {
    const alice = await makeUser(t.url, 'alice');
    const bob = await makeUser(t.url, 'bob');
    await bob.messenger.addContact(alice.username);
    // Alice's account disappears from the relay (as after «Не помню пароль») and someone registers the name.
    await t.relay.store.removeUser(alice.id);
    alice.messenger.dispose();
    const mallory = await makeUser(t.url, 'mallory');
    await mallory.messenger.changeUsername(alice.username);
    const contact = await bob.messenger.addContact(alice.username);
    expect(contact.id).toBe(mallory.id);
    expect(contact.keyWarning).toBe(true);
    bob.messenger.dispose();
    mallory.messenger.dispose();
  });
});
