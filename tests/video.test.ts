// Видеозвонки и показ экрана: the video-call flag on the offer and the camera/screen state travel
// end-to-end encrypted like every other call signal; the relay never sees them.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { CallSignal, Contact } from '../src/core/types.ts';
import { expectOnlyCiphertext, makeUser, testRelay, waitFor, type TestRelay } from './helpers.ts';

let t: TestRelay;
beforeAll(async () => {
  t = await testRelay();
});
afterAll(async () => {
  await t.relay.close();
});

describe('video call signals', () => {
  it('carry the video flag and the camera/screen state, encrypted', async () => {
    const alice = await makeUser(t.url, 'alice');
    const bob = await makeUser(t.url, 'bob');
    await alice.messenger.addContact(bob.username);
    await alice.messenger.sendText(bob.id, 'привет');
    await waitFor(() => bob.messenger.getSnapshot().conversations[alice.id]?.length);
    bob.messenger.acceptRequest(alice.id);
    const got: CallSignal[] = [];
    bob.messenger.callHandler = (_c: Contact, signal: CallSignal) => {
      got.push(signal);
      return true;
    };
    const sdp = 'v=0\r\no=- 1 2 IN IP4 127.0.0.1\r\ns=video-marker-sdp\r\n';
    await alice.messenger.sendCallSignal(bob.id, { k: 'offer', id: 'call-video-1', sdp, v: 1 });
    await alice.messenger.sendCallSignal(bob.id, { k: 'media', id: 'call-video-1', cam: true, scr: true });
    await waitFor(() => got.length === 2);
    expect(got[0]).toEqual({ k: 'offer', id: 'call-video-1', sdp, v: 1 });
    expect(got[1]).toEqual({ k: 'media', id: 'call-video-1', cam: true, scr: true });
    expectOnlyCiphertext(t.frames, ['video-marker-sdp', 'call-video-1', '"scr"']);
    alice.messenger.dispose();
    bob.messenger.dispose();
  });

  it('cleans a malformed media signal', async () => {
    const alice = await makeUser(t.url, 'alice');
    const bob = await makeUser(t.url, 'bob');
    await alice.messenger.addContact(bob.username);
    await alice.messenger.sendText(bob.id, 'привет');
    await waitFor(() => bob.messenger.getSnapshot().conversations[alice.id]?.length);
    bob.messenger.acceptRequest(alice.id);
    const got: CallSignal[] = [];
    bob.messenger.callHandler = (_c: Contact, signal: CallSignal) => {
      got.push(signal);
      return true;
    };
    await alice.messenger.sendCallSignal(bob.id, { k: 'media', id: 'x', cam: 'yes', scr: 1 } as unknown as CallSignal);
    await waitFor(() => got.length === 1);
    expect(got[0]).toEqual({ k: 'media', id: 'x', cam: false, scr: false });
    alice.messenger.dispose();
    bob.messenger.dispose();
  });
});
