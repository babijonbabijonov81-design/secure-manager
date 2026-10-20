import { Copy, Download, Hourglass, Info, LockKeyhole, Paperclip, RotateCcw, ShieldCheck, Trash2, TriangleAlert, X } from 'lucide-react';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type DragEvent, type MouseEvent, type ReactNode } from 'react';
import type { Messenger } from '../../../core/messenger.ts';
import { MAX_ATTACHMENT_BYTES, type Contact, type Message, type MessengerSnapshot } from '../../../core/types.ts';
import { readFile, saveAttachment } from '../lib/attachments.ts';
import { formatDay, sameDay, systemText, timerLabel } from '../lib/format.ts';
import { Avatar, ContextMenu, useEscape, useToast, type MenuItem } from '../lib/ui.tsx';
import { Bubble } from './Bubble.tsx';
import { Composer } from './Composer.tsx';

interface Props {
  messenger: Messenger;
  snapshot: MessengerSnapshot;
  contact: Contact;
  infoOpen: boolean;
  onToggleInfo(): void;
  onShowSafety(): void;
}

const GROUP_GAP_MS = 3 * 60 * 1000;

export function ChatView({ messenger, snapshot, contact, infoOpen, onToggleInfo, onShowSafety }: Props) {
  const messages = snapshot.conversations[contact.id] ?? [];
  const typing = !!snapshot.typing[contact.id];
  const toast = useToast();
  const scroller = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);
  const [menu, setMenu] = useState<{ x: number; y: number; message: Message } | null>(null);
  const [lightbox, setLightbox] = useState<{ url: string; message: Message } | null>(null);
  const [dragging, setDragging] = useState(false);
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
  const inner = useRef<HTMLDivElement>(null);
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

  const sendFiles = useCallback(
    async (files: File[]) => {
      for (const file of files) {
        if (file.size > MAX_ATTACHMENT_BYTES) {
          toast(`«${file.name}» больше 20 МБ`, 'error');
          continue;
        }
        try {
          await messenger.sendFile(contact.id, await readFile(file));
        } catch (e) {
          toast((e as Error).message, 'error');
        }
      }
    },
    [messenger, contact.id, toast],
  );

  const onContext = useCallback((e: MouseEvent, message: Message) => {
    e.preventDefault();
    setMenu({ x: e.clientX, y: e.clientY, message });
  }, []);
  const onOpenImage = useCallback((url: string, message: Message) => setLightbox({ url, message }), []);
  const onRetry = useCallback((message: Message) => void messenger.retryMessage(contact.id, message.id), [messenger, contact.id]);

  const menuItems = useMemo<MenuItem[]>(() => {
    if (!menu) return [];
    const m = menu.message;
    const items: MenuItem[] = [];
    if (m.text && !m.deleted)
      items.push({
        label: 'Копировать',
        icon: <Copy size={16} />,
        onClick: () => {
          void navigator.clipboard.writeText(m.text!);
          toast('Скопировано', 'success');
        },
      });
    if (m.att && !m.deleted) items.push({ label: 'Сохранить файл', icon: <Download size={16} />, onClick: () => void saveAttachment(messenger, m.att!) });
    if (m.status === 'failed') items.push({ label: 'Отправить снова', icon: <RotateCcw size={16} />, onClick: () => onRetry(m) });
    items.push({ label: 'Удалить у меня', icon: <Trash2 size={16} />, danger: true, onClick: () => void messenger.deleteMessage(contact.id, m.id, false) });
    if (m.dir === 'out' && !m.deleted && m.status !== 'failed' && m.status !== 'pending')
      items.push({ label: 'Удалить у всех', icon: <Trash2 size={16} />, danger: true, onClick: () => void messenger.deleteMessage(contact.id, m.id, true) });
    return items;
  }, [menu, messenger, contact.id, toast, onRetry]);

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
    if (e.dataTransfer.files.length) void sendFiles([...e.dataTransfer.files]);
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
      !!a && !!b && a.dir === b.dir && b.ts - a.ts < GROUP_GAP_MS && sameDay(a.ts, b.ts);
    rows.push(
      <Bubble
        key={message.id}
        message={message}
        messenger={messenger}
        groupStart={!continues(previous, message)}
        groupEnd={!continues(message, next)}
        onContext={onContext}
        onOpenImage={onOpenImage}
        onRetry={onRetry}
      />,
    );
    previous = message;
  });

  return (
    <section
      className="chat"
      onDragEnter={onDragEnter}
      onDragLeave={onDragLeave}
      onDragOver={(e) => e.preventDefault()}
      onDrop={onDrop}
    >
      <div className="chat-bg" />
      <header className="chat-header">
        <button className="who" onClick={onToggleInfo}>
          <Avatar name={contact.displayName} seed={contact.id} size={42} />
          <div style={{ minWidth: 0 }}>
            <div className="name">
              {contact.displayName}
              {contact.verified && <ShieldCheck size={15} style={{ color: 'var(--success)' }} />}
            </div>
            {typing ? (
              <div className="sub typing">
                печатает
                <span className="typing-dots">
                  <i />
                  <i />
                  <i />
                </span>
              </div>
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
          <button className={`icon-btn${infoOpen ? ' active' : ''}`} onClick={onToggleInfo} aria-label="Информация о чате">
            <Info size={20} />
          </button>
        </div>
      </header>

      {contact.blocked && <div className="banner warn">Вы заблокировали этого пользователя. Сообщения от него не принимаются.</div>}

      <div className="messages" ref={scroller} onScroll={onScroll}>
        <div className="messages-inner" ref={inner}>
          <div className="messages-spacer" />
          <div className="e2e-card">
            <div className="icon">
              <LockKeyhole size={20} />
            </div>
            <b>Сквозное шифрование</b>
            Сообщения и файлы шифруются на вашем устройстве. Прочитать их можете только вы и {contact.displayName} — даже сервер не видит
            содержимое.
            <button onClick={onShowSafety}>Проверить код безопасности</button>
          </div>
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
        <Composer messenger={messenger} contact={contact} enterToSend={snapshot.settings.enterToSend} onFiles={(f) => void sendFiles(f)} />
      )}

      {dragging && (
        <div className="drop-zone">
          <div>
            <Paperclip size={32} />
            Отпустите, чтобы отправить в зашифрованном виде
          </div>
        </div>
      )}
      {menu && <ContextMenu x={menu.x} y={menu.y} items={menuItems} onClose={() => setMenu(null)} />}
      {lightbox && <Lightbox url={lightbox.url} onSave={() => void saveAttachment(messenger, lightbox.message.att!)} onClose={() => setLightbox(null)} />}
    </section>
  );
}

function Lightbox({ url, onSave, onClose }: { url: string; onSave(): void; onClose(): void }) {
  useEscape(onClose);
  return (
    <div className="lightbox" onClick={onClose}>
      <img src={url} alt="" onClick={(e) => e.stopPropagation()} />
      <button
        className="icon-btn dl"
        onClick={(e) => {
          e.stopPropagation();
          onSave();
        }}
        aria-label="Сохранить"
      >
        <Download size={20} />
      </button>
      <button className="icon-btn" onClick={onClose} aria-label="Закрыть">
        <X size={20} />
      </button>
    </div>
  );
}
