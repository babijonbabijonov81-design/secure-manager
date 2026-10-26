// «Новый чат»: by @name, or by a veil:// invite (then both sides are verified at once).
import { X } from 'lucide-react-native';
import { useState } from 'react';
import { KeyboardAvoidingView, Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useSession } from '../state/session.tsx';
import { Button, Field } from '../ui/kit.tsx';
import { FONT, useTheme } from '../ui/theme.ts';
import type { StackProps } from './navigation.ts';

export function NewChatScreen({ navigation }: StackProps<'NewChat'>) {
  const t = useTheme();
  const insets = useSafeAreaInsets();
  const { messenger } = useSession();
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const invite = /veil:\/\//i.test(value);

  const open = async () => {
    setError('');
    setBusy(true);
    try {
      const contact = invite ? await messenger.acceptInvite(value.trim()) : await messenger.addContact(value.trim());
      navigation.replace('Chat', { id: contact.id });
    } catch (e) {
      setError((e as Error).message || 'Не получилось');
    } finally {
      setBusy(false);
    }
  };

  return (
    <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={{ flex: 1, backgroundColor: t.bg }}>
      <View style={[styles.wrap, { paddingTop: Platform.OS === 'ios' ? 18 : insets.top + 12, paddingBottom: insets.bottom + 18 }]}>
        <View style={styles.head}>
          <Text style={[styles.title, { color: t.text }]} accessibilityRole="header">
            Новый чат
          </Text>
          <Pressable accessibilityRole="button" accessibilityLabel="Закрыть" onPress={() => navigation.goBack()} hitSlop={10} style={styles.close}>
            <X size={22} color={t.text} />
          </Pressable>
        </View>
        <Field
          label="Имя пользователя или приглашение"
          value={value}
          onChangeText={setValue}
          placeholder="@anna или veil://add/…"
          autoCapitalize="none"
          autoCorrect={false}
          autoFocus
          returnKeyType="go"
          onSubmitEditing={() => void open()}
          error={error || undefined}
          hint={
            invite
              ? 'В приглашении — отпечаток ключа собеседника: если ключ совпадёт, контакт сразу будет сверен.'
              : 'Собеседник должен быть на том же сервере, что и вы.'
          }
        />
        <Button title={invite ? 'Добавить по приглашению' : 'Найти и открыть чат'} onPress={() => void open()} busy={busy} disabled={!value.trim()} />
        <Text style={[styles.note, { color: t.muted }]}>Сервер видит только, что вы ищете это имя. Что вы напишете — не видит.</Text>
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  wrap: { flex: 1, paddingHorizontal: 20, gap: 18 },
  head: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  title: { fontFamily: FONT.heavy, fontSize: 26, letterSpacing: -0.5 },
  close: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  note: { fontFamily: FONT.regular, fontSize: 13, lineHeight: 18 },
});
