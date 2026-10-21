// «Сервер видит только шифр»: every frame the relay receives or sends is captured and searched
// for the plaintext of everything the features send — texts, names, files, notes, previews.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MemoryStorage } from '../src/core/storage.ts';
import { expectOnlyCiphertext, lastText, makeUser, messages, testRelay, waitFor, type TestRelay } from './helpers.ts';

let t: TestRelay;
beforeAll(async () => {
  t = await testRelay();
});
afterAll(async () => {
  await t.relay.close();
});

describe('the relay sees only ciphertext', () => {
  it('messages, replies, reactions, timers, files, typing, presence and profile names', async () => {
    const alice = await makeUser(t.url, 'alice', new MemoryStorage(), 'Алиса Секретная');
    const bob = await makeUser(t.url, 'bob', new MemoryStorage(), 'Борис Тайный');
    const contact = await alice.messenger.addContact(bob.username);
    await alice.messenger.sendText(contact.id, 'Пароль от сейфа: лунная-дорожка-77');
    await waitFor(() => lastText(bob.messenger, alice.id) === 'Пароль от сейфа: лунная-дорожка-77');
    const first = messages(bob.messenger, alice.id).at(-1)!;
    bob.messenger.sendTyping(alice.id, true);
    await bob.messenger.sendText(alice.id, 'Записал в блокнот у камина', { replyTo: first.id });
    await waitFor(() => lastText(alice.messenger, bob.id) === 'Записал в блокнот у камина');
    await alice.messenger.react(contact.id, messages(alice.messenger, bob.id).at(-1)!.id, '🔥');
    await alice.messenger.setTimer(contact.id, 3600);
    await alice.messenger.sendMedia(contact.id, [{ name: 'договор-аренды-квартиры.pdf', mime: 'application/pdf', data: new TextEncoder().encode('%PDF-1.4 Арендатор Иванов') }]);
    await waitFor(() => messages(bob.messenger, alice.id).some((m) => m.atts?.[0]?.name === 'договор-аренды-квартиры.pdf'));
    await alice.messenger.updateProfile('Алиса Новое Имя');
    await waitFor(() => bob.messenger.getSnapshot().contacts.find((c) => c.id === alice.id)?.displayName === 'Алиса Новое Имя');

    expectOnlyCiphertext(t.frames, [
      'Пароль от сейфа',
      'лунная-дорожка-77',
      'Записал в блокнот',
      'Алиса Секретная',
      'Борис Тайный',
      'Алиса Новое Имя',
      'договор-аренды-квартиры',
      'Арендатор Иванов',
      '🔥',
    ]);
    // The check itself works: usernames are public on the relay (lookup) and are found.
    expect(() => expectOnlyCiphertext(t.frames, [bob.username])).toThrow(/plain form/);
    alice.messenger.dispose();
    bob.messenger.dispose();
  });
});
