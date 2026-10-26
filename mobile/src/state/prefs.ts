// Settings of this iPhone that are not part of the account: when to lock, and the theme before
// the vault is open. Kept in the Keychain (no secrets in them, but it survives reinstalls less).
import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';
import type { ThemeChoice } from '../ui/theme.ts';

export interface PhonePrefs {
  /** Minutes in the background before Veil locks; 0 — at once. */
  lockAfter: 0 | 1 | 5;
  theme: ThemeChoice;
  /** This device's id in «Устройства» on the desktop. */
  deviceId: string;
}

const KEY = 'veil.prefs';
const DEFAULTS: Omit<PhonePrefs, 'deviceId'> = { lockAfter: 1, theme: 'system' };

const web = Platform.OS === 'web';
const read = async () => (web ? globalThis.localStorage?.getItem(KEY) : await SecureStore.getItemAsync(KEY).catch(() => null)) ?? null;
const write = async (value: string) => (web ? globalThis.localStorage?.setItem(KEY, value) : SecureStore.setItemAsync(KEY, value, { keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY }));

const newId = () => [...crypto.getRandomValues(new Uint8Array(8))].map((b) => b.toString(16).padStart(2, '0')).join('');

export async function loadPrefs(): Promise<PhonePrefs> {
  let stored: Partial<PhonePrefs> = {};
  try {
    stored = JSON.parse((await read()) ?? '{}') as Partial<PhonePrefs>;
  } catch {
    stored = {};
  }
  const prefs: PhonePrefs = {
    lockAfter: stored.lockAfter === 0 || stored.lockAfter === 5 ? stored.lockAfter : DEFAULTS.lockAfter,
    theme: stored.theme === 'dark' || stored.theme === 'light' ? stored.theme : DEFAULTS.theme,
    deviceId: typeof stored.deviceId === 'string' && /^[0-9a-f]{16}$/.test(stored.deviceId) ? stored.deviceId : newId(),
  };
  if (prefs.deviceId !== stored.deviceId) await write(JSON.stringify(prefs));
  return prefs;
}

export async function savePrefs(prefs: PhonePrefs): Promise<void> {
  await write(JSON.stringify(prefs));
}
