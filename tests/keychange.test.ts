import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createAccount } from '../src/core/messenger.ts';
import { MemoryStorage } from '../src/core/storage.ts';
import { FAST_KDF, lastText, makeUser, messages, testRelay, waitFor, type TestRelay } from './helpers.ts';

let t: TestRelay;
beforeAll(async () => {
  t = await testRelay();
});
afterAll(async () => {
  await t.relay.close();
});

describe('a contact whose key changed (P0-3)', () => {
  it('keeps the chat, drops the verified mark, shows a red line and can hold sending', async () => {
    const alice = await makeUser(t.url, 'alice');
    const bob = await makeUser(t.url, 'bob', new MemoryStorage(), 'Максим');
    const contact = await alice.messenger.addContact(bob.username);
    await alice.messenger.sendText(contact.id, 'Старый ключ, привет');
    await waitFor(() => lastText(bob.messenger, alice.id) === 'Старый ключ, привет');
    await bob.messenger.sendText(alice.id, 'Привет!');
    await waitFor(() => lastText(alice.messenger, bob.id) === 'Привет!');
    alice.messenger.setVerified(bob.id, true);
    alice.messenger.updateSettings({ holdUntilVerified: true });

    // Bob loses his computer and starts over with the same username: a brand-new identity key.
    await bob.messenger.deleteAccount();
    const bob2 = await createAccount({ storage: new MemoryStorage(), serverUrl: t.url, username: bob.username, displayName: 'Максим', password: 'x', kdf: FAST_KDF });
    const newId = bob2.getSnapshot().me.userId;
    expect(newId).not.toBe(bob.id);
    await waitFor(() => bob2.getSnapshot().status === 'online');
    const aliceOnBob2 = await bob2.addContact(alice.username);
    await bob2.sendText(aliceOnBob2.id, 'Это я, с нового компьютера');

    const migrated = await waitFor(() => alice.messenger.getSnapshot().contacts.find((c) => c.id === newId));
    expect(alice.messenger.getSnapshot().contacts.some((c) => c.id === bob.id)).toBe(false);
    expect(migrated.keyWarning).toBe(true);
    expect(migrated.verified).toBe(false);
    expect(migrated.displayName).toBe('Максим');
    const history = messages(alice.messenger, newId);
    expect(history.some((m) => m.text === 'Старый ключ, привет')).toBe(true);
    expect(history.some((m) => m.sys?.kind === 'keychange')).toBe(true);
    await waitFor(() => lastText(alice.messenger, newId) === 'Это я, с нового компьютера');

    // «Не отправлять, пока не сверю».
    expect(alice.messenger.isHeld(newId)).toBe(true);
    await expect(alice.messenger.sendText(newId, 'Это точно ты?')).rejects.toMatchObject({ code: 'key_changed' });
    alice.messenger.setVerified(newId, true);
    expect(alice.messenger.isHeld(newId)).toBe(false);
    await alice.messenger.sendText(newId, 'Код совпал, пишу');
    await waitFor(() => lastText(bob2, alice.id) === 'Код совпал, пишу');

    alice.messenger.dispose();
    bob2.dispose();
  });

  it('switching the feature off lifts the hold', async () => {
    const alice = await makeUser(t.url, 'alice');
    const bob = await makeUser(t.url, 'bob');
    await alice.messenger.addContact(bob.username);
    await bob.messenger.deleteAccount();
    const bob2 = await createAccount({ storage: new MemoryStorage(), serverUrl: t.url, username: bob.username, displayName: 'Bob', password: 'x', kdf: FAST_KDF });
    // Looking the username up again finds the new key.
    const contact = await alice.messenger.addContact(bob.username);
    expect(contact.id).toBe(bob2.getSnapshot().me.userId);
    expect(contact.keyWarning).toBe(true);
    alice.messenger.updateSettings({ holdUntilVerified: true });
    expect(alice.messenger.isHeld(contact.id)).toBe(true);
    alice.messenger.updateSettings({ features: { ...alice.messenger.getSnapshot().settings.features, keyGuard: false } });
    expect(alice.messenger.isHeld(contact.id)).toBe(false);
    alice.messenger.acceptKeyChange(contact.id);
    expect(alice.messenger.getSnapshot().contacts.find((c) => c.id === contact.id)?.keyWarning).toBe(false);
    alice.messenger.dispose();
    bob2.dispose();
  });
});
