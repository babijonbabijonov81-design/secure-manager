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
}

export interface AuthFrame {
  type: 'auth';
  userId: string;
  sig: string;
}

export type RequestFrame =
  | { type: 'lookup'; reqId: string; username: string }
  | { type: 'resolve'; reqId: string; userId: string }
  | { type: 'bundle'; reqId: string; userId: string }
  | { type: 'send'; reqId: string; to: string; cid: string; ephemeral?: boolean }
  | { type: 'prekeys'; reqId: string; opks?: OneTimePreKeyPublic[]; spk?: SignedPreKeyPublic }
  | { type: 'unregister'; reqId: string; sig: string };

export type ClientFrame =
  | RegisterFrame
  | AuthFrame
  | RequestFrame
  | { type: 'ack'; ids: string[] }
  | { type: 'ping' };

export type ServerFrame =
  | { type: 'hello'; nonce: string; version: number; name: string }
  | { type: 'ready'; userId: string; username: string; opkCount: number; spkId: number | null; queued: number }
  | { type: 'error'; reqId?: string; code: ErrorCode; message: string }
  | { type: 'result'; reqId: string; data?: unknown }
  | { type: 'msg'; id: string; ts: number }
  | { type: 'prekeys_low'; count: number }
  | { type: 'pong' };

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
