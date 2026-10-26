// «Ещё»: my profile and photo (and who sees it), wallpapers, theme, Face ID, auto-lock, the server.
import Constants from 'expo-constants';
import { Camera, Trash2 } from 'lucide-react-native';
import { useEffect, useState } from 'react';
import { KeyboardAvoidingView, Platform, ScrollView, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { fingerprintOf } from '../../../src/core/messenger.ts';
import type { AvatarVisibility } from '../../../src/core/types.ts';
import { biometry, forgetBiometricKey, hasBiometricKey, saveBiometricKey, type Biometry } from '../platform/keychain';
import { pickAvatar } from '../platform/pictures.ts';
import { usePrefs } from '../state/prefsContext.ts';
import { useSession, useSnapshot } from '../state/session.tsx';
import { Avatar, Button, Field, Row, Section, Segmented, Toggle, useToast } from '../ui/kit.tsx';
import { FONT, useTheme, type ThemeChoice } from '../ui/theme.ts';
import { WallpaperPicker } from '../ui/WallpaperPicker.tsx';
import { TAB_BAR_SPACE } from './MainNavigator.tsx';

const STATUS: Record<string, string> = { online: 'подключено', connecting: 'подключаемся…', offline: 'нет связи' };

export function MoreScreen() {
  const t = useTheme();
  const insets = useSafeAreaInsets();
  const { messenger, lock } = useSession();
  const snapshot = useSnapshot();
  const { prefs, update } = usePrefs();
  const toast = useToast();
  const [name, setName] = useState(snapshot.me.displayName);
  const [bio, setBio] = useState<Biometry | null>(null);
  const [faceOn, setFaceOn] = useState(false);

  useEffect(() => {
    void Promise.all([biometry(), hasBiometricKey()]).then(([b, kept]) => {
      setBio(b);
      setFaceOn(kept);
    });
  }, []);

  const changePhoto = async () => {
    try {
      const picture = await pickAvatar();
      if (!picture) return;
      await messenger.setAvatar(picture);
      toast('Фото обновлено', 'success');
    } catch (e) {
      toast((e as Error).message || 'Не удалось открыть фото', 'error');
    }
  };

  const toggleFace = async (on: boolean) => {
    try {
      if (on) await saveBiometricKey(messenger.quickUnlockKey());
      else await forgetBiometricKey();
      setFaceOn(await hasBiometricKey());
    } catch {
      toast(`Не удалось включить ${bio?.label ?? 'Face ID'}`, 'error');
    }
  };

  const photos = snapshot.settings.features.avatars !== false;
  const version = Constants.expoConfig?.version ?? '';

  return (
    <KeyboardAvoidingView style={{ flex: 1, backgroundColor: t.bg }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <ScrollView contentContainerStyle={{ paddingTop: insets.top + 14, paddingHorizontal: 18, paddingBottom: TAB_BAR_SPACE + insets.bottom, gap: 22 }} keyboardShouldPersistTaps="handled">
        <Text style={{ fontFamily: FONT.heavy, fontSize: 32, letterSpacing: -1, color: t.text }} accessibilityRole="header">
          Ещё
        </Text>

        <View style={{ alignItems: 'center', gap: 6 }}>
          <Avatar name={snapshot.me.displayName} seed={snapshot.me.userId} photo={photos ? snapshot.me.avatar : undefined} photoId="me" size={96} />
          <Text style={{ fontFamily: FONT.heavy, fontSize: 22, color: t.text, marginTop: 6 }}>{snapshot.me.displayName}</Text>
          <Text style={{ fontFamily: FONT.mono, fontSize: 13, color: t.muted }}>@{snapshot.me.username}</Text>
          {photos && (
            <View style={{ flexDirection: 'row', gap: 8, marginTop: 8 }}>
              <Button title={snapshot.me.avatar ? 'Сменить фото' : 'Добавить фото'} kind="secondary" icon={<Camera size={17} color={t.text} />} onPress={() => void changePhoto()} style={{ minHeight: 44 }} />
              {snapshot.me.avatar && (
                <Button
                  title="Удалить"
                  kind="ghost"
                  icon={<Trash2 size={17} color={t.text} />}
                  onPress={() => void messenger.setAvatar(null).then(() => toast('Фото удалено', 'success'))}
                  style={{ minHeight: 44 }}
                />
              )}
            </View>
          )}
        </View>

        {photos && (
          <Section
            title="Кто видит фото"
            footer="Фото уходит собеседникам внутри зашифрованных сообщений, сервер его не видит. Если убрать доступ, у них фото исчезнет, но кто-то мог успеть его сохранить."
          >
            <View style={{ padding: 12 }}>
              <Segmented<AvatarVisibility>
                label="Кто видит фото"
                value={snapshot.settings.avatarVisibility}
                options={[
                  ['chats', 'Всем собеседникам'],
                  ['verified', 'Сверенным'],
                  ['nobody', 'Никому'],
                ]}
                onChange={(value) => messenger.updateSettings({ avatarVisibility: value })}
              />
            </View>
          </Section>
        )}

        <Section title="Имя" footer="Передаётся собеседникам внутри зашифрованных сообщений, сервер его не знает.">
          <View style={{ padding: 12, gap: 10 }}>
            <Field label="Отображаемое имя" value={name} onChangeText={setName} maxLength={64} />
            <Button
              title="Сохранить"
              kind="secondary"
              disabled={!name.trim() || name.trim() === snapshot.me.displayName}
              onPress={() => void messenger.updateProfile(name).then(() => toast('Имя обновлено', 'success'))}
            />
          </View>
        </Section>

        {snapshot.settings.features.wallpapers !== false && (
          <Section title="Обои всех чатов" footer="Только на этом iPhone, собеседник их не видит. Для одного чата — в его карточке.">
            <View style={{ padding: 14 }}>
              <WallpaperPicker messenger={messenger} scope="all" current={snapshot.settings.wallpaper} />
            </View>
          </Section>
        )}

        <Section title="Оформление">
          <View style={{ padding: 12 }}>
            <Segmented<ThemeChoice>
              label="Тема"
              value={prefs.theme}
              options={[
                ['system', 'Как в iOS'],
                ['dark', 'Тёмная'],
                ['light', 'Светлая'],
              ]}
              onChange={(theme) => update({ theme })}
            />
          </View>
        </Section>

        <Section title="Защита" footer="Ключ хранилища лежит в Keychain только этого iPhone и открывается после проверки лица или пальца.">
          {bio?.available && <Row title={`Вход по ${bio.label}`} detail="Пароль остаётся запасным способом" right={<Toggle label={`Вход по ${bio.label}`} value={faceOn} onChange={(v) => void toggleFace(v)} />} />}
          <View style={{ padding: 12, gap: 8 }}>
            <Text style={{ fontFamily: FONT.semibold, fontSize: 14, color: t.text2 }}>Закрывать Veil в фоне</Text>
            <Segmented<'0' | '1' | '5'>
              label="Закрывать Veil в фоне"
              value={String(prefs.lockAfter) as '0' | '1' | '5'}
              options={[
                ['0', 'Сразу'],
                ['1', 'Через 1 мин'],
                ['5', 'Через 5 мин'],
              ]}
              onChange={(v) => update({ lockAfter: Number(v) as 0 | 1 | 5 })}
            />
          </View>
          <Row title="Заблокировать сейчас" onPress={lock} last />
        </Section>

        <Section title="Сервер">
          <Row title={snapshot.me.serverUrl} detail={STATUS[snapshot.status] ?? snapshot.status} />
          <Row title="Ключ сервера" detail={snapshot.me.serverKey ? fingerprintOf(snapshot.me.serverKey) : 'сервер не прислал ключ'} last />
        </Section>

        <Section title="Ключ личности" footer="Публичный ключ Ed25519. Приватный ключ никогда не покидает этот iPhone.">
          <Text selectable style={{ padding: 14, fontFamily: FONT.mono, fontSize: 12, color: t.text2 }}>
            {snapshot.me.userId}
          </Text>
        </Section>

        <Text style={{ textAlign: 'center', fontFamily: FONT.regular, fontSize: 12, color: t.muted }}>Veil для iPhone {version} · открытый исходный код</Text>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}
