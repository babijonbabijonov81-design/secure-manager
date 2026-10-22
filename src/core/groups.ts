// Group chats (features.groups): who is in a group, with which role, and which changes a member
// may make. There is no server authority: every member checks every change against the same
// rules, so a relay (or a member without the right) cannot add people, raise roles or take over.
//
//   owner  — everything, including roles and handing over ownership
//   admin  — rename, add and remove ordinary members
//   member — write, and leave
//
// Messages use Sender Keys (src/core/crypto/sender-keys.ts) instead of MLS: Sender Keys sit on the
// pairwise X3DH + Double Ratchet sessions and sealed-sender envelopes Veil already has, and need
// nothing from the relay. MLS would need a delivery service that orders commits for the whole
// group, i.e. a new server role and a second protocol stack, for a gain (cheap membership changes
// in very large groups) that groups of up to 50 people do not need.

import { USERNAME_RE } from '../../server/src/shared/protocol.ts';
import { unb64Len } from '../../server/src/shared/wire.ts';
import { verifyDhKey } from './crypto/x3dh.ts';

export type GroupRole = 'owner' | 'admin' | 'member';

export interface GroupMember {
  /** Identity key (account id). */
  id: string;
  username: string;
  name: string;
  role: GroupRole;
  /** X25519 identity key and its signature by `id` (to seal envelopes to them). */
  dh: string;
  ds: string;
}

/** The whole group as every member stores and sends it; `v` grows with every change. */
export interface GroupState {
  id: string;
  name: string;
  v: number;
  members: GroupMember[];
}

export const MAX_GROUP_MEMBERS = 50;
export const GROUP_PREFIX = 'g:';
export const groupChatId = (groupId: string) => `${GROUP_PREFIX}${groupId}`;
export const isGroupChat = (id: string) => id.startsWith(GROUP_PREFIX);
export const ROLE_LABEL: Record<GroupRole, string> = { owner: 'Владелец', admin: 'Админ', member: 'Участник' };

const ROLES: GroupRole[] = ['owner', 'admin', 'member'];

/** A well-formed state: valid keys, unique members, exactly one owner. */
export function validState(state: unknown): state is GroupState {
  const s = state as GroupState;
  if (!s || typeof s !== 'object' || typeof s.id !== 'string' || !/^[\w-]{8,40}$/.test(s.id)) return false;
  if (typeof s.name !== 'string' || !s.name.trim() || s.name.length > 64 || !Number.isInteger(s.v) || s.v < 1) return false;
  if (!Array.isArray(s.members) || !s.members.length || s.members.length > MAX_GROUP_MEMBERS) return false;
  const ids = new Set<string>();
  for (const m of s.members) {
    if (!m || typeof m.id !== 'string' || ids.has(m.id) || !ROLES.includes(m.role)) return false;
    if (typeof m.username !== 'string' || !USERNAME_RE.test(m.username) || typeof m.name !== 'string' || m.name.length > 64) return false;
    const signPub = unb64Len(m.id, 32);
    const dh = unb64Len(m.dh, 32);
    const ds = unb64Len(m.ds, 64);
    if (!signPub || !dh || !ds || !verifyDhKey(signPub, dh, ds)) return false;
    ids.add(m.id);
  }
  return s.members.filter((m) => m.role === 'owner').length === 1;
}

const roleOf = (state: GroupState | undefined, id: string) => state?.members.find((m) => m.id === id)?.role;

/**
 * May `senderId` turn `current` into `next`? Without `current` this is a group I am being added
 * to: the sender must run it and I must be in it.
 */
export function canApply(current: GroupState | undefined, next: GroupState, senderId: string, myId: string): boolean {
  if (!validState(next)) return false;
  if (!current) {
    const role = roleOf(next, senderId);
    return (role === 'owner' || role === 'admin') && next.members.some((m) => m.id === myId);
  }
  if (next.id !== current.id || next.v <= current.v) return false;
  const role = roleOf(current, senderId);
  if (role === 'owner') return true;
  if (role !== 'admin') return false;
  // An admin keeps every role as it was and only adds or removes ordinary members.
  const before = new Map(current.members.map((m) => [m.id, m]));
  const after = new Map(next.members.map((m) => [m.id, m]));
  for (const [id, m] of before) {
    const now = after.get(id);
    if (!now) {
      if (m.role !== 'member') return false;
    } else if (now.role !== m.role || now.dh !== m.dh) return false;
  }
  for (const [id, m] of after) if (!before.has(id) && m.role !== 'member') return false;
  return true;
}

/** A member left on their own: everyone computes the same next state (a new owner if needed). */
export function withoutMember(state: GroupState, id: string): GroupState | null {
  const members = state.members.filter((m) => m.id !== id).map((m) => ({ ...m }));
  if (members.length === state.members.length || !members.length) return null;
  if (!members.some((m) => m.role === 'owner')) {
    const heir = members.find((m) => m.role === 'admin') ?? members[0];
    heir.role = 'owner';
  }
  return { ...state, v: state.v + 1, members };
}

/** What changed, for the lines in the chat («Анна добавила Бориса»). */
export function describeChange(before: GroupState, after: GroupState): { added: GroupMember[]; removed: GroupMember[]; roles: GroupMember[]; renamed: boolean } {
  const was = new Map(before.members.map((m) => [m.id, m]));
  const is = new Map(after.members.map((m) => [m.id, m]));
  return {
    added: after.members.filter((m) => !was.has(m.id)),
    removed: before.members.filter((m) => !is.has(m.id)),
    roles: after.members.filter((m) => was.has(m.id) && was.get(m.id)!.role !== m.role),
    renamed: before.name !== after.name,
  };
}
