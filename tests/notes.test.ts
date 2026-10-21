import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { snippetOf } from '../src/core/messenger.ts';
import { SAVED_ID, type Message } from '../src/core/types.ts';
import { makeUser, messages, testRelay, type TestRelay } from './helpers.ts';

let t: TestRelay;
beforeAll(async () => {
  t = await testRelay();
});
afterAll(async () => {
  await t.relay.close();
});
afterEach(() => vi.useRealTimers());

const DAY = 86_400_000;

describe('«Избранное» notes and temporary notes (P1-3)', () => {
  it('notes, links and passwords; passwords never show in previews', async () => {
    const { messenger } = await makeUser(t.url, 'alice');
    messenger.addNote({ text: 'Купить хлеб' });
    messenger.addNote({ text: 'https://example.org/a' });
    const password = messenger.addNote({ text: 'sunflower-42', kind: 'password', title: 'Wi-Fi' });
    const list = messages(messenger, SAVED_ID);
    expect(list.map((m) => m.note?.kind)).toEqual(['note', 'link', 'password']);
    expect(snippetOf(password)).toBe('Пароль · Wi-Fi');
    expect(() => messenger.addNote({ text: '   ' })).toThrow();
    messenger.dispose();
  });

  it('a temporary note reminds a day before and then burns for good', async () => {
    const reminded: Message[] = [];
    const user = await makeUser(t.url, 'bob');
    const messenger = user.messenger;
    (messenger as unknown as { events: { onNoteReminder(m: Message): void } }).events.onNoteReminder = (m) => reminded.push(m);
    const start = Date.now();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(start);
    const note = messenger.addNote({ text: 'Код от подъезда 4521', burnDays: 7 });
    expect(note.expiresAt).toBe(start + 7 * DAY);
    const tick = () => (messenger as unknown as { tick(): void }).tick();

    vi.setSystemTime(start + 5 * DAY);
    tick();
    expect(reminded).toHaveLength(0);
    vi.setSystemTime(start + 6 * DAY + 60_000);
    tick();
    expect(reminded.map((m) => m.id)).toEqual([note.id]);
    tick();
    expect(reminded).toHaveLength(1); // only once

    vi.setSystemTime(start + 7 * DAY + 1000);
    tick();
    expect(messages(messenger, SAVED_ID).some((m) => m.id === note.id)).toBe(false);
    messenger.dispose();
  });

  it('temporary notes stay out of the server backup', async () => {
    const { messenger } = await makeUser(t.url, 'carol');
    messenger.addNote({ text: 'Сгорит', burnDays: 1 });
    messenger.addNote({ text: 'Останется' });
    const backup = (messenger as unknown as { conversations: Map<string, Message[]> }).conversations.get(SAVED_ID)!.filter((m) => !m.expiresAt && !m.once);
    expect(backup.map((m) => m.text)).toEqual(['Останется']);
    messenger.dispose();
  });
});
