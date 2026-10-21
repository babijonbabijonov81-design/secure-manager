import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BridgeGuest, BridgeHost, channelPair, formatCode, newCode, normalizeCode, splitRelayCode, type BridgeError } from '../src/core/bridge.ts';
import { relayBridgeChannel } from '../src/core/bridge-relay.ts';
import { importAccount, setThisDevice, unlock } from '../src/core/messenger.ts';
import { MemoryStorage } from '../src/core/storage.ts';
import { expectOnlyCiphertext, FAST_KDF, lastText, makeUser, messages, testRelay, waitFor, type TestRelay } from './helpers.ts';

let t: TestRelay;
beforeAll(async () => {
  t = await testRelay();
});
afterAll(async () => {
  await t.relay.close();
});

const source = (records: Record<string, string>) => ({
  names: async () => Object.keys(records),
  get: async (name: string) => (name in records ? new TextEncoder().encode(records[name]) : null),
});

describe('«Мост»: moving the account (P1-1)', () => {
  it('codes are 8 Crockford characters and survive retyping', () => {
    const code = newCode();
    expect(code).toMatch(/^[0-9A-HJKMNP-TV-Z]{8}$/);
    expect(normalizeCode(formatCode(code).toLowerCase())).toBe(code);
    expect(normalizeCode('k7qm-2xpa')).toBe('K7QM2XPA');
    expect(normalizeCode('O1IL u')).toBe('0111V');
    expect(splitRelayCode('ABCD-K7QM-2XPA')).toEqual({ room: 'ABCD', secret: 'K7QM2XPA' });
  });

  it('the right code gives the same six digits on both sides, and the data arrives', async () => {
    const big = 'x'.repeat(3 * 256 * 1024 + 17);
    const records = { account: '{"userId":"u"}', 'conv.a': 'привет', 'att.1': big, empty: '' };
    const [hostSide, guestSide] = channelPair();
    let hostSas = '';
    let done = false;
    const host = new BridgeHost(source(records), { onSas: (s) => (hostSas = s), onDone: () => (done = true) });
    host.attach(hostSide);
    let guestSas = '';
    let received: Map<string, Uint8Array> | null = null;
    const guest = new BridgeGuest(guestSide, formatCode(host.code).toLowerCase(), { onSas: (s) => (guestSas = s), onRecords: (r) => (received = r) });
    guest.start();
    await waitFor(() => hostSas && guestSas);
    expect(hostSas).toMatch(/^\d{6}$/);
    expect(guestSas).toBe(hostSas);
    expect(received).toBeNull(); // nothing is sent before the person confirms the digits
    await host.confirm();
    const got = await waitFor(() => received);
    expect(new TextDecoder().decode(got.get('conv.a'))).toBe('привет');
    expect(got.get('att.1')!.length).toBe(big.length);
    expect(got.get('empty')!.length).toBe(0);
    guest.finish();
    await waitFor(() => done);
  });

  it('a wrong code is refused; three wrong codes make a new one', async () => {
    const host = new BridgeHost(source({ account: '{}' }));
    const first = host.code;
    let newCodeSeen = '';
    (host as unknown as { events: { onCode(c: string): void } }).events.onCode = (c) => (newCodeSeen = c);
    for (let i = 0; i < 3; i++) {
      const [hostSide, guestSide] = channelPair();
      host.attach(hostSide);
      let error: BridgeError | null = null;
      new BridgeGuest(guestSide, 'AAAAAAAA', { onError: (e) => (error = e) }).start();
      const failed = await waitFor(() => error);
      expect(failed.code).toBe('bad_code');
    }
    expect(newCodeSeen).not.toBe('');
    expect(host.code).not.toBe(first);
  });

  it('moves a real account: the chat continues from the new computer, the old one is wiped', async () => {
    setThisDevice({ id: 'device-old-0000000001', name: 'Старый ноутбук' });
    const alice = await makeUser(t.url, 'alice', new MemoryStorage(), 'Алиса');
    const bob = await makeUser(t.url, 'bob');
    const contact = await alice.messenger.addContact(bob.username);
    await alice.messenger.sendText(contact.id, 'До переноса');
    await waitFor(() => lastText(bob.messenger, alice.id) === 'До переноса');
    await bob.messenger.sendText(alice.id, 'Ответ до переноса');
    await waitFor(() => lastText(alice.messenger, bob.id) === 'Ответ до переноса');
    alice.messenger.addNote({ text: 'Заметка в избранном' });

    // Through the relay: both computers join a room, the relay only pipes bytes.
    const room = 'K7QM';
    let hostSas = '';
    let wiped = false;
    const host = new BridgeHost(await alice.messenger.bridgeSource(), {
      onSas: (s) => (hostSas = s),
      onDone: () => void alice.messenger.wipeAfterBridge().then(() => (wiped = true)),
    });
    await relayBridgeChannel(t.url, room, 'host', (channel) => host.attach(channel));
    setThisDevice({ id: 'device-new-0000000002', name: 'Новый ПК на Linux' });
    const guestChannel = await relayBridgeChannel(t.url, room, 'guest');
    let records: Map<string, Uint8Array> | null = null;
    let guestSas = '';
    const guest = new BridgeGuest(guestChannel, host.code, { onSas: (s) => (guestSas = s), onRecords: (r) => (records = r) });
    guest.start();
    await waitFor(() => hostSas && guestSas === hostSas);
    await host.confirm();
    await waitFor(() => records);
    const storage = new MemoryStorage();
    const alice2 = await importAccount({ storage, password: 'новый-пароль', records: records!, kdf: FAST_KDF });
    guest.finish();
    await waitFor(() => wiped);
    expect(await alice.storage.list()).toEqual([]);
    await waitFor(() => alice2.getSnapshot().status === 'online');

    // Everything is there and the encrypted sessions continue.
    expect(messages(alice2, bob.id).some((m) => m.text === 'До переноса')).toBe(true);
    expect(messages(alice2, 'saved').some((m) => m.text === 'Заметка в избранном')).toBe(true);
    await bob.messenger.sendText(alice.id, 'Привет на новом ПК');
    await waitFor(() => lastText(alice2, bob.id) === 'Привет на новом ПК', 8000);
    await alice2.sendText(bob.id, 'Всё перенеслось');
    await waitFor(() => lastText(bob.messenger, alice.id) === 'Всё перенеслось');
    // The new password opens it after a restart.
    await alice2.lock();
    const again = await unlock(storage, 'новый-пароль');
    await waitFor(() => again.getSnapshot().status === 'online');

    // «Устройства»: both computers, names readable only by the account.
    const devices = await again.listDevices();
    expect(devices.find((d) => d.current)?.name).toBe('Новый ПК на Linux');
    expect(devices.some((d) => d.name === 'Старый ноутбук')).toBe(true);
    expectOnlyCiphertext(t.frames, ['До переноса', 'Ответ до переноса', 'Заметка в избранном', 'Старый ноутбук', 'Новый ПК на Linux', 'Алиса']);

    // «Отвязать»: the relay refuses that computer from now on.
    await again.revokeDevice('device-old-0000000001');
    expect((await again.listDevices()).some((d) => d.id === 'device-old-0000000001')).toBe(false);
    await expect(again.revokeDevice('device-new-0000000002')).rejects.toThrow();
    again.dispose();
    bob.messenger.dispose();
  });
});
