// Choosing a background: none (or «as in all chats»), the built-in ones, an own photo, and dimming.
import { Ban, Check, ImagePlus } from 'lucide-react-native';
import { useState } from 'react';
import { Image, Pressable, StyleSheet, Text, View } from 'react-native';
import type { Messenger } from '../../../src/core/messenger.ts';
import type { Wallpaper } from '../../../src/core/types.ts';
import { pickWallpaper } from '../platform/pictures.ts';
import { Segmented, useToast } from './kit.tsx';
import { FONT, useTheme } from './theme.ts';
import { PresetArt, useWallpaperPhoto, WALLPAPERS } from './Wallpaper.tsx';

type Dim = '0' | '0.2' | '0.4' | '0.6';
const DIMS: [Dim, string][] = [
  ['0', '0%'],
  ['0.2', '20%'],
  ['0.4', '40%'],
  ['0.6', '60%'],
];
/** The step closest to a stored dimming (the desktop has a slider). */
const nearest = (dim: number): Dim => DIMS.reduce((best, [v]) => (Math.abs(Number(v) - dim) < Math.abs(Number(best) - dim) ? v : best), '0' as Dim);

export function WallpaperPicker({ messenger, scope, current, inherited }: { messenger: Messenger; scope: string; current?: Wallpaper; inherited?: boolean }) {
  const t = useTheme();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const photo = useWallpaperPhoto(messenger, scope, current?.kind === 'photo' ? current.rev : undefined);
  const set = (wallpaper: Wallpaper | null, picture?: Uint8Array) => messenger.setWallpaper(scope, wallpaper, picture).catch((e) => toast((e as Error).message, 'error'));
  const dim = current?.dim ?? 0;

  const choosePhoto = async () => {
    setBusy(true);
    try {
      const picture = await pickWallpaper();
      if (picture) await set({ kind: 'photo', dim: current?.dim ?? 0.4 }, picture);
    } catch {
      toast('Не удалось открыть фото', 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <View style={{ gap: 14 }}>
      <View style={styles.grid} accessibilityRole="radiogroup" accessibilityLabel="Обои">
        <Tile on={!current} label={scope === 'all' ? 'Без обоев' : inherited ? 'Как во всех' : 'Без обоев'} onPress={() => void set(null)}>
          <Ban size={20} color={t.muted} />
        </Tile>
        {WALLPAPERS.map((w) => (
          <Tile key={w.id} on={current?.kind === 'preset' && current.preset === w.id} label={w.label} onPress={() => void set({ kind: 'preset', preset: w.id, dim: current?.kind === 'preset' ? dim : 0 })}>
            <PresetArt id={w.id} />
          </Tile>
        ))}
        <Tile on={current?.kind === 'photo'} label={current?.kind === 'photo' ? 'Другое фото' : 'Своё фото'} onPress={() => !busy && void choosePhoto()}>
          {photo ? <Image source={{ uri: photo }} style={StyleSheet.absoluteFill} resizeMode="cover" /> : <ImagePlus size={20} color={t.muted} />}
        </Tile>
      </View>
      {current && (
        <View style={{ gap: 6 }}>
          <Text style={{ fontFamily: FONT.semibold, fontSize: 14, color: t.text2 }}>Затемнение</Text>
          <Segmented
            label="Затемнение обоев"
            value={nearest(dim)}
            options={DIMS}
            onChange={(v) => void set({ ...current, dim: Number(v) })}
          />
        </View>
      )}
    </View>
  );
}

function Tile({ on, label, onPress, children }: { on: boolean; label: string; onPress(): void; children: React.ReactNode }) {
  const t = useTheme();
  return (
    <Pressable
      accessibilityRole="radio"
      accessibilityState={{ checked: on }}
            aria-checked={on}
      accessibilityLabel={label}
      onPress={onPress}
      style={[styles.tile, { backgroundColor: t.surface2, borderColor: on ? t.ember : t.line, borderWidth: on ? 2 : 1 }]}
    >
      <View style={[StyleSheet.absoluteFill, { alignItems: 'center', justifyContent: 'center' }]}>{children}</View>
      {on && (
        <View style={[styles.check, { backgroundColor: t.ember }]}>
          <Check size={12} color={t.emberInk} strokeWidth={3} />
        </View>
      )}
      <Text style={[styles.label, { color: t.text, backgroundColor: t.dark ? 'rgba(12,10,9,0.7)' : 'rgba(255,255,255,0.8)' }]}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  tile: { width: 92, height: 124, borderRadius: 14, overflow: 'hidden', justifyContent: 'flex-end', alignItems: 'center', paddingBottom: 8 },
  check: { position: 'absolute', top: 8, right: 8, width: 20, height: 20, borderRadius: 10, alignItems: 'center', justifyContent: 'center' },
  label: { fontFamily: FONT.semibold, fontSize: 12, paddingHorizontal: 8, paddingVertical: 2, borderRadius: 999, overflow: 'hidden' },
});
