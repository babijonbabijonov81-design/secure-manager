// No Keychain in the browser build: always the password.
import type { Biometry } from './keychain';

export type { Biometry };
export const biometry = async (): Promise<Biometry> => ({ available: false, label: 'Face ID' });
export const hasBiometricKey = async () => false;
export const saveBiometricKey = async (_key: Uint8Array) => {};
export const loadBiometricKey = async (): Promise<Uint8Array | null> => null;
export const forgetBiometricKey = async () => {};
