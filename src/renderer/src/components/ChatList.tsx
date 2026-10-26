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
  EyeOff,
  FileText,
  Image as ImageIcon,
  Link2,
  MailOpen,
  MessageSquarePlus,
  Mic,
  MoreVertical,
  Pin,
  PinOff,
  Search,
  ShieldCheck,
  Trash2,
  TriangleAlert,
  Users,
  UserPlus,
} from 'lucide-react';
import { forwardRef, useDeferredValue, useEffect, useMemo, useState, type MouseEvent, type ReactNode } from 'react';
import { snippetOf, type Messenger } from '../../../core/messenger.ts';
import type { SearchFilter, SearchHit } from '../../../core/search.ts';
import { isSavedChat, type Contact, type Message, type MessengerSnapshot } from '../../../core/types.ts';
import { formatListTime, systemText } from '../lib/format.ts';
import { feature, veiledFor } from '../lib/hooks.ts';
import { Avatar, ConfirmDialog, ContextMenu, type MenuItem } from '../lib/ui.tsx';

interface Props {
  messenger: Messenger;
  snapshot: MessengerSnapshot;
  activeId: string | null;
  onSelect(id: string): void;
  onNewChat(): void;
  onDeleted(id: string): void;
  /** Enter in the search: the secret phrase of hidden chats opens them (returns true). */
  onSecret?(query: string): Promise<boolean>;
  /** Hidden chats are shown right now. */
  hiddenOpen?: boolean;
  onCloseHidden?(): void;
  /** A message found by «Поиск по всей переписке». */
  onOpenMessage?(contactId: string, messageId: string): void;
}

const FILTERS: { id: SearchFilter; label: string; icon: ReactNode }[] = [
  { id: 'photo', label: 'Фото', icon: <ImageIcon size={14} /> },
  { id: 'file', label: 'Файлы', icon: <FileText size={14} /> },
  { id: 'link', label: 'Ссылки', icon: <Link2 size={14} /> },
  { id: 'voice', label: 'Голосовые', icon: <Mic size={14} /> },
];

export const ChatList = forwardRef<HTMLInputElement, Props>(function ChatList(
  { messenger, snapshot, activeId, onSelect, onNewChat, onDeleted, onSecret, hiddenOpen, onCloseHidden, onOpenMessage },
  searchRef,
) {
  const [query, setQuery] = useState('');
  const [showArchive, setShowArchive] = useState(false);
  const [showRequests, setShowRequests] = useState(false);
  const [menu, setMenu] = useState<{ x: number; y: number; contact: Contact } | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<Contact | null>(null);

  // People known only through a group get a chat in the list once we talk directly.
  const listed = useMemo(
    () => snapshot.contacts.filter((c) => !c.groupOnly && (!c.group || feature(snapshot.settings, 'groups'))),
    [snapshot.contacts, snapshot.settings],
  );
  // «Запросы на переписку»: strangers who wrote first live apart until accepted.
  const requests = listed.filter((c) => c.request);
  const archived = listed.filter((c) => c.archived && !c.request);
  // The last request accepted or deleted: back to the chats.
  useEffect(() => {
    if (showRequests && requests.length === 0) setShowRequests(false);
  }, [showRequests, requests.length]);
  const contacts = useMemo(() => {
    const q = query.trim().toLowerCase().replace(/^@/, '');
    if (q) return listed.filter((c) => c.displayName.toLowerCase().includes(q) || c.username.toLowerCase().includes(q));
    if (showRequests) return listed.filter((c) => c.request);
    return listed.filter((c) => !c.request && !!c.archived === showArchive);
  }, [listed, query, showArchive, showRequests]);
  const archivedUnread = archived.reduce((n, c) => n + c.unread, 0);

  // «Поиск по всей переписке»: messages too, from 2 letters or with a filter.
  const searchOn = feature(snapshot.settings, 'search');
  const [filter, setFilter] = useState<SearchFilter>('all');
  const deferred = useDeferredValue(query);
  const searching = searchOn && (deferred.trim().length >= 2 || filter !== 'all');
  const hits = useMemo(
    () => (searching ? messenger.search(deferred, filter, { hidden: hiddenOpen }) : []),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [searching, deferred, filter, hiddenOpen, snapshot.conversations, messenger],
  );
  const byId = useMemo(() => new Map(snapshot.contacts.map((c) => [c.id, c])), [snapshot.contacts]);
  const shownContacts = filter === 'all' ? contacts : [];

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
          {(showArchive || showRequests) && !query ? (
            <>
              <button
                className="icon-btn"
                onClick={() => {
                  setShowArchive(false);
                  setShowRequests(false);
                }}
                aria-label="Назад к чатам"
              >
                <ArrowLeft size={20} />
              </button>
              <h2 style={{ flex: 1, marginLeft: 6 }}>{showRequests ? 'Запросы на переписку' : 'Архив'}</h2>
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
            placeholder={searchOn ? 'Поиск — только по этому устройству' : 'Поиск'}
            aria-label="Поиск чатов"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                setQuery('');
                setFilter('all');
              }
              if (e.key !== 'Enter') return;
              const typed = query;
              if (onSecret && typed.trim().length >= 4)
                void onSecret(typed).then((secret) => {
                  if (secret) setQuery('');
                  else if (contacts[0]) onSelect(contacts[0].id);
                });
              else if (contacts[0]) onSelect(contacts[0].id);
            }}
          />
        </div>
      </div>
      {searchOn && (query || filter !== 'all') && (
        <div className="search-filters" role="group" aria-label="Что искать">
          {FILTERS.map((f) => (
            <button
              key={f.id}
              className={filter === f.id ? 'active' : ''}
              aria-pressed={filter === f.id}
              aria-label={f.label}
              onClick={() => setFilter(filter === f.id ? 'all' : f.id)}
            >
              {f.icon} {f.label}
            </button>
          ))}
        </div>
      )}
      {hiddenOpen && (
        <div className="hidden-banner" role="status">
          <EyeOff size={15} /> Скрытые чаты открыты
          <button onClick={onCloseHidden}>Спрятать</button>
        </div>
      )}
      <div className="chat-list" role="list">
        {!showArchive && !showRequests && !query && requests.length > 0 && (
          <button className="chat-item archive-row" data-testid="requests-row" onClick={() => setShowRequests(true)}>
            <div className="archive-icon">
              <UserPlus size={22} />
            </div>
            <div className="body">
              <div className="row">
                <span className="name">Запросы на переписку</span>
              </div>
              <div className="row">
                <span className="preview">{requests.map((c) => c.displayName).join(', ')}</span>
                <span className="badge">{requests.length}</span>
              </div>
            </div>
          </button>
        )}
        {showRequests && !query && (
          <p className="list-note">
            Эти люди написали первыми. Пока вы не примете запрос, они не видят «прочитано» и «в сети», не могут дозвониться, а картинки от них
            закрыты.
          </p>
        )}
        {!showArchive && !showRequests && !query && archived.length > 0 && (
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
        {searching && shownContacts.length > 0 && <div className="list-section">Чаты</div>}
        {(searching ? shownContacts : contacts).map((contact) => (
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
            nameOf={(id) => byId.get(id)?.displayName}
          />
        ))}
        {searching && (
          <>
            <div className="list-section" data-testid="search-results">
              {hits.length ? `Сообщения · ${hits.length >= 200 ? '200+' : hits.length}` : 'Сообщения'}
            </div>
            {hits.map((hit) => (
              <SearchItem
                key={`${hit.contactId}:${hit.id}`}
                hit={hit}
                contact={byId.get(hit.contactId)}
                veiled={veiledFor(snapshot.settings, byId.get(hit.contactId))}
                onClick={() => onOpenMessage?.(hit.contactId, hit.id)}
              />
            ))}
            {!hits.length && <div className="empty-list compact">Ничего не найдено на этом устройстве</div>}
          </>
        )}
        {listed.length === 0 && (
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
        {!searching && listed.length > 0 && contacts.length === 0 && (
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

const HIT_ICON: Record<SearchHit['kind'], ReactNode> = {
  text: null,
  photo: <ImageIcon size={13} />,
  file: <FileText size={13} />,
  link: <Link2 size={13} />,
  voice: <Mic size={13} />,
};

function SearchItem({ hit, contact, veiled, onClick }: { hit: SearchHit; contact: Contact | undefined; veiled: boolean; onClick(): void }) {
  const name = contact ? (isSavedChat(contact.id) ? 'Избранное' : contact.displayName) : 'Чат';
  const text: ReactNode[] = [];
  let at = 0;
  for (const [a, b] of hit.marks) {
    text.push(hit.snippet.slice(at, a), <mark key={a}>{hit.snippet.slice(a, b)}</mark>);
    at = b;
  }
  text.push(hit.snippet.slice(at));
  return (
    <button className={`chat-item search-hit${veiled ? ' veiled' : ''}`} role="listitem" data-testid="search-hit" onClick={onClick}>
      <Avatar name={name} seed={contact?.id ?? hit.contactId} size={42} photo={contact?.avatar} />
      <div className="body">
        <div className="row">
          <span className="name">{name}</span>
          <span className="time">{formatListTime(hit.ts)}</span>
        </div>
        <div className="row">
          <span className="preview">
            {HIT_ICON[hit.kind]}
            {hit.dir === 'out' && <span className="you">Вы: </span>}
            {text}
          </span>
        </div>
      </div>
    </button>
  );
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
  nameOf,
}: {
  /** A group member's current name. */
  nameOf?(id: string): string | undefined;
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
      : last.status === 'scheduled'
        ? `Запланировано: ${snippetOf(last)}`
        : contact.group && last.dir === 'in' && last.from
          ? `${nameOf?.(last.from) ?? contact.group.members.find((m) => m.id === last.from)?.name ?? 'Участник'}: ${snippetOf(last)}`
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
        <Avatar name={contact.displayName} seed={contact.id} photo={contact.avatar} size={50} />
        {online && <i className="online-dot" />}
        {contact.group && (
          <i className="group-dot" aria-label="Группа">
            <Users size={11} />
          </i>
        )}
      </span>
      <div className="body">
        <div className="row">
          <span className="name">
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{contact.displayName}</span>
            {contact.verified && !saved && <ShieldCheck size={14} style={{ color: 'var(--success)' }} />}
            {contact.keyWarning && <TriangleAlert size={14} style={{ color: 'var(--danger)' }} />}
            {contact.hidden && <EyeOff size={13} aria-label="Скрытый чат" style={{ color: 'var(--text-3)' }} />}
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
