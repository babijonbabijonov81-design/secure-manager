// «Приглашение veil://»: the identity key travels in the link, the server cannot swap it, and the
// one-time token verifies the inviter's side too, end-to-end encrypted.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { b64 } from '../server/src/shared/wire.ts';
import { random } from '../src/core/crypto/primitives.ts';
import { inviteLink, parseInvite, serverKey } from '../src/core/invite.ts';
import type { Messenger } from '../src/core/messenger.ts';
import { expectOnlyCiphertext, makeUser, messages, testRelay, waitFor, type TestRelay } from './helpers.ts';

const contactOf = (m: Messenger, id: string) => m.getSnapshot().contacts.find((c) => c.id === id);

describe('the link', () => {
  const userId = b64(random(32));
  it('round-trips and is found inside a text', () => {
    const link = inviteLink({ username: 'alice_1', userId, server: 'wss://Veil.Example.org/', token: 'AAAAAAAAAAAAAAAAAAAAAA' });
    expect(link).toMatch(/^veil:\/\/add\/alice_1\?k=[A-Za-z0-9_-]{43}&s=veil\.example\.org&t=A{22}$/);
    expect(parseInvite(`Добавь меня: ${link} — до встречи`)).toEqual({ username: 'alice_1', userId, server: 'veil.example.org', token: 'AAAAAAAAAAAAAAAAAAAAAA' });
    expect(parseInvite(inviteLink({ username: 'bob_2', userId }))).toEqual({ username: 'bob_2', userId });
  });

  it('rejects broken links', () => {
    for (const bad of ['veil://add/alice', 'veil://add/a?k=short', `veil://add/Bad-Name!?k=${'A'.repeat(43)}`, 'https://example.org/add/alice', 'просто текст']) {
      expect(parseInvite(bad), bad).toBeNull();
    }
    // A bad token is dropped, the key still counts.
    expect(parseInvite(inviteLink({ username: 'alice_1', userId }) + '&t=x')?.token).toBeUndefined();
  });

  it('compares servers however they are written', () => {
    expect(serverKey('wss://Host.example:443/')).toBe(serverKey('host.example:443'));
    expect(serverKey('127.0.0.1:8787')).not.toBe(serverKey('127.0.0.1:8790'));
  });
});

describe('inviting', () => {
  let t: TestRelay;
  beforeAll(async () => {
    t = await testRelay();
  });
  afterAll(async () => {
    await t.relay.close();
  });

  it('verifies both sides and the token works once', async () => {
    const alice = await makeUser(t.url, 'alice');
    const bob = await makeUser(t.url, 'bob');
    const carol = await makeUser(t.url, 'carol');
    const link = alice.messenger.createInvite();
    const token = parseInvite(link)!.token!;

    const contact = await bob.messenger.acceptInvite(link);
    expect(contact.id).toBe(alice.id);
    expect(contactOf(bob.messenger, alice.id)).toMatchObject({ verified: true, verifiedBy: 'invite' });
    expect(messages(bob.messenger, alice.id).at(-1)?.sys).toEqual({ kind: 'invite', by: 'me' });
    // The token comes back to Alice in the first encrypted message: Bob is verified on her side.
    await waitFor(() => contactOf(alice.messenger, bob.id)?.verifiedBy === 'invite');
    expect(messages(alice.messenger, bob.id).some((m) => m.sys?.kind === 'invite' && m.sys.by === 'them')).toBe(true);

    // Carol got the same link later: she checks Alice's key, but the used token verifies no one.
    await carol.messenger.acceptInvite(link);
    expect(contactOf(carol.messenger, alice.id)).toMatchObject({ verified: true, verifiedBy: 'invite' });
    await waitFor(() => contactOf(alice.messenger, carol.id));
    await new Promise((r) => setTimeout(r, 300));
    expect(contactOf(alice.messenger, carol.id)?.verified).toBe(false);

    expectOnlyCiphertext(t.frames, [token]);
    for (const u of [alice, bob, carol]) u.messenger.dispose();
  });

  it('a swapped key is caught before anything is stored', async () => {
    const alice = await makeUser(t.url, 'alice');
    const bob = await makeUser(t.url, 'bob');
    const mallory = await makeUser(t.url, 'mallory');
    await bob.messenger.addContact(alice.username);
    // The link says «alice» but carries another key, as if the server had swapped Alice's key.
    const forged = inviteLink({ username: alice.username, userId: mallory.id, server: t.url });
    await expect(bob.messenger.acceptInvite(forged)).rejects.toMatchObject({ code: 'invite_mismatch' });
    expect(contactOf(bob.messenger, alice.id)).toMatchObject({ verified: false });
    expect(contactOf(bob.messenger, mallory.id)).toBeUndefined();
    expect(bob.messenger.getSnapshot().securityLog.some((e) => e.kind === 'invite_mismatch')).toBe(true);
    for (const u of [alice, bob, mallory]) u.messenger.dispose();
  });

  it('refuses my own link, another server and a turned-off feature', async () => {
    const alice = await makeUser(t.url, 'alice');
    const bob = await makeUser(t.url, 'bob');
    await expect(alice.messenger.acceptInvite(alice.messenger.createInvite())).rejects.toMatchObject({ code: 'own_invite' });
    await expect(bob.messenger.acceptInvite(inviteLink({ username: alice.username, userId: alice.id, server: 'other.example' }))).rejects.toMatchObject({
      code: 'other_server',
    });
    await expect(bob.messenger.acceptInvite('veil://add/x')).rejects.toMatchObject({ code: 'bad_invite' });

    const link = alice.messenger.createInvite();
    alice.messenger.updateSettings({ features: { ...alice.messenger.getSnapshot().settings.features, invites: false } });
    expect(() => alice.messenger.createInvite()).toThrow(/выключены/);
    // With the feature off, Alice ignores the token: Bob stays unverified on her side.
    await bob.messenger.acceptInvite(link);
    await waitFor(() => contactOf(alice.messenger, bob.id));
    await new Promise((r) => setTimeout(r, 300));
    expect(contactOf(alice.messenger, bob.id)?.verified).toBe(false);
    alice.messenger.dispose();
    bob.messenger.dispose();
  });
});
