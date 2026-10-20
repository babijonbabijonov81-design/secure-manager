import { AtSign, Copy, Search } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import type { Messenger } from '../../../core/messenger.ts';
import { Modal, useToast } from '../lib/ui.tsx';

export function NewChatModal({ messenger, onClose, onOpen }: { messenger: Messenger; onClose(): void; onOpen(id: string): void }) {
  const [username, setUsername] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const toast = useToast();
  const me = messenger.getSnapshot().me;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!username.trim()) return;
    setBusy(true);
    setError('');
    try {
      const contact = await messenger.addContact(username);
      onOpen(contact.id);
      onClose();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title="Новый чат" onClose={onClose}>
      <form className="modal-body" onSubmit={submit}>
        <p>Введите имя пользователя собеседника. Он должен быть зарегистрирован на том же сервере.</p>
        <div className="field">
          <div className="input-wrap">
            <AtSign size={18} />
            <input
              className={`input${error ? ' invalid' : ''}`}
              placeholder="username"
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
          ) : (
            <>
              <Search size={17} /> Найти и открыть чат
            </>
          )}
        </button>
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
    </Modal>
  );
}
