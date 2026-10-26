// First start: the server (or a veil:// invite), then name and password, then Face ID.
import { ChevronLeft, ScanFace, ShieldCheck } from 'lucide-react-native';
import { useState } from 'react';
import { KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { parseInvite, type Invite } from '../../../src/core/invite.ts';
import { createAccount, findInviteServer, MessengerError, type Messenger } from '../../../src/core/messenger.ts';
import { probeServer } from '../../../src/core/relay-client.ts';
import type { StorageBackend } from '../../../src/core/storage.ts';
import { USERNAME_RE } from '../../../server/src/shared/protocol.ts';
import { passwordStrength } from '../../../src/renderer/src/lib/format.ts';
import { biometry, saveBiometricKey } from '../platform/keychain';
import { PHONE_KDF } from '../state/session.tsx';
import { Button, Field, Logo } from '../ui/kit.tsx';
import { FONT, useTheme } from '../ui/theme.ts';

type Step = 'welcome' | 'server' | 'profile' | 'creating' | 'biometry';

export function WelcomeFlow({ storage, onOpened }: { storage: StorageBackend; onOpened(m: Messenger): void }) {
  const t = useTheme();
  const insets = useSafeAreaInsets();
  const [step, setStep] = useState<Step>('welcome');
  const [server, setServer] = useState('');
  const [invite, setInvite] = useState<{ link: string; data: Invite; address?: string; key?: string } | null>(null);
  const [checking, setChecking] = useState(false);
  const [serverNote, setServerNote] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [password2, setPassword2] = useState('');
  const [error, setError] = useState<{ field?: 'server' | 'username' | 'password'; text: string } | null>(null);
  const [progress, setProgress] = useState('');
  const [created, setCreated] = useState<Messenger | null>(null);
  const [faceLabel, setFaceLabel] = useState('Face ID');

  const checkServer = async () => {
    setError(null);
    setServerNote('');
    setChecking(true);
    try {
      const typed = server.trim();
      if (/veil:\/\//i.test(typed)) {
        const data = parseInvite(typed);
        if (!data) throw new Error('Это не приглашение Veil или ссылка повреждена');
        const found = await findInviteServer(data);
        if (!found) throw new Error('Сервер из приглашения сейчас не отвечает. Попросите пригласившего открыть Veil и попробуйте ещё раз');
        setInvite({ link: typed, data, address: found.address, ...(found.key ? { key: found.key } : {}) });
        setServer(found.address);
        setServerNote(`Приглашение от @${data.username}: сервер ${found.address} подтвердил свой ключ`);
      } else {
        const info = await probeServer(typed);
        setInvite(null);
        setServerNote(`Подключено: ${info.name}`);
      }
      setStep('profile');
    } catch (e) {
      setError({ field: 'server', text: (e as Error).message });
    } finally {
      setChecking(false);
    }
  };

  const clean = username.trim().toLowerCase().replace(/^@/, '');
  const strength = passwordStrength(password);

  const create = async () => {
    setError(null);
    if (!USERNAME_RE.test(clean)) return setError({ field: 'username', text: 'От 3 до 32 символов: латинские буквы, цифры и «_»' });
    if (password.length < 8) return setError({ field: 'password', text: 'Пароль должен быть не короче 8 символов' });
    if (password !== password2) return setError({ field: 'password', text: 'Пароли не совпадают' });
    setStep('creating');
    setProgress('Генерируем ключи шифрования…');
    await new Promise((r) => setTimeout(r, 30));
    try {
      const messenger = await createAccount({
        storage,
        serverUrl: server.trim(),
        username: clean,
        displayName: displayName.trim() || clean,
        password,
        kdf: PHONE_KDF,
        ...(invite?.data.registration ? { inviteToken: invite.data.registration } : {}),
        ...(invite?.key && invite.address === server.trim() ? { serverKey: invite.key } : {}),
        onProgress: (stage) => {
          if (stage === 'vault') setProgress('Шифруем хранилище на телефоне…');
          if (stage === 'register') setProgress('Публикуем открытые ключи на сервере…');
        },
      });
      if (invite) await messenger.acceptInvite(invite.link).catch(() => {});
      const b = await biometry();
      if (b.available) {
        setFaceLabel(b.label);
        setCreated(messenger);
        setStep('biometry');
      } else onOpened(messenger);
    } catch (e) {
      const err = e as MessengerError;
      if (err.code === 'username_taken') {
        setError({ field: 'username', text: 'Это имя уже занято — попробуйте другое' });
        setStep('profile');
      } else if (err.code === 'invite_required') {
        setError({ field: 'server', text: 'На этом сервере регистрируются только по приглашению: попросите ссылку veil://' });
        setStep('server');
      } else if (err.code === 'timeout' || err.code === 'offline') {
        setError({ field: 'server', text: err.message });
        setStep('server');
      } else {
        setError({ text: err.message || 'Не удалось создать аккаунт' });
        setStep('profile');
      }
    }
  };

  const enableFace = async () => {
    if (!created) return;
    try {
      await saveBiometricKey(created.quickUnlockKey());
    } catch {
      // Cancelled: stays with the password, can be switched on later in «Ещё».
    }
    onOpened(created);
  };

  const back = step === 'server' ? 'welcome' : step === 'profile' ? 'server' : null;

  return (
    <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={{ flex: 1, backgroundColor: t.bg }}>
      <ScrollView contentContainerStyle={[styles.wrap, { paddingTop: insets.top + 16, paddingBottom: insets.bottom + 24 }]} keyboardShouldPersistTaps="handled">
        {back && (
          <Pressable accessibilityRole="button" accessibilityLabel="Назад" onPress={() => setStep(back)} style={styles.back} hitSlop={8}>
            <ChevronLeft size={24} color={t.ember} />
          </Pressable>
        )}

        {step === 'welcome' && (
          <View style={styles.center}>
            <View style={[styles.plate, { backgroundColor: t.dark ? '#1A1411' : t.surface, borderColor: t.line }]}>
              <Logo size={80} />
            </View>
            <Text style={[styles.hero, { color: t.text }]}>veil</Text>
            <Text style={[styles.lead, { color: t.text2 }]}>Переписка, которую видите только вы и собеседник. Даже сервер не может её прочитать.</Text>
            <View style={styles.points}>
              {[
                'Сквозное шифрование, как на компьютере',
                'Ключи хранятся только на этом телефоне',
                'Вход по лицу, уведомления без текста',
              ].map((text) => (
                <View key={text} style={styles.point}>
                  <ShieldCheck size={18} color={t.mint} />
                  <Text style={[styles.pointText, { color: t.text2 }]}>{text}</Text>
                </View>
              ))}
            </View>
            <Button title="Создать аккаунт" onPress={() => setStep('server')} style={{ alignSelf: 'stretch', marginTop: 'auto' }} />
          </View>
        )}

        {step === 'server' && (
          <View style={styles.form}>
            <Text style={[styles.title, { color: t.text }]} accessibilityRole="header">
              Сервер
            </Text>
            <Text style={[styles.lead, { color: t.text2, textAlign: 'left' }]}>
              Тот же, что у вашего собеседника: например, ваш сервер на Render или Veil на компьютере, открытый в интернет. Можно вставить приглашение
              veil://.
            </Text>
            <Field
              label="Адрес сервера или приглашение"
              value={server}
              onChangeText={setServer}
              placeholder="veil-relay.onrender.com"
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="url"
              returnKeyType="next"
              onSubmitEditing={() => void checkServer()}
              error={error?.field === 'server' ? error.text : undefined}
            />
            <Button title="Продолжить" onPress={() => void checkServer()} busy={checking} disabled={!server.trim()} />
          </View>
        )}

        {step === 'profile' && (
          <View style={styles.form}>
            <Text style={[styles.title, { color: t.text }]} accessibilityRole="header">
              Профиль
            </Text>
            {serverNote ? <Text style={[styles.ok, { color: t.mint }]}>{serverNote}</Text> : null}
            <Field label="Имя" value={displayName} onChangeText={setDisplayName} placeholder="Как вас называть" maxLength={64} textContentType="name" />
            <Field
              label="Имя пользователя"
              value={username}
              onChangeText={setUsername}
              placeholder="например, alice"
              autoCapitalize="none"
              autoCorrect={false}
              textContentType="username"
              hint="По нему вас находят. Латиница, цифры и «_»."
              error={error?.field === 'username' ? error.text : undefined}
            />
            <Field
              label="Пароль для входа"
              value={password}
              onChangeText={setPassword}
              secureTextEntry
              textContentType="newPassword"
              hint={password ? ['Очень слабый', 'Слабый', 'Средний', 'Хороший', 'Надёжный'][strength] : 'Не короче 8 символов. Восстановить его нельзя.'}
            />
            <Field
              label="Повторите пароль"
              value={password2}
              onChangeText={setPassword2}
              secureTextEntry
              textContentType="newPassword"
              returnKeyType="done"
              onSubmitEditing={() => void create()}
              error={error?.field === 'password' ? error.text : undefined}
            />
            {error && !error.field ? <Text style={{ color: t.danger, fontFamily: FONT.regular }}>{error.text}</Text> : null}
            <Button title="Создать аккаунт" onPress={() => void create()} disabled={!username || !password} />
          </View>
        )}

        {step === 'creating' && (
          <View style={styles.center}>
            <Logo size={64} />
            <Button title={progress} kind="ghost" busy onPress={() => {}} style={{ marginTop: 32 }} />
          </View>
        )}

        {step === 'biometry' && (
          <View style={styles.center}>
            <View style={[styles.face, { borderColor: t.mintLine, backgroundColor: t.mintSoft }]}>
              <ScanFace size={48} color={t.mint} strokeWidth={1.6} />
            </View>
            <Text style={[styles.title, { color: t.text, textAlign: 'center' }]}>Входить по {faceLabel}?</Text>
            <Text style={[styles.lead, { color: t.text2 }]}>
              Ключ хранилища ляжет в Keychain только этого телефона и откроется после проверки {faceLabel}. Пароль останется запасным способом.
            </Text>
            <View style={{ alignSelf: 'stretch', gap: 10, marginTop: 'auto' }}>
              <Button title={`Включить ${faceLabel}`} kind="mint" onPress={() => void enableFace()} />
              <Button title="Не сейчас" kind="ghost" onPress={() => created && onOpened(created)} />
            </View>
          </View>
        )}
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  wrap: { flexGrow: 1, paddingHorizontal: 24 },
  back: { width: 44, height: 44, justifyContent: 'center' },
  center: { flex: 1, alignItems: 'center', paddingTop: 60 },
  plate: { width: 116, height: 116, borderRadius: 30, borderWidth: 1, alignItems: 'center', justifyContent: 'center' },
  hero: { marginTop: 24, fontFamily: FONT.heavy, fontSize: 52, letterSpacing: -2 },
  lead: { marginTop: 8, fontFamily: FONT.regular, fontSize: 16, lineHeight: 23, textAlign: 'center' },
  points: { marginTop: 32, gap: 12, alignSelf: 'stretch', marginBottom: 32 },
  point: { flexDirection: 'row', gap: 10, alignItems: 'center' },
  pointText: { fontFamily: FONT.medium, fontSize: 15, flex: 1 },
  form: { gap: 16, paddingTop: 8 },
  title: { fontFamily: FONT.heavy, fontSize: 32, letterSpacing: -1 },
  ok: { fontFamily: FONT.semibold, fontSize: 14 },
  face: { width: 96, height: 96, borderRadius: 30, borderWidth: 1, alignItems: 'center', justifyContent: 'center', marginBottom: 24 },
});
