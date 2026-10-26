import { Ban, Check, ImagePlus } from 'lucide-react';
import { useRef, useState } from 'react';
import type { Messenger } from '../../../core/messenger.ts';
import type { Wallpaper } from '../../../core/types.ts';
import { wallpaperPicture } from '../lib/media.ts';
import { useToast } from '../lib/ui.tsx';
import { useWallpaperStyle, WALLPAPER_PRESETS } from '../lib/wallpapers.ts';

/**
 * Backgrounds for every chat (`scope` 'all') or for one chat. Built-in patterns, an own photo,
 * and how much to dim it. Stays on this device.
 */
export function WallpaperPicker({ messenger, scope, current, inherited }: { messenger: Messenger; scope: string; current?: Wallpaper; inherited?: boolean }) {
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  const set = (wallpaper: Wallpaper | null, photo?: Uint8Array) =>
    messenger.setWallpaper(scope, wallpaper, photo).catch((e) => toast((e as Error).message, 'error'));
  const photoStyle = useWallpaperStyle(messenger, current?.kind === 'photo' ? current : undefined, scope);
  const dim = current?.dim ?? 0;

  const pickPhoto = async (file: File) => {
    setBusy(true);
    try {
      await set({ kind: 'photo', dim: current?.dim ?? 0.35 }, await wallpaperPicture(file));
    } catch {
      toast('Не удалось открыть картинку', 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="wallpaper-picker" data-testid={`wallpaper-${scope === 'all' ? 'all' : 'chat'}`}>
      <div className="wallpaper-grid" role="radiogroup" aria-label="Обои">
        <button
          type="button"
          role="radio"
          aria-checked={!current}
          className={`wallpaper-tile none${!current ? ' active' : ''}`}
          onClick={() => void set(null)}
        >
          <Ban size={18} />
          <span>{scope === 'all' ? 'Без обоев' : inherited ? 'Как во всех чатах' : 'Как во всех'}</span>
        </button>
        {WALLPAPER_PRESETS.map((preset) => {
          const on = current?.kind === 'preset' && current.preset === preset.id;
          return (
            <button
              type="button"
              role="radio"
              aria-checked={on}
              key={preset.id}
              className={`wallpaper-tile${on ? ' active' : ''}`}
              style={{ background: preset.css, ...(preset.size ? { backgroundSize: preset.size } : {}) }}
              onClick={() => void set({ kind: 'preset', preset: preset.id, dim: current?.kind === 'preset' ? dim : 0 })}
            >
              {on && <Check size={16} className="wallpaper-check" />}
              <span>{preset.label}</span>
            </button>
          );
        })}
        <button
          type="button"
          role="radio"
          aria-checked={current?.kind === 'photo'}
          className={`wallpaper-tile photo${current?.kind === 'photo' ? ' active' : ''}`}
          style={photoStyle?.background ? { background: photoStyle.background } : undefined}
          onClick={() => input.current?.click()}
          disabled={busy}
        >
          {current?.kind === 'photo' ? <Check size={16} className="wallpaper-check" /> : <ImagePlus size={18} />}
          <span>{current?.kind === 'photo' ? 'Другое фото' : 'Своё фото'}</span>
        </button>
        <input
          ref={input}
          type="file"
          accept="image/png,image/jpeg,image/webp"
          hidden
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) void pickPhoto(file);
            e.target.value = '';
          }}
        />
      </div>
      {current && (
        <label className="wallpaper-dim">
          <span>Затемнение</span>
          <input
            type="range"
            min={0}
            max={0.8}
            step={0.05}
            value={dim}
            aria-label="Затемнение обоев"
            onChange={(e) => void set({ ...current, dim: Number(e.target.value) })}
          />
          <b>{Math.round(dim * 100)}%</b>
        </label>
      )}
    </div>
  );
}
