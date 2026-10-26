// «Чаты»: the safe on top, then everyone, with the verified tick, unread count and timers.
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { Archive, Bookmark, Check, ChevronRight, Lock, Plus, Search, UserPlus } from 'lucide-react-native';
import { useEffect, useMemo, useState } from 'react';
import { FlatList, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { snippetOf } from '../../../src/core/messenger.ts';
import { isSavedChat, SAVED_ID, type Contact } from '../../../src/core/types.ts';
import { formatListTime, plural, timerChip } from '../../../src/renderer/src/lib/format.ts';
import { useSession, useSnapshot } from '../state/session.tsx';
import { Avatar, IconButton, Logo } from '../ui/kit.tsx';
import { FONT, RADIUS, useTheme } from '../ui/theme.ts';
import { TAB_BAR_SPACE } from './MainNavigator.tsx';
import type { RootStack } from './navigation.ts';

type View_ = 'chats' | 'requests' | 'archive';

export function ChatsScreen() {
  const t = useTheme();
  const insets = useSafeAreaInsets();
  const snapshot = useSnapshot();
  const { lock } = useSession();
  const navigation = useNavigation<NativeStackNavigationProp<RootStack>>();
  const [query, setQuery] = useState('');
  const [view, setView] = useState<View_>('chats');

  const listed = useMemo(() => snapshot.contacts.filter((c) => !isSavedChat(c.id) && !c.groupOnly && !c.hidden), [snapshot.contacts]);
  const requests = listed.filter((c) => c.request);
  const archived = listed.filter((c) => c.archived && !c.request);
  // The last request accepted (or archive emptied): back to the chats.
  useEffect(() => {
    if ((view === 'requests' && !requests.length) || (view === 'archive' && !archived.length)) setView('chats');
  }, [view, requests.length, archived.length]);
  const q = query.trim().toLowerCase().replace(/^@/, '');
  const shown = q
    ? listed.filter((c) => c.displayName.toLowerCase().includes(q) || c.username.toLowerCase().includes(q))
    : view === 'requests'
      ? requests
      : view === 'archive'
        ? archived
        : listed.filter((c) => !c.request && !c.archived);
  const saved = snapshot.conversations[SAVED_ID]?.filter((m) => m.dir !== 'system').length ?? 0;

  const header = (
    <View style={{ gap: 14, paddingBottom: 6 }}>
      <View style={styles.head}>
        <View style={styles.brand}>
          <Logo size={34} />
          <Text style={[styles.h1, { color: t.text }]} accessibilityRole="header">
            {view === 'requests' ? 'Запросы' : view === 'archive' ? 'Архив' : 'Чаты'}
          </Text>
        </View>
        <View style={{ flexDirection: 'row', gap: 8 }}>
          <IconButton label="Заблокировать" onPress={lock}>
            <Lock size={20} color={t.text} />
          </IconButton>
          <IconButton label="Новый чат" filled onPress={() => navigation.navigate('NewChat')}>
            <Plus size={20} color={t.emberInk} strokeWidth={2.4} />
          </IconButton>
        </View>
      </View>
      <View style={[styles.search, { backgroundColor: t.surface }]}>
        <Search size={18} color={t.muted} />
        <TextInput
          value={query}
          onChangeText={setQuery}
          placeholder="Поиск"
          placeholderTextColor={t.muted}
          accessibilityLabel="Поиск"
          autoCapitalize="none"
          autoCorrect={false}
          style={[styles.searchInput, { color: t.text }]}
        />
      </View>
      {view !== 'chats' && !q ? (
        <Pressable accessibilityRole="button" onPress={() => setView('chats')} style={styles.backRow}>
          <Text style={{ color: t.ember, fontFamily: FONT.semibold, fontSize: 15 }}>‹ Все чаты</Text>
        </Pressable>
      ) : null}
      {view === 'chats' && !q && (
        <>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Избранное, ${saved} ${plural(saved, ['запись', 'записи', 'записей'])}`}
            onPress={() => navigation.navigate('Tabs', { screen: 'Vault' })}
            style={({ pressed }) => [styles.safe, { backgroundColor: t.mintSoft, borderColor: t.mintLine, opacity: pressed ? 0.85 : 1 }]}
          >
            <View style={[styles.safeIcon, { backgroundColor: t.mint }]}>
              <Bookmark size={22} color="#0C0A09" strokeWidth={2.2} />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={[styles.name, { color: t.text }]}>Избранное</Text>
              <Text style={{ fontFamily: FONT.regular, fontSize: 13, color: t.mintText }}>
                {saved} {plural(saved, ['запись', 'записи', 'записей'])} · только на этом iPhone
              </Text>
            </View>
            <ChevronRight size={18} color={t.mintText} />
          </Pressable>
          {requests.length > 0 && (
            <ListLink icon={<UserPlus size={20} color={t.ember} />} title="Запросы на переписку" detail={requests.map((c) => c.displayName).join(', ')} count={requests.length} onPress={() => setView('requests')} />
          )}
          {archived.length > 0 && (
            <ListLink icon={<Archive size={20} color={t.muted} />} title="Архив" detail={archived.map((c) => c.displayName).join(', ')} count={archived.reduce((n, c) => n + c.unread, 0)} onPress={() => setView('archive')} />
          )}
        </>
      )}
      {view === 'requests' && (
        <Text style={[styles.note, { color: t.muted }]}>
          Эти люди написали первыми. Пока вы не примете запрос, они не видят «прочитано» и «в сети», а фото от них закрыты.
        </Text>
      )}
    </View>
  );

  return (
    <View style={{ flex: 1, backgroundColor: t.bg }}>
      <FlatList
        data={shown}
        keyExtractor={(c) => c.id}
        ListHeaderComponent={header}
        contentContainerStyle={{ paddingTop: insets.top + 12, paddingHorizontal: 8, paddingBottom: TAB_BAR_SPACE + insets.bottom }}
        keyboardShouldPersistTaps="handled"
        ListEmptyComponent={
          <Text style={[styles.note, { color: t.muted, textAlign: 'center', marginTop: 32 }]}>
            {q ? 'Никого не нашлось' : 'Пока ни одного чата. Нажмите «+» и введите имя пользователя собеседника.'}
          </Text>
        }
        renderItem={({ item, index }) => (
          <ChatRow contact={item} last={index === shown.length - 1} online={!!snapshot.online[item.id]} typing={!!snapshot.typing[item.id]} onPress={() => navigation.navigate('Chat', { id: item.id })} />
        )}
      />
    </View>
  );
}

function ListLink({ icon, title, detail, count, onPress }: { icon: React.ReactNode; title: string; detail: string; count: number; onPress(): void }) {
  const t = useTheme();
  return (
    <Pressable accessibilityRole="button" onPress={onPress} style={({ pressed }) => [styles.link, { backgroundColor: t.surface, borderColor: t.line, opacity: pressed ? 0.8 : 1 }]}>
      {icon}
      <View style={{ flex: 1 }}>
        <Text style={[styles.name, { color: t.text, fontSize: 15 }]}>{title}</Text>
        <Text numberOfLines={1} style={{ fontFamily: FONT.regular, fontSize: 13, color: t.muted }}>
          {detail}
        </Text>
      </View>
      {count > 0 && <Badge count={count} />}
    </Pressable>
  );
}

function Badge({ count }: { count: number }) {
  const t = useTheme();
  return (
    <View style={[styles.badge, { backgroundColor: t.ember }]}>
      <Text style={{ fontFamily: FONT.heavy, fontSize: 12, color: t.emberInk }}>{count > 99 ? '99+' : count}</Text>
    </View>
  );
}

function ChatRow({ contact, last, online, typing, onPress }: { contact: Contact; last: boolean; online: boolean; typing: boolean; onPress(): void }) {
  const t = useTheme();
  const snapshot = useSnapshot();
  const lastMessage = snapshot.conversations[contact.id]?.filter((m) => m.dir !== 'system').at(-1);
  const preview = typing ? 'печатает…' : lastMessage ? `${lastMessage.dir === 'out' ? 'Вы: ' : ''}${snippetOf(lastMessage)}` : contact.request ? 'Новый собеседник' : 'Нет сообщений';
  const when = lastMessage?.ts ?? contact.lastActivity;
  const missed = lastMessage?.call && lastMessage.dir === 'in' && lastMessage.call.status === 'missed';
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${contact.displayName}${contact.verified ? ', ключи сверены' : ''}${contact.unread ? `, ${contact.unread} непрочитанных` : ''}. ${preview}`}
      onPress={onPress}
      style={({ pressed }) => [styles.row, { backgroundColor: pressed ? t.surface : 'transparent' }]}
    >
      <View>
        <Avatar name={contact.displayName} seed={contact.id} photo={contact.avatar} dashed={contact.keyWarning} />
        {online && <View style={[styles.online, { backgroundColor: t.mint, borderColor: t.bg }]} />}
      </View>
      <View style={[styles.rowBody, !last && { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: t.surface2 }]}>
        <View style={styles.rowLine}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 5, flexShrink: 1 }}>
            <Text numberOfLines={1} style={[styles.name, { color: t.text, flexShrink: 1 }]}>
              {contact.displayName}
            </Text>
            {contact.verified && <Check size={14} color={t.mint} strokeWidth={2.6} />}
          </View>
          <Text style={{ fontFamily: FONT.mono, fontSize: 12, color: contact.unread ? t.ember : t.muted }}>{formatListTime(when)}</Text>
        </View>
        <View style={[styles.rowLine, { marginTop: 4 }]}>
          <Text
            numberOfLines={1}
            style={{
              flex: 1,
              fontFamily: FONT.regular,
              fontSize: 14,
              color: contact.keyWarning ? t.amber : missed ? '#FF8A8D' : typing ? t.mint : t.muted,
            }}
          >
            {contact.keyWarning ? 'Ключ изменился — сверить' : preview}
          </Text>
          {contact.timer > 0 && <Text style={{ fontFamily: FONT.mono, fontSize: 11, color: t.amber }}>{timerChip(contact.timer)}</Text>}
          {contact.unread > 0 && <Badge count={contact.unread} />}
        </View>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  head: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 10 },
  brand: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  h1: { fontFamily: FONT.heavy, fontSize: 32, letterSpacing: -1 },
  search: { marginHorizontal: 10, flexDirection: 'row', alignItems: 'center', gap: 10, height: 44, borderRadius: RADIUS.field, paddingHorizontal: 14 },
  searchInput: { flex: 1, fontFamily: FONT.regular, fontSize: 16, height: 44 },
  safe: { marginHorizontal: 10, flexDirection: 'row', alignItems: 'center', gap: 14, padding: 16, borderRadius: RADIUS.card, borderWidth: 1 },
  safeIcon: { width: 48, height: 48, borderRadius: 16, alignItems: 'center', justifyContent: 'center' },
  link: { marginHorizontal: 10, flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 16, paddingVertical: 12, borderRadius: 18, borderWidth: 1 },
  backRow: { paddingHorizontal: 10, minHeight: 32, justifyContent: 'center' },
  note: { fontFamily: FONT.regular, fontSize: 13, lineHeight: 18, paddingHorizontal: 12 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 10, paddingTop: 12, borderRadius: 18 },
  rowBody: { flex: 1, paddingBottom: 12 },
  rowLine: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
  name: { fontFamily: FONT.bold, fontSize: 16 },
  online: { position: 'absolute', right: 1, bottom: 1, width: 13, height: 13, borderRadius: 7, borderWidth: 2 },
  badge: { minWidth: 22, height: 22, borderRadius: 11, paddingHorizontal: 6, alignItems: 'center', justifyContent: 'center' },
});
