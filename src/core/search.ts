// «Поиск по всей переписке» (features.search): only on this device, never on the server.
//
// The conversations are already decrypted in memory while Veil is unlocked and stay encrypted on
// disk, so the index is just their normalised text, kept in memory next to the messages it was
// made from and gone on lock. Nothing new is written to disk, which is why no SQLCipher is needed.

import { attachmentsOf, type Message } from './types.ts';

export type SearchFilter = 'all' | 'photo' | 'file' | 'link' | 'voice';

export interface SearchHit {
  contactId: string;
  id: string;
  ts: number;
  dir: 'in' | 'out';
  kind: 'text' | 'photo' | 'file' | 'link' | 'voice';
  /** A piece of the text around the first match (or a file name / link title). */
  snippet: string;
  /** Where the query words are inside `snippet`, in order, not overlapping. */
  marks: [number, number][];
}

const LINK = /https?:\/\/[^\s<>"']+/i;

/** Case, «ё» and compatibility forms do not matter. */
export const normalize = (text: string) => text.normalize('NFKC').toLowerCase().replace(/ё/g, 'е');

/** What a message can be found by. Passwords in «Избранное» are found by their title only. */
function searchableText(m: Message): string {
  if (m.note?.kind === 'password') return m.note.title ?? '';
  const parts = [m.note?.title, m.text, m.transcript, m.preview?.title, m.preview?.site, ...attachmentsOf(m).filter((a) => a.kind === 'file').map((a) => a.name)];
  return parts.filter(Boolean).join('\n');
}

const index = new WeakMap<Message, string>();
function indexed(m: Message): string {
  let text = index.get(m);
  if (text === undefined) {
    text = normalize(searchableText(m));
    index.set(m, text);
  }
  return text;
}

function kindOf(m: Message): SearchHit['kind'] {
  const atts = attachmentsOf(m);
  if (atts.some((a) => a.kind === 'voice')) return 'voice';
  if (atts.some((a) => a.kind === 'image')) return 'photo';
  if (atts.some((a) => a.kind === 'file')) return 'file';
  if (m.preview || m.note?.kind === 'link' || (m.text && LINK.test(m.text))) return 'link';
  return 'text';
}

/** Never searchable: system lines, calls, view-once media, sealed capsules, deleted placeholders. */
const searchable = (m: Message) => m.dir !== 'system' && !m.call && !m.once && !(m.capsule && !m.capsule.opened) && !m.deleted;

function passes(m: Message, filter: SearchFilter): boolean {
  if (filter === 'all') return true;
  const kind = kindOf(m);
  return filter === 'link' ? kind === 'link' : filter === kind;
}

/** Every place where one of the words occurs in `text` (already normalised), merged. */
function marksIn(lower: string, words: string[]): [number, number][] {
  const found: [number, number][] = [];
  for (const w of words) for (let i = lower.indexOf(w); i >= 0; i = lower.indexOf(w, i + w.length)) found.push([i, i + w.length]);
  found.sort((a, b) => a[0] - b[0]);
  const merged: [number, number][] = [];
  for (const m of found) {
    const last = merged.at(-1);
    if (last && m[0] <= last[1]) last[1] = Math.max(last[1], m[1]);
    else merged.push([...m]);
  }
  return merged;
}

function snippetFor(m: Message, words: string[]): Pick<SearchHit, 'snippet' | 'marks'> {
  const atts = attachmentsOf(m);
  const raw =
    m.note?.kind === 'password'
      ? (m.note.title ?? 'Пароль')
      : (m.text || m.transcript || m.preview?.title || atts.find((a) => a.kind === 'file')?.name || (atts.some((a) => a.kind === 'voice') ? 'Голосовое' : 'Фото'));
  const flat = raw.replace(/\s+/g, ' ').trim();
  const all = marksIn(normalize(flat), words);
  if (!all.length) return { snippet: flat.slice(0, 120), marks: [] };
  // Starts a little before the first match so it shows in a one-line preview.
  const start = Math.max(0, all[0][0] - 40);
  const end = Math.min(flat.length, start + 160);
  const lead = start > 0 ? 1 : 0;
  const snippet = (lead ? '…' : '') + flat.slice(start, end) + (end < flat.length ? '…' : '');
  const marks = all.filter(([a, b]) => a >= start && b <= end).map(([a, b]): [number, number] => [a - start + lead, b - start + lead]);
  return { snippet, marks };
}

/**
 * Every word of the query must be in the message (in any order). With an empty query, a filter
 * lists everything of that kind. Newest first.
 */
export function searchMessages(
  conversations: Iterable<[string, Message[]]>,
  query: string,
  filter: SearchFilter = 'all',
  skip: (contactId: string) => boolean = () => false,
  limit = 200,
): SearchHit[] {
  const words = normalize(query).split(/\s+/).filter(Boolean);
  if (!words.length && filter === 'all') return [];
  const hits: SearchHit[] = [];
  for (const [contactId, messages] of conversations) {
    if (skip(contactId)) continue;
    for (const m of messages) {
      if (!searchable(m) || !passes(m, filter)) continue;
      if (words.length) {
        const text = indexed(m);
        if (!words.every((w) => text.includes(w))) continue;
      }
      hits.push({ contactId, id: m.id, ts: m.ts, dir: m.dir as 'in' | 'out', kind: kindOf(m), ...snippetFor(m, words) });
    }
  }
  return hits.sort((a, b) => b.ts - a.ts).slice(0, limit);
}
