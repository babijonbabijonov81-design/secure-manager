import { Eye, EyeOff, Fingerprint, KeyRound, LockKeyhole, Smartphone } from 'lucide-react';
import { useEffect, useState, type FormEvent } from 'react';
import { unb64 } from '../../../../server/src/shared/wire.ts';
import { WrongPasswordError } from '../../../core/crypto/vault.ts';
import { unlock, unlockWithKey, type Messenger, type MessengerEvents } from '../../../core/messenger.ts';
import { bridge } from '../../../core/platform.ts';
import { unwrapWithPin, type PinBlob } from '../../../core/quick-unlock.ts';
import type { StorageBackend } from '../../../core/storage.ts';
import { accountTitle, type DeviceAccount, type Slot } from '../../../core/accounts.ts';
import { useQuickUnlockStatus } from '../components/QuickUnlock.tsx';
import { CodeInput } from '../components/SecurityDialogs.tsx';
import { Backdrop, ConfirmDialog, Logo } from '../lib/ui.tsx';

// Wrong passwords happen before the vault is open, so they are counted here (just a number, one
// per account) and written to the encrypted security log after the next successful login.
const failedKey = (slot: Slot) => (slot === 2 ? 'veil.failed.2' : 'veil.failed');
const failedAttempts = (slot: Slot) => {
  try {
    return Number(localStorage.getItem(failedKey(slot))) || 0;
  } catch {
    return 0;
  }
};
const countFailedAttempt = (slot: Slot) => {
  try {
    localStorage.setItem(failedKey(slot), String(failedAttempts(slot) + 1));
  } catch {
    // storage unavailable
  }
};
const resetFailedAttempts = (slot: Slot) => {
  try {
    localStorage.removeItem(failedKey(slot));
  } catch {
    // storage unavailable
  }
};

/** With two accounts on the device: which one this lock screen opens. */
function AccountPicker({ slot, accounts, onSwitch }: { slot: Slot; accounts: DeviceAccount[]; onSwitch(slot: Slot): void }) {
  if (accounts.length < 2) return null;
  return (
    <div className="account-picker" role="tablist" aria-label="Аккаунт">
      {accounts.map((a) => (
        <button
          key={a.slot}
          type="button"
          role="tab"
          aria-selected={a.slot === slot}
          className={a.slot === slot ? 'active' : ''}
          onClick={() => a.slot !== slot && onSwitch(a.slot)}
        >
          <span className="account-dot">{accountTitle(a).slice(0, 1).toUpperCase()}</span>
          <span className="account-names">
            <b>{accountTitle(a)}</b>
            {a.label?.username && !a.label.hidden && <small>@{a.label.username}</small>}
          </span>
        </button>
      ))}
    </div>
  );
}

export function LockScreen({
  slot,
  accounts,
  notice = '',
  storage,
  events,
  onUnlock,
  onSwitch,
  onReset,
}: {
  slot: Slot;
  accounts: DeviceAccount[];
  notice?: string;
  storage: StorageBackend;
  events: MessengerEvents;
  onUnlock(messenger: Messenger): void;
  onSwitch(slot: Slot): void;
  onReset(): void;
}) {
  const picker = <AccountPicker slot={slot} accounts={accounts} onSwitch={onSwitch} />;
  const [password, setPassword] = useState('');
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState(notice);
  const [shake, setShake] = useState(0);
  const [confirmReset, setConfirmReset] = useState(false);
  const [pending, setPending] = useState<Messenger | null>(null);
  const [code, setCode] = useState('');
  const [quick] = useQuickUnlockStatus();
  const [mode, setMode] = useState<'password' | 'pin'>('password');
  const [pin, setPin] = useState('');
  useEffect(() => {
    if (quick?.pin) setMode('pin');
  }, [quick?.pin]);

  const opened = (messenger: Messenger, method: 'password' | 'pin' | 'fingerprint') => {
    if (messenger.wipedReal) void bridge?.quickUnlock.disable('all');
    messenger.recordLogin(method, failedAttempts(slot));
    resetFailedAttempts(slot);
    if (messenger.needsTotp) {
      setPending(messenger);
      setBusy(false);
      setPassword('');
      setPin('');
    } else onUnlock(messenger);
  };
  const failed = (text: string, attempt = true) => {
    if (attempt) countFailedAttempt(slot);
    setError(text);
    setShake((n) => n + 1);
    setBusy(false);
    setProgress(0);
  };

  const submitPin = async (e: FormEvent) => {
    e.preventDefault();
    if (pin.length < 4 || busy) return;
    setBusy(true);
    setError('');
    const blob = await bridge!.quickUnlock.loadPin();
    if (!blob) {
      setMode('password');
      return failed('Вход по PIN недоступен. Введите пароль.', false);
    }
    let key: Uint8Array;
    try {
      key = await unwrapWithPin(JSON.parse(blob) as PinBlob, pin);
    } catch {
      setPin('');
      const left = await bridge!.quickUnlock.pinFailed();
      if (left > 0) return failed(`Неверный PIN. Осталось попыток: ${left}`);
      setMode('password');
      return failed('Пять неверных PIN подряд: PIN отключён. Войдите по паролю.');
    }
    await bridge!.quickUnlock.pinSucceeded();
    try {
      opened(await unlockWithKey(storage, key, events), 'pin');
    } catch (err) {
      failed((err as Error).message, false);
    } finally {
      key.fill(0);
    }
  };

  const unlockByFingerprint = async () => {
    setBusy(true);
    setError('');
    const key = await bridge!.quickUnlock.fingerprint();
    if (!key) return failed('Отпечаток не распознан');
    const bytes = unb64(key);
    try {
      opened(await unlockWithKey(storage, bytes, events), 'fingerprint');
    } catch (err) {
      failed((err as Error).message, false);
    } finally {
      bytes.fill(0);
    }
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!password || busy) return;
    setBusy(true);
    setError('');
    try {
      opened(await unlock(storage, password, events, setProgress), 'password');
    } catch (err) {
      setPassword('');
      failed(err instanceof WrongPasswordError ? 'Неверный пароль' : (err as Error).message);
    }
  };

  const submitCode = (e: FormEvent) => {
    e.preventDefault();
    if (!pending) return;
    if (pending.completeTotp(code)) onUnlock(pending);
    else {
      setError('Неверный код. Проверьте время на телефоне');
      setShake((n) => n + 1);
      setCode('');
    }
  };

  if (pending) {
    return (
      <>
        <Backdrop />
        <div className="center-stage">
          <form className={`glass-card${shake ? ' shake' : ''}`} key={shake} onSubmit={submitCode} style={{ maxWidth: 400 }}>
            <div className="brand" style={{ marginBottom: 22 }}>
              <div className="lock-anim" style={{ width: 84, height: 84 }}>
                <div className="core">
                  <Smartphone size={28} />
                </div>
              </div>
              <h1 style={{ fontSize: 22 }}>Код подтверждения</h1>
              <p>Откройте Google Authenticator и введите 6-значный код для Veil.</p>
            </div>
            <div className="form">
              <CodeInput value={code} onChange={setCode} label="Код из Google Authenticator" autoFocus />
              {error && <span className="field-error">{error}</span>}
              <button className="btn btn-primary btn-lg btn-block" disabled={code.length !== 6}>
                Войти
              </button>
              <div style={{ textAlign: 'center' }}>
                <button
                  type="button"
                  className="link-btn"
                  onClick={() => {
                    void pending.lock();
                    setPending(null);
                    setError('');
                  }}
                >
                  Назад
                </button>
              </div>
            </div>
          </form>
        </div>
      </>
    );
  }

  if (mode === 'pin') {
    return (
      <>
        <Backdrop />
        {bridge && <div className="titlebar" style={{ background: 'transparent', borderBottom: 0, position: 'fixed', inset: '0 0 auto 0' }} />}
        <div className="center-stage">
          <form className={`glass-card${shake ? ' shake' : ''}`} key={shake} onSubmit={submitPin} style={{ maxWidth: 400 }}>
            {picker}
            <div className="brand" style={{ marginBottom: 24 }}>
              <div className="brand-logo">
                <Logo size={68} />
              </div>
              <h1 style={{ fontSize: 24 }}>Veil заблокирован</h1>
              <p>Введите PIN этого компьютера.</p>
            </div>
            <div className="form">
              <input
                className={`input pin-input${error ? ' invalid' : ''}`}
                type="password"
                inputMode="numeric"
                autoComplete="off"
                maxLength={8}
                placeholder="PIN"
                aria-label="PIN"
                autoFocus
                value={pin}
                disabled={busy}
                onChange={(e) => setPin(e.target.value.replace(/\D/g, ''))}
              />
              {error && <span className="field-error">{error}</span>}
              <button className="btn btn-primary btn-lg btn-block" disabled={busy || pin.length < 4}>
                {busy ? <span className="spinner" /> : <LockKeyhole size={18} />} Разблокировать
              </button>
              {quick?.fingerprint.enabled && (
                <button type="button" className="btn btn-secondary btn-block" disabled={busy} onClick={() => void unlockByFingerprint()}>
                  <Fingerprint size={18} /> {bridge?.platform === 'darwin' ? 'Войти по Touch ID' : 'Приложите палец к сканеру'}
                </button>
              )}
              <div style={{ textAlign: 'center' }}>
                <button
                  type="button"
                  className="link-btn"
                  onClick={() => {
                    setMode('password');
                    setError('');
                  }}
                >
                  Войти по паролю
                </button>
              </div>
            </div>
          </form>
        </div>
      </>
    );
  }

  return (
    <>
      <Backdrop />
      {bridge && <div className="titlebar" style={{ background: 'transparent', borderBottom: 0, position: 'fixed', inset: '0 0 auto 0' }} />}
      <div className="center-stage">
        <form className={`glass-card${shake ? ' shake' : ''}`} key={shake} onSubmit={submit} style={{ maxWidth: 400 }}>
          {picker}
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
            {quick?.fingerprint.enabled && (
              <button type="button" className="btn btn-secondary btn-block" disabled={busy} onClick={() => void unlockByFingerprint()}>
                <Fingerprint size={18} /> {bridge?.platform === 'darwin' ? 'Войти по Touch ID' : 'Войти по отпечатку'}
              </button>
            )}
            <div style={{ textAlign: 'center', display: 'flex', justifyContent: 'center', gap: 18 }}>
              {quick?.pin && (
                <button type="button" className="link-btn" onClick={() => setMode('pin')}>
                  Войти по PIN
                </button>
              )}
              <button type="button" className="link-btn" onClick={() => setConfirmReset(true)}>
                Забыли пароль?
              </button>
            </div>
          </div>
        </form>
      </div>
      {confirmReset && (
        <ConfirmDialog
          title={accounts.length > 1 ? 'Удалить этот аккаунт с устройства?' : 'Сбросить Veil?'}
          text={
            accounts.length > 1
              ? 'Пароль невозможно восстановить — в этом и смысл защиты. Можно только удалить данные этого аккаунта на этом устройстве. Переписка в нём будет потеряна навсегда, другой аккаунт останется как был.'
              : 'Пароль невозможно восстановить — в этом и смысл защиты. Можно только удалить все данные на этом устройстве и создать новый аккаунт. Переписка будет потеряна навсегда.'
          }
          confirm={accounts.length > 1 ? 'Удалить аккаунт' : 'Удалить всё'}
          danger
          onClose={() => setConfirmReset(false)}
          onConfirm={async () => {
            await storage.clear();
            await bridge?.quickUnlock.disable('all');
            onReset();
          }}
        />
      )}
    </>
  );
}
