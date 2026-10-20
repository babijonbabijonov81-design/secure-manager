import { BellOff, Check, CheckCheck, Clock, MessageSquarePlus, Pin, Search, ShieldCheck, TriangleAlert } from 'lucide-react';
import { forwardRef, useMemo, useState } from 'react';
import type { Contact, Message, MessengerSnapshot } from '../../../core/types.ts';
import { formatListTime, previewOf } from '../lib/format.ts';
import { Avatar } from '../lib/ui.tsx';

interface Props {
  snapshot: MessengerSnapshot;
  activeId: string | null;
  onSelect(id: string): void;
  onNewChat(): void;
}

export const ChatList = forwardRef<HTMLInputElement, Props>(function ChatList({ snapshot, activeId, onSelect, onNewChat }, searchRef) {
  const [query, setQuery] = useState('');
  const contacts = useMemo(() => {
    const q = query.trim().toLowerCase().replace(/^@/, '');
    if (!q) return snapshot.contacts;
    return snapshot.contacts.filter((c) => c.displayName.toLowerCase().includes(q) || c.username.toLowerCase().includes(q));
  }, [snapshot.contacts, query]);

  return (
    <aside className="sidebar">
      <div className="sidebar-head">
        <div className="sidebar-title">
          <h2>Чаты</h2>
          <button className="icon-btn" onClick={onNewChat} aria-label="Новый чат" title="Новый чат (Ctrl+N)">
            <MessageSquarePlus size={20} />
          </button>
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
        {contacts.map((contact) => (
          <ChatItem
            key={contact.id}
            contact={contact}
            last={lastMessage(snapshot.conversations[contact.id])}
            typing={!!snapshot.typing[contact.id]}
            active={contact.id === activeId}
            onClick={() => onSelect(contact.id)}
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
            <span>Ничего не найдено</span>
          </div>
        )}
      </div>
    </aside>
  );
});

const lastMessage = (messages: Message[] | undefined) => {
  if (!messages) return undefined;
  for (let i = messages.length - 1; i >= 0; i--) if (messages[i].dir !== 'system') return messages[i];
  return messages.at(-1);
};

function StatusTicks({ message }: { message: Message }) {
  if (message.dir !== 'out') return null;
  if (message.status === 'pending') return <Clock size={14} className="ticks" style={{ color: 'var(--text-3)' }} />;
  if (message.status === 'failed') return <TriangleAlert size={14} className="ticks" style={{ color: 'var(--danger)' }} />;
  if (message.status === 'sent') return <Check size={15} className="ticks" style={{ color: 'var(--text-3)' }} />;
  return <CheckCheck size={15} className="ticks" style={message.status === 'delivered' ? { color: 'var(--text-3)' } : undefined} />;
}

function ChatItem({
  contact,
  last,
  typing,
  active,
  onClick,
}: {
  contact: Contact;
  last: Message | undefined;
  typing: boolean;
  active: boolean;
  onClick(): void;
}) {
  return (
    <button className={`chat-item${active ? ' active' : ''}`} onClick={onClick} role="listitem" data-testid={`chat-${contact.username}`}>
      <Avatar name={contact.displayName} seed={contact.id} size={50} />
      <div className="body">
        <div className="row">
          <span className="name">
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{contact.displayName}</span>
            {contact.verified && <ShieldCheck size={14} style={{ color: 'var(--success)' }} />}
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
                previewOf(last)
              )}
            </span>
          )}
          {contact.muted && <BellOff size={14} className="meta-icon" />}
          {contact.pinned && !contact.unread && <Pin size={14} className="meta-icon" />}
          {contact.unread > 0 && <span className={`badge${contact.muted ? ' muted' : ''}`}>{contact.unread > 99 ? '99+' : contact.unread}</span>}
        </div>
      </div>
    </button>
  );
}
