import {
  Archive,
  ArchiveRestore,
  ArrowLeft,
  Bell,
  BellOff,
  Check,
  CheckCheck,
  Clock,
  Eraser,
  MailOpen,
  MessageSquarePlus,
  MoreVertical,
  Pin,
  PinOff,
  Search,
  ShieldCheck,
  Trash2,
  TriangleAlert,
} from 'lucide-react';
import { forwardRef, useMemo, useState, type MouseEvent } from 'react';
import { snippetOf, type Messenger } from '../../../core/messenger.ts';
import { isSavedChat, type Contact, type Message, type MessengerSnapshot } from '../../../core/types.ts';
import { formatListTime, systemText } from '../lib/format.ts';
import { veiledFor } from '../lib/hooks.ts';
import { Avatar, ConfirmDialog, ContextMenu, type MenuItem } from '../lib/ui.tsx';

interface Props {
  messenger: Messenger;
  snapshot: MessengerSnapshot;
  activeId: string | null;
  onSelect(id: string): void;
  onNewChat(): void;
  onDeleted(id: string): void;
}

export const ChatList = forwardRef<HTMLInputElement, Props>(function ChatList(
  { messenger, snapshot, activeId, onSelect, onNewChat, onDeleted },
  searchRef,
) {
  const [query, setQuery] = useState('');
  const [showArchive, setShowArchive] = useState(false);
  const [menu, setMenu] = useState<{ x: number; y: number; contact: Contact } | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<Contact | null>(null);

  const archived = snapshot.contacts.filter((c) => c.archived);
  const contacts = useMemo(() => {
    const q = query.trim().toLowerCase().replace(/^@/, '');
    if (q) return snapshot.contacts.filter((c) => c.displayName.toLowerCase().includes(q) || c.username.toLowerCase().includes(q));
    return snapshot.contacts.filter((c) => !!c.archived === showArchive);
  }, [snapshot.contacts, query, showArchive]);
  const archivedUnread = archived.reduce((n, c) => n + c.unread, 0);

  const openMenu = (e: MouseEvent, contact: Contact) => {
    e.preventDefault();
    e.stopPropagation();
    setMenu({ x: e.clientX, y: e.clientY, contact });
  };

  const menuItems = (c: Contact): MenuItem[] => isSavedChat(c.id) ? savedMenuItems(c) : contactMenuItems(c);
  const savedMenuItems = (c: Contact): MenuItem[] => [
    ...(!c.archived
      ? [{ label: c.pinned ? 'Открепить' : 'Закрепить', icon: c.pinned ? <PinOff size={16} /> : <Pin size={16} />, onClick: () => messenger.setPinned(c.id, !c.pinned) }]
      : []),
    {
      label: c.archived ? 'Вернуть из архива' : 'В архив',
      icon: c.archived ? <ArchiveRestore size={16} /> : <Archive size={16} />,
      onClick: () => messenger.setArchived(c.id, !c.archived),
    },
    { label: 'Очистить', icon: <Eraser size={16} />, danger: true, onClick: () => setConfirmDelete(c) },
  ];
  const contactMenuItems = (c: Contact): MenuItem[] => [
    ...(!c.archived
      ? [{ label: c.pinned ? 'Открепить' : 'Закрепить', icon: c.pinned ? <PinOff size={16} /> : <Pin size={16} />, onClick: () => messenger.setPinned(c.id, !c.pinned) }]
      : []),
    {
      label: c.archived ? 'Вернуть из архива' : 'В архив',
      icon: c.archived ? <ArchiveRestore size={16} /> : <Archive size={16} />,
      onClick: () => messenger.setArchived(c.id, !c.archived),
    },
    { label: c.muted ? 'Включить звук' : 'Без звука', icon: c.muted ? <Bell size={16} /> : <BellOff size={16} />, onClick: () => messenger.setMuted(c.id, !c.muted) },
    ...(c.unread ? [{ label: 'Отметить прочитанным', icon: <MailOpen size={16} />, onClick: () => messenger.markRead(c.id) }] : []),
    { label: 'Удалить чат', icon: <Trash2 size={16} />, danger: true, onClick: () => setConfirmDelete(c) },
  ];

  return (
    <aside className="sidebar">
      <div className="sidebar-head">
        <div className="sidebar-title">
          {showArchive && !query ? (
            <>
              <button className="icon-btn" onClick={() => setShowArchive(false)} aria-label="Назад к чатам">
                <ArrowLeft size={20} />
              </button>
              <h2 style={{ flex: 1, marginLeft: 6 }}>Архив</h2>
            </>
          ) : (
            <>
              <h2>Чаты</h2>
              <button className="icon-btn" onClick={onNewChat} aria-label="Новый чат" title="Новый чат (Ctrl+N)">
                <MessageSquarePlus size={20} />
              </button>
            </>
          )}
        </div>
        <div className="input-wrap search">
          <Search size={16} />
          <input
            ref={searchRef}
            className="input"
            placeholder="Поиск"
            aria-label="Поиск чатов"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') setQuery('');
              if (e.key === 'Enter' && contacts[0]) onSelect(contacts[0].id);
            }}
          />
        </div>
      </div>
      <div className="chat-list" role="list">
        {!showArchive && !query && archived.length > 0 && (
          <button className="chat-item archive-row" onClick={() => setShowArchive(true)}>
            <div className="archive-icon">
              <Archive size={22} />
            </div>
            <div className="body">
              <div className="row">
                <span className="name">Архив</span>
              </div>
              <div className="row">
                <span className="preview">{archived.map((c) => c.displayName).join(', ')}</span>
                {archivedUnread > 0 && <span className="badge muted">{archivedUnread}</span>}
              </div>
            </div>
          </button>
        )}
        {contacts.map((contact) => (
          <ChatItem
            key={contact.id}
            contact={contact}
            last={lastMessage(snapshot.conversations[contact.id])}
            typing={!!snapshot.typing[contact.id]}
            online={!!snapshot.online[contact.id]}
            active={contact.id === activeId}
            veiled={veiledFor(snapshot.settings, contact)}
            onClick={() => onSelect(contact.id)}
            onMenu={(e) => openMenu(e, contact)}
          />
        ))}
        {snapshot.contacts.length === 0 && (
          <div className="empty-list">
            <div className="art">
              <MessageSquarePlus size={34} />
            </div>
            <b>Пока нет чатов</b>
            <span>Найдите собеседника по имени пользователя и начните защищённую переписку.</span>
            <button className="btn btn-primary btn-sm" onClick={onNewChat} style={{ marginTop: 6 }}>
              Найти собеседника
            </button>
          </div>
        )}
        {snapshot.contacts.length > 0 && contacts.length === 0 && (
          <div className="empty-list">
            <span>{query ? 'Ничего не найдено' : showArchive ? 'Архив пуст' : 'Все чаты в архиве'}</span>
          </div>
        )}
      </div>
      {menu && <ContextMenu x={menu.x} y={menu.y} items={menuItems(menu.contact)} onClose={() => setMenu(null)} />}
      {confirmDelete && (
        <ConfirmDialog
          title={isSavedChat(confirmDelete.id) ? 'Очистить «Избранное»?' : 'Удалить чат?'}
          text={
            isSavedChat(confirmDelete.id)
              ? 'Все заметки и файлы в «Избранном» будут удалены с этого устройства.'
              : `Переписка с ${confirmDelete.displayName} и ключи сеанса будут удалены с этого устройства.`
          }
          confirm={isSavedChat(confirmDelete.id) ? 'Очистить' : 'Удалить'}
          danger
          onClose={() => setConfirmDelete(null)}
          onConfirm={async () => {
            await messenger.deleteChat(confirmDelete.id);
            if (!isSavedChat(confirmDelete.id)) onDeleted(confirmDelete.id);
          }}
        />
      )}
    </aside>
  );
});

const lastMessage = (messages: Message[] | undefined) => {
  if (!messages) return undefined;
  for (let i = messages.length - 1; i >= 0; i--) if (messages[i].dir !== 'system') return messages[i];
  return messages.at(-1);
};

function StatusTicks({ message }: { message: Message }) {
  if (message.dir !== 'out' || message.call || !message.status) return null;
  if (message.status === 'pending') return <Clock size={14} className="ticks" style={{ color: 'var(--text-3)' }} />;
  if (message.status === 'failed') return <TriangleAlert size={14} className="ticks" style={{ color: 'var(--danger)' }} />;
  if (message.status === 'sent') return <Check size={15} className="ticks" style={{ color: 'var(--text-3)' }} />;
  return <CheckCheck size={15} className="ticks" style={message.status === 'delivered' ? { color: 'var(--text-3)' } : undefined} />;
}

function ChatItem({
  contact,
  last,
  typing,
  online,
  active,
  veiled,
  onClick,
  onMenu,
}: {
  contact: Contact;
  last: Message | undefined;
  typing: boolean;
  online: boolean;
  active: boolean;
  veiled: boolean;
  onClick(): void;
  onMenu(e: MouseEvent): void;
}) {
  const saved = isSavedChat(contact.id);
  const preview = !last
    ? saved
      ? 'Заметки и файлы для себя'
      : 'Нет сообщений'
    : last.dir === 'system'
      ? systemText(last, contact)
      : snippetOf(last);
  return (
    <div
      className={`chat-item${active ? ' active' : ''}${veiled ? ' veiled' : ''}`}
      role="listitem"
      tabIndex={0}
      aria-current={active ? 'true' : undefined}
      data-testid={`chat-${contact.username || contact.id}`}
      onClick={onClick}
      onKeyDown={(e) => {
        if (e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ')) {
          e.preventDefault();
          onClick();
        }
      }}
      onContextMenu={onMenu}
    >
      <span className="avatar-wrap">
        <Avatar name={contact.displayName} seed={contact.id} size={50} />
        {online && <i className="online-dot" />}
      </span>
      <div className="body">
        <div className="row">
          <span className="name">
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{contact.displayName}</span>
            {contact.verified && !saved && <ShieldCheck size={14} style={{ color: 'var(--success)' }} />}
            {contact.keyWarning && <TriangleAlert size={14} style={{ color: 'var(--warning)' }} />}
          </span>
          {last && <span className="time">{formatListTime(last.ts)}</span>}
        </div>
        <div className="row">
          {typing ? (
            <span className="preview typing">
              печатает
              <span className="typing-dots">
                <i />
                <i />
                <i />
              </span>
            </span>
          ) : (
            <span className="preview">
              {last && <StatusTicks message={last} />}
              {contact.draft ? (
                <>
                  <span style={{ color: 'var(--danger)' }}>Черновик:</span> {contact.draft}
                </>
              ) : (
                preview
              )}
            </span>
          )}
          {contact.muted && <BellOff size={14} className="meta-icon" />}
          {contact.pinned && !contact.unread && !saved && <Pin size={14} className="meta-icon" />}
          {contact.unread > 0 && <span className={`badge${contact.muted ? ' muted' : ''}`}>{contact.unread > 99 ? '99+' : contact.unread}</span>}
        </div>
      </div>
      <button className="item-menu icon-btn sm" onClick={onMenu} aria-label="Действия с чатом" title="Действия">
        <MoreVertical size={16} />
      </button>
    </div>
  );
}
