import {
  Bookmark,
  ChevronLeft,
  ChevronRight,
  Copy,
  CornerUpLeft,
  Download,
  Hourglass,
  Info,
  LockKeyhole,
  Paperclip,
  Phone,
  RotateCcw,
  ShieldCheck,
  Sticker,
  Trash2,
  TriangleAlert,
  X,
} from 'lucide-react';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type DragEvent, type MouseEvent, type ReactNode } from 'react';
import type { Messenger } from '../../../core/messenger.ts';
import { attachmentsOf, isSavedChat, MAX_ATTACHMENT_BYTES, QUICK_REACTIONS, type Attachment, type Contact, type Message, type MessengerSnapshot } from '../../../core/types.ts';
import { attachmentUrl, saveAttachment } from '../lib/attachments.ts';
import { formatDay, sameDay, systemText, timerLabel } from '../lib/format.ts';
import { copyImage, copyText, prepareFile } from '../lib/media.ts';
import { presenceText } from '../lib/text.ts';
import { Avatar, ContextMenu, useEscape, useToast, type MenuItem } from '../lib/ui.tsx';
import { AttachmentPreview } from './AttachmentPreview.tsx';
import { Bubble } from './Bubble.tsx';
import { Composer } from './Composer.tsx';

interface Props {
  messenger: Messenger;
  snapshot: MessengerSnapshot;
  contact: Contact;
  infoOpen: boolean;
  onToggleInfo(): void;
  onShowSafety(): void;
  onCall(contactId: string): void;
}

const GROUP_GAP_MS = 3 * 60 * 1000;

export function ChatView({ messenger, snapshot, contact, infoOpen, onToggleInfo, onShowSafety, onCall }: Props) {
  const saved = isSavedChat(contact.id);
  const messages = snapshot.conversations[contact.id] ?? [];
  const typing = !!snapshot.typing[contact.id];
  const online = !!snapshot.online[contact.id];
  const toast = useToast();
  const scroller = useRef<HTMLDivElement>(null);
  const inner = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);
  const [menu, setMenu] = useState<{ x: number; y: number; message: Message } | null>(null);
  const [lightbox, setLightbox] = useState<{ items: Attachment[]; index: number } | null>(null);
  const [dragging, setDragging] = useState(false);
  const [replyTo, setReplyTo] = useState<Message | null>(null);
  const [highlight, setHighlight] = useState<string | null>(null);
  const [pending, setPending] = useState<File[]>([]);
  const dragDepth = useRef(0);

  // Mark as read while the chat is visible and the window focused.
  useEffect(() => {
    const read = () => {
      if (document.hasFocus() && !document.hidden) messenger.markRead(contact.id);
    };
    read();
    window.addEventListener('focus', read);
    document.addEventListener('visibilitychange', read);
    return () => {
      window.removeEventListener('focus', read);
      document.removeEventListener('visibilitychange', read);
    };
  }, [messenger, contact.id, messages.length]);

  useLayoutEffect(() => {
    stickToBottom.current = true;
    const el = scroller.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [contact.id]);

  const lastOut = messages.at(-1)?.dir === 'out';
  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && (stickToBottom.current || lastOut)) el.scrollTop = el.scrollHeight;
  }, [messages.length, typing, lastOut]);

  // Keep pinned to the bottom while images decode and bubbles grow.
  useEffect(() => {
    const el = scroller.current;
    if (!el || !inner.current) return;
    const observer = new ResizeObserver(() => {
      if (stickToBottom.current) el.scrollTop = el.scrollHeight;
    });
    observer.observe(inner.current);
    return () => observer.disconnect();
  }, []);

  const onScroll = () => {
    const el = scroller.current;
    if (el) stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  };

  const queueFiles = useCallback(
    (files: File[]) => {
      const ok = files.filter((f) => {
        if (f.size > MAX_ATTACHMENT_BYTES) toast(`«${f.name}» больше 20 МБ`, 'error');
        return f.size <= MAX_ATTACHMENT_BYTES;
      });
      if (ok.length) setPending((list) => [...list, ...ok]);
    },
    [toast],
  );

  const sendPending = async (caption: string, compress: boolean) => {
    const files = pending;
    const reply = replyTo?.id;
    setPending([]);
    setReplyTo(null);
    try {
      const prepared = await Promise.all(files.map((f) => prepareFile(f, compress)));
      await messenger.sendMedia(contact.id, prepared, { caption, replyTo: reply });
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  };

  const copy = useCallback(
    async (message: Message) => {
      try {
        const images = attachmentsOf(message).filter((a) => a.kind === 'image' || a.kind === 'sticker');
        if (message.text) await copyText(message.text);
        else if (images.length) {
          const data = await messenger.getAttachment(images[0].id);
          if (!data) throw new Error('missing');
          await copyImage(data, images[0].mime);
        } else return;
        toast(message.text ? 'Текст скопирован' : 'Изображение скопировано', 'success');
      } catch {
        toast('Не удалось скопировать', 'error');
      }
    },
    [messenger, toast],
  );

  const onContext = useCallback((e: MouseEvent, message: Message) => {
    e.preventDefault();
    e.stopPropagation();
    setMenu({ x: e.clientX, y: e.clientY, message });
  }, []);
  const onOpenMedia = useCallback((message: Message, index: number) => {
    setLightbox({ items: attachmentsOf(message).filter((a) => a.kind === 'image'), index });
  }, []);
  const onRetry = useCallback((message: Message) => void messenger.retryMessage(contact.id, message.id), [messenger, contact.id]);
  const onReply = useCallback((message: Message) => setReplyTo(message), []);
  const onReact = useCallback(
    (message: Message, emoji: string) => void messenger.react(contact.id, message.id, emoji).catch(() => {}),
    [messenger, contact.id],
  );
  const onCopy = useCallback((message: Message) => void copy(message), [copy]);
  const onCallBack = useCallback(() => onCall(contact.id), [onCall, contact.id]);
  const onJump = useCallback((id: string) => {
    const el = document.getElementById(`msg-${id}`);
    if (!el) return;
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    setHighlight(id);
    setTimeout(() => setHighlight((h) => (h === id ? null : h)), 1600);
  }, []);

  const menuItems = useMemo<MenuItem[]>(() => {
    if (!menu) return [];
    const m = menu.message;
    if (m.call)
      return [
        { label: 'Позвонить', icon: <Phone size={16} />, onClick: () => onCall(contact.id) },
        { label: 'Удалить из истории', icon: <Trash2 size={16} />, danger: true, onClick: () => void messenger.deleteMessage(contact.id, m.id, false) },
      ];
    const atts = attachmentsOf(m);
    const items: MenuItem[] = [{ label: 'Ответить', icon: <CornerUpLeft size={16} />, onClick: () => setReplyTo(m) }];
    if (!saved && (m.text || atts.length))
      items.push({
        label: 'В избранное',
        icon: <Bookmark size={16} />,
        onClick: () =>
          void messenger
            .saveToFavorites(contact.id, m.id)
            .then(() => toast('Сохранено в «Избранное»', 'success'))
            .catch((e: Error) => toast(e.message, 'error')),
      });
    const selection = window.getSelection()?.toString().trim();
    if (selection) items.push({ label: 'Копировать выделенное', icon: <Copy size={16} />, onClick: () => void copyText(selection).then(() => toast('Скопировано', 'success')) });
    if (m.text) items.push({ label: 'Копировать текст', icon: <Copy size={16} />, onClick: () => void copy(m) });
    else if (atts.some((a) => a.kind === 'image' || a.kind === 'sticker'))
      items.push({ label: 'Копировать изображение', icon: <Copy size={16} />, onClick: () => void copy(m) });
    for (const att of atts.filter((a) => a.kind !== 'sticker'))
      items.push({ label: atts.length > 1 ? `Сохранить «${att.name}»` : 'Сохранить файл', icon: <Download size={16} />, onClick: () => void saveAttachment(messenger, att) });
    const sticker = atts.find((a) => a.kind === 'sticker' && a.sticker);
    if (sticker && !snapshot.stickers.some((s) => s.id === sticker.sticker))
      items.push({
        label: 'Сохранить в мои стикеры',
        icon: <Sticker size={16} />,
        onClick: () => void messenger.saveSticker(sticker).then(() => toast('Стикер сохранён', 'success')),
      });
    if (m.status === 'failed') items.push({ label: 'Отправить снова', icon: <RotateCcw size={16} />, onClick: () => onRetry(m) });
    items.push({ label: 'Удалить у меня', icon: <Trash2 size={16} />, danger: true, onClick: () => void messenger.deleteMessage(contact.id, m.id, false) });
    if (!saved && m.dir === 'out' && m.status !== 'failed' && m.status !== 'pending')
      items.push({ label: 'Удалить у всех', icon: <Trash2 size={16} />, danger: true, onClick: () => void messenger.deleteMessage(contact.id, m.id, true) });
    return items;
  }, [menu, messenger, contact.id, toast, onRetry, copy, snapshot.stickers, onCall, saved]);

  const onDragEnter = (e: DragEvent) => {
    if (!e.dataTransfer.types.includes('Files')) return;
    dragDepth.current++;
    setDragging(true);
  };
  const onDragLeave = () => {
    dragDepth.current = Math.max(0, dragDepth.current - 1);
    if (!dragDepth.current) setDragging(false);
  };
  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    dragDepth.current = 0;
    setDragging(false);
    if (e.dataTransfer.files.length) queueFiles([...e.dataTransfer.files]);
  };

  const rows: ReactNode[] = [];
  let previous: Message | undefined;
  let lastDay: number | undefined;
  messages.forEach((message, i) => {
    if (lastDay === undefined || !sameDay(lastDay, message.ts)) {
      rows.push(
        <div className="day-sep" key={`day-${message.id}`}>
          {formatDay(message.ts)}
        </div>,
      );
      lastDay = message.ts;
      previous = undefined;
    }
    if (message.dir === 'system') {
      const warn = message.sys?.kind === 'keychange';
      rows.push(
        <div className={`sys-msg${warn ? ' warn' : ''}`} key={message.id}>
          {warn ? <TriangleAlert size={13} /> : message.sys?.kind === 'timer' ? <Hourglass size={13} /> : <ShieldCheck size={13} />}
          {systemText(message, contact)}
        </div>,
      );
      previous = undefined;
      return;
    }
    const next = messages[i + 1];
    const continues = (a: Message | undefined, b: Message | undefined) =>
      !!a && !!b && !a.call && !b.call && a.dir === b.dir && b.ts - a.ts < GROUP_GAP_MS && sameDay(a.ts, b.ts);
    rows.push(
      <Bubble
        key={message.id}
        message={message}
        messenger={messenger}
        contactName={contact.displayName}
        groupStart={!continues(previous, message)}
        groupEnd={!continues(message, next)}
        highlighted={highlight === message.id}
        onContext={onContext}
        onOpenMedia={onOpenMedia}
        onRetry={onRetry}
        onReply={onReply}
        onReact={onReact}
        onCopy={onCopy}
        onJump={onJump}
        onCallBack={onCallBack}
      />,
    );
    previous = message;
  });

  const status = typing ? null : presenceText(contact, online);

  return (
    <section className="chat" onDragEnter={onDragEnter} onDragLeave={onDragLeave} onDragOver={(e) => e.preventDefault()} onDrop={onDrop}>
      <div className="chat-bg" />
      <header className="chat-header">
        <button className="who" onClick={onToggleInfo}>
          <span className="avatar-wrap">
            <Avatar name={contact.displayName} seed={contact.id} size={42} />
            {online && <i className="online-dot" />}
          </span>
          <div style={{ minWidth: 0 }}>
            <div className="name">
              {contact.displayName}
              {contact.verified && !saved && <ShieldCheck size={15} style={{ color: 'var(--success)' }} />}
            </div>
            {saved ? (
              <div className="sub">
                <LockKeyhole size={12} className="lock" />
                только на этом устройстве
              </div>
            ) : typing ? (
              <div className="sub typing">
                печатает
                <span className="typing-dots">
                  <i />
                  <i />
                  <i />
                </span>
              </div>
            ) : status ? (
              <div className={`sub${online ? ' online' : ''}`}>{status}</div>
            ) : (
              <div className="sub">
                <LockKeyhole size={12} className="lock" />
                {contact.username ? `@${contact.username} · ` : ''}защищено сквозным шифрованием
              </div>
            )}
          </div>
        </button>
        <div className="actions">
          {contact.timer > 0 && (
            <span className="timer-chip" title="Исчезающие сообщения">
              <Hourglass size={14} /> {timerLabel(contact.timer, true)}
            </span>
          )}
          {!saved && (
            <button className="icon-btn" onClick={() => onCall(contact.id)} aria-label="Позвонить" title="Аудиозвонок" disabled={contact.blocked}>
              <Phone size={19} />
            </button>
          )}
          <button className={`icon-btn${infoOpen ? ' active' : ''}`} onClick={onToggleInfo} aria-label="Информация о чате">
            <Info size={20} />
          </button>
        </div>
      </header>

      {contact.blocked && <div className="banner warn">Вы заблокировали этого пользователя. Сообщения от него не принимаются.</div>}

      <div className="messages" ref={scroller} onScroll={onScroll}>
        <div className="messages-inner" ref={inner}>
          <div className="messages-spacer" />
          {saved ? (
            <div className="e2e-card saved-card">
              <div className="icon">
                <Bookmark size={20} />
              </div>
              <b>Избранное</b>
              Сохраняйте сюда заметки, ссылки и файлы, а из других чатов — сообщения (правый клик → «В избранное»). Всё хранится
              зашифрованным только на этом компьютере и никуда не отправляется.
            </div>
          ) : (
            <div className="e2e-card">
              <div className="icon">
                <LockKeyhole size={20} />
              </div>
              <b>Сквозное шифрование</b>
              Сообщения и файлы шифруются на вашем устройстве. Прочитать их можете только вы и {contact.displayName} — даже сервер не видит
              содержимое.
              <button onClick={onShowSafety}>Проверить код безопасности</button>
            </div>
          )}
          {rows}
          {typing && (
            <div className="msg-row in group-start group-end">
              <div className="bubble" style={{ padding: '12px 14px' }}>
                <span className="typing-dots" style={{ color: 'var(--text-3)' }}>
                  <i />
                  <i />
                  <i />
                </span>
              </div>
            </div>
          )}
        </div>
      </div>

      {!contact.blocked && (
        <Composer
          messenger={messenger}
          contact={contact}
          settings={snapshot.settings}
          stickers={snapshot.stickers}
          replyTo={replyTo}
          onCancelReply={() => setReplyTo(null)}
          onFiles={queueFiles}
        />
      )}

      {dragging && (
        <div className="drop-zone">
          <div>
            <Paperclip size={32} />
            Отпустите, чтобы отправить в зашифрованном виде
          </div>
        </div>
      )}
      {pending.length > 0 && (
        <AttachmentPreview
          files={pending}
          onAdd={queueFiles}
          onRemove={(i) => setPending((list) => list.filter((_, j) => j !== i))}
          onClose={() => setPending([])}
          onSend={(caption, compress) => void sendPending(caption, compress)}
        />
      )}
      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          items={menuItems}
          onClose={() => setMenu(null)}
          header={
            !menu.message.call && (
              <div className="menu-reactions">
                {QUICK_REACTIONS.map((emoji) => (
                  <button
                    key={emoji}
                    aria-label={`Реакция ${emoji}`}
                    className={menu.message.reactions?.me === emoji ? 'active' : ''}
                    onClick={() => {
                      setMenu(null);
                      onReact(menu.message, emoji);
                    }}
                  >
                    {emoji}
                  </button>
                ))}
              </div>
            )
          }
        />
      )}
      {lightbox && <Lightbox messenger={messenger} items={lightbox.items} start={lightbox.index} onClose={() => setLightbox(null)} />}
    </section>
  );
}

function Lightbox({ messenger, items, start, onClose }: { messenger: Messenger; items: Attachment[]; start: number; onClose(): void }) {
  const [index, setIndex] = useState(start);
  const [url, setUrl] = useState<string | null>(null);
  const toast = useToast();
  const att = items[index];
  useEscape(onClose);
  useEffect(() => {
    let alive = true;
    setUrl(null);
    void attachmentUrl(messenger, att).then((u) => alive && setUrl(u));
    return () => {
      alive = false;
    };
  }, [messenger, att]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'ArrowLeft') setIndex((i) => Math.max(0, i - 1));
      if (e.key === 'ArrowRight') setIndex((i) => Math.min(items.length - 1, i + 1));
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [items.length]);
  const stop = (fn: () => void) => (e: MouseEvent) => {
    e.stopPropagation();
    fn();
  };
  return (
    <div className="lightbox" onClick={onClose}>
      {url && <img src={url} alt="" onClick={(e) => e.stopPropagation()} />}
      {items.length > 1 && (
        <>
          <span className="lightbox-count">
            {index + 1} / {items.length}
          </span>
          {index > 0 && (
            <button className="icon-btn nav prev" onClick={stop(() => setIndex(index - 1))} aria-label="Предыдущее">
              <ChevronLeft size={26} />
            </button>
          )}
          {index < items.length - 1 && (
            <button className="icon-btn nav next" onClick={stop(() => setIndex(index + 1))} aria-label="Следующее">
              <ChevronRight size={26} />
            </button>
          )}
        </>
      )}
      <div className="lightbox-actions">
        <button
          className="icon-btn"
          onClick={stop(() =>
            void messenger.getAttachment(att.id).then(async (data) => {
              if (data) await copyImage(data, att.mime);
              toast('Изображение скопировано', 'success');
            }),
          )}
          aria-label="Копировать"
        >
          <Copy size={19} />
        </button>
        <button className="icon-btn" onClick={stop(() => void saveAttachment(messenger, att))} aria-label="Сохранить">
          <Download size={20} />
        </button>
        <button className="icon-btn" onClick={onClose} aria-label="Закрыть">
          <X size={20} />
        </button>
      </div>
    </div>
  );
}
