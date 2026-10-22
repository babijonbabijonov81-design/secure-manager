// Two accounts on one device: separate vaults in one storage, the second never sees the first,
// signing out removes only its own account and this device from the server's list.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { accountTitle, deviceAccounts, duplicateOf, forgetAccount, freeSlot, lastSlot, rememberAccount, setNameHidden, SpaceStorage } from '../src/core/accounts.ts';
import { WrongPasswordError } from '../src/core/crypto/vault.ts';
import { setThisDevice, unlock } from '../src/core/messenger.ts';
import { MemoryStorage } from '../src/core/storage.ts';
import { makeUser, testRelay, waitFor, type TestRelay } from './helpers.ts';

let t: TestRelay;
beforeAll(async () => {
  t = await testRelay();
  setThisDevice({ id: 'test-device-accounts-01', name: 'Тестовый ПК' });
});
afterAll(async () => {
  await t.relay.close();
});

describe('accounts on one device', () => {
  it('keeps two accounts apart and signs out of one', async () => {
    const root = new MemoryStorage();
    const first = new SpaceStorage(root, 1);
    const second = new SpaceStorage(root, 2);
    expect(await freeSlot(root)).toBe(1);

    const anna = await makeUser(t.url, 'anna', first);
    await rememberAccount(root, 1, anna.messenger.getSnapshot().me);
    expect(await freeSlot(root)).toBe(2);
    // The first account keeps the key names it had before accounts existed.
    expect([...root.data.keys()].some((k) => k === 'meta')).toBe(true);

    const boris = await makeUser(t.url, 'boris', second);
    await rememberAccount(root, 2, boris.messenger.getSnapshot().me);
    expect(await freeSlot(root)).toBe(null);
    expect([...root.data.keys()].filter((k) => k !== 'accounts' && k !== 'meta' && !k.startsWith('@2/') && !k.startsWith('r.') && !k.startsWith('d.'))).toEqual([]);

    const list = await deviceAccounts(root);
    expect(list.map((a) => a.slot)).toEqual([1, 2]);
    expect(list.map(accountTitle)).toEqual(['Anna', 'Boris']);
    expect(await lastSlot(root, list)).toBe(2);
    expect(await duplicateOf(root, 2, anna.id)).toBe(1);
    expect(await duplicateOf(root, 2, boris.id)).toBe(null);

    // Each password opens only its own account.
    await anna.messenger.lock();
    await boris.messenger.lock();
    await expect(unlock(first, boris.password)).rejects.toBeInstanceOf(WrongPasswordError);
    await expect(unlock(second, anna.password)).rejects.toBeInstanceOf(WrongPasswordError);
    const annaAgain = await unlock(first, anna.password);
    expect(annaAgain.getSnapshot().me.userId).toBe(anna.id);
    await annaAgain.lock();

    // Hidden names leave only «Аккаунт 2» readable before unlocking.
    await setNameHidden(root, 2, true, boris.messenger.getSnapshot().me);
    const hidden = (await deviceAccounts(root)).find((a) => a.slot === 2)!;
    expect(accountTitle(hidden)).toBe('Аккаунт 2');
    expect(hidden.label?.username).toBeUndefined();

    // Signing out of Boris: his data goes, Anna's stays, and the server forgets this device for him.
    const borisAgain = await unlock(second, boris.password);
    await waitFor(() => borisAgain.getSnapshot().status === 'online');
    expect((await borisAgain.listDevices()).some((d) => d.current)).toBe(true);
    await borisAgain.signOut();
    await forgetAccount(root, 2);
    expect(await second.list()).toEqual([]);
    expect((await deviceAccounts(root)).map((a) => a.slot)).toEqual([1]);
    const annaStill = await unlock(first, anna.password);
    expect(annaStill.getSnapshot().me.username).toBe(anna.username);
    await annaStill.lock();

    // The server forgot this device for Boris, without barring it from signing in again.
    const record = t.relay.store.users.get(boris.id)!;
    expect(record.devices?.some((d) => d.id === 'test-device-accounts-01')).toBe(false);
    expect(record.revoked ?? []).not.toContain('test-device-accounts-01');
  });
});
