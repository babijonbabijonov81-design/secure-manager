import { createContext, useContext } from 'react';
import type { PhonePrefs } from './prefs.ts';

export interface PrefsApi {
  prefs: PhonePrefs;
  update(patch: Partial<PhonePrefs>): void;
}

export const PrefsContext = createContext<PrefsApi | null>(null);

export function usePrefs(): PrefsApi {
  const api = useContext(PrefsContext);
  if (!api) throw new Error('prefs not loaded');
  return api;
}
