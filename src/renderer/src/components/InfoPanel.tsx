import { Archive, ArchiveRestore, Ban, Bell, BellOff, Eraser, Hourglass, Phone, Pin, PinOff, RotateCcw, ShieldCheck, ShieldQuestion, Trash2, TriangleAlert, X } from 'lucide-react';
import { useMemo, useState } from 'react';
import { formatSafetyNumber } from '../../../core/crypto/fingerprint.ts';
import type { Messenger } from '../../../core/messenger.ts';
import { TIMER_OPTIONS, type Contact } from '../../../core/types.ts';
import { timerLabel } from '../lib/format.ts';
import { presenceText } from '../lib/text.ts';
import { Avatar, ConfirmDialog, useToast } from '../lib/ui.tsx';

type Confirm = 'clear' | 'delete' | 'block' | 'reset' | null;

export function InfoPanel({
  messenger,
  contact,
  online,
  onCall,
  onClose,
  onDeleted,
}: {
  messenger: Messenger;
  contact: Contact;
  online: boolean;
  onCall(): void;
  onClose(): void;
  onDeleted(): void;
}) {
  const toast = useToast();
  const [confirm, setConfirm] = useState<Confirm>(null);
  const safety = useMemo(() => formatSafetyNumber(messenger.safetyNumber(contact.id)), [messenger, contact.id]);

  return (
    <aside className="info-panel">
      <div className="panel-head">
        <h3>Информация</h3>
        <button className="icon-btn sm" onClick={onClose} aria-label="Закрыть панель">
          <X size={18} />
        </button>
      </div>
      <div className="panel-body">
        <div className="profile-hero">
          <Avatar name={contact.displayName} seed={contact.id} size={96} />
          <h4>
            {contact.displayName}
            {contact.verified && <ShieldCheck size={18} style={{ color: 'var(--success)' }} />}
          </h4>
          {contact.username && <span className="handle selectable">@{contact.username}</span>}
          {presenceText(contact, online) && <span className={`presence${online ? ' online' : ''}`}>{presenceText(contact, online)}</span>}
          <div style={{ marginTop: 8 }}>
            {contact.verified ? (
              <span className="chip success">
                <ShieldCheck size={13} /> Проверен
              </span>
            ) : contact.keyWarning ? (
              <span className="chip warning">
                <TriangleAlert size={13} /> Ключ изменился
              </span>
            ) : (
              <span className="chip">
                <ShieldQuestion size={13} /> Не проверен
              </span>
            )}
          </div>
          {!contact.blocked && (
            <button className="btn btn-sm btn-secondary hero-call" onClick={onCall}>
              <Phone size={15} /> Позвонить
            </button>
          )}
        </div>

        <div className="section" id="safety">
          <div className="section-title">
            <ShieldCheck size={16} /> Код безопасности
          </div>
          <div className={`safety-grid${contact.verified ? ' verified' : ''}`} data-testid="safety-number">
            {safety.map((group, i) => (
              <span key={i}>{group}</span>
            ))}
          </div>
          <p>
            Сравните эти цифры с собеседником лично или по телефону. Если они совпадают — никто не подменил ключи, и переписку не может
            прочитать посредник.
          </p>
          <button
            className={`btn btn-sm ${contact.verified ? 'btn-secondary' : 'btn-primary'}`}
            onClick={() => {
              messenger.setVerified(contact.id, !contact.verified);
              if (!contact.verified) toast('Контакт отмечен как проверенный', 'success');
            }}
          >
            {contact.verified ? 'Снять отметку' : 'Коды совпадают — отметить как проверенный'}
          </button>
        </div>

        <div className="section">
          <div className="section-title">
            <Hourglass size={16} /> Исчезающие сообщения
          </div>
          <div className="timer-options">
            {TIMER_OPTIONS.map((seconds) => (
              <button
                key={seconds}
                className={contact.timer === seconds ? 'active' : ''}
                onClick={() => void messenger.setTimer(contact.id, seconds).catch((e) => toast((e as Error).message, 'error'))}
              >
                {timerLabel(seconds, true)}
              </button>
            ))}
          </div>
          <p>Новые сообщения будут удаляться у обоих собеседников через выбранное время.</p>
        </div>

        <div className="section action-list">
          <button className="action-item" onClick={() => messenger.setPinned(contact.id, !contact.pinned)}>
            {contact.pinned ? <PinOff size={18} /> : <Pin size={18} />}
            <span className="grow">{contact.pinned ? 'Открепить чат' : 'Закрепить чат'}</span>
          </button>
          <button className="action-item" onClick={() => messenger.setArchived(contact.id, !contact.archived)}>
            {contact.archived ? <ArchiveRestore size={18} /> : <Archive size={18} />}
            <span className="grow">{contact.archived ? 'Вернуть из архива' : 'В архив'}</span>
          </button>
          <button className="action-item" onClick={() => messenger.setMuted(contact.id, !contact.muted)}>
            {contact.muted ? <Bell size={18} /> : <BellOff size={18} />}
            <span className="grow">{contact.muted ? 'Включить уведомления' : 'Без звука'}</span>
          </button>
          <button className="action-item" onClick={() => setConfirm('reset')}>
            <RotateCcw size={18} />
            <span className="grow">Сбросить сеанс шифрования</span>
          </button>
          <button className="action-item" onClick={() => setConfirm('clear')}>
            <Eraser size={18} />
            <span className="grow">Очистить историю</span>
          </button>
          <button
            className="action-item danger"
            onClick={() => (contact.blocked ? messenger.setBlocked(contact.id, false) : setConfirm('block'))}
          >
            <Ban size={18} />
            <span className="grow">{contact.blocked ? 'Разблокировать' : 'Заблокировать'}</span>
          </button>
          <button className="action-item danger" onClick={() => setConfirm('delete')}>
            <Trash2 size={18} />
            <span className="grow">Удалить чат</span>
          </button>
        </div>
      </div>

      {confirm === 'clear' && (
        <ConfirmDialog
          title="Очистить историю?"
          text="Все сообщения и файлы этого чата будут удалены с этого устройства."
          confirm="Очистить"
          danger
          onClose={() => setConfirm(null)}
          onConfirm={() => messenger.clearChat(contact.id)}
        />
      )}
      {confirm === 'delete' && (
        <ConfirmDialog
          title="Удалить чат?"
          text={`Переписка с ${contact.displayName} и ключи сеанса будут удалены с этого устройства.`}
          confirm="Удалить"
          danger
          onClose={() => setConfirm(null)}
          onConfirm={async () => {
            await messenger.deleteChat(contact.id);
            onDeleted();
          }}
        />
      )}
      {confirm === 'block' && (
        <ConfirmDialog
          title="Заблокировать?"
          text={`${contact.displayName} не сможет присылать вам сообщения. Об этом он не узнает.`}
          confirm="Заблокировать"
          danger
          onClose={() => setConfirm(null)}
          onConfirm={() => messenger.setBlocked(contact.id, true)}
        />
      )}
      {confirm === 'reset' && (
        <ConfirmDialog
          title="Сбросить сеанс?"
          text="Следующее сообщение начнёт новый сеанс шифрования с новыми ключами. Помогает, если сообщения перестали расшифровываться."
          confirm="Сбросить"
          onClose={() => setConfirm(null)}
          onConfirm={() => messenger.resetSession(contact.id)}
        />
      )}
    </aside>
  );
}
