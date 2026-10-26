// About a chat: the shield, the safety number to compare, disappearing messages, the wallpaper.
import { Check, ShieldAlert, ShieldCheck, ShieldQuestion, X } from 'lucide-react-native';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { formatSafetyNumber } from '../../../src/core/crypto/fingerprint.ts';
import { TIMER_OPTIONS } from '../../../src/core/types.ts';
import { timerLabel } from '../../../src/renderer/src/lib/format.ts';
import { chatShield } from '../../../src/renderer/src/lib/shield.ts';
import { presenceText } from '../../../src/renderer/src/lib/text.ts';
import { useSession, useSnapshot } from '../state/session.tsx';
import { Avatar, Button, Section, useToast } from '../ui/kit.tsx';
import { FONT, useTheme } from '../ui/theme.ts';
import { WallpaperPicker } from '../ui/WallpaperPicker.tsx';
import type { StackProps } from './navigation.ts';

export function ChatInfoScreen({ route, navigation }: StackProps<'ChatInfo'>) {
  const t = useTheme();
  const insets = useSafeAreaInsets();
  const { messenger } = useSession();
  const snapshot = useSnapshot();
  const toast = useToast();
  const contact = snapshot.contacts.find((c) => c.id === route.params.id);
  if (!contact) return null;
  const shield = chatShield(contact, snapshot, messenger.iceServers.hasTurn);
  const groups = formatSafetyNumber(messenger.safetyNumber(contact.id));
  const presence = presenceText(contact, !!snapshot.online[contact.id], snapshot.settings);
  // On the iPhone a screenshot cannot be forbidden — the shield says so (hiding on screen recording comes next).
  const items = shield.items.map((item) => (item.id === 'screen' ? { ...item, title: 'Скрытие при записи экрана', value: 'в следующей версии', state: 'na' as const } : item));

  return (
    <ScrollView style={{ flex: 1, backgroundColor: t.bg }} contentContainerStyle={{ padding: 18, paddingBottom: insets.bottom + 30, gap: 22 }}>
      <View style={styles.head}>
        <Pressable accessibilityRole="button" accessibilityLabel="Закрыть" onPress={() => navigation.goBack()} hitSlop={10} style={styles.close}>
          <X size={22} color={t.text} />
        </Pressable>
      </View>
      <View style={{ alignItems: 'center', gap: 6 }}>
        <Avatar name={contact.displayName} seed={contact.id} photo={contact.avatar} size={96} />
        <Text style={{ fontFamily: FONT.heavy, fontSize: 24, color: t.text, marginTop: 6 }}>{contact.displayName}</Text>
        {contact.username ? <Text style={{ fontFamily: FONT.mono, fontSize: 13, color: t.muted }}>@{contact.username}</Text> : null}
        {presence ? <Text style={{ fontFamily: FONT.medium, fontSize: 13, color: snapshot.online[contact.id] ? t.mint : t.muted }}>{presence}</Text> : null}
      </View>

      <Section title={`Щит чата · ${shield.score}/${shield.total}`}>
        {items.map((item, i) => (
          <View key={item.id} style={[styles.shieldRow, i < items.length - 1 && { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: t.line }]}>
            <Text style={{ flex: 1, fontFamily: FONT.medium, fontSize: 15, color: t.text }}>{item.title}</Text>
            <Text style={{ fontFamily: FONT.semibold, fontSize: 14, color: item.state === 'ok' ? t.mint : item.state === 'alert' ? t.danger : item.state === 'na' ? t.muted : t.amber }}>
              {item.value}
            </Text>
          </View>
        ))}
      </Section>

      <Section
        title="Код безопасности"
        footer="Сравните эти цифры с собеседником лично или по телефону. Если они совпадают — никто не подменил ключи, и переписку не может прочитать посредник."
      >
        <View style={{ padding: 16, gap: 14 }}>
          <View style={styles.digits} accessibilityLabel={`Код безопасности: ${groups.join(' ')}`}>
            {groups.map((g, i) => (
              <Text key={i} style={[styles.group, { color: contact.verified ? t.mint : t.text, backgroundColor: t.bg }]}>
                {g}
              </Text>
            ))}
          </View>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
            {contact.verified ? <ShieldCheck size={18} color={t.mint} /> : contact.keyWarning ? <ShieldAlert size={18} color={t.danger} /> : <ShieldQuestion size={18} color={t.amber} />}
            <Text style={{ fontFamily: FONT.semibold, fontSize: 14, color: contact.verified ? t.mint : contact.keyWarning ? t.danger : t.amber }}>
              {contact.verified ? 'Ключи сверены' : contact.keyWarning ? 'Ключ изменился' : 'Ключи не сверены'}
            </Text>
          </View>
          {contact.verified ? (
            <Button title="Снять отметку" kind="ghost" onPress={() => messenger.setVerified(contact.id, false)} />
          ) : (
            <Button
              title="Цифры совпадают"
              kind="mint"
              icon={<Check size={18} color="#0C0A09" strokeWidth={2.6} />}
              onPress={() => {
                messenger.setVerified(contact.id, true);
                toast('Ключи сверены', 'success');
              }}
            />
          )}
        </View>
      </Section>

      <Section title="Исчезающие сообщения" footer="Новые сообщения удалятся у обоих через выбранное время.">
        <View style={styles.timers}>
          {TIMER_OPTIONS.map((seconds) => {
            const on = contact.timer === seconds;
            return (
              <Pressable
                key={seconds}
                accessibilityRole="radio"
                accessibilityState={{ checked: on }}
            aria-checked={on}
                onPress={() => void messenger.setTimer(contact.id, seconds).catch((e) => toast((e as Error).message, 'error'))}
                style={[styles.timer, { borderColor: on ? t.amber : t.line, backgroundColor: on ? t.surface2 : 'transparent' }]}
              >
                <Text style={{ fontFamily: on ? FONT.bold : FONT.medium, fontSize: 14, color: on ? t.amber : t.text2 }}>{timerLabel(seconds, true)}</Text>
              </Pressable>
            );
          })}
        </View>
      </Section>

      <Section title="Обои этого чата" footer="Только на этом iPhone, собеседник их не видит.">
        <View style={{ padding: 14 }}>
          <WallpaperPicker messenger={messenger} scope={contact.id} current={contact.wallpaper} inherited={!!snapshot.settings.wallpaper} />
        </View>
      </Section>

      <View style={{ gap: 10 }}>
        <Button title={contact.blocked ? 'Разблокировать' : 'Заблокировать'} kind="danger" onPress={() => messenger.setBlocked(contact.id, !contact.blocked)} />
        <Button
          title="Удалить чат"
          kind="danger"
          onPress={() =>
            void messenger.deleteChat(contact.id).then(() => {
              navigation.popToTop();
            })
          }
        />
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  head: { flexDirection: 'row', justifyContent: 'flex-end' },
  close: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  shieldRow: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 16, minHeight: 50 },
  digits: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, justifyContent: 'space-between' },
  group: { width: '23%', textAlign: 'center', fontFamily: 'JetBrainsMono_600SemiBold', fontSize: 17, paddingVertical: 8, borderRadius: 10, overflow: 'hidden' },
  timers: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, padding: 14 },
  timer: { minHeight: 40, paddingHorizontal: 14, borderRadius: 12, borderWidth: 1, alignItems: 'center', justifyContent: 'center' },
});
