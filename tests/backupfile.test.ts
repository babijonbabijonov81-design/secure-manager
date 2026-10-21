import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createBackupFile, openBackupFile, readBackupHeader } from '../src/core/backup-file.ts';
import { WrongPasswordError } from '../src/core/crypto/vault.ts';
import { restoreBackupFile } from '../src/core/messenger.ts';
import { MemoryStorage } from '../src/core/storage.ts';
import { FAST_KDF, lastText, makeUser, messages, testRelay, waitFor, type TestRelay } from './helpers.ts';

let t: TestRelay;
beforeAll(async () => {
  t = await testRelay();
});
afterAll(async () => {
  await t.relay.close();
});

describe('«.veil» backup file (P1-9)', () => {
  it('round-trips records, refuses a wrong password and any change to the file', async () => {
    const big = new Uint8Array(randomBytes(2_500_000)); // incompressible: three chunks
    const records = new Map([
      ['account', new TextEncoder().encode('{"userId":"x"}')],
      ['att.1', big],
    ]);
    const file = await createBackupFile(records, 'пароль-копии', FAST_KDF);
    expect(Buffer.from(file).includes(Buffer.from('userId'))).toBe(false);
    expect(readBackupHeader(file).header.records).toBe(2);
    const back = await openBackupFile(file, 'пароль-копии');
    expect(Buffer.from(back.get('att.1')!).equals(Buffer.from(big))).toBe(true);
    await expect(openBackupFile(file, 'не тот')).rejects.toBeInstanceOf(WrongPasswordError);
    const tampered = file.slice();
    tampered[tampered.length - 5] ^= 1;
    await expect(openBackupFile(tampered, 'пароль-копии')).rejects.toBeInstanceOf(WrongPasswordError);
    // Cutting the last chunk off is noticed too (the "last" flag is authenticated).
    const { body } = readBackupHeader(file);
    const firstChunk = 28 + new DataView(body.buffer, body.byteOffset + 24, 4).getUint32(0);
    expect(firstChunk).toBeLessThan(body.length);
    const cut = file.slice(0, file.length - body.length + firstChunk);
    await expect(openBackupFile(cut, 'пароль-копии')).rejects.toBeInstanceOf(WrongPasswordError);
    expect(() => readBackupHeader(new TextEncoder().encode('hello'))).toThrow();
  });

  it('restores the account on another computer and the chat goes on', async () => {
    const alice = await makeUser(t.url, 'alice');
    const bob = await makeUser(t.url, 'bob');
    await alice.messenger.addContact(bob.username);
    await alice.messenger.sendText(bob.id, 'До копии');
    await waitFor(() => lastText(bob.messenger, alice.id) === 'До копии');
    alice.messenger.addNote({ text: 'Пароль от роутера', kind: 'password', title: 'Роутер' });
    await alice.messenger.sendMedia('saved', [{ name: 'фото.png', mime: 'image/png', data: new Uint8Array([1, 2, 3, 4]) }]);
    const file = await alice.messenger.exportBackupFile('копия-12345', FAST_KDF);
    expect(alice.messenger.getSnapshot().settings.backupFileAt).toBeGreaterThan(0);
    alice.messenger.dispose();

    const storage = new MemoryStorage();
    const restored = await restoreBackupFile({ storage, file, backupPassword: 'копия-12345', password: 'новый-пароль', kdf: FAST_KDF });
    await waitFor(() => restored.getSnapshot().status === 'online');
    expect(messages(restored, bob.id).some((m) => m.text === 'До копии')).toBe(true);
    const saved = messages(restored, 'saved');
    expect(saved.some((m) => m.note?.kind === 'password')).toBe(true);
    const photo = saved.find((m) => m.atts?.length)!;
    expect(Array.from((await restored.getAttachment(photo.atts![0].id))!)).toEqual([1, 2, 3, 4]);
    expect(restored.getSnapshot().securityLog[0].kind).toBe('backup_import');

    // Fresh sessions both ways.
    await restored.sendText(bob.id, 'После восстановления');
    await waitFor(() => lastText(bob.messenger, alice.id) === 'После восстановления', 8000);
    await bob.messenger.sendText(alice.id, 'Получил');
    await waitFor(() => lastText(restored, bob.id) === 'Получил', 8000);
    restored.dispose();
    bob.messenger.dispose();
  });
});
