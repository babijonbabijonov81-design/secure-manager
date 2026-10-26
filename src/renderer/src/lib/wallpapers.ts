// Chat backgrounds: built-in ones in the brand colours (no blue or violet), or the person's own
// photo from the vault. Only on this device — the other side never sees them.
import { useEffect, useState, type CSSProperties } from 'react';
import type { Messenger } from '../../../core/messenger.ts';
import type { Contact, Settings, Wallpaper } from '../../../core/types.ts';

export interface WallpaperPreset {
  id: string;
  label: string;
  /** CSS background; theme colours come in through variables. */
  css: string;
  size?: string;
}

export const WALLPAPER_PRESETS: WallpaperPreset[] = [
  { id: 'ember', label: 'Угли', css: 'radial-gradient(120% 90% at 100% 100%, rgba(255,122,69,.28), transparent 60%), radial-gradient(90% 70% at 0% 0%, rgba(245,183,0,.14), transparent 60%), var(--bg)' },
  { id: 'mint', label: 'Мята', css: 'radial-gradient(110% 80% at 0% 100%, rgba(61,220,151,.22), transparent 60%), radial-gradient(80% 60% at 100% 0%, rgba(61,220,151,.10), transparent 60%), var(--bg)' },
  { id: 'dusk', label: 'Закат', css: 'linear-gradient(160deg, rgba(255,122,69,.30) 0%, rgba(245,183,0,.16) 45%, transparent 75%), var(--bg)' },
  { id: 'sand', label: 'Песок', css: 'linear-gradient(180deg, rgba(201,160,110,.20), rgba(201,160,110,.06)), var(--bg)' },
  {
    id: 'dots',
    label: 'Точки',
    css: 'radial-gradient(rgba(255,122,69,.35) 1.4px, transparent 1.6px), var(--bg)',
    size: '18px 18px',
  },
  {
    id: 'weave',
    label: 'Вуаль',
    css: "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='64' height='64' viewBox='0 0 48 48'%3E%3Cpath d='M7 9 Q19 10 24 39 Q11 29 7 9 Z' fill='%23FF7A45' fill-opacity='.12'/%3E%3Cpath d='M41 9 Q29 10 24 39 Q37 29 41 9 Z' fill='%233DDC97' fill-opacity='.10'/%3E%3C/svg%3E\"), var(--bg)",
    size: '64px 64px',
  },
];

/** The background in effect for a chat: its own, else the common one. */
export const wallpaperOf = (settings: Settings, contact?: Contact): { wallpaper?: Wallpaper; scope: string } =>
  contact?.wallpaper ? { wallpaper: contact.wallpaper, scope: contact.id } : { wallpaper: settings.wallpaper, scope: 'all' };

const photoUrls = new Map<string, Promise<string | null>>();

function photoUrl(messenger: Messenger, scope: string, rev: string): Promise<string | null> {
  const key = `${scope}:${rev}`;
  let url = photoUrls.get(key);
  if (!url) {
    url = messenger.getWallpaperPhoto(scope).then((bytes) => (bytes ? URL.createObjectURL(new Blob([bytes as BlobPart], { type: 'image/jpeg' })) : null));
    photoUrls.set(key, url);
  }
  return url;
}

/** Style for the chat background layer (and the --wall-dim overlay), or null for the default dots. */
export function useWallpaperStyle(messenger: Messenger, wallpaper: Wallpaper | undefined, scope: string): CSSProperties | null {
  const [photo, setPhoto] = useState<string | null>(null);
  const rev = wallpaper?.kind === 'photo' ? wallpaper.rev : undefined;
  useEffect(() => {
    setPhoto(null);
    if (!rev) return;
    let alive = true;
    void photoUrl(messenger, scope, rev).then((url) => alive && setPhoto(url));
    return () => {
      alive = false;
    };
  }, [messenger, scope, rev]);
  if (!wallpaper) return null;
  const dim = { '--wall-dim': String(wallpaper.dim ?? 0) } as CSSProperties;
  if (wallpaper.kind === 'photo') return photo ? { ...dim, background: `center / cover no-repeat url("${photo}")` } : dim;
  const preset = WALLPAPER_PRESETS.find((p) => p.id === wallpaper.preset);
  if (!preset) return null;
  return { ...dim, background: preset.css, ...(preset.size ? { backgroundSize: preset.size } : {}) };
}
