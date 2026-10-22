// «Поиск по всей переписке»: words in any order, «ё» = «е», filters, what is never found,
// hidden chats, and that searching sends nothing anywhere.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { normalize, searchMessages } from '../src/core/search.ts';
import type { Message } from '../src/core/types.ts';
import { makeUser, messages, testRelay, waitFor, type TestRelay } from './helpers.ts';

let n = 0;
const msg = (patch: Partial<Message>): Message => ({ id: `m${n++}`, dir: 'in', ts: 1000 + n, at: 1000 + n, ...patch });
const file = (kind: 'image' | 'file' | 'voice', name = 'x') => ({ id: `a${n++}`, name, mime: 'application/octet-stream', size: 1, kind });

describe('searchMessages', () => {
  const chats: [string, Message[]][] = [
    [
      'anna',
      [
        msg({ text: 'Ёлка стоит у входа, ключи под ковриком' }),
        msg({ text: 'Встречаемся у ёлки в семь', dir: 'out' }),
        msg({ text: 'Вот статья https://example.org/news', preview: { url: 'https://example.org/news', title: 'Большая новость' } }),
        msg({ atts: [file('image')], text: 'Фото с ёлки' }),
        msg({ atts: [file('file', 'Договор-аренды.pdf')] }),
        msg({ atts: [file('voice')] }),
        msg({ dir: 'system', sys: { kind: 'reset' } }),
        msg({ text: 'секретное фото', once: { k: 'x' } }),
        msg({ capsule: { at: 9e12, ct: 'x' } }),
      ],
    ],
    ['saved', [msg({ dir: 'out', note: { kind: 'password', title: 'Почта' }, text: 'ёлка-пароль-123' })]],
  ];

  it('finds every word in any order, ignoring case and ё', () => {
    expect(searchMessages(chats, 'ЕЛК').map((h) => h.snippet)).toEqual(['Фото с ёлки', 'Встречаемся у ёлки в семь', 'Ёлка стоит у входа, ключи под ковриком']);
    expect(searchMessages(chats, 'ковриком ключи')).toHaveLength(1);
    expect(searchMessages(chats, 'ключи самолёт')).toHaveLength(0);
    expect(normalize('ЁЖ')).toBe('еж');
  });

  it('marks where the match is and who wrote it', () => {
    const [hit] = searchMessages(chats, 'семь ёлки');
    expect(hit.dir).toBe('out');
    expect(hit.marks.map(([a, b]) => hit.snippet.slice(a, b))).toEqual(['ёлки', 'семь']);
    const long = searchMessages([['x', [msg({ text: `${'слово '.repeat(40)}находка в конце` })]]], 'находка')[0];
    expect(long.snippet.startsWith('…')).toBe(true);
    expect(long.snippet.slice(...long.marks[0])).toBe('находка');
  });

  it('finds file names and link titles; filters by kind', () => {
    expect(searchMessages(chats, 'договор')[0].kind).toBe('file');
    expect(searchMessages(chats, 'новость')[0].kind).toBe('link');
    expect(searchMessages(chats, '', 'photo').map((h) => h.kind)).toEqual(['photo']);
    expect(searchMessages(chats, '', 'file')).toHaveLength(1);
    expect(searchMessages(chats, '', 'voice')).toHaveLength(1);
    expect(searchMessages(chats, '', 'link')).toHaveLength(1);
    expect(searchMessages(chats, 'ёлки', 'photo')).toHaveLength(1);
    expect(searchMessages(chats, '')).toEqual([]);
  });

  it('finds voice messages by the text recognised on this device', () => {
    const voice: [string, Message[]][] = [['x', [msg({ atts: [file('voice')], transcript: 'Встретимся на вокзале в семь' })]]];
    const [hit] = searchMessages(voice, 'вокзале');
    expect(hit.kind).toBe('voice');
    expect(hit.snippet).toBe('Встретимся на вокзале в семь');
    expect(searchMessages(voice, 'вокзал', 'voice')).toHaveLength(1);
  });

  it('never finds a password, view-once media or a sealed capsule; skips chats on request', () => {
    expect(searchMessages(chats, 'пароль')).toHaveLength(0);
    expect(searchMessages(chats, 'почта')[0].snippet).toBe('Почта');
    expect(searchMessages(chats, 'секретное')).toHaveLength(0);
    expect(searchMessages(chats, 'ёлка', 'all', (id) => id === 'anna')).toHaveLength(0);
  });
});

describe('Messenger.search', () => {
  let t: TestRelay;
  beforeAll(async () => {
    t = await testRelay();
  });
  afterAll(async () => {
    await t.relay.close();
  });

  it('works on this device only and leaves hidden chats out until they are open', async () => {
    const alice = await makeUser(t.url, 'alice');
    const bob = await makeUser(t.url, 'bob');
    const carol = await makeUser(t.url, 'carol');
    const c1 = await alice.messenger.addContact(bob.username);
    const c2 = await alice.messenger.addContact(carol.username);
    await alice.messenger.sendText(c1.id, 'Пароль от вайфая на холодильнике');
    await alice.messenger.sendText(c2.id, 'Холодильник сломался');
    await waitFor(() => messages(carol.messenger, alice.id).length > 0);
    const framesBefore = t.frames.length;
    expect(alice.messenger.search('холодильн').map((h) => h.contactId).sort()).toEqual([c1.id, c2.id].sort());
    expect(t.frames.length).toBe(framesBefore);

    await alice.messenger.setupHiddenChats('тайная фраза', '2468');
    alice.messenger.setHidden(c2.id, true);
    expect(alice.messenger.search('холодильн').map((h) => h.contactId)).toEqual([c1.id]);
    expect(alice.messenger.search('холодильн', 'all', { hidden: true })).toHaveLength(2);

    alice.messenger.updateSettings({ features: { ...alice.messenger.getSnapshot().settings.features, search: false } });
    expect(alice.messenger.search('холодильн')).toEqual([]);
    for (const u of [alice, bob, carol]) u.messenger.dispose();
  });
});
