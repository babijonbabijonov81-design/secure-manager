// «Звонки»: the call history from all chats. Calling from the iPhone (CallKit) comes in a later version.
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { Phone, PhoneIncoming, PhoneMissed, PhoneOutgoing } from 'lucide-react-native';
import { useMemo } from 'react';
import { FlatList, Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { callTitle } from '../../../src/core/messenger.ts';
import type { Contact, Message } from '../../../src/core/types.ts';
import { formatCallDuration, formatListTime } from '../../../src/renderer/src/lib/format.ts';
import { useSnapshot } from '../state/session.tsx';
import { Avatar } from '../ui/kit.tsx';
import { FONT, RADIUS, useTheme } from '../ui/theme.ts';
import { TAB_BAR_SPACE } from './MainNavigator.tsx';
import type { RootStack } from './navigation.ts';

export function CallsScreen() {
  const t = useTheme();
  const insets = useSafeAreaInsets();
  const snapshot = useSnapshot();
  const navigation = useNavigation<NativeStackNavigationProp<RootStack>>();
  const calls = useMemo(() => {
    const byId = new Map(snapshot.contacts.map((c) => [c.id, c]));
    const out: { message: Message; contact: Contact }[] = [];
    for (const [id, list] of Object.entries(snapshot.conversations)) {
      const contact = byId.get(id);
      if (!contact) continue;
      for (const message of list) if (message.call) out.push({ message, contact });
    }
    return out.sort((a, b) => b.message.ts - a.message.ts).slice(0, 200);
  }, [snapshot.conversations, snapshot.contacts]);

  return (
    <FlatList
      style={{ backgroundColor: t.bg }}
      data={calls}
      keyExtractor={(c) => c.message.id}
      contentContainerStyle={{ paddingTop: insets.top + 14, paddingHorizontal: 18, paddingBottom: TAB_BAR_SPACE + insets.bottom, gap: 6 }}
      ListHeaderComponent={
        <View style={{ gap: 12, marginBottom: 8 }}>
          <Text style={{ fontFamily: FONT.heavy, fontSize: 32, letterSpacing: -1, color: t.text }} accessibilityRole="header">
            Звонки
          </Text>
          <View style={[styles.note, { backgroundColor: t.surface, borderColor: t.line }]}>
            <Phone size={18} color={t.ember} />
            <Text style={{ flex: 1, fontFamily: FONT.regular, fontSize: 14, lineHeight: 20, color: t.text2 }}>
              Звонки с iPhone появятся в следующей версии — как обычные, через CallKit, с теми же защитой и словами-сверкой. Пока звоните с компьютера.
            </Text>
          </View>
        </View>
      }
      ListEmptyComponent={<Text style={{ fontFamily: FONT.regular, fontSize: 14, color: t.muted, textAlign: 'center', marginTop: 20 }}>Звонков пока не было</Text>}
      renderItem={({ item: { message, contact } }) => {
        const missed = message.call?.status === 'missed' && message.dir === 'in';
        const Icon = missed ? PhoneMissed : message.dir === 'in' ? PhoneIncoming : PhoneOutgoing;
        return (
          <Pressable accessibilityRole="button" onPress={() => navigation.navigate('Chat', { id: contact.id })} style={({ pressed }) => [styles.row, { opacity: pressed ? 0.7 : 1 }]}>
            <Avatar name={contact.displayName} seed={contact.id} photo={contact.avatar} size={46} />
            <View style={{ flex: 1 }}>
              <Text style={{ fontFamily: FONT.bold, fontSize: 16, color: t.text }}>{contact.displayName}</Text>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                <Icon size={14} color={missed ? '#FF8A8D' : t.muted} />
                <Text style={{ fontFamily: FONT.regular, fontSize: 13, color: missed ? '#FF8A8D' : t.muted }}>
                  {callTitle(message)}
                  {message.call?.dur ? ` · ${formatCallDuration(message.call.dur)}` : ''}
                </Text>
              </View>
            </View>
            <Text style={{ fontFamily: FONT.mono, fontSize: 12, color: t.muted }}>{formatListTime(message.ts)}</Text>
          </Pressable>
        );
      }}
    />
  );
}

const styles = StyleSheet.create({
  note: { flexDirection: 'row', gap: 12, padding: 14, borderRadius: RADIUS.card, borderWidth: 1 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 64 },
});
