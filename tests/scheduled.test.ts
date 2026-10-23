import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { unlock } from '../src/core/messenger.ts';
import { expectOnlyCiphertext, lastText, makeUser, messages, testRelay, waitFor, type TestRelay } from './helpers.ts';

let t: TestRelay;
beforeAll(async () => {
  t = await testRelay();
});
afterAll(async () => {
  await t.relay.close();
});

/** Moves a message's due time into the past, as if the clock had run on. */
function makeDue(m: { conversations: Map<string, { id: string; schedule?: { at: number }; capsule?: { at: number } }[]> }, contactId: string, field: 'schedule' | 'capsule', ago: number) {
  const list = m.conversations.get(contactId)!;
  m.conversations.set(
    contactId,
    list.map((x) => (x[field] ? { ...x, [field]: { ...x[field]!, at: Date.now() - ago } } : x)),
  );
  (m as unknown as { lastTimedScan: number }).lastTimedScan = 0;
}

describe('scheduled send and time capsules (P1-5)', () => {
  it('a scheduled message waits on this computer, then goes; one missed while off is marked late', async () => {
    const alice = await makeUser(t.url, 'alice');
    const bob = await makeUser(t.url, 'bob');
    const contact = await alice.messenger.addContact(bob.username);
    await alice.messenger.sendText(contact.id, 'Привет');
    await waitFor(() => lastText(bob.messenger, alice.id) === 'Привет');
    await alice.messenger.sendText(contact.id, 'С днём рождения!', { at: Date.now() + 3600_000 });
    const scheduled = messages(alice.messenger, contact.id).at(-1)!;
    expect(scheduled.status).toBe('scheduled');
    await new Promise((r) => setTimeout(r, 300));
    expect(lastText(bob.messenger, alice.id)).toBe('Привет'); // nothing sent yet

    // The computer was off at the time: after unlocking, it goes at once, marked late.
    await alice.messenger.lock();
    const again = await unlock(alice.storage, alice.password);
    await waitFor(() => again.getSnapshot().status === 'online');
    makeDue(again as never, contact.id, 'schedule', 10 * 60_000);
    await waitFor(() => lastText(bob.messenger, alice.id) === 'С днём рождения!', 8000);
    const sent = messages(again, contact.id).at(-1)!;
    expect(sent.schedule?.late).toBe(true);
    expect(sent.status).not.toBe('scheduled');

    // «Отправить сейчас» and «Отменить».
    await again.sendText(contact.id, 'Позже', { at: Date.now() + 3600_000 });
    await again.sendScheduledNow(contact.id, messages(again, contact.id).at(-1)!.id);
    await waitFor(() => lastText(bob.messenger, alice.id) === 'Позже');
    await again.sendText(contact.id, 'Не отправится', { at: Date.now() + 3600_000 });
    await again.deleteMessage(contact.id, messages(again, contact.id).at(-1)!.id, false);
    expect(messages(again, contact.id).some((m) => m.text === 'Не отправится')).toBe(false);
    again.dispose();
    bob.messenger.dispose();
  });

  it('a time capsule arrives sealed and opens only when its key comes', async () => {
    const alice = await makeUser(t.url, 'alice');
    const bob = await makeUser(t.url, 'bob');
    const contact = await alice.messenger.addContact(bob.username);
    await alice.messenger.sendText(contact.id, 'Сначала просто привет');
    await waitFor(() => lastText(bob.messenger, alice.id) === 'Сначала просто привет');
    bob.messenger.acceptRequest(alice.id);
    const openAt = Date.now() + 30 * 86_400_000;
    await alice.messenger.sendText(contact.id, 'Письмо в будущее: открой через месяц', { capsule: openAt });

    const sealed = await waitFor(() => messages(bob.messenger, alice.id).find((m) => m.capsule));
    expect(sealed.text).toBeUndefined();
    expect(sealed.capsule?.at).toBe(openAt);
    expect(sealed.capsule?.ct).toBeTruthy();
    expect(sealed.capsule?.k).toBeUndefined();
    // The sender sees the text and keeps the key.
    const mine = messages(alice.messenger, contact.id).find((m) => m.capsule)!;
    expect(mine.text).toBe('Письмо в будущее: открой через месяц');
    await waitFor(() => messages(alice.messenger, contact.id).find((m) => m.capsule)?.status === 'delivered');

    // The date comes on the sender's side: the key goes, the capsule opens.
    makeDue(alice.messenger as never, contact.id, 'capsule', 1000);
    makeDue(bob.messenger as never, alice.id, 'capsule', 1000);
    await waitFor(() => messages(bob.messenger, alice.id).find((m) => m.capsule)?.text === 'Письмо в будущее: открой через месяц', 8000);
    expect(messages(bob.messenger, alice.id).find((m) => m.capsule)?.capsule?.opened).toBe(true);
    expect(messages(alice.messenger, contact.id).find((m) => m.capsule)?.capsule?.sent).toBe(true);

    expectOnlyCiphertext(t.frames, ['С днём рождения', 'Письмо в будущее', 'открой через месяц', 'Не отправится']);
    alice.messenger.dispose();
    bob.messenger.dispose();
  });
});
