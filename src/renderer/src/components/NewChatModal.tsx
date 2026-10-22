import { ArrowLeft, AtSign, Copy, QrCode, ScanLine, Search, ShieldCheck, Users } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { parseInvite } from '../../../core/invite.ts';
import type { Messenger } from '../../../core/messenger.ts';
import { feature } from '../lib/hooks.ts';
import { Modal, useToast } from '../lib/ui.tsx';
import { GroupCreate } from './GroupPanel.tsx';
import { InvitePanel, ScanPanel } from './Invites.tsx';

export function NewChatModal({ messenger, onClose, onOpen }: { messenger: Messenger; onClose(): void; onOpen(id: string): void }) {
  const [username, setUsername] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [mode, setMode] = useState<'find' | 'invite' | 'scan' | 'group'>('find');
  const toast = useToast();
  const snapshot = messenger.getSnapshot();
  const me = snapshot.me;
  const invites = feature(snapshot.settings, 'invites');
  const groups = feature(snapshot.settings, 'groups') && !snapshot.decoy;
  const isInvite = invites && !!parseInvite(username);

  const open = async (value: string) => {
    setBusy(true);
    setError('');
    try {
      const invite = invites && parseInvite(value);
      const contact = invite ? await messenger.acceptInvite(value) : await messenger.addContact(value);
      if (invite) toast('Ключ совпал — контакт проверен', 'success');
      onOpen(contact.id);
      onClose();
    } catch (err) {
      setMode('find');
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (username.trim()) void open(username);
  };

  const back = (
    <span className="modal-title-back">
      <button type="button" className="icon-btn sm" onClick={() => setMode('find')} aria-label="Назад">
        <ArrowLeft size={18} />
      </button>
      {mode === 'invite' ? 'Пригласить лично' : mode === 'group' ? 'Новая группа' : 'Сканировать QR-код'}
    </span>
  );

  return (
    <Modal title={mode === 'find' ? 'Новый чат' : back} onClose={onClose}>
      {mode === 'invite' && <InvitePanel messenger={messenger} />}
      {mode === 'scan' && <ScanPanel onFound={(link) => void open(link)} />}
      {mode === 'group' && (
        <GroupCreate
          messenger={messenger}
          snapshot={snapshot}
          onDone={(id) => {
            onOpen(id);
            onClose();
          }}
        />
      )}
      {mode === 'find' && (
        <form className="modal-body" onSubmit={submit}>
          <p>
            Введите имя пользователя собеседника{invites ? ' или вставьте его ссылку veil://' : ''}. Он должен быть зарегистрирован на том же сервере.
          </p>
          <div className="field">
            <div className="input-wrap">
              <AtSign size={18} />
              <input
                className={`input${error ? ' invalid' : ''}`}
                placeholder={invites ? 'username или veil://…' : 'username'}
                aria-label="Имя пользователя"
                autoFocus
                value={username}
                onChange={(e) => setUsername(e.target.value.replace(/\s/g, ''))}
              />
            </div>
            {error && <span className="field-error">{error}</span>}
          </div>
          <button className="btn btn-primary btn-block" disabled={busy || !username.trim()}>
            {busy ? (
              <span className="spinner" />
            ) : isInvite ? (
              <>
                <ShieldCheck size={17} /> Добавить по приглашению
              </>
            ) : (
              <>
                <Search size={17} /> Найти и открыть чат
              </>
            )}
          </button>
          {groups && (
            <button type="button" className="btn btn-secondary btn-block" onClick={() => setMode('group')}>
              <Users size={16} /> Новая группа
            </button>
          )}
          {invites && (
            <div className="invite-actions">
              <button type="button" className="btn btn-secondary" onClick={() => setMode('invite')}>
                <QrCode size={16} /> Пригласить лично
              </button>
              <button type="button" className="btn btn-secondary" onClick={() => setMode('scan')}>
                <ScanLine size={16} /> Сканировать QR-код
              </button>
            </div>
          )}
          <div className="divider" />
          <div className="option-card" style={{ cursor: 'default' }}>
            <div className="grow">
              <span>Ваше имя пользователя</span>
              <b className="selectable">@{me.username}</b>
            </div>
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              onClick={() => {
                void navigator.clipboard.writeText(`@${me.username}`);
                toast('Имя пользователя скопировано', 'success');
              }}
            >
              <Copy size={15} /> Копировать
            </button>
          </div>
        </form>
      )}
    </Modal>
  );
}
