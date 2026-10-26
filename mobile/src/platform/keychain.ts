// «Вход по Face ID»: the vault key in the iPhone Keychain, only on this device and only after
// Face ID / Touch ID (a new face or finger enrolled makes it unreadable).
import * as LocalAuthentication from 'expo-local-authentication';
import * as SecureStore from 'expo-secure-store';
import { b64, unb64 } from '../../../server/src/shared/wire.ts';

const KEY = 'veil.vaultKey';
const FLAG = 'veil.biometry';

export interface Biometry {
  available: boolean;
  /** «Face ID» or «Touch ID». */
  label: string;
}

export async function biometry(): Promise<Biometry> {
  try {
    const [hardware, enrolled, types] = await Promise.all([
      LocalAuthentication.hasHardwareAsync(),
      LocalAuthentication.isEnrolledAsync(),
      LocalAuthentication.supportedAuthenticationTypesAsync(),
    ]);
    const face = types.includes(LocalAuthentication.AuthenticationType.FACIAL_RECOGNITION);
    return { available: hardware && enrolled, label: face ? 'Face ID' : 'Touch ID' };
  } catch {
    return { available: false, label: 'Face ID' };
  }
}

/** Whether the key is kept (asking needs no Face ID). */
export async function hasBiometricKey(): Promise<boolean> {
  return (await SecureStore.getItemAsync(FLAG).catch(() => null)) === '1';
}

export async function saveBiometricKey(key: Uint8Array): Promise<void> {
  await SecureStore.setItemAsync(KEY, b64(key), {
    requireAuthentication: true,
    keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
    authenticationPrompt: 'Включить вход в Veil',
  });
  await SecureStore.setItemAsync(FLAG, '1', { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY });
}

/** Asks for Face ID; null when cancelled or the key is gone (then the password is needed). */
export async function loadBiometricKey(): Promise<Uint8Array | null> {
  try {
    const value = await SecureStore.getItemAsync(KEY, { requireAuthentication: true, authenticationPrompt: 'Открыть Veil' });
    return value ? unb64(value) : null;
  } catch {
    return null;
  }
}

export async function forgetBiometricKey(): Promise<void> {
  await SecureStore.deleteItemAsync(KEY).catch(() => {});
  await SecureStore.deleteItemAsync(FLAG).catch(() => {});
}
