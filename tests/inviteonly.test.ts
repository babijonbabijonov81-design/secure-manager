// A home server open to the internet: registration only with a token from a veil:// invite, and
// invites that carry the server's key and every address to reach it.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startRelay, type RelayHandle } from '../server/src/relay.ts';
import { inviteLink, parseInvite } from '../src/core/invite.ts';
import { createAccount, findInviteServer } from '../src/core/messenger.ts';
import { MemoryStorage } from '../src/core/storage.ts';
import { FAST_KDF, makeUser, testRelay, waitFor, type TestRelay } from './helpers.ts';

let home: RelayHandle;
let homeUrl: string;
let stranger: TestRelay;
beforeAll(async () => {
  home = await startRelay({ port: 0, host: '127.0.0.1', dataDir: null, inviteOnly: true });
  homeUrl = `ws://127.0.0.1:${home.port}`;
  stranger = await testRelay();
});
afterAll(async () => {
  await home.close();
  await stranger.relay.close();
});

let n = 0;
const register = (inviteToken?: string, serverKey?: string, url = homeUrl) =>
  createAccount({
    storage: new MemoryStorage(),
    serverUrl: url,
    username: `guest_${process.pid % 1000}_${n++}`,
    displayName: 'Гость',
    password: 'guest-password',
    kdf: FAST_KDF,
    ...(inviteToken ? { inviteToken } : {}),
    ...(serverKey ? { serverKey } : {}),
  });

describe('invite-only registration', () => {
  it('refuses strangers, takes a token once', async () => {
    await expect(register()).rejects.toMatchObject({ code: 'invite_required' });
    await expect(register('A'.repeat(22))).rejects.toMatchObject({ code: 'invite_required' });
    const token = home.mintInvite();
    const guest = await register(token);
    await waitFor(() => guest.getSnapshot().status === 'online');
    await expect(register(token)).rejects.toMatchObject({ code: 'invite_required' });
    guest.dispose();
  });

  it('lets members invite friends, five a day', async () => {
    const owner = await register(home.mintInvite());
    await waitFor(() => owner.getSnapshot().status === 'online');
    const tokens = [];
    for (let i = 0; i < 5; i++) tokens.push(await owner.mintRegistration());
    await expect(owner.mintRegistration()).rejects.toMatchObject({ code: 'rate_limited' });
    const friend = await register(tokens[0]);
    await waitFor(() => friend.getSnapshot().status === 'online');
    friend.dispose();
    owner.dispose();
  });

  it('is off unless asked', async () => {
    const open = await makeUser(stranger.url, 'free');
    expect(open.messenger.getSnapshot().me.username).toMatch(/^free/);
    open.messenger.dispose();
  });
});

describe('invites with the server key and addresses', () => {
  it('lead a newcomer to the server that proves the key, past dead and foreign addresses', async () => {
    // The host made the account on «localhost»: that address means nothing to anyone else.
    const host = await register(home.mintInvite(), undefined, `ws://localhost:${home.port}`);
    await waitFor(() => host.getSnapshot().me.serverKey);
    const link = host.createInvite({
      addresses: ['ws://127.0.0.1:9', stranger.url, homeUrl],
      registration: home.mintInvite(),
    });
    const invite = parseInvite(link)!;
    expect(invite.serverKey).toBe(host.getSnapshot().me.serverKey);
    expect(invite.addresses).toEqual(['ws://127.0.0.1:9', stranger.url, homeUrl]);

    // Port 9 is dead, the stranger relay has another key: the third address is the one.
    const found = await findInviteServer(invite);
    expect(found?.address).toBe(homeUrl);
    const guest = await register(invite.registration, invite.serverKey, found!.address);
    await waitFor(() => guest.getSnapshot().status === 'online');
    const contact = await guest.acceptInvite(link);
    expect(contact.id).toBe(host.getSnapshot().me.userId);
    expect(contact.verified).toBe(true);
    guest.dispose();
    host.dispose();
  });

  it('still reads links from older versions', () => {
    const old = inviteLink({ username: 'anna', userId: 'A'.repeat(43), server: 'relay.example.com', token: 'B'.repeat(22) });
    expect(old).not.toContain('sk=');
    const parsed = parseInvite(old)!;
    expect(parsed).toMatchObject({ username: 'anna', server: 'relay.example.com', token: 'B'.repeat(22) });
    expect(parsed.serverKey).toBeUndefined();
    expect(parsed.addresses).toBeUndefined();
  });
});
