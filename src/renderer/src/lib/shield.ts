// «Щит чата»: what protects one conversation right now, as a score out of six.

import type { SettingsTab } from '../components/SettingsModal.tsx';
import type { Contact, MessengerSnapshot } from '../../../core/types.ts';
import { platform } from '../../../core/platform.ts';
import { formatDay, timerLabel } from './format.ts';

export type ShieldLevel = 'ok' | 'weak' | 'alert';
export type ShieldItemId = 'e2e' | 'code' | 'timer' | 'screen' | 'ip' | 'server';

export interface ShieldItem {
  id: ShieldItemId;
  title: string;
  value: string;
  /** ok counts towards the score; 'na' is shown honestly as unavailable on this platform. */
  state: 'ok' | 'weak' | 'alert' | 'na';
  /** Where the item leads: a section of the panel or a settings tab. */
  target: { panel: 'safety' | 'timer' | 'about' } | { settings: SettingsTab };
}

export interface ChatShield {
  score: number;
  total: number;
  level: ShieldLevel;
  items: ShieldItem[];
}

const PRIVATE_HOST = /^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|\[?::1\]?|[^.:]+\.local\b)/i;

export function serverHost(url: string): string {
  return url.replace(/^[a-z]+:\/\//i, '').replace(/\/.*$/, '');
}

/** A relay on this computer or the home network, or one the user marked as their own. */
export function isOwnServer(snapshot: MessengerSnapshot): boolean {
  return snapshot.settings.ownServer ?? PRIVATE_HOST.test(serverHost(snapshot.me.serverUrl));
}

export function chatShield(contact: Contact, snapshot: MessengerSnapshot, hasTurn: boolean): ChatShield {
  const { settings } = snapshot;
  const host = serverHost(snapshot.me.serverUrl);
  const screenSupported = platform === 'win32' || platform === 'darwin';
  const items: ShieldItem[] = [
    { id: 'e2e', title: 'Сквозное шифрование', value: 'Включено · X3DH и Double Ratchet', state: 'ok', target: { panel: 'about' } },
    {
      id: 'code',
      title: 'Код безопасности',
      value: contact.keyWarning
        ? 'Ключ изменился — сверьте заново'
        : contact.verified
          ? contact.verifiedAt
            ? `Сверен ${formatDay(contact.verifiedAt).toLowerCase()}`
            : 'Сверен'
          : 'Не сверен',
      state: contact.keyWarning ? 'alert' : contact.verified ? 'ok' : 'weak',
      target: { panel: 'safety' },
    },
    {
      id: 'timer',
      title: 'Исчезающие сообщения',
      value: contact.timer ? `Через ${timerLabel(contact.timer)}` : 'Выключены',
      state: contact.timer ? 'ok' : 'weak',
      target: { panel: 'timer' },
    },
    {
      id: 'screen',
      title: 'Защита от скриншотов',
      value: !screenSupported ? (platform === 'linux' ? 'На Linux недоступно' : 'Только в приложении для ПК') : settings.screenProtection ? 'Вкл' : 'Выкл',
      state: !screenSupported ? 'na' : settings.screenProtection ? 'ok' : 'weak',
      target: { settings: 'privacy' },
    },
    {
      id: 'ip',
      title: 'IP в звонках',
      value: settings.callsRelayOnly && hasTurn ? 'Скрыт — звук идёт через сервер' : 'Виден собеседнику',
      state: settings.callsRelayOnly && hasTurn ? 'ok' : 'weak',
      target: { settings: 'audio' },
    },
    {
      id: 'server',
      title: 'Сервер',
      value: `${isOwnServer(snapshot) ? 'Свой' : 'Общий'} · ${host}`,
      state: isOwnServer(snapshot) ? 'ok' : 'weak',
      target: { settings: 'server' },
    },
  ];
  const score = items.filter((i) => i.state === 'ok').length;
  const level: ShieldLevel = contact.keyWarning ? 'alert' : score === items.length ? 'ok' : 'weak';
  return { score, total: items.length, level, items };
}

export const SHIELD_SUMMARY: Record<ShieldLevel, string> = {
  ok: 'Всё защищено',
  weak: 'Защита ослаблена',
  alert: 'Ключ собеседника изменился',
};
