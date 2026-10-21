import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WrongPasswordError } from '../src/core/crypto/vault.ts';
import { unlock } from '../src/core/messenger.ts';
import { readVaultMeta } from '../src/core/storage.ts';
import { lastText, makeUser, messages, testRelay, waitFor, type TestRelay } from './helpers.ts';

let t: TestRelay;
beforeAll(async () => {
  t = await testRelay();
});
afterAll(async () => {
  await t.relay.close();
});

describe('duress password (P1-4)', () => {
  it('opens an empty Veil that looks the same; the real one stays intact', async () => {
    const alice = await makeUser(t.url, 'alice');
    const bob = await makeUser(t.url, 'bob');
    const contact = await alice.messenger.addContact(bob.username);
    await alice.messenger.sendText(contact.id, 'Настоящая переписка');
    alice.messenger.addNote({ text: 'Секретная заметка' });
    const before = await readVaultMeta(alice.storage);
    expect(before!.alt).toBeDefined(); // the second slot exists even without a duress password
    const randomAltLength = before!.alt!.ct.length;

    await expect(alice.messenger.enableDuress(alice.password, { wipe: false })).rejects.toMatchObject({ code: 'same' });
    await alice.messenger.enableDuress('panic-password-1', { wipe: false });
    expect(alice.messenger.getSnapshot().security.duress).toEqual({ wipe: false });
    const after = await readVaultMeta(alice.storage);
    expect(after!.alt!.ct.length).toBe(randomAltLength); // same shape: the file does not tell
    expect(after!.kdf.salt).toBe(before!.kdf.salt);
    await alice.messenger.lock();

    // Under duress: same name, nothing inside, "online", nobody can be found.
    const decoy = await unlock(alice.storage, 'panic-password-1');
    const snap = decoy.getSnapshot();
    expect(decoy.decoy).toBe(true);
    expect(snap.me.username).toBe(alice.username);
    expect(snap.me.displayName).toBe('Alice');
    expect(snap.me.userId).not.toBe(alice.id);
    expect(snap.contacts.map((c) => c.id)).toEqual(['saved']);
    expect(snap.conversations.saved).toEqual([]);
    expect(snap.status).toBe('online');
    expect(snap.security.duress).toBeUndefined();
    await expect(decoy.addContact(bob.username)).rejects.toMatchObject({ code: 'not_found' });
    // Meanwhile Bob's message waits on the relay for the real account.
    await bob.messenger.sendText(alice.id, 'Пока тебя нет');
    await decoy.lock();

    const real = await unlock(alice.storage, alice.password);
    expect(real.decoy).toBe(false);
    expect(messages(real, contact.id).some((m) => m.text === 'Настоящая переписка')).toBe(true);
    expect(messages(real, 'saved').some((m) => m.text === 'Секретная заметка')).toBe(true);
    await waitFor(() => lastText(real, bob.id) === 'Пока тебя нет');
    await expect(unlock(alice.storage, 'wrong-password')).rejects.toBeInstanceOf(WrongPasswordError);

    // Changing the real password keeps the duress password working.
    await real.changePassword(alice.password, 'new-real-password');
    await real.lock();
    const again = await unlock(alice.storage, 'panic-password-1');
    expect(again.decoy).toBe(true);
    await again.lock();
    const back = await unlock(alice.storage, 'new-real-password');
    await back.disableDuress();
    await back.lock();
    await expect(unlock(alice.storage, 'panic-password-1')).rejects.toBeInstanceOf(WrongPasswordError);
    bob.messenger.dispose();
  });

  it('«Стереть всё при вводе»: the duress password erases the real vault', async () => {
    const alice = await makeUser(t.url, 'carol');
    alice.messenger.addNote({ text: 'Это должно исчезнуть' });
    await alice.messenger.enableDuress('panic-password-2', { wipe: true });
    await alice.messenger.lock();
    const decoy = await unlock(alice.storage, 'panic-password-2');
    expect(decoy.wipedReal).toBe(true);
    expect((await alice.storage.list()).some((k) => k.startsWith('r.'))).toBe(false);
    await decoy.lock();
    await expect(unlock(alice.storage, alice.password)).rejects.toBeInstanceOf(WrongPasswordError);
  });

  it('takes about as long as the real password', async () => {
    const alice = await makeUser(t.url, 'dave');
    for (let i = 0; i < 30; i++) alice.messenger.addNote({ text: `Заметка ${i}` });
    await alice.messenger.enableDuress('panic-password-3', { wipe: false });
    await alice.messenger.lock();
    const time = async (password: string) => {
      const start = performance.now();
      const m = await unlock(alice.storage, password);
      const ms = performance.now() - start;
      await m.lock();
      return ms;
    };
    const real = await time(alice.password);
    const duress = await time('panic-password-3');
    expect(Math.abs(real - duress)).toBeLessThan(Math.max(60, real * 0.5));
  });
});
