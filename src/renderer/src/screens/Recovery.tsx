import { ArrowLeft, AtSign, Globe, KeyRound, LifeBuoy, Mail, Smartphone } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { WrongPasswordError } from '../../../core/crypto/vault.ts';
import {
  resetAccount,
  restoreAccount,
  startRecovery,
  verifyRecovery,
  type Messenger,
  type MessengerEvents,
  type RecoveryTicket,
} from '../../../core/messenger.ts';
import { RelayRequestError } from '../../../core/relay-client.ts';
import type { StorageBackend } from '../../../core/storage.ts';
import { CodeInput } from '../components/SecurityDialogs.tsx';

type Step = 'start' | 'code' | 'password' | 'reset' | 'working';

/** Restores an account on a new device: email code (+ 2FA) → encrypted backup → password. */
export function RecoveryFlow({
  storage,
  events,
  initialServer,
  onBack,
  onDone,
}: {
  storage: StorageBackend;
  events: MessengerEvents;
  initialServer: string;
  onBack(): void;
  onDone(messenger: Messenger): void;
}) {
  const [step, setStep] = useState<Step>('start');
  const [server, setServer] = useState(initialServer);
  const [username, setUsername] = useState('');
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [totp, setTotp] = useState('');
  const [needsTotp, setNeedsTotp] = useState(false);
  const [ticket, setTicket] = useState<RecoveryTicket | null>(null);
  const [password, setPassword] = useState('');
  const [password2, setPassword2] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('');

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError('');
    try {
      await fn();
    } catch (err) {
      if (err instanceof RelayRequestError && err.code === 'totp_required') {
        setNeedsTotp(true);
        setError('');
      } else setError(err instanceof WrongPasswordError ? 'Неверный пароль' : (err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const start = (e: FormEvent) => {
    e.preventDefault();
    void run(async () => {
      await startRecovery(server, username, email);
      setStep('code');
    });
  };

  const verify = (e: FormEvent) => {
    e.preventDefault();
    void run(async () => {
      const result = await verifyRecovery(server, username, code, needsTotp ? totp : undefined);
      setTicket(result);
      setStep(result.backup ? 'password' : 'reset');
    });
  };

  const restore = (e: FormEvent) => {
    e.preventDefault();
    if (!ticket) return;
    void run(async () => {
      setStatus('Расшифровываем резервную копию…');
      try {
        const messenger = await restoreAccount({ storage, ticket, password }, events);
        setStep('working');
        onDone(messenger);
      } finally {
        setStatus('');
      }
    });
  };

  const reset = (e: FormEvent) => {
    e.preventDefault();
    if (!ticket) return;
    if (password.length < 8) return setError('Пароль должен быть не короче 8 символов');
    if (password !== password2) return setError('Пароли не совпадают');
    void run(async () => {
      setStatus('Создаём новые ключи для @' + ticket.username + '…');
      try {
        const messenger = await resetAccount({ storage, ticket, displayName: displayName || ticket.username, password }, events);
        setStep('working');
        onDone(messenger);
      } finally {
        setStatus('');
      }
    });
  };

  return (
    <div className="glass-card" key={step}>
      <div className="step-head">
        <div className="feature-icon" style={{ width: 46, height: 46, borderRadius: 15 }}>
          <LifeBuoy size={22} />
        </div>
        <h2>Восстановление аккаунта</h2>
        {step === 'start' && <p>Укажите сервер, имя пользователя и почту, которую вы привязали к аккаунту.</p>}
        {step === 'code' && (
          <p>
            Если почта совпадает с привязанной к @{username.replace(/^@/, '')}, на неё пришёл 6-значный код. Проверьте и папку «Спам».
          </p>
        )}
        {step === 'password' && <p>Код подтверждён. Введите пароль Veil, которым зашифрована резервная копия.</p>}
        {step === 'reset' && (
          <p>
            Мы создадим новые ключи и сохраним за вами имя <b>@{ticket?.username}</b>. Старую переписку вернуть не получится — она была
            зашифрована забытым паролем. Собеседники увидят, что ваш ключ безопасности изменился.
          </p>
        )}
      </div>

      {step === 'start' && (
        <form className="form" onSubmit={start}>
          <div className="input-wrap">
            <Globe size={18} />
            <input className="input" aria-label="Адрес сервера" placeholder="Адрес сервера" value={server} onChange={(e) => setServer(e.target.value)} />
          </div>
          <div className="input-wrap">
            <AtSign size={18} />
            <input className="input" aria-label="Имя пользователя" placeholder="username" value={username} autoFocus onChange={(e) => setUsername(e.target.value.trim())} />
          </div>
          <div className="input-wrap">
            <Mail size={18} />
            <input className="input" type="email" aria-label="Почта" placeholder="you@example.com" value={email} onChange={(e) => setEmail(e.target.value)} />
          </div>
          {error && <span className="field-error">{error}</span>}
          <div className="form-actions">
            <button type="button" className="btn btn-secondary" onClick={onBack}>
              <ArrowLeft size={18} />
            </button>
            <button className="btn btn-primary" disabled={busy || !server || !username || !email.includes('@')}>
              {busy ? <span className="spinner" /> : 'Получить код'}
            </button>
          </div>
        </form>
      )}

      {step === 'code' && (
        <form className="form" onSubmit={verify}>
          <div className="field">
            <label className="field-label">Код из письма</label>
            <CodeInput value={code} onChange={setCode} label="Код из письма" autoFocus />
          </div>
          {needsTotp && (
            <div className="field">
              <label className="field-label" style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                <Smartphone size={14} /> Код из Google Authenticator
              </label>
              <CodeInput value={totp} onChange={setTotp} label="Код из Google Authenticator" autoFocus />
              <span className="field-hint">На аккаунте включена двухфакторная аутентификация.</span>
            </div>
          )}
          {error && <span className="field-error">{error}</span>}
          <div className="form-actions">
            <button type="button" className="btn btn-secondary" onClick={() => setStep('start')}>
              <ArrowLeft size={18} />
            </button>
            <button className="btn btn-primary" disabled={busy || code.length !== 6 || (needsTotp && totp.length !== 6)}>
              {busy ? <span className="spinner" /> : 'Продолжить'}
            </button>
          </div>
        </form>
      )}

      {step === 'password' && (
        <form className="form" onSubmit={restore}>
          <div className="input-wrap">
            <KeyRound size={18} />
            <input className="input" type="password" aria-label="Пароль" placeholder="Пароль" value={password} autoFocus onChange={(e) => setPassword(e.target.value)} />
          </div>
          {error && <span className="field-error">{error}</span>}
          {status && <span className="field-hint">{status}</span>}
          <button className="btn btn-primary btn-lg btn-block" disabled={busy || !password}>
            {busy ? <span className="spinner" /> : 'Восстановить'}
          </button>
          <div style={{ textAlign: 'center' }}>
            <button
              type="button"
              className="link-btn"
              onClick={() => {
                setPassword('');
                setError('');
                setStep('reset');
              }}
            >
              Не помню пароль
            </button>
          </div>
        </form>
      )}

      {step === 'reset' && (
        <form className="form" onSubmit={reset}>
          <input className="input" aria-label="Имя" placeholder="Как вас называть" value={displayName} onChange={(e) => setDisplayName(e.target.value)} />
          <input className="input" type="password" aria-label="Новый пароль" placeholder="Новый пароль (минимум 8 символов)" value={password} onChange={(e) => setPassword(e.target.value)} />
          <input className="input" type="password" aria-label="Повторите пароль" placeholder="Повторите пароль" value={password2} onChange={(e) => setPassword2(e.target.value)} />
          {error && <span className="field-error">{error}</span>}
          <div className="form-actions">
            {ticket?.backup && (
              <button type="button" className="btn btn-secondary" onClick={() => setStep('password')}>
                <ArrowLeft size={18} />
              </button>
            )}
            <button className="btn btn-primary" disabled={busy || !password}>
              {busy ? <span className="spinner" /> : 'Начать с новыми ключами'}
            </button>
          </div>
        </form>
      )}

      {step === 'working' && (
        <div className="creating">
          <div className="lock-anim">
            <div className="ring" />
            <div className="ring" />
            <div className="ring" />
            <div className="core">
              <LifeBuoy size={28} />
            </div>
          </div>
          <p style={{ margin: 0, color: 'var(--text-2)' }}>{status}</p>
        </div>
      )}
    </div>
  );
}
