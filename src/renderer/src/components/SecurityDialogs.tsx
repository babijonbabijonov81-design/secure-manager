import { Copy, KeyRound, Mail, ShieldCheck, Smartphone } from 'lucide-react';
import QRCode from 'qrcode';
import { useEffect, useState, type FormEvent } from 'react';
import { WrongPasswordError } from '../../../core/crypto/vault.ts';
import type { Messenger } from '../../../core/messenger.ts';
import { passwordStrength } from '../lib/format.ts';
import { copyText } from '../lib/media.ts';
import { Modal, useToast } from '../lib/ui.tsx';

/** Six-digit code input used for authenticator and email codes. */
export function CodeInput({ value, onChange, autoFocus, label }: { value: string; onChange(v: string): void; autoFocus?: boolean; label: string }) {
  return (
    <input
      className="input code-input"
      inputMode="numeric"
      autoComplete="one-time-code"
      placeholder="000 000"
      aria-label={label}
      maxLength={7}
      autoFocus={autoFocus}
      value={value}
      onChange={(e) => onChange(e.target.value.replace(/[^\d]/g, '').slice(0, 6))}
    />
  );
}

export function TotpSetupDialog({ messenger, onClose }: { messenger: Messenger; onClose(): void }) {
  const [setup] = useState(() => messenger.beginTotpSetup());
  const [qr, setQr] = useState('');
  const [code, setCode] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const toast = useToast();

  useEffect(() => {
    void QRCode.toDataURL(setup.url, { margin: 1, width: 220, errorCorrectionLevel: 'M', color: { dark: '#1a1411', light: '#ffffff' } }).then(setQr);
  }, [setup.url]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      await messenger.confirmTotpSetup(code);
      toast('Двухфакторная аутентификация включена', 'success');
      onClose();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title="Google Authenticator" onClose={onClose} width={460}>
      <form className="modal-body" onSubmit={submit}>
        <ol className="steps-list">
          <li>
            <Smartphone size={16} /> Установите <b>Google Authenticator</b> (или Microsoft Authenticator, Authy) на телефон.
          </li>
          <li>Нажмите «+» → «Сканировать QR-код» и наведите камеру:</li>
        </ol>
        <div className="qr-box">{qr ? <img src={qr} alt="QR-код для приложения-аутентификатора" /> : <span className="spinner" />}</div>
        <div className="secret-row">
          <code className="selectable">{setup.secret.match(/.{1,4}/g)?.join(' ')}</code>
          <button
            type="button"
            className="icon-btn sm"
            onClick={() => void copyText(setup.secret).then(() => toast('Ключ скопирован', 'success'))}
            aria-label="Копировать ключ"
          >
            <Copy size={15} />
          </button>
        </div>
        <span className="field-hint" style={{ textAlign: 'center' }}>
          Нет камеры? Введите этот ключ вручную.
        </span>
        <div className="field">
          <label className="field-label">Код из приложения</label>
          <CodeInput value={code} onChange={setCode} label="Код из приложения" autoFocus />
          {error && <span className="field-error">{error}</span>}
        </div>
        <div className="notice info">
          <ShieldCheck size={16} />
          <span>После включения Veil будет спрашивать код при каждом входе и при восстановлении аккаунта по почте.</span>
        </div>
        <button className="btn btn-primary btn-block" disabled={busy || code.length !== 6}>
          {busy ? <span className="spinner" /> : 'Включить'}
        </button>
      </form>
    </Modal>
  );
}

export function TotpDisableDialog({ messenger, onClose }: { messenger: Messenger; onClose(): void }) {
  const [code, setCode] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  return (
    <Modal title="Отключить двухфакторную аутентификацию" onClose={onClose} width={420}>
      <form
        className="modal-body"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          try {
            await messenger.disableTotp(code);
            toast('Двухфакторная аутентификация отключена', 'info');
            onClose();
          } catch (err) {
            setError((err as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        <p>Введите текущий код из приложения-аутентификатора, чтобы подтвердить.</p>
        <CodeInput value={code} onChange={setCode} label="Код из приложения" autoFocus />
        {error && <span className="field-error">{error}</span>}
        <button className="btn btn-danger btn-block" disabled={busy || code.length !== 6}>
          {busy ? <span className="spinner" /> : 'Отключить'}
        </button>
      </form>
    </Modal>
  );
}

export function RecoveryEmailDialog({ messenger, onClose }: { messenger: Messenger; onClose(): void }) {
  const [step, setStep] = useState<'email' | 'code'>('email');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const toast = useToast();

  const sendCode = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    // The server copy is encrypted with this password: whoever gets the mailbox can try guesses
    // offline, so a weak password must not protect it.
    if (passwordStrength(password) < 3)
      return setError('Пароль Veil слишком простой для копии на сервере: её можно перебирать без ограничений. Сначала смените пароль на более длинный');
    setBusy(true);
    try {
      await messenger.setRecoveryEmail(email, password);
      setStep('code');
    } catch (err) {
      setError(err instanceof WrongPasswordError ? 'Неверный пароль' : (err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const confirm = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      await messenger.confirmRecoveryEmail(code);
      toast('Почта подтверждена, резервная копия создана', 'success');
      onClose();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title="Почта для восстановления" onClose={onClose} width={460}>
      {step === 'email' ? (
        <form className="modal-body" onSubmit={sendCode}>
          <p>
            Если вы смените компьютер или переустановите Veil, аккаунт можно будет вернуть по коду из письма. Контакты и переписка хранятся на
            сервере в виде резервной копии, <b>зашифрованной вашим паролем</b>: сервер прочитать её не может.
          </p>
          <div className="field">
            <label className="field-label" htmlFor="rec-email">
              Почта
            </label>
            <div className="input-wrap">
              <Mail size={18} />
              <input id="rec-email" className="input" type="email" placeholder="you@example.com" value={email} autoFocus onChange={(e) => setEmail(e.target.value)} />
            </div>
            <span className="field-hint">Сервер хранит только хэш адреса, а не саму почту.</span>
          </div>
          <div className="field">
            <label className="field-label" htmlFor="rec-password">
              Пароль Veil
            </label>
            <div className="input-wrap">
              <KeyRound size={18} />
              <input id="rec-password" className="input" type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
            </div>
            <span className="field-hint">Им будет зашифрована резервная копия. При восстановлении понадобятся код из письма и этот пароль.</span>
          </div>
          {error && <span className="field-error">{error}</span>}
          <button className="btn btn-primary btn-block" disabled={busy || !email.includes('@') || !password}>
            {busy ? <span className="spinner" /> : 'Получить код'}
          </button>
        </form>
      ) : (
        <form className="modal-body" onSubmit={confirm}>
          <p>
            Мы отправили 6-значный код на <b>{email}</b>. Письмо может попасть в «Спам».
          </p>
          <CodeInput value={code} onChange={setCode} label="Код из письма" autoFocus />
          {error && <span className="field-error">{error}</span>}
          <div className="form-actions">
            <button type="button" className="btn btn-secondary" onClick={() => setStep('email')}>
              Назад
            </button>
            <button className="btn btn-primary" disabled={busy || code.length !== 6}>
              {busy ? <span className="spinner" /> : 'Подтвердить'}
            </button>
          </div>
        </form>
      )}
    </Modal>
  );
}
