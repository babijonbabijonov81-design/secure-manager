import { Phone, PhoneIncoming, PhoneMissed, PhoneOutgoing } from 'lucide-react';
import { useMemo } from 'react';
import { callTitle } from '../../../core/messenger.ts';
import { isSavedChat, type Contact, type Message, type MessengerSnapshot } from '../../../core/types.ts';
import { formatCallDuration, formatListTime } from '../lib/format.ts';
import { Avatar } from '../lib/ui.tsx';

/** «Звонки»: every call from every chat, newest first. */
export function CallsList({
  snapshot,
  activeId,
  onSelect,
  onCall,
}: {
  snapshot: MessengerSnapshot;
  activeId: string | null;
  onSelect(contactId: string): void;
  onCall(contactId: string): void;
}) {
  const calls = useMemo(() => {
    const list: { contact: Contact; message: Message }[] = [];
    for (const contact of snapshot.contacts) {
      if (isSavedChat(contact.id)) continue;
      for (const message of snapshot.conversations[contact.id] ?? []) if (message.call) list.push({ contact, message });
    }
    return list.sort((a, b) => b.message.ts - a.message.ts).slice(0, 300);
  }, [snapshot.contacts, snapshot.conversations]);

  return (
    <aside className="sidebar">
      <div className="sidebar-head">
        <div className="sidebar-title">
          <h2>Звонки</h2>
        </div>
      </div>
      <div className="chat-list" role="list" aria-label="История звонков">
        {calls.map(({ contact, message }) => {
          const call = message.call!;
          const missed = message.dir === 'in' && call.status !== 'done' && call.status !== 'declined';
          const Icon = missed ? PhoneMissed : message.dir === 'out' ? PhoneOutgoing : PhoneIncoming;
          return (
            <div
              key={message.id}
              className={`chat-item call-item${contact.id === activeId ? ' active' : ''}`}
              role="listitem"
              tabIndex={0}
              data-testid="call-history-item"
              onClick={() => onSelect(contact.id)}
              onKeyDown={(e) => e.key === 'Enter' && onSelect(contact.id)}
            >
              <Avatar name={contact.displayName} seed={contact.id} photo={contact.avatar} size={46} />
              <div className="body">
                <div className="row">
                  <span className="name">{contact.displayName}</span>
                  <span className="time">{formatListTime(message.ts)}</span>
                </div>
                <div className="row">
                  <span className={`preview call-kind${missed ? ' missed' : ''}`}>
                    <Icon size={14} />
                    {callTitle(message)}
                    {call.dur ? ` · ${formatCallDuration(call.dur)}` : ''}
                  </span>
                </div>
              </div>
              {!contact.blocked && (
                <button
                  className="icon-btn"
                  aria-label={`Позвонить: ${contact.displayName}`}
                  title="Позвонить"
                  onClick={(e) => {
                    e.stopPropagation();
                    onCall(contact.id);
                  }}
                >
                  <Phone size={18} />
                </button>
              )}
            </div>
          );
        })}
        {calls.length === 0 && (
          <div className="empty-list">
            <div className="art">
              <Phone size={30} />
            </div>
            <b>Звонков пока не было</b>
            <span>Позвоните собеседнику из шапки чата — звонок зашифрован на обоих устройствах.</span>
          </div>
        )}
      </div>
    </aside>
  );
}
