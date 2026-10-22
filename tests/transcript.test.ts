// «Голосовые в текст»: the text recognised on this device stays on this device.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { expectOnlyCiphertext, makeUser, messages, testRelay, waitFor, type TestRelay } from './helpers.ts';

let t: TestRelay;
beforeAll(async () => {
  t = await testRelay();
});
afterAll(async () => {
  await t.relay.close();
});

describe('transcripts', () => {
  it('are kept next to the voice message and never sent', async () => {
    const alice = await makeUser(t.url, 'alice');
    const bob = await makeUser(t.url, 'bob');
    const contact = await alice.messenger.addContact(bob.username);
    await alice.messenger.sendMedia(contact.id, [{ name: 'voice.ogg', mime: 'audio/ogg', data: new Uint8Array(2000).fill(7), kind: 'voice', dur: 3 }]);
    const voice = await waitFor(() => messages(bob.messenger, alice.id).find((m) => m.atts?.[0]?.kind === 'voice'));

    bob.messenger.setTranscript(alice.id, voice.id, '  Встретимся у фонтана в полдень  ');
    expect(messages(bob.messenger, alice.id).find((m) => m.id === voice.id)?.transcript).toBe('Встретимся у фонтана в полдень');
    // Only voice messages take a transcript.
    await bob.messenger.sendText(alice.id, 'ок');
    const text = messages(bob.messenger, alice.id).at(-1)!;
    bob.messenger.setTranscript(alice.id, text.id, 'подмена');
    expect(messages(bob.messenger, alice.id).at(-1)?.transcript).toBeUndefined();

    await bob.messenger.react(alice.id, voice.id, '👍');
    await waitFor(() => messages(alice.messenger, bob.id).some((m) => m.reactions?.them === '👍'));
    expect(messages(alice.messenger, bob.id).find((m) => m.atts?.[0]?.kind === 'voice')?.transcript).toBeUndefined();
    expectOnlyCiphertext(t.frames, ['Встретимся у фонтана']);
    alice.messenger.dispose();
    bob.messenger.dispose();
  });
});
