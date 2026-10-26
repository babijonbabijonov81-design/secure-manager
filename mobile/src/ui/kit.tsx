// Building blocks in the Veil style: logo, avatars with photos, buttons, fields, switches, toasts.
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import {
  ActivityIndicator,
  Animated,
  Image,
  Pressable,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
  type StyleProp,
  type TextInputProps,
  type TextStyle,
  type ViewStyle,
} from 'react-native';
import Svg, { Circle, Path } from 'react-native-svg';
import { avatarColor, initials } from '../../../src/renderer/src/lib/format.ts';
import { FONT, RADIUS, useTheme } from './theme.ts';

/** «Две вуали»: two sheets with the conversation (a dot) between them. */
export function Logo({ size = 34 }: { size?: number }) {
  const t = useTheme();
  return (
    <Svg width={size} height={size} viewBox="0 0 48 48" accessibilityLabel="Veil">
      <Path d="M7 9 Q19 10 24 39 Q11 29 7 9 Z" fill={t.ember} />
      <Path d="M41 9 Q29 10 24 39 Q37 29 41 9 Z" fill={t.mint} opacity={0.92} />
      <Circle cx="24" cy="14" r="4.2" fill={t.text} />
    </Svg>
  );
}

/** Bytes as a data: URI for <Image> (standard base64). */
export function dataUri(bytes: Uint8Array, mime = 'image/jpeg'): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return `data:${mime};base64,${btoa(binary)}`;
}

/** Where avatars take photos from: messenger.getAvatar ('me' or a contact id). */
export const PhotoSource = createContext<((id: string) => Promise<Uint8Array | null>) | null>(null);
const photoCache = new Map<string, Promise<string | null>>();

export function Avatar({ name, seed, size = 54, photo, photoId, dashed }: { name: string; seed: string; size?: number; photo?: string; photoId?: string; dashed?: boolean }) {
  const t = useTheme();
  const source = useContext(PhotoSource);
  const [uri, setUri] = useState<string | null>(null);
  const id = photoId ?? seed;
  useEffect(() => {
    setUri(null);
    if (!photo || !source) return;
    const key = `${id}:${photo}`;
    let pending = photoCache.get(key);
    if (!pending) {
      pending = source(id).then((bytes) => (bytes ? dataUri(bytes) : null));
      photoCache.set(key, pending);
    }
    let alive = true;
    void pending.then((u) => alive && setUri(u));
    return () => {
      alive = false;
    };
  }, [source, id, photo]);
  const round = { width: size, height: size, borderRadius: size / 2 };
  if (uri) return <Image source={{ uri }} style={[round, { backgroundColor: t.surface2 }]} accessibilityIgnoresInvertColors />;
  return (
    <View
      style={[
        round,
        styles.center,
        dashed ? { backgroundColor: t.surface2, borderWidth: 1, borderStyle: 'dashed', borderColor: t.muted } : { backgroundColor: avatarColor(seed) },
      ]}
    >
      <Text style={{ fontFamily: FONT.heavy, fontSize: Math.round(size * 0.32), color: dashed ? t.text2 : '#1A0E08' }} allowFontScaling={false}>
        {initials(name)}
      </Text>
    </View>
  );
}

type ButtonKind = 'primary' | 'secondary' | 'ghost' | 'mint' | 'danger';

export function Button({
  title,
  onPress,
  kind = 'primary',
  disabled,
  busy,
  icon,
  style,
  accessibilityLabel,
}: {
  title: string;
  onPress(): void;
  kind?: ButtonKind;
  disabled?: boolean;
  busy?: boolean;
  icon?: ReactNode;
  style?: StyleProp<ViewStyle>;
  accessibilityLabel?: string;
}) {
  const t = useTheme();
  const look: Record<ButtonKind, { bg: string; fg: string; border?: string }> = {
    primary: { bg: t.ember, fg: t.emberInk },
    secondary: { bg: t.surface, fg: t.text, border: t.line },
    ghost: { bg: 'transparent', fg: t.text, border: t.line },
    mint: { bg: t.mint, fg: '#0C0A09' },
    danger: { bg: 'transparent', fg: t.danger, border: t.line },
  };
  const { bg, fg, border } = look[kind];
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? title}
      accessibilityState={{ disabled: !!disabled || !!busy, busy: !!busy }}
      disabled={disabled || busy}
      onPress={onPress}
      style={({ pressed }) => [
        styles.button,
        { backgroundColor: bg, borderColor: border ?? bg, borderWidth: border ? 1 : 0, opacity: disabled ? 0.45 : pressed ? 0.8 : 1 },
        style,
      ]}
    >
      {busy ? <ActivityIndicator color={fg} /> : icon}
      <Text style={[styles.buttonText, { color: fg }]}>{title}</Text>
    </Pressable>
  );
}

/** A round icon button (44 pt, as the design and Apple's guidelines ask). */
export function IconButton({
  label,
  onPress,
  children,
  filled,
  tone,
  style,
}: {
  label: string;
  onPress(): void;
  children: ReactNode;
  filled?: boolean;
  tone?: 'mint';
  style?: StyleProp<ViewStyle>;
}) {
  const t = useTheme();
  const bg = filled ? t.ember : tone === 'mint' ? t.mintSoft : t.surface;
  const border = filled ? t.ember : tone === 'mint' ? t.mint : t.line;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      hitSlop={4}
      onPress={onPress}
      style={({ pressed }) => [styles.iconButton, { backgroundColor: bg, borderColor: border, opacity: pressed ? 0.75 : 1 }, style]}
    >
      {children}
    </Pressable>
  );
}

export function Field({ label, hint, error, style, ...input }: TextInputProps & { label: string; hint?: string; error?: string; style?: StyleProp<TextStyle> }) {
  const t = useTheme();
  return (
    <View style={{ gap: 6 }}>
      <Text style={[styles.label, { color: t.text2 }]}>{label}</Text>
      <TextInput
        placeholderTextColor={t.muted}
        accessibilityLabel={label}
        {...input}
        style={[styles.input, { backgroundColor: t.surface, borderColor: error ? t.danger : t.line, color: t.text }, style]}
      />
      {error ? <Text style={[styles.hint, { color: t.danger }]}>{error}</Text> : hint ? <Text style={[styles.hint, { color: t.muted }]}>{hint}</Text> : null}
    </View>
  );
}

export function Toggle({ value, onChange, label }: { value: boolean; onChange(v: boolean): void; label: string }) {
  const t = useTheme();
  return (
    <Switch
      accessibilityLabel={label}
      value={value}
      onValueChange={onChange}
      trackColor={{ true: t.mint, false: t.line }}
      thumbColor="#F4EFE9"
      ios_backgroundColor={t.line}
    />
  );
}

export function Segmented<T extends string>({ value, options, onChange, label }: { value: T; options: [T, string][]; onChange(v: T): void; label: string }) {
  const t = useTheme();
  return (
    <View accessibilityRole="radiogroup" accessibilityLabel={label} style={[styles.segmented, { backgroundColor: t.surface, borderColor: t.line }]}>
      {options.map(([id, text]) => {
        const on = id === value;
        return (
          <Pressable
            key={id}
            accessibilityRole="radio"
            accessibilityState={{ checked: on }}
            aria-checked={on}
            onPress={() => onChange(id)}
            style={[styles.segment, on && { backgroundColor: t.emberSoft }]}
          >
            <Text style={{ fontFamily: on ? FONT.bold : FONT.semibold, fontSize: 13, color: on ? t.ember : t.text2, textAlign: 'center' }}>{text}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

/** A titled group of rows, like iOS settings but in Veil colours. */
export function Section({ title, children, footer }: { title?: string; children: ReactNode; footer?: string }) {
  const t = useTheme();
  return (
    <View style={{ gap: 8 }}>
      {title ? <Text style={[styles.sectionTitle, { color: t.muted }]}>{title.toUpperCase()}</Text> : null}
      <View style={[styles.card, { backgroundColor: t.surface, borderColor: t.line }]}>{children}</View>
      {footer ? <Text style={[styles.hint, { color: t.muted, paddingHorizontal: 4 }]}>{footer}</Text> : null}
    </View>
  );
}

export function Row({ title, detail, right, onPress, danger, last }: { title: string; detail?: string; right?: ReactNode; onPress?(): void; danger?: boolean; last?: boolean }) {
  const t = useTheme();
  const body = (
    <View style={[styles.row, !last && { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: t.line }]}>
      <View style={{ flex: 1, gap: 2 }}>
        <Text style={{ fontFamily: FONT.semibold, fontSize: 16, color: danger ? t.danger : t.text }}>{title}</Text>
        {detail ? <Text style={{ fontFamily: FONT.regular, fontSize: 13, color: t.muted }}>{detail}</Text> : null}
      </View>
      {right}
    </View>
  );
  return onPress ? (
    <Pressable accessibilityRole="button" onPress={onPress} style={({ pressed }) => ({ opacity: pressed ? 0.7 : 1 })}>
      {body}
    </Pressable>
  ) : (
    body
  );
}

// ---- toasts ----

type ToastKind = 'info' | 'success' | 'error';
const ToastContext = createContext<(text: string, kind?: ToastKind) => void>(() => {});
export const useToast = () => useContext(ToastContext);

export function ToastProvider({ children }: { children: ReactNode }) {
  const t = useTheme();
  const [toast, setToast] = useState<{ text: string; kind: ToastKind } | null>(null);
  const fade = useRef(new Animated.Value(0)).current;
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const show = useCallback(
    (text: string, kind: ToastKind = 'info') => {
      clearTimeout(timer.current);
      setToast({ text, kind });
      Animated.timing(fade, { toValue: 1, duration: 180, useNativeDriver: true }).start();
      timer.current = setTimeout(() => Animated.timing(fade, { toValue: 0, duration: 220, useNativeDriver: true }).start(() => setToast(null)), 3200);
    },
    [fade],
  );
  return (
    <ToastContext.Provider value={show}>
      {children}
      {toast && (
        <Animated.View pointerEvents="none" accessibilityLiveRegion="polite" style={[styles.toast, { opacity: fade, backgroundColor: toast.kind === 'error' ? t.danger : t.text }]}>
          <Text style={{ fontFamily: FONT.semibold, fontSize: 14, color: toast.kind === 'error' ? '#fff' : t.bg }}>{toast.text}</Text>
        </Animated.View>
      )}
    </ToastContext.Provider>
  );
}

export const styles = StyleSheet.create({
  center: { alignItems: 'center', justifyContent: 'center' },
  button: { minHeight: 54, borderRadius: 18, paddingHorizontal: 20, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8 },
  buttonText: { fontFamily: FONT.bold, fontSize: 16 },
  iconButton: { width: 44, height: 44, borderRadius: 22, borderWidth: 1, alignItems: 'center', justifyContent: 'center' },
  label: { fontFamily: FONT.semibold, fontSize: 14 },
  input: { minHeight: 50, borderRadius: RADIUS.field, borderWidth: 1, paddingHorizontal: 14, fontFamily: FONT.regular, fontSize: 16 },
  hint: { fontFamily: FONT.regular, fontSize: 13, lineHeight: 18 },
  segmented: { flexDirection: 'row', borderRadius: 14, borderWidth: 1, padding: 3, gap: 3 },
  segment: { flex: 1, minHeight: 40, borderRadius: 11, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 6 },
  sectionTitle: { fontFamily: FONT.mono, fontSize: 11, letterSpacing: 1, paddingHorizontal: 4 },
  card: { borderRadius: RADIUS.card, borderWidth: 1, overflow: 'hidden' },
  row: { minHeight: 56, flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 16, paddingVertical: 10 },
  toast: { position: 'absolute', left: 18, right: 18, bottom: 112, borderRadius: 16, paddingHorizontal: 14, paddingVertical: 12 },
});
