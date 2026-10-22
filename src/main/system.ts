// System integration for locking: the quick-unlock key in the system keychain (Electron
// safeStorage: DPAPI on Windows, Keychain on macOS, libsecret or KWallet on Linux), the
// fingerprint (fprintd on Linux, Touch ID on macOS), and the operating system's own screen lock.
// Nothing here is logged.

import { app, powerMonitor, safeStorage, systemPreferences } from 'electron';
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const MAX_ATTEMPTS = 5;
/** Each account on this computer has its own quick unlock (Settings → «Аккаунты»). */
type Slot = 1 | 2;
const file = (slot: Slot) => join(app.getPath('userData'), slot === 2 ? 'quick-unlock-2.json' : 'quick-unlock.json');
export const quickSlot = (value: unknown): Slot => (value === 2 ? 2 : 1);

interface Stored {
  /** The PIN-wrapped vault key, itself encrypted by safeStorage (base64). */
  pin?: string;
  /** The vault key encrypted by safeStorage, released after a fingerprint match (Linux). */
  fingerprint?: string;
  failures?: number;
}

export interface QuickUnlockStatus {
  /** The system keychain works: quick unlock can be switched on. */
  available: boolean;
  /** Where the key is kept, for the settings text. */
  keychain: 'dpapi' | 'keychain' | 'libsecret' | 'kwallet' | 'test' | 'none';
  pin: boolean;
  attemptsLeft: number;
  fingerprint: { available: boolean; enabled: boolean };
  /** Windows Hello needs a signed native module: not offered (see the settings text). */
  hello: false;
}

async function load(slot: Slot): Promise<Stored> {
  try {
    return JSON.parse(await readFile(file(slot), 'utf8')) as Stored;
  } catch {
    return {};
  }
}

async function save(slot: Slot, stored: Stored): Promise<void> {
  if (!stored.pin && !stored.fingerprint) await rm(file(slot), { force: true });
  else await writeFile(file(slot), JSON.stringify(stored), { mode: 0o600 });
}

function keychain(): QuickUnlockStatus['keychain'] {
  // Development builds only: lets the smoke test run the PIN flow on CI machines without a keychain.
  if (process.platform === 'linux' && !app.isPackaged && process.env.VEIL_TEST_KEYCHAIN === '1') {
    safeStorage.setUsePlainTextEncryption(true);
    return 'test';
  }
  if (!safeStorage.isEncryptionAvailable()) return 'none';
  if (process.platform === 'win32') return 'dpapi';
  if (process.platform === 'darwin') return 'keychain';
  const backend = safeStorage.getSelectedStorageBackend?.() ?? 'unknown';
  if (backend === 'gnome_libsecret') return 'libsecret';
  if (backend.startsWith('kwallet')) return 'kwallet';
  // "basic_text" means no keychain: the key would sit on disk with a hard-coded password.
  return 'none';
}

const run = (command: string, args: string[], timeout = 5000) =>
  new Promise<{ code: number; out: string }>((resolve) => {
    execFile(command, args, { timeout }, (error, stdout, stderr) =>
      resolve({ code: error ? ((error as { code?: number }).code ?? 1) : 0, out: `${stdout}${stderr}` }),
    );
  });

let fprintdChecked: boolean | null = null;
/** fprintd is installed and the user has at least one enrolled finger. */
async function fingerprintAvailable(): Promise<boolean> {
  // macOS: Touch ID, answered by the system itself.
  if (process.platform === 'darwin') return systemPreferences.canPromptTouchID();
  if (process.platform !== 'linux') return false;
  if (fprintdChecked !== null) return fprintdChecked;
  const user = process.env.USER || process.env.LOGNAME || '';
  const { code, out } = await run('fprintd-list', [user]);
  fprintdChecked = code === 0 && /#\d+:/.test(out);
  return fprintdChecked;
}

export async function quickUnlockStatus(slot: Slot): Promise<QuickUnlockStatus> {
  const stored = await load(slot);
  const kc = keychain();
  return {
    available: kc !== 'none',
    keychain: kc,
    pin: !!stored.pin && kc !== 'none',
    attemptsLeft: MAX_ATTEMPTS - (stored.failures ?? 0),
    fingerprint: { available: kc !== 'none' && (await fingerprintAvailable()), enabled: !!stored.fingerprint },
    hello: false,
  };
}

export async function enablePin(slot: Slot, blob: string): Promise<void> {
  if (keychain() === 'none') throw new Error('Нет системной связки ключей');
  const stored = await load(slot);
  await save(slot, { ...stored, pin: safeStorage.encryptString(String(blob)).toString('base64'), failures: 0 });
}

/** The PIN-wrapped key (the renderer checks the PIN), or null. */
export async function loadPin(slot: Slot): Promise<string | null> {
  const stored = await load(slot);
  if (!stored.pin) return null;
  try {
    return safeStorage.decryptString(Buffer.from(stored.pin, 'base64'));
  } catch {
    return null;
  }
}

/** A wrong PIN: after five in a row the wrapped key is deleted. Returns attempts left. */
export async function pinFailed(slot: Slot): Promise<number> {
  const stored = await load(slot);
  const failures = (stored.failures ?? 0) + 1;
  if (failures >= MAX_ATTEMPTS) {
    await save(slot, { fingerprint: stored.fingerprint });
    return 0;
  }
  await save(slot, { ...stored, failures });
  return MAX_ATTEMPTS - failures;
}

export async function pinSucceeded(slot: Slot): Promise<void> {
  const stored = await load(slot);
  if (stored.failures) await save(slot, { ...stored, failures: 0 });
}

export async function enableFingerprint(slot: Slot, key: string): Promise<void> {
  if (!(await fingerprintAvailable())) throw new Error('Сканер отпечатков не найден');
  const stored = await load(slot);
  await save(slot, { ...stored, fingerprint: safeStorage.encryptString(String(key)).toString('base64') });
}

let verifying: ChildProcess | null = null;
/** Asks fprintd for a finger; on a match returns the vault key (base64), otherwise null. */
export async function unlockWithFingerprint(slot: Slot): Promise<string | null> {
  const stored = await load(slot);
  if (!stored.fingerprint || !(await fingerprintAvailable())) return null;
  verifying?.kill();
  const matched =
    process.platform === 'darwin'
      ? await systemPreferences.promptTouchID('открыть Veil').then(
          () => true,
          () => false,
        )
      : await new Promise<boolean>((resolve) => {
    const child = spawn('fprintd-verify', [], { stdio: ['ignore', 'pipe', 'pipe'] });
    verifying = child;
    let out = '';
    child.stdout.on('data', (chunk) => (out += chunk));
    const timer = setTimeout(() => child.kill(), 30_000);
    child.on('close', (code) => {
      clearTimeout(timer);
      verifying = null;
      resolve(code === 0 && /verify-match/.test(out));
    });
    child.on('error', () => resolve(false));
  });
  if (!matched) return null;
  try {
    return safeStorage.decryptString(Buffer.from(stored.fingerprint, 'base64'));
  } catch {
    return null;
  }
}

export async function disableQuickUnlock(slot: Slot, what: 'pin' | 'fingerprint' | 'all'): Promise<void> {
  const stored = await load(slot);
  if (what === 'all') return save(slot, {});
  const { [what]: _removed, ...rest } = stored;
  await save(slot, rest);
}

// ---- the operating system's lock screen -------------------------------------------------------

/**
 * Calls `onLock` when the screen is locked or the computer goes to sleep. Windows and macOS report
 * it through powerMonitor; on Linux logind (Lock) and the ScreenSaver services are watched over
 * D-Bus with gdbus. Resolves to whether locking can be detected on this system.
 */
export async function watchSystemLock(onLock: () => void): Promise<boolean> {
  powerMonitor.on('suspend', onLock);
  if (process.platform !== 'linux') {
    powerMonitor.on('lock-screen', onLock);
    return true;
  }
  const { out } = await run('gdbus', ['help']);
  if (!/monitor/.test(out)) return false; // gdbus is not installed
  const monitors: [string[], RegExp][] = [
    [['monitor', '--system', '--dest', 'org.freedesktop.login1'], /\.Session\.Lock\b/],
    [['monitor', '--session', '--dest', 'org.freedesktop.ScreenSaver'], /ActiveChanged \(true/],
    [['monitor', '--session', '--dest', 'org.gnome.ScreenSaver'], /ActiveChanged \(true/],
  ];
  for (const [args, pattern] of monitors) {
    const child = spawn('gdbus', args, { stdio: ['ignore', 'pipe', 'ignore'] });
    child.on('error', () => {});
    child.stdout.on('data', (chunk: Buffer) => pattern.test(chunk.toString()) && onLock());
    app.on('will-quit', () => child.kill());
  }
  return true;
}
