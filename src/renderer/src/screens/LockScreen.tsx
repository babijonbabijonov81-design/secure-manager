import { Eye, EyeOff, KeyRound, LockKeyhole } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { WrongPasswordError } from '../../../core/crypto/vault.ts';
import { unlock, type Messenger, type MessengerEvents } from '../../../core/messenger.ts';
import { bridge } from '../../../core/platform.ts';
import type { StorageBackend } from '../../../core/storage.ts';
import { Backdrop, ConfirmDialog, Logo } from '../lib/ui.tsx';

export function LockScreen({
  storage,
  events,
  onUnlock,
  onReset,
}: {
  storage: StorageBackend;
  events: MessengerEvents;
  onUnlock(messenger: Messenger): void;
  onReset(): void;
}) {
  const [password, setPassword] = useState('');
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState('');
  const [shake, setShake] = useState(0);
  const [confirmReset, setConfirmReset] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!password || busy) return;
    setBusy(true);
    setError('');
    try {
      const messenger = await unlock(storage, password, events, setProgress);
      onUnlock(messenger);
    } catch (err) {
      setError(err instanceof WrongPasswordError ? 'Неверный пароль' : (err as Error).message);
      setShake((n) => n + 1);
      setPassword('');
      setBusy(false);
      setProgress(0);
    }
  };

  return (
    <>
      <Backdrop />
      {bridge && <div className="titlebar" style={{ background: 'transparent', borderBottom: 0, position: 'fixed', inset: '0 0 auto 0' }} />}
      <div className="center-stage">
        <form className={`glass-card${shake ? ' shake' : ''}`} key={shake} onSubmit={submit} style={{ maxWidth: 400 }}>
          <div className="brand" style={{ marginBottom: 24 }}>
            <div className="brand-logo">
              <Logo size={68} />
            </div>
            <h1 style={{ fontSize: 24 }}>Veil заблокирован</h1>
            <p>Введите пароль, чтобы расшифровать переписку на этом устройстве.</p>
          </div>
          <div className="form">
            <div className="field">
              <div className="input-wrap">
                <KeyRound size={18} />
                <input
                  className={`input${error ? ' invalid' : ''}`}
                  type={show ? 'text' : 'password'}
                  placeholder="Пароль"
                  aria-label="Пароль"
                  autoFocus
                  value={password}
                  disabled={busy}
                  onChange={(e) => setPassword(e.target.value)}
                  style={{ paddingRight: 48 }}
                />
                <button
                  type="button"
                  className="icon-btn sm input-action"
                  onClick={() => setShow((v) => !v)}
                  aria-label={show ? 'Скрыть пароль' : 'Показать пароль'}
                >
                  {show ? <EyeOff size={16} /> : <Eye size={16} />}
                </button>
              </div>
              {error && <span className="field-error">{error}</span>}
            </div>
            {busy && (
              <div className="progress">
                <div style={{ width: `${Math.max(8, Math.round(progress * 100))}%` }} />
              </div>
            )}
            <button className="btn btn-primary btn-lg btn-block" disabled={busy || !password}>
              {busy ? (
                <>
                  <span className="spinner" /> Расшифровка…
                </>
              ) : (
                <>
                  <LockKeyhole size={18} /> Разблокировать
                </>
              )}
            </button>
            <div style={{ textAlign: 'center' }}>
              <button type="button" className="link-btn" onClick={() => setConfirmReset(true)}>
                Забыли пароль?
              </button>
            </div>
          </div>
        </form>
      </div>
      {confirmReset && (
        <ConfirmDialog
          title="Сбросить Veil?"
          text="Пароль невозможно восстановить — в этом и смысл защиты. Можно только удалить все данные на этом устройстве и создать новый аккаунт. Переписка будет потеряна навсегда."
          confirm="Удалить всё"
          danger
          onClose={() => setConfirmReset(false)}
          onConfirm={async () => {
            await storage.clear();
            onReset();
          }}
        />
      )}
    </>
  );
}
