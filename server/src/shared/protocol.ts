// Relay protocol shared by the server and the desktop client.
//
// The relay is deliberately "zero-knowledge": it only ever sees public keys, usernames
// and opaque end-to-end encrypted envelopes. It never learns who sent an envelope
// (the sender identity lives inside the encrypted envelope), and it deletes every
// envelope as soon as the recipient acknowledges it.

import { concat, u32, utf8 } from './wire.ts';

export const PROTOCOL_VERSION = 1;
export const MAX_FRAME_BYTES = 26 * 1024 * 1024;
export const MAX_ENVELOPE_BYTES = 25 * 1024 * 1024;
export const USERNAME_RE = /^[a-z0-9_]{3,32}$/;
export const MAX_OPKS_PER_UPLOAD = 200;
export const MAX_BACKUP_BYTES = 16 * 1024 * 1024;
export const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,255}\.[^\s@]{2,}$/;

/** userId is the base64url Ed25519 identity (signing) public key. */
export interface SignedPreKeyPublic {
  id: number;
  pub: string;
  sig: string;
}

export interface OneTimePreKeyPublic {
  id: number;
  pub: string;
}

export interface UserInfo {
  userId: string;
  username: string;
  /** X25519 identity key, signed by the userId (Ed25519) key. */
  dhKey: string;
  dhSig: string;
}

export interface PreKeyBundle extends UserInfo {
  spk: SignedPreKeyPublic;
  opk?: OneTimePreKeyPublic;
}

export interface RegisterFrame {
  type: 'register';
  username: string;
  userId: string;
  dhKey: string;
  dhSig: string;
  spk: SignedPreKeyPublic;
  opks: OneTimePreKeyPublic[];
  sig: string;
  /** Proof of email (+2FA) recovery: lets new keys take over an existing username. */
  recoveryToken?: string;
  device?: DeviceHello;
}

/**
 * Encrypted account backup. The relay stores the ciphertext only; the key is derived
 * from the user's password with scrypt, so the relay can never decrypt it.
 */
export interface BackupMeta {
  v: 1;
  kdf: { N: number; r: number; p: number; salt: string };
  nonce: string;
  updatedAt: number;
}

export interface AccountStatus {
  email: boolean;
  totp: boolean;
  backup: { size: number; updatedAt: number } | null;
  /** The relay is configured to send email. */
  mail: boolean;
}

/** Requests allowed before login, used to recover an account on a new device. */
export type RecoveryFrame =
  | { type: 'recover_start'; reqId: string; username: string; email: string }
  | { type: 'recover_finish'; reqId: string; username: string; code: string; totp?: string };

export interface AuthFrame {
  type: 'auth';
  userId: string;
  sig: string;
  device?: DeviceHello;
}

/** A computer of this account (Settings → «Устройства»). The label is encrypted by the client. */
export interface DeviceHello {
  /** Random per installation, base64url. */
  id: string;
  /** Computer name encrypted with a key only the account knows; the relay cannot read it. */
  label?: string;
}

export interface DeviceRecord extends DeviceHello {
  first: number;
  last: number;
  online?: boolean;
}

export const DEVICE_ID_RE = /^[A-Za-z0-9_-]{16,32}$/;
/** Bridge rooms on the relay: a transfer between two computers without a common network. */
export const BRIDGE_ROOM_RE = /^[0-9A-Z]{4}$/;

export type RequestFrame =
  | { type: 'lookup'; reqId: string; username: string }
  | { type: 'resolve'; reqId: string; userId: string }
  | { type: 'bundle'; reqId: string; userId: string }
  | { type: 'send'; reqId: string; to: string; cid: string; ephemeral?: boolean }
  | { type: 'prekeys'; reqId: string; opks?: OneTimePreKeyPublic[]; spk?: SignedPreKeyPublic }
  | { type: 'unregister'; reqId: string; sig: string; totp?: string }
  | { type: 'account_status'; reqId: string }
  | { type: 'email_set'; reqId: string; email: string }
  | { type: 'email_confirm'; reqId: string; code: string }
  | { type: 'email_remove'; reqId: string; totp?: string }
  | { type: 'totp_set'; reqId: string; secret: string; code: string }
  | { type: 'totp_disable'; reqId: string; code: string }
  | { type: 'backup_put'; reqId: string; meta: BackupMeta }
  | { type: 'devices'; reqId: string }
  | { type: 'device_revoke'; reqId: string; id: string }
  | { type: 'device_signout'; reqId: string }
  /** Is this @name free? (for the live hint while typing a new one) */
  | { type: 'username_check'; reqId: string; username: string }
  /** Take a new @name; the old one is released at once. */
  | { type: 'username_set'; reqId: string; username: string };

/** Anonymous frames of a bridge room: the relay only pipes the (encrypted) bytes between two sides. */
export type BridgeFrame =
  | { type: 'bridge_open'; reqId: string; room: string }
  | { type: 'bridge_join'; reqId: string; room: string }
  | { type: 'bridge_data' };

export type ClientFrame =
  | RegisterFrame
  | AuthFrame
  | RecoveryFrame
  | RequestFrame
  | BridgeFrame
  | { type: 'ack'; ids: string[] }
  | { type: 'ping' };

/** STUN/TURN server for calls, in the shape RTCPeerConnection expects. */
export interface IceServer {
  urls: string[];
  username?: string;
  credential?: string;
}

export type ServerFrame =
  | { type: 'hello'; nonce: string; version: number; name: string }
  | { type: 'ready'; userId: string; username: string; opkCount: number; spkId: number | null; queued: number; ice?: IceServer[] }
  | { type: 'error'; reqId?: string; code: ErrorCode; message: string }
  | { type: 'result'; reqId: string; data?: unknown }
  | { type: 'msg'; id: string; ts: number }
  | { type: 'prekeys_low'; count: number }
  | { type: 'pong' }
  | { type: 'bridge_peer' }
  | { type: 'bridge_data' }
  | { type: 'bridge_closed' };

export type ErrorCode =
  | 'bad_request'
  | 'unauthorized'
  | 'unknown_user'
  | 'username_taken'
  | 'not_found'
  | 'rate_limited'
  | 'too_large'
  | 'quota'
  | 'offline'
  | 'mail_unavailable'
  | 'bad_code'
  | 'totp_required'
  | 'bad_totp'
  | 'device_revoked'
  | 'server_error';

// ---- Signed statements -------------------------------------------------------------
// Both sides build exactly the same byte strings, the client signs and the server
// (and peers) verify. Fields are separated by "|" and never contain it themselves.

export function authStatement(nonce: string, action: 'auth' | 'register' | 'unregister', extra = ''): Uint8Array {
  return utf8(`veil-auth-v1|${nonce}|${action}|${extra}`);
}

export function registerExtra(frame: Pick<RegisterFrame, 'username' | 'dhKey' | 'spk'>): string {
  return `${frame.username}|${frame.dhKey}|${frame.spk.id}|${frame.spk.pub}`;
}

export function dhKeyStatement(dhKey: Uint8Array): Uint8Array {
  return concat(utf8('veil-dh-v1'), dhKey);
}

export function signedPreKeyStatement(id: number, pub: Uint8Array): Uint8Array {
  return concat(utf8('veil-spk-v1'), u32(id), pub);
}
