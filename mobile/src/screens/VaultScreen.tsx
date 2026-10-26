// «Сейф»: «Избранное» of this iPhone — passwords, notes (also burning ones), links and files.
import * as Clipboard from 'expo-clipboard';
import { FileText, KeyRound, Link2, Lock, Plus, StickyNote } from 'lucide-react-native';
import { useEffect, useRef, useState } from 'react';
import { FlatList, KeyboardAvoidingView, Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { attachmentsOf, SAVED_ID, type Message } from '../../../src/core/types.ts';
import { formatSize, plural } from '../../../src/renderer/src/lib/format.ts';
import { useSession, useSnapshot } from '../state/session.tsx';
import { Button, Field, Segmented, useToast } from '../ui/kit.tsx';
import { FONT, RADIUS, useTheme } from '../ui/theme.ts';
import { TAB_BAR_SPACE } from './MainNavigator.tsx';

type Filter = 'all' | 'password' | 'note' | 'file';
const CLEAR_SECONDS = 30;

export function VaultScreen() {
  const t = useTheme();
  const insets = useSafeAreaInsets();
  const { messenger } = useSession();
  const snapshot = useSnapshot();
  const toast = useToast();
  const [filter, setFilter] = useState<Filter>('all');
  const [adding, setAdding] = useState<null | 'note' | 'password'>(null);
  const [title, setTitle] = useState('');
  const [text, setText] = useState('');
  const [burn, setBurn] = useState(false);
  const clearTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(clearTimer.current), []);

  const entries = (snapshot.conversations[SAVED_ID] ?? []).filter((m) => m.dir !== 'system');
  const kindOf = (m: Message): Filter => (attachmentsOf(m).length ? 'file' : m.note?.kind === 'password' ? 'password' : 'note');
  const shown = entries.filter((m) => filter === 'all' || kindOf(m) === filter).reverse();

  const copySecret = async (value: string) => {
    await Clipboard.setStringAsync(value);
    clearTimeout(clearTimer.current);
    clearTimer.current = setTimeout(() => {
      void Clipboard.getStringAsync().then((now) => now === value && Clipboard.setStringAsync(''));
    }, CLEAR_SECONDS * 1000);
    toast(`Скопировано · Veil очистит буфер через ${CLEAR_SECONDS} с`, 'success');
  };

  const save = () => {
    if (!text.trim()) return;
    messenger.addNote({ text, kind: adding === 'password' ? 'password' : undefined, ...(title.trim() ? { title: title.trim() } : {}), ...(burn ? { burnDays: 7 } : {}) });
    setAdding(null);
    setTitle('');
    setText('');
    setBurn(false);
  };

  const header = (
    <View style={{ gap: 14, paddingBottom: 4 }}>
      <View style={{ gap: 6 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
          <Lock size={12} color={t.mint} strokeWidth={2.4} />
          <Text style={{ fontFamily: FONT.mono, fontSize: 11, letterSpacing: 1, color: t.mint }}>ТОЛЬКО НА ЭТОМ IPHONE</Text>
        </View>
        <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
          <Text style={{ fontFamily: FONT.heavy, fontSize: 32, letterSpacing: -1, color: t.text }} accessibilityRole="header">
            Сейф
          </Text>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Добавить запись"
            onPress={() => setAdding(adding ? null : 'note')}
            style={[styles.add, { backgroundColor: t.ember }]}
          >
            <Plus size={20} color={t.emberInk} strokeWidth={2.4} />
          </Pressable>
        </View>
      </View>
      {adding && (
        <View style={[styles.form, { backgroundColor: t.surface, borderColor: t.line }]}>
          <Segmented<'note' | 'password'> label="Что добавить" value={adding} options={[['note', 'Заметка'], ['password', 'Пароль']]} onChange={setAdding} />
          {adding === 'password' && <Field label="Для чего" value={title} onChangeText={setTitle} placeholder="Wi-Fi на даче" />}
          <Field
            label={adding === 'password' ? 'Пароль' : 'Текст'}
            value={text}
            onChangeText={setText}
            secureTextEntry={adding === 'password'}
            multiline={adding === 'note'}
            autoCapitalize={adding === 'password' ? 'none' : 'sentences'}
            style={adding === 'note' ? { minHeight: 90, paddingTop: 12, textAlignVertical: 'top' } : undefined}
          />
          <Pressable accessibilityRole="checkbox" accessibilityState={{ checked: burn }} aria-checked={burn} onPress={() => setBurn(!burn)} style={styles.burn}>
            <View style={[styles.box, { borderColor: burn ? t.amber : t.line, backgroundColor: burn ? t.amber : 'transparent' }]} />
            <Text style={{ fontFamily: FONT.medium, fontSize: 14, color: t.text2 }}>Сгорит через 7 дней</Text>
          </Pressable>
          <Button title="Сохранить" onPress={save} disabled={!text.trim()} />
        </View>
      )}
      <Segmented<Filter>
        label="Фильтр"
        value={filter}
        options={[
          ['all', 'Всё'],
          ['password', 'Пароли'],
          ['note', 'Заметки'],
          ['file', 'Файлы'],
        ]}
        onChange={setFilter}
      />
    </View>
  );

  return (
    <KeyboardAvoidingView style={{ flex: 1, backgroundColor: t.bg }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <FlatList
        data={shown}
        keyExtractor={(m) => m.id}
        ListHeaderComponent={header}
        contentContainerStyle={{ paddingTop: insets.top + 14, paddingHorizontal: 18, paddingBottom: TAB_BAR_SPACE + insets.bottom, gap: 10 }}
        keyboardShouldPersistTaps="handled"
        ListEmptyComponent={
          <Text style={{ fontFamily: FONT.regular, fontSize: 14, color: t.muted, textAlign: 'center', marginTop: 24, lineHeight: 20 }}>
            Здесь хранится то, что нужно только вам: пароли, заметки, файлы. Ничего из этого не уходит на сервер.
          </Text>
        }
        renderItem={({ item }) => <Card message={item} onCopy={(v) => void copySecret(v)} />}
      />
    </KeyboardAvoidingView>
  );
}

function Card({ message, onCopy }: { message: Message; onCopy(value: string): void }) {
  const t = useTheme();
  const [shown, setShown] = useState(false);
  const atts = attachmentsOf(message);
  const burnsIn = message.expiresAt ? Math.max(1, Math.ceil((message.expiresAt - Date.now()) / 86_400_000)) : 0;
  if (atts.length) {
    return (
      <View style={[styles.card, styles.fileCard, { backgroundColor: t.surface, borderColor: t.line }]}>
        <View style={[styles.fileIcon, { backgroundColor: t.emberSoft }]}>
          <FileText size={20} color={t.ember} />
        </View>
        <View style={{ flex: 1 }}>
          <Text numberOfLines={1} style={{ fontFamily: FONT.bold, fontSize: 15, color: t.text }}>
            {atts.length > 1 ? `Файлы · ${atts.length}` : atts[0].name}
          </Text>
          <Text style={{ fontFamily: FONT.mono, fontSize: 12, color: t.muted }}>{formatSize(atts.reduce((n, a) => n + a.size, 0))}</Text>
        </View>
      </View>
    );
  }
  if (message.note?.kind === 'password') {
    return (
      <View style={[styles.card, { backgroundColor: t.surface, borderColor: t.mint, gap: 10 }]}>
        <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
            <KeyRound size={13} color={t.mint} />
            <Text style={[styles.eyebrow, { color: t.mint }]}>ПАРОЛЬ</Text>
          </View>
          <Text style={{ fontFamily: FONT.regular, fontSize: 13, color: t.muted }}>{message.note.title ?? ''}</Text>
        </View>
        <Text selectable={shown} style={{ fontFamily: FONT.mono, fontSize: 20, letterSpacing: shown ? 0 : 3, color: t.text }}>
          {shown ? message.text : '••••••••••••'}
        </Text>
        <View style={{ flexDirection: 'row', gap: 8 }}>
          <Button title={shown ? 'Скрыть' : 'Показать'} kind="ghost" onPress={() => setShown(!shown)} style={{ flex: 1, minHeight: 44 }} />
          <Button title="Копировать" kind="mint" onPress={() => onCopy(message.text ?? '')} style={{ flex: 1, minHeight: 44 }} />
        </View>
      </View>
    );
  }
  const link = message.note?.kind === 'link';
  return (
    <View style={[styles.card, burnsIn ? { backgroundColor: t.dark ? '#1F1A0C' : '#FFF6DD', borderColor: t.dark ? '#4A3A10' : '#E8D28A' } : { backgroundColor: t.surface, borderColor: t.line }]}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
        {link ? <Link2 size={13} color={t.muted} /> : <StickyNote size={13} color={burnsIn ? t.amber : t.muted} />}
        <Text style={[styles.eyebrow, { color: burnsIn ? t.amber : t.muted }]}>
          {burnsIn ? `СГОРИТ ЧЕРЕЗ ${burnsIn} ${plural(burnsIn, ['ДЕНЬ', 'ДНЯ', 'ДНЕЙ'])}` : link ? 'ССЫЛКА' : 'ЗАМЕТКА'}
        </Text>
      </View>
      <Text selectable style={{ marginTop: 6, fontFamily: FONT.medium, fontSize: 16, lineHeight: 23, color: t.text }}>
        {message.text}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  add: { width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center' },
  form: { borderRadius: RADIUS.card, borderWidth: 1, padding: 14, gap: 12 },
  burn: { flexDirection: 'row', alignItems: 'center', gap: 10, minHeight: 36 },
  box: { width: 20, height: 20, borderRadius: 6, borderWidth: 2 },
  card: { borderRadius: RADIUS.card, borderWidth: 1, padding: 16 },
  fileCard: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 14 },
  fileIcon: { width: 44, height: 44, borderRadius: 14, alignItems: 'center', justifyContent: 'center' },
  eyebrow: { fontFamily: FONT.mono, fontSize: 11, letterSpacing: 1 },
});
