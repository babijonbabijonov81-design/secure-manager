// Chat backgrounds on the iPhone: the same built-in ones as on the desktop (by id), or an own
// photo from the vault, dimmed with the theme's background colour.
import { useEffect, useState } from 'react';
import { Image, StyleSheet, View } from 'react-native';
import Svg, { Circle, Defs, LinearGradient, Path, Pattern, RadialGradient, Rect, Stop } from 'react-native-svg';
import type { Messenger } from '../../../src/core/messenger.ts';
import type { Contact, Settings, Wallpaper } from '../../../src/core/types.ts';
import { dataUri } from './kit.tsx';
import { useTheme } from './theme.ts';

/** The background in effect for a chat: its own, else the common one. */
export const wallpaperOf = (settings: Settings, contact: Contact): { wallpaper?: Wallpaper; scope: string } =>
  contact.wallpaper ? { wallpaper: contact.wallpaper, scope: contact.id } : { wallpaper: settings.wallpaper, scope: 'all' };

export const WALLPAPERS: { id: string; label: string }[] = [
  { id: 'ember', label: 'Угли' },
  { id: 'mint', label: 'Мята' },
  { id: 'dusk', label: 'Закат' },
  { id: 'sand', label: 'Песок' },
  { id: 'dots', label: 'Точки' },
  { id: 'weave', label: 'Вуаль' },
];

export function PresetArt({ id }: { id: string }) {
  const t = useTheme();
  return (
    <Svg style={StyleSheet.absoluteFill} width="100%" height="100%" preserveAspectRatio="xMidYMid slice" viewBox="0 0 400 860">
      <Defs>
        <RadialGradient id="a" cx="100%" cy="100%" r="90%">
          <Stop offset="0" stopColor="#FF7A45" stopOpacity={0.3} />
          <Stop offset="1" stopColor="#FF7A45" stopOpacity={0} />
        </RadialGradient>
        <RadialGradient id="b" cx="0%" cy="0%" r="70%">
          <Stop offset="0" stopColor="#F5B700" stopOpacity={0.15} />
          <Stop offset="1" stopColor="#F5B700" stopOpacity={0} />
        </RadialGradient>
        <RadialGradient id="m" cx="0%" cy="100%" r="90%">
          <Stop offset="0" stopColor="#3DDC97" stopOpacity={0.24} />
          <Stop offset="1" stopColor="#3DDC97" stopOpacity={0} />
        </RadialGradient>
        <LinearGradient id="d" x1="0" y1="0" x2="0.6" y2="1">
          <Stop offset="0" stopColor="#FF7A45" stopOpacity={0.32} />
          <Stop offset="0.45" stopColor="#F5B700" stopOpacity={0.16} />
          <Stop offset="0.8" stopColor="#F5B700" stopOpacity={0} />
        </LinearGradient>
        <LinearGradient id="s" x1="0" y1="0" x2="0" y2="1">
          <Stop offset="0" stopColor="#C9A06E" stopOpacity={0.22} />
          <Stop offset="1" stopColor="#C9A06E" stopOpacity={0.06} />
        </LinearGradient>
        <Pattern id="p" width="18" height="18" patternUnits="userSpaceOnUse">
          <Circle cx="9" cy="9" r="1.5" fill="#FF7A45" fillOpacity={0.35} />
        </Pattern>
        <Pattern id="w" width="64" height="64" patternUnits="userSpaceOnUse" viewBox="0 0 48 48">
          <Path d="M7 9 Q19 10 24 39 Q11 29 7 9 Z" fill="#FF7A45" fillOpacity={0.12} />
          <Path d="M41 9 Q29 10 24 39 Q37 29 41 9 Z" fill="#3DDC97" fillOpacity={0.1} />
        </Pattern>
      </Defs>
      <Rect width="400" height="860" fill={t.bg} />
      {id === 'ember' && (
        <>
          <Rect width="400" height="860" fill="url(#a)" />
          <Rect width="400" height="860" fill="url(#b)" />
        </>
      )}
      {id === 'mint' && <Rect width="400" height="860" fill="url(#m)" />}
      {id === 'dusk' && <Rect width="400" height="860" fill="url(#d)" />}
      {id === 'sand' && <Rect width="400" height="860" fill="url(#s)" />}
      {id === 'dots' && <Rect width="400" height="860" fill="url(#p)" />}
      {id === 'weave' && <Rect width="400" height="860" fill="url(#w)" />}
    </Svg>
  );
}

function usePhoto(messenger: Messenger, scope: string, rev: string | undefined): string | null {
  const [uri, setUri] = useState<string | null>(null);
  useEffect(() => {
    setUri(null);
    if (!rev) return;
    let alive = true;
    void messenger.getWallpaperPhoto(scope).then((bytes) => alive && setUri(bytes ? dataUri(bytes) : null));
    return () => {
      alive = false;
    };
  }, [messenger, scope, rev]);
  return uri;
}

/** The layer behind the messages: the design's faint dots when there is no wallpaper. */
export function ChatBackground({ messenger, wallpaper, scope }: { messenger: Messenger; wallpaper?: Wallpaper; scope: string }) {
  const t = useTheme();
  const photo = usePhoto(messenger, scope, wallpaper?.kind === 'photo' ? wallpaper.rev : undefined);
  return (
    <View style={StyleSheet.absoluteFill} pointerEvents="none">
      {!wallpaper ? (
        <Svg style={StyleSheet.absoluteFill} width="100%" height="100%">
          <Defs>
            <Pattern id="dots" width="20" height="20" patternUnits="userSpaceOnUse">
              <Circle cx="10" cy="10" r="1" fill={t.surface2} />
            </Pattern>
          </Defs>
          <Rect width="100%" height="100%" fill={t.bg} />
          <Rect width="100%" height="100%" fill="url(#dots)" />
        </Svg>
      ) : wallpaper.kind === 'photo' ? (
        <View style={[StyleSheet.absoluteFill, { backgroundColor: t.bg }]}>{photo && <Image source={{ uri: photo }} style={StyleSheet.absoluteFill} resizeMode="cover" />}</View>
      ) : (
        <PresetArt id={wallpaper.preset ?? ''} />
      )}
      {wallpaper && <View style={[StyleSheet.absoluteFill, { backgroundColor: t.bg, opacity: wallpaper.dim ?? 0 }]} />}
    </View>
  );
}

export { usePhoto as useWallpaperPhoto };
