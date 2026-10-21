import type { Contact, Message } from '../../../core/types.ts';

const pad = (n: number) => String(n).padStart(2, '0');

export const formatTime = (ts: number) => {
  const d = new Date(ts);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

const startOfDay = (ts: number) => {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
};

const MONTHS = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];
const WEEKDAYS = ['Вс', 'Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб'];

export function formatDay(ts: number): string {
  const today = startOfDay(Date.now());
  const day = startOfDay(ts);
  if (day === today) return 'Сегодня';
  if (day === today - 86_400_000) return 'Вчера';
  const d = new Date(ts);
  const sameYear = d.getFullYear() === new Date().getFullYear();
  return `${d.getDate()} ${MONTHS[d.getMonth()]}${sameYear ? '' : ` ${d.getFullYear()}`}`;
}

/** "сегодня в 18:00", "завтра в 9:00", "1 января в 9:00", "1 января 2027 в 9:00". */
export function formatWhen(ts: number): string {
  const today = startOfDay(Date.now());
  const day = startOfDay(ts);
  const d = new Date(ts);
  const time = `${d.getHours()}:${pad(d.getMinutes())}`;
  if (day === today) return `сегодня в ${time}`;
  if (day === today + 86_400_000) return `завтра в ${time}`;
  const sameYear = d.getFullYear() === new Date().getFullYear();
  return `${d.getDate()} ${MONTHS[d.getMonth()]}${sameYear ? '' : ` ${d.getFullYear()}`} в ${time}`;
}

/** "1 января", "1 января 2027". */
export function formatDate(ts: number): string {
  const d = new Date(ts);
  const sameYear = d.getFullYear() === new Date().getFullYear();
  return `${d.getDate()} ${MONTHS[d.getMonth()]}${sameYear ? '' : ` ${d.getFullYear()}`}`;
}

/** Compact timestamp for the chat list. */
export function formatListTime(ts: number): string {
  const today = startOfDay(Date.now());
  const day = startOfDay(ts);
  if (day === today) return formatTime(ts);
  if (today - day < 6 * 86_400_000) return WEEKDAYS[new Date(ts).getDay()];
  const d = new Date(ts);
  return `${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${String(d.getFullYear()).slice(2)}`;
}

export const sameDay = (a: number, b: number) => startOfDay(a) === startOfDay(b);

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} Б`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} КБ`;
  return `${(bytes / 1024 / 1024).toFixed(1)} МБ`;
}

export function timerLabel(seconds: number, short = false): string {
  if (!seconds) return short ? 'Выкл' : 'Выключены';
  if (seconds < 60) return `${seconds} с`;
  if (seconds < 3600) return `${Math.round(seconds / 60)} мин`;
  if (seconds < 86400) return `${Math.round(seconds / 3600)} ч`;
  if (seconds < 604800) return `${Math.round(seconds / 86400)} д`;
  return `${Math.round(seconds / 604800)} нед`;
}

/** The disappearing-messages chip in the chat header: «1 ДЕНЬ», «5 МИН». */
export function timerChip(seconds: number): string {
  const units: [number, [string, string, string]][] = [
    [604800, ['НЕДЕЛЯ', 'НЕДЕЛИ', 'НЕДЕЛЬ']],
    [86400, ['ДЕНЬ', 'ДНЯ', 'ДНЕЙ']],
    [3600, ['ЧАС', 'ЧАСА', 'ЧАСОВ']],
    [60, ['МИН', 'МИН', 'МИН']],
    [1, ['СЕК', 'СЕК', 'СЕК']],
  ];
  for (const [size, forms] of units) {
    if (seconds >= size && seconds % size === 0) {
      const n = seconds / size;
      return `${n} ${plural(n, forms)}`;
    }
  }
  return timerLabel(seconds, true).toUpperCase();
}

/** Russian plural: 1 день, 2 дня, 5 дней. */
export function plural(n: number, [one, few, many]: [string, string, string]): string {
  const a = Math.abs(n) % 100;
  const b = a % 10;
  if (a > 10 && a < 20) return many;
  if (b === 1) return one;
  if (b >= 2 && b <= 4) return few;
  return many;
}

export function remaining(expiresAt: number): string {
  const s = Math.max(0, Math.round((expiresAt - Date.now()) / 1000));
  if (s < 60) return `${s}с`;
  if (s < 3600) return `${Math.floor(s / 60)}м`;
  if (s < 86400) return `${Math.floor(s / 3600)}ч`;
  return `${Math.floor(s / 86400)}д`;
}

export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '?';
  const first = [...parts[0]][0] ?? '';
  const second = parts.length > 1 ? ([...parts[1]][0] ?? '') : ([...parts[0]][1] ?? '');
  return (first + second).toUpperCase();
}

// Flat warm colours (no blue or violet); initials on them are dark, contrast ≥ 4.5:1.
const AVATAR_COLORS = ['#e2582a', '#3ddc97', '#f5b700', '#ff8a6b', '#d9b48f', '#8fc9a8', '#ffb547', '#e8a598'];

export function avatarColor(seed: string): string {
  let hash = 0;
  for (let i = 0; i < seed.length; i++) hash = (hash * 31 + seed.charCodeAt(i)) >>> 0;
  return AVATAR_COLORS[hash % AVATAR_COLORS.length];
}

export function systemText(message: Message, contact: Contact | undefined): string {
  const sys = message.sys;
  if (!sys) return '';
  const name = contact?.displayName ?? 'Собеседник';
  switch (sys.kind) {
    case 'timer':
      if (!sys.seconds) return sys.by === 'me' ? 'Вы выключили исчезающие сообщения' : `${name} выключил(а) исчезающие сообщения`;
      return sys.by === 'me'
        ? `Вы включили исчезающие сообщения: ${timerLabel(sys.seconds)}`
        : `${name} включил(а) исчезающие сообщения: ${timerLabel(sys.seconds)}`;
    case 'verified':
      return sys.value ? `Вы сверили код безопасности с «${name}» — контакт проверен` : 'Отметка «проверен» снята';
    case 'keychange':
      return `Ключ контакта «${name}» изменился. Сверьте код безопасности заново`;
    case 'reset':
      return 'Сеанс шифрования сброшен';
    case 'callwords':
      return sys.match
        ? `Слова в звонке совпали — между вами и «${name}» никого нет`
        : 'Слова в звонке не совпали. Разговор могли перехватить — сверьте код безопасности при встрече';
    case 'invite':
      return sys.by === 'me'
        ? `Контакт добавлен по приглашению «${name}» — ключ совпал, контакт проверен`
        : `«${name}» открыл(а) ваше приглашение — ключ сверен, контакт проверен`;
  }
}

const EMOJI_ONLY = /^(?:\p{Extended_Pictographic}|\p{Emoji_Component}|‍|️|\s){1,24}$/u;
export const isEmojiOnly = (text: string | undefined) => {
  if (!text) return false;
  const trimmed = text.trim();
  return trimmed.length > 0 && [...trimmed].length <= 8 && EMOJI_ONLY.test(trimmed) && !/^[\d#*\s]+$/.test(trimmed);
};

export function passwordStrength(password: string): number {
  let score = 0;
  if (password.length >= 8) score++;
  if (password.length >= 12) score++;
  if (/[a-zа-я]/.test(password) && /[A-ZА-Я]/.test(password)) score++;
  if (/\d/.test(password) && /[^\p{L}\d]/u.test(password)) score++;
  return Math.min(4, score);
}

/** Running call timer: 0:07, 12:34, 1:02:03. */
export function formatClock(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h ? `${h}:${pad(m)}:${pad(s % 60)}` : `${m}:${pad(s % 60)}`;
}

/** Call length in words: "45 сек", "2 мин 31 сек", "1 ч 5 мин". */
export function formatCallDuration(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return `${s} сек`;
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h) return `${h} ч ${m} мин`;
  return s % 60 ? `${m} мин ${s % 60} сек` : `${m} мин`;
}
