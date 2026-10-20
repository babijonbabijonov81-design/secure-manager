import type { KeyPairJSON } from './crypto/primitives.ts';
import type { ConnectionStatus } from './relay-client.ts';

export type Theme = 'dark' | 'light' | 'system';
export type Accent = 'violet' | 'blue' | 'teal' | 'rose' | 'amber';

export interface Settings {
  theme: Theme;
  accent: Accent;
  readReceipts: boolean;
  typingIndicators: boolean;
  notifications: boolean;
  notificationPreview: boolean;
  sounds: boolean;
  /** Minutes of inactivity before the app locks itself; 0 disables auto-lock. */
  autoLockMinutes: number;
  enterToSend: boolean;
  /** Hide the window from screenshots and screen sharing (Windows and macOS). */
  screenProtection: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  theme: 'dark',
  accent: 'violet',
  readReceipts: true,
  typingIndicators: true,
  notifications: true,
  notificationPreview: false,
  sounds: true,
  autoLockMinutes: 15,
  enterToSend: true,
  screenProtection: false,
};

export interface SignedPreKeyRecord {
  id: number;
  pub: string;
  priv: string;
  sig: string;
  createdAt: number;
}

export interface AccountRecord {
  userId: string;
  username: string;
  displayName: string;
  sign: KeyPairJSON;
  dh: KeyPairJSON;
  dhSig: string;
  /** Newest first; older ones are kept for a while to read delayed first messages. */
  spks: SignedPreKeyRecord[];
  opks: Record<string, KeyPairJSON>;
  nextOpkId: number;
  nextSpkId: number;
  serverUrl: string;
  createdAt: number;
}

export interface Contact {
  id: string;
  username: string;
  displayName: string;
  dhKey: string;
  dhSig: string;
  verified: boolean;
  blocked: boolean;
  createdAt: number;
  lastActivity: number;
  unread: number;
  /** Disappearing-message timer in seconds; 0 = off. */
  timer: number;
  pinned?: boolean;
  muted?: boolean;
  draft?: string;
  /** Another account claims this contact's username (possible reinstall or impersonation). */
  keyWarning?: boolean;
}

export type MessageStatus = 'pending' | 'sent' | 'delivered' | 'read' | 'failed';

export interface Attachment {
  id: string;
  name: string;
  mime: string;
  size: number;
  kind: 'image' | 'file';
  w?: number;
  h?: number;
}

export type SystemEvent =
  | { kind: 'timer'; seconds: number; by: 'me' | 'them' }
  | { kind: 'verified'; value: boolean }
  | { kind: 'keychange' }
  | { kind: 'reset' };

export interface Message {
  id: string;
  dir: 'in' | 'out' | 'system';
  text?: string;
  att?: Attachment;
  /** Sender clock. */
  ts: number;
  /** Local clock when added. */
  at: number;
  status?: MessageStatus;
  timer?: number;
  expiresAt?: number;
  deleted?: boolean;
  readSent?: boolean;
  sys?: SystemEvent;
}

/** Plaintext carried inside the Double Ratchet. */
export type Content =
  | {
      t: 'msg';
      id: string;
      ts: number;
      text?: string;
      att?: Omit<Attachment, 'id'>;
      timer?: number;
      p?: { n: string };
    }
  | { t: 'rcpt'; k: 'd' | 'r'; ids: string[] }
  | { t: 'typ'; on: boolean }
  | { t: 'timer'; seconds: number; ts: number }
  | { t: 'del'; ids: string[] }
  | { t: 'prof'; n: string };

export interface OutboxItem {
  qid: string;
  to: string;
  env: string;
  msgIds: string[];
}

export interface MessengerSnapshot {
  status: ConnectionStatus;
  statusError?: string;
  fatal?: string;
  me: { userId: string; username: string; displayName: string; serverUrl: string };
  settings: Settings;
  contacts: Contact[];
  conversations: Record<string, Message[]>;
  typing: Record<string, boolean>;
}

export const TIMER_OPTIONS = [0, 30, 300, 3600, 28800, 86400, 604800] as const;
export const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;
