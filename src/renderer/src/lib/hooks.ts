import { useEffect, useState } from 'react';
import { isSavedChat, type Contact, type FeatureName, type Settings } from '../../../core/types.ts';

/** Tracks a CSS media query, e.g. the 1100 px and 760 px layout breakpoints. */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => matchMedia(query).matches);
  useEffect(() => {
    const media = matchMedia(query);
    const onChange = () => setMatches(media.matches);
    onChange();
    media.addEventListener('change', onChange);
    return () => media.removeEventListener('change', onChange);
  }, [query]);
  return matches;
}

/** A feature flag from Settings → «Функции». */
export const feature = (settings: Settings, name: FeatureName) => settings.features?.[name] !== false;

/** «Вуаль» covers this chat: everywhere, or only in the chats where it was switched on. */
export const veiledFor = (settings: Settings, contact: Contact | undefined) =>
  feature(settings, 'veil') && settings.veil && !!contact && !isSavedChat(contact.id) && (settings.veilScope === 'all' || !!contact.veil);

/** Re-renders every `ms` milliseconds (countdowns, "сгорит через…"). */
export function useNow(ms = 1000): number {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(timer);
  }, [ms]);
  return now;
}
