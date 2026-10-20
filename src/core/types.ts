import type { KeyPairJSON } from './crypto/primitives.ts';
import type { ConnectionStatus } from './relay-client.ts';

export type Theme = 'dark' | 'light' | 'system';
export type Accent = 'violet' | 'blue' | 'teal' | 'rose' | 'amber';

export interface AudioSettings {
  /** Microphone deviceId; '' is the system default. */
  input: string;
  /** Speakers/headphones deviceId; '' is the system default. */
  output: string;
  echoCancellation: boolean;
  noiseSuppression: boolean;
  autoGainControl: boolean;
}

export interface Settings {
  theme: Theme;
  accent: Accent;
  readReceipts: boolean;
  typingIndicators: boolean;
  notifications: boolean;
  notificationPreview: boolean;
  /** Veil's own notification cards or the operating system's ones. */
  notificationStyle: 'veil' | 'system';
  sounds: boolean;
  /** Minutes of inactivity before the app locks itself; 0 disables auto-lock. */
  autoLockMinutes: number;
  enterToSend: boolean;
  /** Hide the window from screenshots and screen sharing (Windows and macOS). */
  screenProtection: boolean;
  spellcheck: boolean;
  autocorrect: boolean;
  /** Who sees when you were last online: exact time, or only "recently". */
  lastSeen: 'everyone' | 'nobody';
  audio: AudioSettings;
  /** Calls only through the relay's TURN server, so the other side never learns your IP. */
  callsRelayOnly: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  theme: 'dark',
  accent: 'violet',
  readReceipts: true,
  typingIndicators: true,
  notifications: true,
  notificationPreview: false,
  notificationStyle: 'veil',
  sounds: true,
  autoLockMinutes: 15,
  enterToSend: true,
  screenProtection: false,
  spellcheck: true,
  autocorrect: true,
  lastSeen: 'everyone',
  audio: { input: '', output: '', echoCancellation: true, noiseSuppression: true, autoGainControl: true },
  callsRelayOnly: false,
};

export interface SignedPreKeyRecord {
  id: number;
  pub: string;
  priv: string;
  sig: string;
  createdAt: number;
}

export interface RecoverySettings {
  email: string;
  /** Key that encrypts the server backup, derived from the password with scrypt. */
  key: string;
  kdf: { N: number; r: number; p: number; salt: string };
  lastBackupAt: number;
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
  /** Base32 secret of the authenticator app (two-factor authentication). */
  totp?: string;
  recovery?: RecoverySettings;
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
  archived?: boolean;
  draft?: string;
  /** Another account claims this contact's username (possible reinstall or impersonation). */
  keyWarning?: boolean;
  /** When the contact was last seen online (our clock), if they share it. */
  lastSeen?: number;
  /** The contact hides their last-seen time ("был(а) недавно"). */
  presenceHidden?: boolean;
}

export type MessageStatus = 'pending' | 'sent' | 'delivered' | 'read' | 'failed';

export type AttachmentKind = 'image' | 'file' | 'voice' | 'sticker';

export interface Attachment {
  id: string;
  name: string;
  mime: string;
  size: number;
  kind: AttachmentKind;
  w?: number;
  h?: number;
  /** Voice messages: duration in seconds and a coarse waveform (0–31 per bar). */
  dur?: number;
  wave?: number[];
  /** Stickers: content hash, lets the recipient save it to their collection. */
  sticker?: string;
}

export type SystemEvent =
  | { kind: 'timer'; seconds: number; by: 'me' | 'them' }
  | { kind: 'verified'; value: boolean }
  | { kind: 'keychange' }
  | { kind: 'reset' };

/** A call as shown in the chat; kept only on this device. */
export interface CallRecord {
  status: 'done' | 'missed' | 'declined' | 'cancelled' | 'busy' | 'failed' | 'unavailable';
  /** Seconds of conversation. */
  dur?: number;
}

/** Why a call ended, as told to the other side. */
export type CallEndReason = 'hangup' | 'decline' | 'busy' | 'cancel' | 'timeout' | 'failed';

/** WebRTC signalling, carried end-to-end encrypted; `sdp` includes all ICE candidates. */
export type CallSignal =
  | { k: 'offer'; id: string; sdp: string }
  | { k: 'ring'; id: string }
  | { k: 'answer'; id: string; sdp: string }
  | { k: 'end'; id: string; r: CallEndReason };

export interface ReplyRef {
  id: string;
  text: string;
  /** The quoted message was written by me. */
  out: boolean;
}

export interface Message {
  id: string;
  dir: 'in' | 'out' | 'system';
  /** Text, or the caption of attachments. */
  text?: string;
  /** Legacy single attachment (v1.0); new messages use `atts`. */
  att?: Attachment;
  atts?: Attachment[];
  reply?: ReplyRef;
  reactions?: { me?: string; them?: string };
  /** Sender clock. */
  ts: number;
  /** Local clock when added. */
  at: number;
  status?: MessageStatus;
  timer?: number;
  expiresAt?: number;
  /** Legacy (v1.0) "deleted" placeholders; such messages are dropped on load. */
  deleted?: boolean;
  readSent?: boolean;
  sys?: SystemEvent;
  call?: CallRecord;
}

export const attachmentsOf = (message: Message): Attachment[] => message.atts ?? (message.att ? [message.att] : []);

export type AttachmentMeta = Omit<Attachment, 'id'> & { len: number };

/** Plaintext carried inside the Double Ratchet. */
export type Content =
  | {
      t: 'msg';
      id: string;
      ts: number;
      text?: string;
      /** Legacy single attachment, still sent for one-file messages so v1.0 can read them. */
      att?: Omit<Attachment, 'id'>;
      atts?: AttachmentMeta[];
      /** Reply: quoted id, short snippet and who wrote it from the sender's point of view. */
      r?: { id: string; s: string; a: 'me' | 'you' };
      timer?: number;
      p?: { n: string };
    }
  | { t: 'rcpt'; k: 'd' | 'r'; ids: string[] }
  | { t: 'typ'; on: boolean }
  | { t: 'timer'; seconds: number; ts: number }
  | { t: 'del'; ids: string[] }
  | { t: 'react'; id: string; e: string }
  /** Presence: online, going offline, or hidden ("recently"); `ask` requests a reply. */
  | { t: 'pres'; s: 'on' | 'off' | 'hidden'; ask?: 1 }
  /** Sent after restoring from a backup to open fresh sessions with every contact. */
  | { t: 'hi' }
  | { t: 'prof'; n: string }
  | ({ t: 'call'; ts: number } & CallSignal);

export interface OutboxItem {
  qid: string;
  to: string;
  env: string;
  msgIds: string[];
}

export interface StickerMeta {
  id: string;
  mime: string;
  w: number;
  h: number;
  addedAt: number;
}

export interface MessengerSnapshot {
  status: ConnectionStatus;
  statusError?: string;
  fatal?: string;
  me: { userId: string; username: string; displayName: string; serverUrl: string };
  security: { totp: boolean; recoveryEmail?: string; lastBackupAt?: number };
  settings: Settings;
  contacts: Contact[];
  conversations: Record<string, Message[]>;
  typing: Record<string, boolean>;
  online: Record<string, boolean>;
  stickers: StickerMeta[];
}

export const TIMER_OPTIONS = [0, 30, 300, 3600, 28800, 86400, 604800] as const;
export const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;
export const MAX_ALBUM_ITEMS = 10;
export const QUICK_REACTIONS = ['👍', '❤️', '😂', '😮', '😢', '🔥'] as const;
