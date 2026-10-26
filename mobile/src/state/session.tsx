// The open account: one Messenger from the shared core, its snapshot for React, and locking.
import { createContext, useContext, useSyncExternalStore } from 'react';
import type { Messenger } from '../../../src/core/messenger.ts';
import type { StorageBackend } from '../../../src/core/storage.ts';
import type { MessengerSnapshot } from '../../../src/core/types.ts';

export interface Session {
  messenger: Messenger;
  storage: StorageBackend;
  lock(): void;
}

export const SessionContext = createContext<Session | null>(null);

export function useSession(): Session {
  const session = useContext(SessionContext);
  if (!session) throw new Error('Veil закрыт');
  return session;
}

export function useSnapshot(): MessengerSnapshot {
  const { messenger } = useSession();
  return useSyncExternalStore(messenger.subscribe, messenger.getSnapshot);
}

/** The phone keeps the vault under a lighter password function than the desktop: Face ID and
 * the iPhone's own data protection guard it too, and Hermes runs scrypt several times slower. */
export const PHONE_KDF = { N: 2 ** 15, r: 8, p: 1 };
