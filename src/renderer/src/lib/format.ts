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

const GRADIENTS = [
  ['#ff6b8b', '#ff9a5a'],
  ['#7c5cff', '#4f8cff'],
  ['#00c6a7', '#1e9bff'],
  ['#ffb347', '#ff5e62'],
  ['#a855f7', '#ec4899'],
  ['#22c55e', '#14b8a6'],
  ['#3b82f6', '#8b5cf6'],
  ['#f97316', '#eab308'],
  ['#06b6d4', '#6366f1'],
  ['#e11d48', '#9333ea'],
];

export function avatarGradient(seed: string): string {
  let hash = 0;
  for (let i = 0; i < seed.length; i++) hash = (hash * 31 + seed.charCodeAt(i)) >>> 0;
  const [a, b] = GRADIENTS[hash % GRADIENTS.length];
  return `linear-gradient(135deg, ${a}, ${b})`;
}

export function previewOf(message: Message | undefined): string {
  if (!message) return 'Нет сообщений';
  if (message.dir === 'system') return systemText(message, undefined);
  if (message.deleted) return 'Сообщение удалено';
  if (message.att) return message.att.kind === 'image' ? '📷 Фото' : `📎 ${message.att.name}`;
  return message.text ?? '';
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
      return 'Внимание: у этого имени пользователя новый ключ безопасности. Сверьте код безопасности.';
    case 'reset':
      return 'Сеанс шифрования сброшен';
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
