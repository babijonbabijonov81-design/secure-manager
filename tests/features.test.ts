import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startRelay, type RelayHandle } from '../server/src/relay.ts';
import { base32Decode, totp } from '../server/src/shared/totp.ts';
import { utf8 } from '../server/src/shared/wire.ts';
import { WrongPasswordError } from '../src/core/crypto/vault.ts';
import {
  createAccount,
  resetAccount,
  restoreAccount,
  startRecovery,
  unlock,
  verifyRecovery,
  claimRecovery,
  isRecoveryWait,
  snippetOf,
  type Messenger,
} from '../src/core/messenger.ts';
import { MemoryStorage } from '../src/core/storage.ts';

const FAST_KDF = { N: 2 ** 10, r: 8, p: 1 };
let relay: RelayHandle;
let url: string;
const mail: { to: string; text: string }[] = [];

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
async function makeUser(name: string, storage = new MemoryStorage()) {
  const username = `${name}_${process.pid % 1000}_${counter++}`;
  const password = `${name}-password`;
  const messenger = await createAccount({ storage, serverUrl: url, username, displayName: name, password, kdf: FAST_KDF });
  await waitFor(() => messenger.getSnapshot().status === 'online');
  return { messenger, storage, username, password, id: messenger.getSnapshot().me.userId };
}

async function pair() {
  const alice = await makeUser('alice');
  const bob = await makeUser('bob');
  await alice.messenger.addContact(bob.username);
  await alice.messenger.sendText(bob.id, 'hello');
  await waitFor(() => last(bob.messenger, alice.id)?.text === 'hello');
  await bob.messenger.sendText(alice.id, 'hi');
  await waitFor(() => last(alice.messenger, bob.id)?.text === 'hi');
  return { alice, bob };
}

const conv = (m: Messenger, id: string) => (m.getSnapshot().conversations[id] ?? []).filter((x) => x.dir !== 'system');
const last = (m: Messenger, id: string) => conv(m, id).at(-1);
const lastCode = (to?: string) => {
  const entry = [...mail].reverse().find((m) => !to || m.to === to);
  return /(\d{6})/.exec(entry?.text ?? '')?.[1] ?? '';
};
/** A code for the next 30-second step, so the relay's replay protection never trips. */
const codeFor = (secret: string, offsetSteps = 0) => totp(base32Decode(secret), Date.now() + offsetSteps * 30_000);

beforeAll(async () => {
  relay = await startRelay({
    port: 0,
    host: '127.0.0.1',
    dataDir: null,
    mailer: async ({ to, text }) => {
      mail.push({ to, text });
    },
    // Recovery by email alone waits; here a moment instead of 7 days.
    recoveryDelayMs: 800,
  });
  url = `ws://127.0.0.1:${relay.port}`;
});

afterAll(async () => {
  await relay.close();
});

describe('conversation features', () => {
  it('replies, reactions and silent deletion', async () => {
    const { alice, bob } = await pair();
    const original = last(bob.messenger, alice.id)!; // "hi" from bob's side
    await alice.messenger.sendText(bob.id, 'ответ на hi', { replyTo: conv(alice.messenger, bob.id).at(-1)!.id });
    const reply = await waitFor(() => conv(bob.messenger, alice.id).find((m) => m.text === 'ответ на hi'));
    expect(reply.reply).toEqual({ id: original.id, text: 'hi', out: true });

    await bob.messenger.react(alice.id, reply.id, '❤️');
    await waitFor(() => conv(alice.messenger, bob.id).find((m) => m.text === 'ответ на hi')?.reactions?.them === '❤️');
    await bob.messenger.react(alice.id, reply.id, '❤️'); // toggles off
    await waitFor(() => !conv(alice.messenger, bob.id).find((m) => m.text === 'ответ на hi')?.reactions?.them);

    // Bob deletes "hi" for everyone: it vanishes and quotes of it disappear too.
    await bob.messenger.deleteMessage(alice.id, original.id, true);
    await waitFor(() => !conv(alice.messenger, bob.id).some((m) => m.id === original.id));
    const quoting = conv(alice.messenger, bob.id).find((m) => m.text === 'ответ на hi')!;
    expect(quoting.reply).toBeUndefined();
    expect(JSON.stringify(alice.messenger.getSnapshot().conversations)).not.toContain('deleted');

    alice.messenger.dispose();
    bob.messenger.dispose();
  });

  it('albums with a caption, voice messages and stickers that can be saved', async () => {
    const { alice, bob } = await pair();
    const photos = [1, 2, 3].map((n) => ({
      name: `p${n}.jpg`,
      mime: 'image/jpeg',
      data: new Uint8Array(1000 * n).fill(n),
      w: 100 * n,
      h: 80,
    }));
    await alice.messenger.sendMedia(bob.id, photos, { caption: 'Наш отпуск 🌴' });
    const album = await waitFor(() => conv(bob.messenger, alice.id).find((m) => m.atts?.length === 3));
    expect(album.text).toBe('Наш отпуск 🌴');
    for (const [i, att] of album.atts!.entries()) {
      expect(att).toMatchObject({ kind: 'image', size: 1000 * (i + 1), w: 100 * (i + 1) });
      expect((await bob.messenger.getAttachment(att.id))![0]).toBe(i + 1);
    }

    await alice.messenger.sendVoice(bob.id, { data: utf8('opus-bytes'), mime: 'audio/webm', dur: 3.4, wave: [1, 5, 31, 40] });
    const voice = await waitFor(() => conv(bob.messenger, alice.id).find((m) => m.atts?.[0]?.kind === 'voice'));
    expect(voice.atts![0]).toMatchObject({ dur: 3.4, wave: [1, 5, 31, 31] });

    const sticker = await alice.messenger.addSticker(new Uint8Array([7, 7, 7]), 'image/webp', 256, 256);
    await alice.messenger.sendSticker(bob.id, sticker.id);
    const got = await waitFor(() => conv(bob.messenger, alice.id).find((m) => m.atts?.[0]?.kind === 'sticker'));
    expect(got.atts![0].sticker).toBe(sticker.id);
    const saved = await bob.messenger.saveSticker(got.atts![0]);
    expect(saved.id).toBe(sticker.id);
    expect(bob.messenger.getSnapshot().stickers.map((s) => s.id)).toContain(sticker.id);

    alice.messenger.dispose();
    bob.messenger.dispose();
  });

  it('«кружки»: round video messages up to a minute; anything but video arrives as a file', async () => {
    const { alice, bob } = await pair();
    const video = new Uint8Array(5000).fill(9);
    await alice.messenger.sendCircle(bob.id, { data: video, mime: 'video/webm', dur: 75, size: 384 });
    const circle = await waitFor(() => conv(bob.messenger, alice.id).find((m) => m.atts?.[0]?.kind === 'circle'));
    expect(circle.atts![0]).toMatchObject({ kind: 'circle', mime: 'video/webm', dur: 60, w: 384, h: 384, size: 5000 });
    expect((await bob.messenger.getAttachment(circle.atts![0].id))![0]).toBe(9);
    expect(snippetOf(circle)).toBe('Кружок · 1:00');
    expect(() => alice.messenger.sendCircle(bob.id, { data: video, mime: 'image/png', dur: 3, size: 384 })).toThrow('видео');

    // A circle that is not a video (a forged one) is just a file on the other side.
    await alice.messenger.sendMedia(bob.id, [{ name: 'x.png', mime: 'image/png', data: new Uint8Array([1, 2]), kind: 'circle' }]);
    const forged = await waitFor(() => conv(bob.messenger, alice.id).find((m) => m.atts?.[0]?.name === 'x.png'));
    expect(forged.atts![0].kind).toBe('file');

    alice.messenger.dispose();
    bob.messenger.dispose();
  });

  it('profile photo: sent inside the profile, only to those allowed, withdrawn on «nobody»', async () => {
    const { alice, bob } = await pair();
    const photo = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, ...new Array(500).fill(7)]);
    const photoOf = (id: string) => bob.messenger.getSnapshot().contacts.find((c) => c.id === id)?.avatar;
    await expect(alice.messenger.setAvatar(new Uint8Array([1, 2, 3]))).rejects.toThrow('картинкой');

    await alice.messenger.setAvatar(photo);
    const rev = alice.messenger.getSnapshot().me.avatar!;
    await waitFor(() => photoOf(alice.id) === rev);
    expect([...(await bob.messenger.getAvatar(alice.id))!]).toEqual([...photo]);

    // Only verified contacts: Bob is not verified, so the photo is withdrawn.
    alice.messenger.updateSettings({ avatarVisibility: 'verified' });
    await waitFor(() => !photoOf(alice.id));
    expect(await bob.messenger.getAvatar(alice.id)).toBeNull();
    alice.messenger.setVerified(bob.id, true);
    await waitFor(() => photoOf(alice.id) === rev);

    alice.messenger.updateSettings({ avatarVisibility: 'nobody' });
    await waitFor(() => !photoOf(alice.id));
    alice.messenger.updateSettings({ avatarVisibility: 'chats' });
    await waitFor(() => photoOf(alice.id) === rev);
    await alice.messenger.setAvatar(null);
    await waitFor(() => !photoOf(alice.id));

    // Backgrounds stay on this device: a built-in one for all chats, a photo for one chat.
    await alice.messenger.setWallpaper('all', { kind: 'preset', preset: 'ember', dim: 2 });
    expect(alice.messenger.getSnapshot().settings.wallpaper).toEqual({ kind: 'preset', preset: 'ember', dim: 0.8 });
    await alice.messenger.setWallpaper(bob.id, { kind: 'photo', dim: 0.3 }, photo);
    const own = alice.messenger.getSnapshot().contacts.find((c) => c.id === bob.id)!.wallpaper!;
    expect(own).toMatchObject({ kind: 'photo', dim: 0.3 });
    expect((await alice.messenger.getWallpaperPhoto(bob.id))!.length).toBe(photo.length);
    await alice.messenger.setWallpaper(bob.id, null);
    expect(alice.messenger.getSnapshot().contacts.find((c) => c.id === bob.id)!.wallpaper).toBeUndefined();
    expect(await alice.messenger.getWallpaperPhoto(bob.id)).toBeNull();

    alice.messenger.dispose();
    bob.messenger.dispose();
  });

  it('archived chats come back on a new message unless muted', async () => {
    const { alice, bob } = await pair();
    alice.messenger.setArchived(bob.id, true);
    await bob.messenger.sendText(alice.id, 'вернись');
    await waitFor(() => alice.messenger.getSnapshot().contacts.find((c) => c.id === bob.id)?.archived === false);
    alice.messenger.setArchived(bob.id, true);
    alice.messenger.setMuted(bob.id, true);
    await bob.messenger.sendText(alice.id, 'тихо');
    await waitFor(() => last(alice.messenger, bob.id)?.text === 'тихо');
    expect(alice.messenger.getSnapshot().contacts.find((c) => c.id === bob.id)?.archived).toBe(true);
    alice.messenger.dispose();
    bob.messenger.dispose();
  });

  it('presence: online, last seen time, and "recently" when hidden', async () => {
    const { alice, bob } = await pair();
    bob.messenger.reconnect(); // bob comes online again and asks for statuses
    await waitFor(() => alice.messenger.getSnapshot().online[bob.id]);
    await waitFor(() => bob.messenger.getSnapshot().online[alice.id]);

    await bob.messenger.lock(); // going offline announces it
    const seen = await waitFor(() => alice.messenger.getSnapshot().contacts.find((c) => c.id === bob.id)?.lastSeen);
    expect(Date.now() - seen).toBeLessThan(5000);
    expect(alice.messenger.getSnapshot().online[bob.id]).toBeUndefined();

    const bob2 = await unlock(bob.storage, bob.password);
    bob2.updateSettings({ lastSeen: 'nobody' });
    await waitFor(() => alice.messenger.getSnapshot().contacts.find((c) => c.id === bob.id)?.presenceHidden);
    expect(alice.messenger.getSnapshot().contacts.find((c) => c.id === bob.id)?.lastSeen).toBeUndefined();
    alice.messenger.dispose();
    bob2.dispose();
  });
});

describe('account security', () => {
  it('two-factor authentication guards unlock and recovery', async () => {
    const user = await makeUser('totp');
    const { secret, url: otpUrl } = user.messenger.beginTotpSetup();
    expect(otpUrl).toContain('otpauth://totp/');
    await expect(user.messenger.confirmTotpSetup('000000')).rejects.toThrow();
    await user.messenger.confirmTotpSetup(codeFor(secret));
    expect(user.messenger.getSnapshot().security.totp).toBe(true);
    await user.messenger.lock();

    const again = await unlock(user.storage, user.password);
    expect(again.needsTotp).toBe(true);
    expect(again.getSnapshot().status).toBe('offline');
    expect(again.completeTotp('123')).toBe(false);
    expect(again.completeTotp(codeFor(secret))).toBe(true);
    await waitFor(() => again.getSnapshot().status === 'online');

    await again.disableTotp(codeFor(secret, 1));
    expect(again.getSnapshot().security.totp).toBe(false);
    again.dispose();
  });

  it('restores an account from the encrypted backup after email (+2FA) verification', async () => {
    const { alice, bob } = await pair();
    const email = `alice${counter}@example.com`;
    await alice.messenger.setRecoveryEmail(email, 'wrong').catch((e) => expect(e).toBeInstanceOf(WrongPasswordError));
    await alice.messenger.setRecoveryEmail(email, alice.password);
    await waitFor(() => lastCode(email));
    await alice.messenger.confirmRecoveryEmail(lastCode(email));
    await waitFor(() => alice.messenger.getSnapshot().security.lastBackupAt);
    const { secret } = alice.messenger.beginTotpSetup();
    await alice.messenger.confirmTotpSetup(codeFor(secret));
    await alice.messenger.backupNow();

    // The relay only has ciphertext.
    const stored = await relay.store.getBackup(alice.id);
    expect(Buffer.from(stored!).includes(Buffer.from('hello'))).toBe(false);
    alice.messenger.dispose();

    // A new computer: wrong email gets no code, right email does.
    const before = mail.length;
    await startRecovery(url, alice.username, 'someone@else.com');
    expect(mail.length).toBe(before);
    await startRecovery(url, `@${alice.username}`, email);
    await waitFor(() => mail.length > before);
    await expect(verifyRecovery(url, alice.username, '000000')).rejects.toMatchObject({ code: 'bad_code' });
    await expect(verifyRecovery(url, alice.username, lastCode(email))).rejects.toMatchObject({ code: 'totp_required' });
    // Email + authenticator: no waiting.
    const ticket = await verifyRecovery(url, alice.username, lastCode(email), codeFor(secret, 1));
    if (isRecoveryWait(ticket)) throw new Error('two factors must not wait');
    expect(ticket.backup).not.toBeNull();

    const storage = new MemoryStorage();
    await expect(restoreAccount({ storage, ticket, password: 'nope', kdf: FAST_KDF })).rejects.toBeInstanceOf(WrongPasswordError);
    const restored = await restoreAccount({ storage, ticket, password: alice.password, kdf: FAST_KDF });
    await waitFor(() => restored.getSnapshot().status === 'online');
    expect(restored.getSnapshot().me.userId).toBe(alice.id);
    expect(conv(restored, bob.id).map((m) => m.text)).toEqual(['hello', 'hi']);
    expect(restored.getSnapshot().security).toMatchObject({ totp: true, recoveryEmail: email });

    // Messaging continues with fresh sessions in both directions.
    await restored.sendText(bob.id, 'я на новом компьютере');
    await waitFor(() => last(bob.messenger, alice.id)?.text === 'я на новом компьютере');
    await bob.messenger.sendText(alice.id, 'вижу!');
    await waitFor(() => last(restored, bob.id)?.text === 'вижу!');
    restored.dispose();
    bob.messenger.dispose();
  });

  it('email alone waits, the owner can cancel, then a forgotten password keeps the username with new keys', async () => {
    const user = await makeUser('forgot');
    const email = `forgot${counter}@example.com`;
    await user.messenger.setRecoveryEmail(email, user.password);
    await waitFor(() => lastCode(email));
    await user.messenger.confirmRecoveryEmail(lastCode(email));

    // Someone with the mailbox starts a recovery: it waits, and the owner hears of it at once.
    await startRecovery(url, user.username, email);
    await waitFor(() => lastCode(email));
    const intruder = await verifyRecovery(url, user.username, lastCode(email));
    if (!isRecoveryWait(intruder)) throw new Error('email alone must wait');
    await expect(claimRecovery(intruder)).rejects.toMatchObject({ code: 'recovery_wait' });
    await waitFor(() => user.messenger.getSnapshot().recoveryHold);
    expect(user.messenger.getSnapshot().securityLog.some((e) => e.kind === 'recovery_hold')).toBe(true);
    // «Это не я»: even after the wait the claim is worthless.
    await user.messenger.cancelRecovery();
    await new Promise((r) => setTimeout(r, 900));
    await expect(claimRecovery(intruder)).rejects.toMatchObject({ code: 'bad_code' });
    user.messenger.dispose();

    // The real owner, who forgot the password, waits it out.
    const sent = mail.length;
    await startRecovery(url, user.username, email);
    await waitFor(() => mail.length > sent);
    const wait = await verifyRecovery(url, user.username, lastCode(email));
    if (!isRecoveryWait(wait)) throw new Error('email alone must wait');
    await new Promise((r) => setTimeout(r, 900));
    const ticket = await claimRecovery(wait);
    const fresh = await resetAccount({ storage: new MemoryStorage(), ticket, displayName: 'New', password: 'new-password', kdf: FAST_KDF });
    await waitFor(() => fresh.getSnapshot().status === 'online');
    expect(fresh.getSnapshot().me.username).toBe(user.username);
    expect(fresh.getSnapshot().me.userId).not.toBe(user.id);
    expect(relay.store.users.has(user.id)).toBe(false);
    fresh.dispose();
  });
});
