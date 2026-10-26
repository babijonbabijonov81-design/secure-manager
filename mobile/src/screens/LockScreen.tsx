// «Veil закрыт»: Face ID (or Touch ID), or the password.
import { Bell, ScanFace } from 'lucide-react-native';
import { useEffect, useRef, useState } from 'react';
import { KeyboardAvoidingView, Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { WrongPasswordError } from '../../../src/core/crypto/vault.ts';
import { unlock, unlockWithKey, type Messenger } from '../../../src/core/messenger.ts';
import type { StorageBackend } from '../../../src/core/storage.ts';
import { biometry, forgetBiometricKey, hasBiometricKey, loadBiometricKey, type Biometry } from '../platform/keychain';
import { Button, Field, Logo } from '../ui/kit.tsx';
import { FONT, useTheme } from '../ui/theme.ts';

export function LockScreen({ storage, onOpened }: { storage: StorageBackend; onOpened(m: Messenger): void }) {
  const t = useTheme();
  const insets = useSafeAreaInsets();
  const [bio, setBio] = useState<Biometry | null>(null);
  const [keyKept, setKeyKept] = useState(false);
  const [typing, setTyping] = useState(false);
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const asked = useRef(false);

  const withFace = async () => {
    setError('');
    const key = await loadBiometricKey();
    if (!key) return;
    setBusy(true);
    try {
      onOpened(await unlockWithKey(storage, key));
    } catch {
      // The kept key no longer opens this vault (the password changed elsewhere): forget it.
      await forgetBiometricKey();
      setKeyKept(false);
      setTyping(true);
      setError('Войдите паролем, потом снова включите вход по лицу в «Ещё»');
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    void (async () => {
      const [b, kept] = await Promise.all([biometry(), hasBiometricKey()]);
      setBio(b);
      setKeyKept(kept && b.available);
      if (kept && b.available && !asked.current) {
        asked.current = true;
        void withFace();
      } else setTyping(true);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const withPassword = async () => {
    if (!password) return;
    setBusy(true);
    setError('');
    // Let the spinner draw before scrypt takes the thread.
    await new Promise((r) => setTimeout(r, 30));
    try {
      onOpened(await unlock(storage, password));
    } catch (e) {
      setError(e instanceof WrongPasswordError ? 'Неверный пароль' : (e as Error).message || 'Не удалось открыть');
    } finally {
      setBusy(false);
    }
  };

  return (
    <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={{ flex: 1, backgroundColor: t.bg }}>
      <View style={[styles.wrap, { paddingTop: insets.top + 80, paddingBottom: insets.bottom + 24 }]}>
        <View style={[styles.plate, { backgroundColor: t.dark ? '#1A1411' : t.surface, borderColor: t.line }]}>
          <Logo size={80} />
        </View>
        <Text style={[styles.title, { color: t.text }]} accessibilityRole="header">
          Veil закрыт
        </Text>
        <Text style={[styles.sub, { color: t.text2 }]}>Чаты и «Избранное» зашифрованы на этом {Platform.OS === 'ios' ? 'iPhone' : 'устройстве'}.</Text>

        {keyKept && !typing && (
          <>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`Открыть по ${bio?.label ?? 'Face ID'}`}
              onPress={() => void withFace()}
              style={({ pressed }) => [styles.face, { borderColor: t.mintLine, backgroundColor: t.mintSoft, opacity: pressed ? 0.8 : 1 }]}
            >
              <ScanFace size={48} color={t.mint} strokeWidth={1.6} />
            </Pressable>
            <Text style={[styles.caption, { color: t.muted }]}>{bio?.label === 'Touch ID' ? 'Приложите палец' : 'Посмотрите на экран'}</Text>
          </>
        )}

        {typing && (
          <View style={{ alignSelf: 'stretch', marginTop: 48, gap: 14 }}>
            <Field
              label="Пароль"
              value={password}
              onChangeText={setPassword}
              secureTextEntry
              autoFocus
              textContentType="password"
              returnKeyType="go"
              onSubmitEditing={() => void withPassword()}
              error={error || undefined}
            />
            <Button title="Открыть" onPress={() => void withPassword()} busy={busy} disabled={!password} />
          </View>
        )}

        <View style={styles.bottom}>
          {keyKept && !typing && <Button title="Ввести пароль" kind="secondary" onPress={() => setTyping(true)} style={{ alignSelf: 'stretch' }} />}
          {keyKept && typing && <Button title={`Открыть по ${bio?.label ?? 'Face ID'}`} kind="ghost" onPress={() => void withFace()} style={{ alignSelf: 'stretch' }} />}
          {!typing && error ? <Text style={[styles.caption, { color: t.danger }]}>{error}</Text> : null}
          <View style={styles.note}>
            <Bell size={14} color={t.muted} />
            <Text style={[styles.caption, { color: t.muted, marginTop: 0 }]}>Уведомления без текста, пока Veil закрыт</Text>
          </View>
        </View>
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  wrap: { flex: 1, alignItems: 'center', paddingHorizontal: 28 },
  plate: { width: 116, height: 116, borderRadius: 30, borderWidth: 1, alignItems: 'center', justifyContent: 'center' },
  title: { marginTop: 28, marginBottom: 8, fontFamily: FONT.heavy, fontSize: 30, letterSpacing: -1 },
  sub: { textAlign: 'center', fontFamily: FONT.regular, fontSize: 15, lineHeight: 22 },
  face: { marginTop: 64, width: 96, height: 96, borderRadius: 30, borderWidth: 1, alignItems: 'center', justifyContent: 'center' },
  caption: { marginTop: 14, fontFamily: FONT.regular, fontSize: 14, textAlign: 'center' },
  bottom: { marginTop: 'auto', alignSelf: 'stretch', alignItems: 'center', gap: 14 },
  note: { flexDirection: 'row', alignItems: 'center', gap: 6 },
});
