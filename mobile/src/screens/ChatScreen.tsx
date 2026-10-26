// «Переписка»: the shield and presence in the header, bubbles on the chat's wallpaper, quick
// reactions on a long press, and the composer with a photo button.
import { useFocusEffect } from '@react-navigation/native';
import { Check, CheckCheck, ChevronLeft, Clock, CornerUpLeft, FileText, Film, Hourglass, Image as ImageIcon, Mic, Phone, Plus, SendHorizontal, Shield, ShieldAlert, ShieldCheck, Sticker, TriangleAlert, X } from 'lucide-react-native';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { FlatList, Image, KeyboardAvoidingView, Modal, Platform, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { snippetOf } from '../../../src/core/messenger.ts';
import { attachmentsOf, isSavedChat, QUICK_REACTIONS, type Attachment, type Contact, type Message } from '../../../src/core/types.ts';
import { formatDay, formatTime, sameDay, systemText, timerLabel } from '../../../src/renderer/src/lib/format.ts';
import { chatShield } from '../../../src/renderer/src/lib/shield.ts';
import { presenceText } from '../../../src/renderer/src/lib/text.ts';
import { pickPhoto } from '../platform/pictures.ts';
import { useSession, useSnapshot } from '../state/session.tsx';
import { Avatar, dataUri, IconButton, useToast } from '../ui/kit.tsx';
import { FONT, RADIUS, useTheme } from '../ui/theme.ts';
import { ChatBackground, wallpaperOf } from '../ui/Wallpaper.tsx';
import type { StackProps } from './navigation.ts';

type Item = { kind: 'day'; key: string; ts: number } | { kind: 'msg'; key: string; message: Message };

export function ChatScreen({ route, navigation }: StackProps<'Chat'>) {
  const t = useTheme();
  const insets = useSafeAreaInsets();
  const { messenger } = useSession();
  const snapshot = useSnapshot();
  const toast = useToast();
  const contact = snapshot.contacts.find((c) => c.id === route.params.id);
  const messages = snapshot.conversations[route.params.id];
  const [text, setText] = useState(contact?.draft ?? '');
  const [replyTo, setReplyTo] = useState<Message | null>(null);
  const [picked, setPicked] = useState<Message | null>(null);
  const [focused, setFocused] = useState(false);

  useFocusEffect(
    useCallback(() => {
      setFocused(true);
      return () => setFocused(false);
    }, []),
  );
  // Read while the chat is on screen (a stranger's request gets no receipts — the core sees to that).
  useEffect(() => {
    if (focused && contact) messenger.markRead(contact.id);
  }, [focused, messages?.length, contact, messenger]);
  useEffect(() => () => contact && messenger.setDraft(contact.id, text.trim() ? text : ''), [contact?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const items = useMemo<Item[]>(() => {
    const out: Item[] = [];
    let previous: Message | undefined;
    for (const message of messages ?? []) {
      if (!previous || !sameDay(previous.ts, message.ts)) out.push({ kind: 'day', key: `day-${message.ts}`, ts: message.ts });
      out.push({ kind: 'msg', key: message.id, message });
      previous = message;
    }
    return out.reverse();
  }, [messages]);

  if (!contact) {
    navigation.goBack();
    return null;
  }

  const saved = isSavedChat(contact.id);
  const online = !!snapshot.online[contact.id];
  const typing = !!snapshot.typing[contact.id];
  const shield = saved ? null : chatShield(contact, snapshot, messenger.iceServers.hasTurn);
  const ShieldIcon = shield?.level === 'alert' ? ShieldAlert : shield?.level === 'ok' ? ShieldCheck : Shield;
  const status = typing ? 'печатает…' : presenceText(contact, online, snapshot.settings);
  const wall = wallpaperOf(snapshot.settings, contact);

  const send = async () => {
    const body = text.trim();
    if (!body) return;
    setText('');
    messenger.sendTyping(contact.id, false);
    const reply = replyTo?.id;
    setReplyTo(null);
    try {
      await messenger.sendText(contact.id, body, reply ? { replyTo: reply } : {});
    } catch (e) {
      setText(body);
      toast((e as Error).message, 'error');
    }
  };

  const sendPhoto = async () => {
    try {
      const photo = await pickPhoto();
      if (!photo) return;
      await messenger.sendMedia(contact.id, [{ name: 'photo.jpg', mime: 'image/jpeg', data: photo.data, w: photo.width, h: photo.height }], replyTo ? { replyTo: replyTo.id } : {});
      setReplyTo(null);
    } catch (e) {
      toast((e as Error).message || 'Не удалось отправить фото', 'error');
    }
  };

  return (
    <View style={{ flex: 1, backgroundColor: t.bg }}>
      <ChatBackground messenger={messenger} wallpaper={wall.wallpaper} scope={wall.scope} />
      <View style={[styles.header, { paddingTop: insets.top + 6, backgroundColor: t.bg, borderBottomColor: t.line }]}>
        <Pressable accessibilityRole="button" accessibilityLabel="Назад к чатам" onPress={() => navigation.goBack()} style={styles.back} hitSlop={6}>
          <ChevronLeft size={26} color={t.ember} strokeWidth={2.4} />
        </Pressable>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`${contact.displayName}: о чате и сверка ключей`}
          onPress={() => !saved && navigation.navigate('ChatInfo', { id: contact.id })}
          style={styles.who}
        >
          <Avatar name={contact.displayName} seed={contact.id} photo={contact.avatar} size={42} />
          <View style={{ flex: 1 }}>
            <Text numberOfLines={1} style={{ fontFamily: FONT.bold, fontSize: 16, color: t.text }}>
              {contact.displayName}
            </Text>
            {shield ? (
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
                <ShieldIcon size={12} color={shield.level === 'ok' ? t.mint : shield.level === 'alert' ? t.danger : t.amber} strokeWidth={2.6} />
                <Text numberOfLines={1} style={{ fontFamily: FONT.medium, fontSize: 12, color: typing || online ? t.mint : t.muted }}>
                  щит {shield.score}/{shield.total}
                  {status ? ` · ${status}` : ''}
                </Text>
              </View>
            ) : (
              <Text style={{ fontFamily: FONT.medium, fontSize: 12, color: t.mintText }}>только на этом iPhone</Text>
            )}
          </View>
        </Pressable>
        {!saved && (
          <IconButton label="Звонки — пока с компьютера" onPress={() => toast('Звонки с iPhone появятся в следующей версии. Пока звоните с компьютера', 'info')} style={{ borderWidth: 0, backgroundColor: 'transparent' }}>
            <Phone size={20} color={t.text} />
          </IconButton>
        )}
      </View>

      {contact.keyWarning && (
        <Pressable accessibilityRole="button" onPress={() => navigation.navigate('ChatInfo', { id: contact.id })} style={[styles.banner, { backgroundColor: t.surface, borderColor: t.amber }]}>
          <TriangleAlert size={18} color={t.amber} />
          <Text style={{ flex: 1, fontFamily: FONT.medium, fontSize: 14, color: t.text }}>Ключ собеседника изменился. Сверьте код безопасности.</Text>
        </Pressable>
      )}

      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <FlatList
          inverted
          data={items}
          keyExtractor={(item) => item.key}
          contentContainerStyle={{ paddingHorizontal: 12, paddingVertical: 14, gap: 8 }}
          keyboardDismissMode="interactive"
          renderItem={({ item }) =>
            item.kind === 'day' ? (
              <Text style={[styles.day, { color: t.text2, backgroundColor: t.surface }]}>{formatDay(item.ts)}</Text>
            ) : (
              <Bubble message={item.message} contact={contact} onLongPress={() => item.message.dir !== 'system' && setPicked(item.message)} />
            )
          }
        />

        {contact.request && (
          <View style={[styles.request, { backgroundColor: t.surface, borderColor: t.line }]}>
            <Text style={{ fontFamily: FONT.medium, fontSize: 14, color: t.text, lineHeight: 20 }}>
              <Text style={{ fontFamily: FONT.bold }}>@{contact.username || contact.displayName} пишет вам впервые.</Text> Пока вы не примете запрос или не ответите, собеседник не видит «прочитано» и «в сети», а фото закрыты.
            </Text>
            <View style={{ flexDirection: 'row', gap: 8 }}>
              <SmallButton title="Принять" kind="primary" onPress={() => messenger.acceptRequest(contact.id)} />
              <SmallButton title="Заблокировать" kind="danger" onPress={() => messenger.setBlocked(contact.id, true)} />
              <SmallButton title="Удалить" kind="ghost" onPress={() => void messenger.deleteChat(contact.id).then(() => navigation.goBack())} />
            </View>
          </View>
        )}

        <View style={[styles.composerWrap, { paddingBottom: Math.max(insets.bottom, 10), backgroundColor: t.bg, borderTopColor: t.line }]}>
          {contact.timer > 0 && (
            <View style={styles.timerLine}>
              <Hourglass size={13} color={t.amber} />
              <Text style={{ fontFamily: FONT.medium, fontSize: 12, color: t.amber }}>Сообщения исчезнут через {timerLabel(contact.timer)}</Text>
            </View>
          )}
          {replyTo && (
            <View style={[styles.reply, { borderLeftColor: t.ember, backgroundColor: t.surface }]}>
              <CornerUpLeft size={16} color={t.ember} />
              <Text numberOfLines={1} style={{ flex: 1, fontFamily: FONT.regular, fontSize: 13, color: t.text2 }}>
                {snippetOf(replyTo) || 'Сообщение'}
              </Text>
              <Pressable accessibilityRole="button" accessibilityLabel="Отменить ответ" onPress={() => setReplyTo(null)} hitSlop={10}>
                <X size={16} color={t.muted} />
              </Pressable>
            </View>
          )}
          <View style={styles.composer}>
            <IconButton label="Отправить фото" onPress={() => void sendPhoto()} style={{ borderWidth: 0, backgroundColor: t.surface2 }}>
              <Plus size={20} color={t.text} strokeWidth={2.2} />
            </IconButton>
            <View style={[styles.inputWrap, { backgroundColor: t.surface, borderColor: t.line }]}>
              <TextInput
                value={text}
                onChangeText={(value) => {
                  setText(value);
                  if (!saved) messenger.sendTyping(contact.id, !!value);
                }}
                placeholder={saved ? 'Заметка для себя' : 'Сообщение'}
                placeholderTextColor={t.muted}
                accessibilityLabel="Сообщение"
                multiline
                style={[styles.input, { color: t.text }]}
              />
            </View>
            <IconButton label="Отправить" filled onPress={() => void send()} style={{ opacity: text.trim() ? 1 : 0.5 }}>
              <SendHorizontal size={20} color={t.emberInk} />
            </IconButton>
          </View>
        </View>
      </KeyboardAvoidingView>

      <MessageMenu
        message={picked}
        contact={contact}
        onClose={() => setPicked(null)}
        onReply={(m) => setReplyTo(m)}
        onReact={(m, e) => void messenger.react(contact.id, m.id, e).catch((err) => toast((err as Error).message, 'error'))}
        onDelete={(m, all) => void messenger.deleteMessage(contact.id, m.id, all)}
      />
    </View>
  );
}

function SmallButton({ title, kind, onPress }: { title: string; kind: 'primary' | 'danger' | 'ghost'; onPress(): void }) {
  const t = useTheme();
  const look = { primary: [t.ember, t.emberInk, t.ember], danger: ['transparent', t.danger, t.line], ghost: ['transparent', t.text2, t.line] }[kind];
  return (
    <Pressable accessibilityRole="button" onPress={onPress} style={({ pressed }) => [styles.small, { backgroundColor: look[0], borderColor: look[2], opacity: pressed ? 0.8 : 1 }]}>
      <Text style={{ fontFamily: FONT.bold, fontSize: 14, color: look[1] }}>{title}</Text>
    </Pressable>
  );
}

function StatusMark({ message }: { message: Message }) {
  const t = useTheme();
  const color = t.emberInk;
  if (message.status === 'read') return <CheckCheck size={14} color={color} accessibilityLabel="Прочитано" />;
  if (message.status === 'delivered') return <CheckCheck size={14} color={color} style={{ opacity: 0.6 }} accessibilityLabel="Доставлено" />;
  if (message.status === 'sent') return <Check size={14} color={color} style={{ opacity: 0.6 }} accessibilityLabel="Отправлено" />;
  if (message.status === 'failed') return <TriangleAlert size={14} color={color} accessibilityLabel="Не отправлено" />;
  return <Clock size={13} color={color} style={{ opacity: 0.6 }} accessibilityLabel="Отправляется" />;
}

function Bubble({ message, contact, onLongPress }: { message: Message; contact: Contact; onLongPress(): void }) {
  const t = useTheme();
  if (message.dir === 'system') {
    return <Text style={[styles.system, { color: t.muted }]}>{systemText(message, contact) || snippetOf(message)}</Text>;
  }
  const out = message.dir === 'out';
  const atts = attachmentsOf(message);
  const images = atts.filter((a) => a.kind === 'image');
  const other = atts.filter((a) => a.kind !== 'image');
  const fg = out ? t.emberInk : t.text;
  const reactions = [message.reactions?.them, message.reactions?.me].filter(Boolean) as string[];
  const closed = contact.request && !out;
  return (
    <View style={{ alignItems: out ? 'flex-end' : 'flex-start' }}>
      <Pressable
        onLongPress={onLongPress}
        delayLongPress={280}
        accessibilityHint="Удерживайте для реакций и ответа"
        style={[
          styles.bubble,
          out
            ? { backgroundColor: t.ember, borderTopRightRadius: RADIUS.bubbleTail }
            : { backgroundColor: t.bubbleIn, borderTopLeftRadius: RADIUS.bubbleTail, borderWidth: 1, borderColor: t.line },
          images.length > 0 && { padding: 0, overflow: 'hidden', width: 250 },
        ]}
      >
        {message.reply && (
          <View style={[styles.quote, { borderLeftColor: out ? t.emberInk : t.ember }, images.length > 0 && { margin: 10, marginBottom: 0 }]}>
            <Text style={{ fontFamily: FONT.bold, fontSize: 12, color: fg }}>{message.reply.out ? 'Вы' : contact.displayName}</Text>
            <Text numberOfLines={1} style={{ fontFamily: FONT.regular, fontSize: 12, color: fg, opacity: 0.85 }}>
              {message.reply.text || 'Сообщение'}
            </Text>
          </View>
        )}
        {images.map((att) => (closed ? <Closed key={att.id} /> : <Photo key={att.id} att={att} />))}
        {other.map((att) => (
          <AttachmentChip key={att.id} att={att} message={message} color={fg} />
        ))}
        {message.text ? <Text style={[styles.text, { color: fg }, images.length > 0 && { paddingHorizontal: 13, paddingTop: 9 }]}>{message.text}</Text> : null}
        <View style={[styles.meta, images.length > 0 && { paddingHorizontal: 12, paddingBottom: 8 }]}>
          {message.expiresAt ? <Hourglass size={11} color={out ? t.emberInk : t.amber} /> : null}
          <Text style={{ fontFamily: FONT.mono, fontSize: 11, color: fg, opacity: 0.7 }}>{formatTime(message.ts)}</Text>
          {out && <StatusMark message={message} />}
        </View>
      </Pressable>
      {reactions.length > 0 && (
        <View style={[styles.reactions, { backgroundColor: t.surface2, borderColor: t.line }]}>
          <Text style={{ fontSize: 14 }}>{reactions.join(' ')}</Text>
        </View>
      )}
    </View>
  );
}

function Closed() {
  const t = useTheme();
  return (
    <View style={{ padding: 18, alignItems: 'center' }}>
      <Text style={{ fontFamily: FONT.regular, fontSize: 13, color: t.muted, textAlign: 'center' }}>Фото откроется, когда вы примете запрос</Text>
    </View>
  );
}

function Photo({ att }: { att: Attachment }) {
  const { messenger } = useSession();
  const t = useTheme();
  const [uri, setUri] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    void messenger.getAttachment(att.id).then((bytes) => alive && bytes && setUri(dataUri(bytes, att.mime)));
    return () => {
      alive = false;
    };
  }, [messenger, att.id, att.mime]);
  const ratio = att.w && att.h ? Math.min(1.6, Math.max(0.6, att.h / att.w)) : 0.75;
  return (
    <View style={{ width: 250, height: 250 * ratio, backgroundColor: t.surface2 }}>
      {uri && <Image source={{ uri }} style={{ width: '100%', height: '100%' }} resizeMode="cover" accessibilityLabel="Фото" />}
    </View>
  );
}

function AttachmentChip({ att, message, color }: { att: Attachment; message: Message; color: string }) {
  const Icon = att.kind === 'voice' ? Mic : att.kind === 'circle' ? Film : att.kind === 'sticker' ? Sticker : att.mime.startsWith('image/') ? ImageIcon : FileText;
  const label = att.kind === 'file' ? att.name : snippetOf({ ...message, text: undefined, atts: [att] });
  return (
    <View style={styles.chip}>
      <Icon size={18} color={color} />
      <View style={{ flexShrink: 1 }}>
        <Text numberOfLines={1} style={{ fontFamily: FONT.semibold, fontSize: 14, color }}>
          {label}
        </Text>
        {att.kind !== 'file' && <Text style={{ fontFamily: FONT.regular, fontSize: 11, color, opacity: 0.75 }}>Откройте на компьютере — на iPhone скоро</Text>}
      </View>
    </View>
  );
}

function MessageMenu({
  message,
  contact,
  onClose,
  onReply,
  onReact,
  onDelete,
}: {
  message: Message | null;
  contact: Contact;
  onClose(): void;
  onReply(m: Message): void;
  onReact(m: Message, emoji: string): void;
  onDelete(m: Message, forEveryone: boolean): void;
}) {
  const t = useTheme();
  const insets = useSafeAreaInsets();
  if (!message) return null;
  const saved = isSavedChat(contact.id);
  const act = (fn: () => void) => () => {
    fn();
    onClose();
  };
  return (
    <Modal transparent animationType="fade" visible onRequestClose={onClose}>
      <Pressable style={[StyleSheet.absoluteFill, { backgroundColor: 'rgba(0,0,0,0.45)' }]} onPress={onClose} accessibilityLabel="Закрыть" />
      <View style={[styles.sheet, { backgroundColor: t.surface, borderColor: t.line, paddingBottom: insets.bottom + 16 }]}>
        {!saved && (
          <View style={[styles.reactionBar, { backgroundColor: t.surface2, borderColor: t.line }]}>
            {QUICK_REACTIONS.map((emoji) => (
              <Pressable
                key={emoji}
                accessibilityRole="button"
                accessibilityLabel={`Реакция ${emoji}`}
                onPress={act(() => onReact(message, emoji))}
                style={[styles.reaction, message.reactions?.me === emoji && { backgroundColor: t.emberSoft }]}
              >
                <Text style={{ fontSize: 22 }}>{emoji}</Text>
              </Pressable>
            ))}
          </View>
        )}
        {!saved && <MenuRow icon={<CornerUpLeft size={20} color={t.text} />} title="Ответить" onPress={act(() => onReply(message))} />}
        <MenuRow icon={<X size={20} color={t.danger} />} title="Удалить у меня" danger onPress={act(() => onDelete(message, false))} />
        {!saved && message.dir === 'out' && <MenuRow icon={<X size={20} color={t.danger} />} title="Удалить у всех" danger onPress={act(() => onDelete(message, true))} />}
      </View>
    </Modal>
  );
}

function MenuRow({ icon, title, onPress, danger }: { icon: React.ReactNode; title: string; onPress(): void; danger?: boolean }) {
  const t = useTheme();
  return (
    <Pressable accessibilityRole="button" onPress={onPress} style={({ pressed }) => [styles.menuRow, { opacity: pressed ? 0.7 : 1 }]}>
      {icon}
      <Text style={{ fontFamily: FONT.semibold, fontSize: 16, color: danger ? t.danger : t.text }}>{title}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  header: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 8, paddingBottom: 10, borderBottomWidth: StyleSheet.hairlineWidth },
  back: { width: 40, height: 44, alignItems: 'center', justifyContent: 'center' },
  who: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 10 },
  banner: { flexDirection: 'row', alignItems: 'center', gap: 10, margin: 10, marginBottom: 0, padding: 12, borderRadius: 16, borderWidth: 1 },
  day: { alignSelf: 'center', fontFamily: FONT.semibold, fontSize: 12, borderRadius: 999, paddingHorizontal: 12, paddingVertical: 5, overflow: 'hidden', marginVertical: 4 },
  system: { alignSelf: 'center', textAlign: 'center', fontFamily: FONT.regular, fontSize: 12, paddingHorizontal: 24 },
  bubble: { maxWidth: '82%', borderRadius: RADIUS.bubble, paddingHorizontal: 13, paddingVertical: 9 },
  text: { fontFamily: FONT.medium, fontSize: 16, lineHeight: 22 },
  meta: { flexDirection: 'row', alignItems: 'center', alignSelf: 'flex-end', gap: 4, marginTop: 3 },
  quote: { borderLeftWidth: 3, paddingLeft: 8, marginBottom: 5 },
  chip: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 4 },
  reactions: { marginTop: -6, marginHorizontal: 10, paddingHorizontal: 8, paddingVertical: 2, borderRadius: 999, borderWidth: 1 },
  request: { margin: 10, padding: 14, borderRadius: 18, borderWidth: 1, gap: 10 },
  small: { minHeight: 40, paddingHorizontal: 14, borderRadius: 12, borderWidth: 1, alignItems: 'center', justifyContent: 'center' },
  composerWrap: { paddingHorizontal: 12, paddingTop: 8, borderTopWidth: StyleSheet.hairlineWidth, gap: 8 },
  timerLine: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6 },
  reply: { flexDirection: 'row', alignItems: 'center', gap: 8, borderLeftWidth: 3, borderRadius: 10, paddingHorizontal: 10, paddingVertical: 8 },
  composer: { flexDirection: 'row', alignItems: 'flex-end', gap: 8 },
  inputWrap: { flex: 1, minHeight: 44, borderRadius: 22, borderWidth: 1, paddingHorizontal: 14, justifyContent: 'center' },
  input: { fontFamily: FONT.regular, fontSize: 16, maxHeight: 120, paddingTop: Platform.OS === 'ios' ? 11 : 6, paddingBottom: Platform.OS === 'ios' ? 11 : 6 },
  sheet: { position: 'absolute', left: 0, right: 0, bottom: 0, borderTopLeftRadius: 28, borderTopRightRadius: 28, borderWidth: 1, padding: 16, gap: 4 },
  reactionBar: { flexDirection: 'row', justifyContent: 'space-between', borderRadius: 999, borderWidth: 1, padding: 4, marginBottom: 10 },
  reaction: { width: 46, height: 46, borderRadius: 23, alignItems: 'center', justifyContent: 'center' },
  menuRow: { flexDirection: 'row', alignItems: 'center', gap: 14, minHeight: 52, paddingHorizontal: 6 },
});
