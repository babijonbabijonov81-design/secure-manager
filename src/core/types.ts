import type { KeyPairJSON } from './crypto/primitives.ts';
import type { ConnectionStatus } from './relay-client.ts';

export type Theme = 'dark' | 'light' | 'system';

/**
 * Every v2 feature can be switched off in Settings → «Функции». A switched-off feature leaves
 * no trace in the interface and sends nothing.
 */
export const FEATURE_NAMES = [
  'veil',
  'shield',
  'keyGuard',
  'viewOnce',
  'clipboard',
  'stripMeta',
  'quickUnlock',
  'bridge',
  'callWords',
  'tempNotes',
  'duress',
  'scheduled',
  'presence',
  'hiddenChats',
  'securityLog',
  'backupFile',
  'linkPreviews',
  'invites',
  'groups',
  'video',
  'transcribe',
  'search',
] as const;
export type FeatureName = (typeof FEATURE_NAMES)[number];
export type Features = Record<FeatureName, boolean>;
export const DEFAULT_FEATURES = Object.fromEntries(FEATURE_NAMES.map((name) => [name, true])) as Features;

export type TranscribeModel = 'tiny' | 'base' | 'small';

export interface AudioSettings {
  /** Microphone deviceId; '' is the system default. */
  input: string;
  /** Speakers/headphones deviceId; '' is the system default. */
  output: string;
  echoCancellation: boolean;
  noiseSuppression: boolean;
  autoGainControl: boolean;
  /** Camera deviceId for video calls; '' is the system default. */
  camera: string;
}

export interface Settings {
  theme: Theme;
  features: Features;
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
  /** «Вуаль»: incoming messages and previews stay blurred until hovered or focused. */
  veil: boolean;
  /** For every chat, or only for chats where it was switched on (Contact.veil). */
  veilScope: 'all' | 'selected';
  /** «Не отправлять, пока не сверю»: nothing goes to a contact whose key changed until it is checked. */
  holdUntilVerified: boolean;
  /** Clear a password copied from «Избранное» after this many seconds; 0 keeps it. */
  clipboardSeconds: number;
  /** Remove EXIF/GPS from photos and author/program from PDF and Office files before sending. */
  stripMetadata: boolean;
  /** Lock together with the operating system's lock screen. */
  lockOnSystemLock: boolean;
  /** Lock when the window is hidden to the tray. */
  lockOnHide: boolean;
  /** The user says the relay is their own (otherwise private addresses count as own). */
  ownServer?: boolean;
  /** Make link previews when sending (the recipient never opens the link). */
  linkPreviews: boolean;
  /** «Голосовые в текст»: which Whisper model to use (features.transcribe). */
  transcribeModel: TranscribeModel;
  /** When a .veil backup file was last saved (monthly reminder). */
  backupFileAt?: number;
}

export const DEFAULT_SETTINGS: Settings = {
  theme: 'system',
  features: DEFAULT_FEATURES,
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
  audio: { input: '', output: '', echoCancellation: true, noiseSuppression: true, autoGainControl: true, camera: '' },
  callsRelayOnly: false,
  veil: false,
  veilScope: 'all',
  holdUntilVerified: false,
  clipboardSeconds: 30,
  stripMetadata: true,
  lockOnSystemLock: true,
  lockOnHide: false,
  linkPreviews: true,
  transcribeModel: 'base',
};

/** Stored settings from any version, completed with defaults (new feature flags start on). */
export function normalizeSettings(stored: Partial<Settings> | null | undefined): Settings {
  const { accent: _accent, ...rest } = (stored ?? {}) as Partial<Settings> & { accent?: unknown };
  return {
    ...DEFAULT_SETTINGS,
    ...rest,
    features: { ...DEFAULT_FEATURES, ...rest.features },
    audio: { ...DEFAULT_SETTINGS.audio, ...rest.audio },
    transcribeModel: rest.transcribeModel && ['tiny', 'base', 'small'].includes(rest.transcribeModel) ? rest.transcribeModel : DEFAULT_SETTINGS.transcribeModel,
  };
}

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
  /** The duress password is set; with `wipe` it erases the real vault when typed. */
  duress?: { wipe: boolean; at: number };
  /** Device ids already seen in «Устройства» (a new one goes into the security log). */
  knownDevices?: string[];
  /** Hidden chats: scrypt hashes of the secret phrase and the PIN (never the values themselves). */
  hiddenChats?: { salt: string; phrase: string; pin: string };
  /** veil:// invites not used yet: one-time tokens and when they expire (features.invites). */
  invites?: { t: string; exp: number }[];
}

/** «Избранное»: a chat with yourself that never leaves this device. */
export const SAVED_ID = 'saved';
export const isSavedChat = (id: string) => id === SAVED_ID;

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
  /** When the safety number was last confirmed. */
  verifiedAt?: number;
  /** How: the safety number, the words in a call, or a veil:// invite passed in person. */
  verifiedBy?: 'code' | 'call' | 'invite';
  /** «Вуаль» for this chat when it is enabled only for selected chats. */
  veil?: boolean;
  /** What this contact sees of me, overriding the global settings (features.presence). */
  privacy?: Partial<Record<PresenceKind, boolean>>;
  /** Hidden chat: not in the list, opened with the secret phrase in search and a PIN. */
  hidden?: boolean;
}

export type PresenceKind = 'online' | 'read' | 'typing';

/**
 * Whether I share «в сети», «прочитано» or «печатает» with this contact. Reciprocity: what I do
 * not share, I do not see from them either.
 */
export function sharesWith(settings: Settings, contact: Pick<Contact, 'privacy'>, kind: PresenceKind): boolean {
  const global = kind === 'online' ? settings.lastSeen === 'everyone' : kind === 'read' ? settings.readReceipts : settings.typingIndicators;
  if (settings.features?.presence === false) return global;
  return contact.privacy?.[kind] ?? global;
}

export type MessageStatus = 'scheduled' | 'pending' | 'sent' | 'delivered' | 'read' | 'failed';

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
  | { kind: 'reset' }
  /** The two words in a call matched (no one in the middle) or did not. */
  | { kind: 'callwords'; match: boolean }
  /** Added through a veil:// invite: by me opening their link, or by them opening mine. */
  | { kind: 'invite'; by: 'me' | 'them' };

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
  /** `v`: a video call (the caller's camera is on from the start). */
  | { k: 'offer'; id: string; sdp: string; v?: 1 }
  /** Camera and screen sharing switched on or off during the call (features.video). */
  | { k: 'media'; id: string; cam: boolean; scr: boolean }
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
  /** Saved to «Избранное» from another chat: who wrote it and when. */
  fwd?: { name: string; ts: number };
  /**
   * View-once photo or video: the attachment is sealed with key `k`. The key and the file are
   * deleted on both sides once the recipient opens it (`opened`).
   */
  once?: { k?: string; opened?: number };
  /** Scheduled send: kept here (encrypted on disk) until `at`; `late` if the computer was off then. */
  schedule?: { at: number; late?: boolean };
  /**
   * Time capsule: delivered at once but sealed with key `k` until `at`. The sender keeps the key and
   * sends it at that moment; the recipient holds only `ct` until then.
   */
  capsule?: { at: number; k?: string; ct?: string; sent?: boolean; opened?: boolean };
  /** «Избранное»: what kind of entry this is; temporary notes burn at `expiresAt`. */
  note?: { kind: NoteKind; title?: string; reminded?: boolean };
  /** Link preview made by the sender (features.linkPreviews). */
  preview?: LinkPreview;
  /** «Голосовые в текст»: recognised on this device, kept only here (never sent). */
  transcript?: string;
}

export type NoteKind = 'note' | 'password' | 'link';

/** A link preview made by the sender; the recipient's Veil never opens the link. */
export interface LinkPreview {
  url: string;
  title: string;
  desc?: string;
  site?: string;
  /** A small JPEG/PNG/WebP picture as a data: URL. */
  img?: string;
}
/** Temporary notes in «Избранное» burn after one of these numbers of days. */
export const NOTE_BURN_DAYS = [1, 7, 30] as const;

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
      /** View-once: the key that opens the sealed attachment. */
      once?: { k: string };
      /** Time capsule: the text, sealed until `at`; the key follows then. */
      cap?: { at: number; ct: string };
      /** Link preview made by the sender. */
      pv?: LinkPreview;
    }
  | { t: 'rcpt'; k: 'd' | 'r'; ids: string[] }
  | { t: 'typ'; on: boolean }
  | { t: 'timer'; seconds: number; ts: number }
  | { t: 'del'; ids: string[] }
  /** A view-once message was opened: the sender deletes its copy too. */
  | { t: 'viewed'; id: string }
  /** The time capsule's date came: its key. */
  | { t: 'capkey'; id: string; k: string }
  /** The one-time token of a veil:// invite, back to the inviter. */
  | { t: 'inv'; tok: string }
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

/** «Журнал безопасности»: kept only on this computer, inside the encrypted vault. */
export type SecurityEventKind =
  | 'login'
  | 'login_failed'
  | 'device_new'
  | 'device_revoked'
  | 'transfer_in'
  | 'key_change'
  | 'password_change'
  | 'totp_on'
  | 'totp_off'
  | 'email_on'
  | 'email_off'
  | 'duress_on'
  | 'duress_off'
  | 'backup_export'
  | 'backup_import'
  | 'invite_mismatch';

export interface SecurityEvent {
  id: string;
  ts: number;
  kind: SecurityEventKind;
  detail?: string;
}

export interface MessengerSnapshot {
  status: ConnectionStatus;
  statusError?: string;
  fatal?: string;
  me: { userId: string; username: string; displayName: string; serverUrl: string; createdAt: number };
  security: { totp: boolean; recoveryEmail?: string; lastBackupAt?: number; duress?: { wipe: boolean }; hiddenChats: boolean };
  /** This is the empty Veil opened by the duress password (never shown in the interface). */
  decoy?: boolean;
  settings: Settings;
  contacts: Contact[];
  conversations: Record<string, Message[]>;
  typing: Record<string, boolean>;
  online: Record<string, boolean>;
  stickers: StickerMeta[];
  securityLog: SecurityEvent[];
}

export const TIMER_OPTIONS = [0, 30, 300, 3600, 28800, 86400, 604800] as const;
export const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;
export const MAX_ALBUM_ITEMS = 10;
export const QUICK_REACTIONS = ['👍', '❤️', '😂', '😮', '😢', '🔥'] as const;
