import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { makeUser, testRelay, type TestRelay } from './helpers.ts';

let t: TestRelay;
beforeAll(async () => {
  t = await testRelay();
});
afterAll(async () => {
  await t.relay.close();
});

describe('hidden chats (P1-7)', () => {
  it('stores only hashes; the phrase and the PIN are checked, chats hide and come back', async () => {
    const alice = await makeUser(t.url, 'alice');
    const bob = await makeUser(t.url, 'bob');
    await alice.messenger.addContact(bob.username);
    alice.messenger.setHidden(bob.id, true);
    expect(alice.messenger.getSnapshot().contacts.find((c) => c.id === bob.id)?.hidden).toBeFalsy(); // not set up yet
    await expect(alice.messenger.setupHiddenChats('кот', '1234')).rejects.toMatchObject({ code: 'short' });
    await alice.messenger.setupHiddenChats('Синий кит', '2468');
    const account = JSON.stringify((alice.messenger as unknown as { account: unknown }).account);
    expect(account).not.toContain('Синий кит');
    expect(account).not.toContain('синий кит');
    expect(account).not.toContain('2468');
    expect(await alice.messenger.isHiddenPhrase('  синий КИТ ')).toBe(true);
    expect(await alice.messenger.isHiddenPhrase('синий')).toBe(false);
    expect(await alice.messenger.checkHiddenPin('2468')).toBe(true);
    expect(await alice.messenger.checkHiddenPin('2469')).toBe(false);
    alice.messenger.setHidden(bob.id, true);
    expect(alice.messenger.getSnapshot().contacts.find((c) => c.id === bob.id)?.hidden).toBe(true);
    await alice.messenger.disableHiddenChats();
    expect(alice.messenger.getSnapshot().contacts.find((c) => c.id === bob.id)?.hidden).toBeFalsy();
    expect(alice.messenger.getSnapshot().security.hiddenChats).toBe(false);
    alice.messenger.dispose();
    bob.messenger.dispose();
  });
});
