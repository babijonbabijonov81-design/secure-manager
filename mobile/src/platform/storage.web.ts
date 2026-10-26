// The web build (for checking the interface in a browser): IndexedDB, as in the desktop's browser mode.
import { IndexedDBStorage, type StorageBackend } from '../../../src/core/storage.ts';

export const deviceStorage = (): StorageBackend => {
  const profile = new URLSearchParams(globalThis.location?.search ?? '').get('profile') ?? 'default';
  return new IndexedDBStorage(`veil-mobile-${profile}`);
};
