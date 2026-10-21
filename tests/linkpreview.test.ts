// Безопасные превью ссылок: what may be fetched, how a page is read, what the recipient accepts,
// and that the preview travels end-to-end encrypted (the relay never sees the title or picture).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cleanPreview, firstLink, isPrivateAddress, isPublicUrl, parsePreview } from '../src/core/link-preview.ts';
import { expectOnlyCiphertext, makeUser, messages, testRelay, waitFor, type TestRelay } from './helpers.ts';

const PIXEL = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

describe('which links may be fetched', () => {
  it('only public http(s) addresses', () => {
    expect(isPublicUrl('https://example.org/article')).toBeTruthy();
    expect(isPublicUrl('http://news.example.com/a?b=1')).toBeTruthy();
    for (const bad of [
      'file:///etc/passwd',
      'ftp://example.org/x',
      'javascript:alert(1)',
      'http://localhost:3000/',
      'http://127.0.0.1/',
      'http://192.168.1.1/admin',
      'http://10.0.0.5/',
      'http://172.20.0.1/',
      'http://169.254.169.254/latest/meta-data',
      'http://[::1]/',
      'http://printer.local/',
      'http://router/',
      'https://user:pass@example.org/',
      'not a url',
    ]) {
      expect(isPublicUrl(bad), bad).toBeNull();
    }
  });

  it('resolved addresses of this computer and local networks are refused', () => {
    for (const ip of ['127.0.0.1', '10.1.2.3', '192.168.0.10', '172.31.255.1', '169.254.1.1', '100.64.0.1', '0.0.0.0', '::1', '::', 'fd00::1', 'fe80::1', '::ffff:127.0.0.1', '224.0.0.1']) {
      expect(isPrivateAddress(ip), ip).toBe(true);
    }
    for (const ip of ['93.184.216.34', '1.1.1.1', '172.15.0.1', '2606:4700:4700::1111']) expect(isPrivateAddress(ip), ip).toBe(false);
  });
});

describe('reading a page', () => {
  it('og: tags in either attribute order, entities, relative picture', () => {
    const html = `<!doctype html><html><head><title>Fallback</title>
      <meta content="Новости &laquo;дня&raquo;" property="og:title">
      <meta property="og:description" content="Коротко &amp; ясно">
      <meta property="og:site_name" content="Пример">
      <meta property="og:image" content="/img/cover.jpg"></head><body>…</body></html>`;
    const p = parsePreview(html, 'https://www.example.org/news/1');
    expect(p).toEqual({ url: 'https://www.example.org/news/1', title: 'Новости «дня»', desc: 'Коротко & ясно', site: 'Пример', imageUrl: 'https://www.example.org/img/cover.jpg' });
  });

  it('falls back to <title> and the host name', () => {
    const p = parsePreview('<html><head><title> Просто\n страница </title></head></html>', 'https://www.example.org/');
    expect(p.title).toBe('Просто страница');
    expect(p.site).toBe('example.org');
    expect(p.imageUrl).toBeUndefined();
  });

  it('finds the first link in a text', () => {
    expect(firstLink('Смотри https://example.org/a/b?c=1, интересно.')).toBe('https://example.org/a/b?c=1');
    expect(firstLink('(https://example.org/x)')).toBe('https://example.org/x');
    expect(firstLink('без ссылок')).toBeUndefined();
  });
});

describe('what the recipient accepts', () => {
  const text = 'Почитай https://example.org/story';
  it('a sane preview for a link that is in the text', () => {
    expect(cleanPreview({ url: 'https://example.org/story', title: ' Заголовок ', desc: 'Описание', site: 'Пример', img: PIXEL }, text)).toEqual({
      url: 'https://example.org/story',
      title: 'Заголовок',
      desc: 'Описание',
      site: 'Пример',
      img: PIXEL,
    });
  });

  it('nothing for a link that is not in the text, or without a title', () => {
    expect(cleanPreview({ url: 'https://evil.example/', title: 'Банк' }, text)).toBeUndefined();
    expect(cleanPreview({ url: 'https://example.org/story', title: '  ' }, text)).toBeUndefined();
    expect(cleanPreview({ url: 'javascript:alert(1)', title: 'x' }, 'javascript:alert(1)')).toBeUndefined();
    expect(cleanPreview('строка', text)).toBeUndefined();
    expect(cleanPreview({ url: 'https://example.org/story', title: 'x' }, undefined)).toBeUndefined();
  });

  it('drops pictures that are not small data: images, and cuts long fields', () => {
    const base = { url: 'https://example.org/story', title: 'Т'.repeat(500), desc: 'О'.repeat(1000) };
    for (const img of ['https://tracker.example/pixel.png', 'data:image/svg+xml;base64,PHN2Zz4=', `data:image/jpeg;base64,${'A'.repeat(100_000)}`]) {
      const p = cleanPreview({ ...base, img }, text)!;
      expect(p.img).toBeUndefined();
      expect(p.title).toHaveLength(200);
      expect(p.desc).toHaveLength(400);
    }
  });
});

describe('a preview in a message', () => {
  let t: TestRelay;
  beforeAll(async () => {
    t = await testRelay();
  });
  afterAll(async () => {
    await t.relay.close();
  });

  it('arrives with the message, encrypted end to end', async () => {
    const alice = await makeUser(t.url, 'alice');
    const bob = await makeUser(t.url, 'bob');
    const contact = await alice.messenger.addContact(bob.username);
    const text = 'Вот https://example.org/secret-plan';
    const preview = { url: 'https://example.org/secret-plan', title: 'План побега из офиса', desc: 'Подробная карта пожарных выходов', site: 'Пример', img: PIXEL };
    await alice.messenger.sendText(contact.id, text, { preview });
    const got = await waitFor(() => messages(bob.messenger, alice.id).find((m) => m.text === text));
    expect(got.preview).toEqual(preview);
    expect(messages(alice.messenger, bob.id).at(-1)?.preview?.title).toBe('План побега из офиса');
    expectOnlyCiphertext(t.frames, ['План побега из офиса', 'Подробная карта пожарных выходов', 'secret-plan', PIXEL.slice(30, 60)]);
    alice.messenger.dispose();
    bob.messenger.dispose();
  });

  it('is not sent when previews are turned off', async () => {
    const alice = await makeUser(t.url, 'alice');
    const bob = await makeUser(t.url, 'bob');
    const contact = await alice.messenger.addContact(bob.username);
    await alice.messenger.updateSettings({ linkPreviews: false });
    const text = 'Без превью https://example.org/a';
    await alice.messenger.sendText(contact.id, text, { preview: { url: 'https://example.org/a', title: 'Заголовок' } });
    const got = await waitFor(() => messages(bob.messenger, alice.id).find((m) => m.text === text));
    expect(got.preview).toBeUndefined();
    await alice.messenger.updateSettings({ linkPreviews: true, features: { ...alice.messenger.getSnapshot().settings.features, linkPreviews: false } });
    await alice.messenger.sendText(contact.id, 'Снова https://example.org/a', { preview: { url: 'https://example.org/a', title: 'Заголовок' } });
    const second = await waitFor(() => messages(bob.messenger, alice.id).find((m) => m.text === 'Снова https://example.org/a'));
    expect(second.preview).toBeUndefined();
    alice.messenger.dispose();
    bob.messenger.dispose();
  });
});
