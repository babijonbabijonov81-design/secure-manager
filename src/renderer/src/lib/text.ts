// Presence wording and autocorrection.

import { bridge } from '../../../core/platform.ts';
import { sharesWith, type Contact, type Settings } from '../../../core/types.ts';
import { formatDay, formatTime } from './format.ts';

/** "в сети", "был(а) в сети сегодня в 14:32", "был(а) недавно"… or null if unknown. */
export function presenceText(contact: Contact, online: boolean, settings?: Settings): string | null {
  // Reciprocity: hiding my «в сети» from someone hides theirs from me.
  if (settings && !sharesWith(settings, contact, 'online')) return null;
  if (online) return 'в сети';
  if (contact.presenceHidden) return 'был(а) недавно';
  if (!contact.lastSeen) return null;
  const minutes = Math.floor((Date.now() - contact.lastSeen) / 60_000);
  if (minutes < 1) return 'был(а) в сети только что';
  if (minutes < 60) return `был(а) в сети ${minutes} мин. назад`;
  const day = formatDay(contact.lastSeen).toLowerCase();
  return `был(а) в сети ${day} в ${formatTime(contact.lastSeen)}`;
}

/** Optimal string alignment distance (Damerau–Levenshtein with adjacent swaps). */
function distance(a: string, b: string): number {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
    }
  }
  return d[a.length][b.length];
}

const ignored = new Set<string>();
export const ignoreWord = (word: string) => ignored.add(word.toLowerCase());

/**
 * Returns the corrected word when the spellchecker is confident (a close suggestion),
 * otherwise null. Skips short words, numbers, links, mentions and ACRONYMS.
 */
export function autocorrect(word: string): string | null {
  if (!bridge || word.length < 3 || word.length > 30) return null;
  if (/[\d@#/:._]/.test(word) || (word.length > 1 && word === word.toUpperCase())) return null;
  if (ignored.has(word.toLowerCase())) return null;
  let suggestions: string[] | null;
  try {
    suggestions = bridge.spell.suggestions(word);
  } catch {
    return null;
  }
  const best = suggestions?.[0];
  if (!best || /\s/.test(best)) return null;
  const limit = word.length <= 4 ? 1 : 2;
  const dist = distance(word.toLowerCase(), best.toLowerCase());
  if (dist === 0 || dist > limit) return null;
  const capital = word[0] !== word[0].toLowerCase();
  return capital ? best[0].toUpperCase() + best.slice(1) : best;
}
