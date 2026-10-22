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
  target: { panel: 'safety' | 'timer' | 'about' | 'members' } | { settings: SettingsTab };
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

/** Members of a group whose keys I have verified, out of all the others. */
export function groupVerification(contact: Contact, snapshot: MessengerSnapshot): { verified: number; total: number } {
  const others = (contact.group?.members ?? []).filter((m) => m.id !== snapshot.me.userId);
  const verified = others.filter((m) => snapshot.contacts.some((c) => c.id === m.id && c.verified && !c.keyWarning)).length;
  return { verified, total: others.length };
}

/** «Щит группы»: encryption, how many members are verified, screenshots, server. */
function groupShield(contact: Contact, snapshot: MessengerSnapshot, screen: ShieldItem, server: ShieldItem): ChatShield {
  const { verified, total } = groupVerification(contact, snapshot);
  const items: ShieldItem[] = [
    { id: 'e2e', title: 'Сквозное шифрование', value: 'Sender Keys поверх Double Ratchet', state: 'ok', target: { panel: 'about' } },
    {
      id: 'code',
      title: 'Ключи участников',
      value: total ? `Сверены у ${verified} из ${total}` : 'В группе только вы',
      state: total && verified === total ? 'ok' : 'weak',
      target: { panel: 'members' },
    },
    screen,
    server,
  ];
  const score = items.filter((i) => i.state === 'ok').length;
  return { score, total: items.length, level: score === items.length ? 'ok' : 'weak', items };
}

export function chatShield(contact: Contact, snapshot: MessengerSnapshot, hasTurn: boolean): ChatShield {
  const { settings } = snapshot;
  const host = serverHost(snapshot.me.serverUrl);
  const screenSupported = platform === 'win32' || platform === 'darwin';
  if (contact.group) {
    const all = chatShield({ ...contact, group: undefined }, snapshot, hasTurn).items;
    return groupShield(contact, snapshot, all.find((i) => i.id === 'screen')!, all.find((i) => i.id === 'server')!);
  }
  const items: ShieldItem[] = [
    { id: 'e2e', title: 'Сквозное шифрование', value: 'Включено · X3DH и Double Ratchet', state: 'ok', target: { panel: 'about' } },
    {
      id: 'code',
      title: 'Код безопасности',
      value: contact.keyWarning
        ? 'Ключ изменился — сверьте заново'
        : contact.verified
          ? `${contact.verifiedBy === 'call' ? 'Сверен голосом в звонке' : contact.verifiedBy === 'invite' ? 'Сверен приглашением' : 'Сверен'}${
              contact.verifiedAt ? ` ${formatDay(contact.verifiedAt).toLowerCase()}` : ''
            }`
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
