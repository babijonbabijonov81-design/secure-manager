// Up to two Veil accounts on one device. Each account lives in its own space of the same
// key-value storage and has its own vault, password and quick unlock: opening one gives no
// access to the other. Only the list below is kept unencrypted, so the lock screen can offer
// a choice — and the names in it can be hidden.

import { sha256 } from '@noble/hashes/sha2.js';
import { b64, fromUtf8, utf8 } from '../../server/src/shared/wire.ts';
import { readVaultMeta, type StorageBackend } from './storage.ts';

export const MAX_ACCOUNTS = 2;
export type Slot = 1 | 2;
export const SLOTS: Slot[] = [1, 2];

const INDEX_KEY = 'accounts';
/** Keys of the second account; the first one keeps the names it had before accounts existed. */
const SECOND = '@2/';

/** One account's view of the shared storage. */
export class SpaceStorage implements StorageBackend {
  constructor(
    readonly root: StorageBackend,
    readonly slot: Slot,
  ) {}

  private get prefix() {
    return this.slot === 1 ? '' : SECOND;
  }

  private mine(key: string): boolean {
    if (this.slot === 2) return key.startsWith(SECOND);
    return !key.startsWith(SECOND) && key !== INDEX_KEY;
  }

  get(key: string) {
    return this.root.get(this.prefix + key);
  }
  set(key: string, value: Uint8Array) {
    return this.root.set(this.prefix + key, value);
  }
  delete(key: string) {
    return this.root.delete(this.prefix + key);
  }
  async list() {
    return (await this.root.list()).filter((key) => this.mine(key)).map((key) => key.slice(this.prefix.length));
  }
  /** Erases this account only; the other one and the list stay. */
  async clear() {
    for (const key of await this.root.list()) if (this.mine(key)) await this.root.delete(key);
  }
}

export interface AccountLabel {
  /** Hash of the account's public id: tells whether an account is already on this device. */
  uid: string;
  name?: string;
  username?: string;
  /** «Скрывать имя на экране входа»: only «Аккаунт 1/2» is shown before unlocking. */
  hidden?: boolean;
}

interface AccountIndex {
  v: 1;
  last?: Slot;
  labels: Partial<Record<Slot, AccountLabel>>;
}

export interface DeviceAccount {
  slot: Slot;
  label?: AccountLabel;
}

export const accountUid = (userId: string) => b64(sha256(utf8(`veil-account-v1:${userId}`))).slice(0, 22);

async function readIndex(root: StorageBackend): Promise<AccountIndex> {
  try {
    const raw = await root.get(INDEX_KEY);
    const index = raw ? (JSON.parse(fromUtf8(raw)) as AccountIndex) : null;
    if (index?.v === 1 && index.labels) return index;
  } catch {
    // damaged list: rebuilt from the vaults themselves
  }
  return { v: 1, labels: {} };
}

const writeIndex = (root: StorageBackend, index: AccountIndex) => root.set(INDEX_KEY, utf8(JSON.stringify(index)));

/** The accounts on this device (a vault exists), first one first. */
export async function deviceAccounts(root: StorageBackend): Promise<DeviceAccount[]> {
  const index = await readIndex(root);
  const found: DeviceAccount[] = [];
  for (const slot of SLOTS) if (await readVaultMeta(new SpaceStorage(root, slot))) found.push({ slot, label: index.labels[slot] });
  return found;
}

/** The account to show first: the one used last, if it is still here. */
export async function lastSlot(root: StorageBackend, accounts: DeviceAccount[]): Promise<Slot | null> {
  const { last } = await readIndex(root);
  return accounts.find((a) => a.slot === last)?.slot ?? accounts[0]?.slot ?? null;
}

export async function freeSlot(root: StorageBackend): Promise<Slot | null> {
  const used = new Set((await deviceAccounts(root)).map((a) => a.slot));
  return SLOTS.find((s) => !used.has(s)) ?? null;
}

/** After a successful unlock: remember the account and refresh its name for the lock screen. */
export async function rememberAccount(root: StorageBackend, slot: Slot, me: { userId: string; displayName: string; username: string }): Promise<void> {
  const index = await readIndex(root);
  const hidden = index.labels[slot]?.hidden;
  index.labels[slot] = { uid: accountUid(me.userId), ...(hidden ? { hidden: true } : { name: me.displayName, username: me.username }) };
  index.last = slot;
  await writeIndex(root, index);
}

/** `me` is null inside the empty Veil (duress): only the flag changes, the real name stays as it was. */
export async function setNameHidden(
  root: StorageBackend,
  slot: Slot,
  hidden: boolean,
  me: { userId: string; displayName: string; username: string } | null,
): Promise<void> {
  const index = await readIndex(root);
  const label = index.labels[slot];
  if (!me) {
    if (!label) return;
    const { name: _name, username: _username, ...rest } = label;
    index.labels[slot] = hidden ? { ...rest, hidden: true } : { ...label, hidden: false };
    return writeIndex(root, index);
  }
  index.labels[slot] = { ...(label ?? { uid: accountUid(me.userId) }), hidden };
  await writeIndex(root, index);
  await rememberAccount(root, slot, me);
}

export async function setLastSlot(root: StorageBackend, slot: Slot): Promise<void> {
  const index = await readIndex(root);
  index.last = slot;
  await writeIndex(root, index);
}

export async function forgetAccount(root: StorageBackend, slot: Slot): Promise<void> {
  const index = await readIndex(root);
  delete index.labels[slot];
  if (index.last === slot) delete index.last;
  await writeIndex(root, index);
}

/** The same account must not sit in both places (two copies would fight over one inbox). */
export async function duplicateOf(root: StorageBackend, slot: Slot, userId: string): Promise<Slot | null> {
  const uid = accountUid(userId);
  for (const other of await deviceAccounts(root)) if (other.slot !== slot && other.label?.uid === uid) return other.slot;
  return null;
}

export const accountTitle = (account: DeviceAccount) =>
  account.label?.name && !account.label.hidden ? account.label.name : `Аккаунт ${account.slot}`;
