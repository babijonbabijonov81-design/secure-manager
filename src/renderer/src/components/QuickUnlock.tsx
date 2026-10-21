import { Fingerprint, KeyRound, ShieldCheck } from 'lucide-react';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { b64 } from '../../../../server/src/shared/wire.ts';
import type { Messenger } from '../../../core/messenger.ts';
import { bridge, type QuickUnlockStatus } from '../../../core/platform.ts';
import { PIN_RE, wrapWithPin } from '../../../core/quick-unlock.ts';
import { Modal, Toggle, useToast } from '../lib/ui.tsx';

const KEYCHAIN_TEXT: Record<QuickUnlockStatus['keychain'], string> = {
  dpapi: 'Ключ хранится в DPAPI Windows: другой пользователь этого ПК и копия диска его не прочитают.',
  keychain: 'Ключ хранится в связке ключей системы.',
  libsecret: 'Ключ хранится в связке ключей GNOME (libsecret).',
  kwallet: 'Ключ хранится в KWallet.',
  test: 'Тестовое хранилище (только в сборке для разработки).',
  none: '',
};

export function useQuickUnlockStatus(): [QuickUnlockStatus | null, () => void] {
  const [status, setStatus] = useState<QuickUnlockStatus | null>(null);
  const refresh = useCallback(() => void bridge?.quickUnlock.status().then(setStatus), []);
  useEffect(refresh, [refresh]);
  return [status, refresh];
}

/** Settings → Безопасность: quick unlock with a PIN (and a fingerprint through fprintd on Linux). */
export function QuickUnlockSection({ messenger }: { messenger: Messenger }) {
  const [status, refresh] = useQuickUnlockStatus();
  const [dialog, setDialog] = useState(false);
  const toast = useToast();

  if (!bridge) {
    return (
      <div className="section">
        <div className="section-title">
          <KeyRound size={16} /> Быстрый вход
        </div>
        <p>Доступен в приложении для Windows и Linux: PIN вместо пароля, ключ — в защищённом хранилище системы.</p>
      </div>
    );
  }
  if (!status) return null;

  return (
    <div className="section" data-testid="quick-unlock">
      <div className="section-title">
        <KeyRound size={16} /> Быстрый вход
        {status.pin && (
          <span className="chip success" style={{ marginLeft: 'auto' }}>
            PIN включён
          </span>
        )}
      </div>
      {!status.available ? (
        <p>
          {bridge.platform === 'linux'
            ? 'Недоступен: в системе нет связки ключей (GNOME Keyring или KWallet). Без неё ключ пришлось бы хранить на диске почти открытым, поэтому вход — только по паролю.'
            : 'Недоступен: системное хранилище ключей не отвечает. Вход — только по паролю.'}
        </p>
      ) : (
        <>
          <p>
            PIN из 4–8 цифр вместо пароля. {KEYCHAIN_TEXT[status.keychain]} Пять неверных PIN подряд — и войти можно только по паролю. PIN защищает от
            того, кто сел за ваш компьютер, но не от вредоносной программы на нём.
          </p>
          <div className="setting-row" style={{ padding: 0, border: 0 }}>
            <div className="grow">
              <b>Вход по PIN</b>
            </div>
            <Toggle
              label="Вход по PIN"
              on={status.pin}
              onChange={async (on) => {
                if (on) setDialog(true);
                else {
                  await bridge!.quickUnlock.disable('pin');
                  refresh();
                }
              }}
            />
          </div>
          {status.fingerprint.available && (
            <div className="setting-row" style={{ padding: 0, border: 0 }}>
              <div className="grow">
                <b>Отпечаток пальца</b>
                <span>Через fprintd. Ключ выдаётся только после совпадения отпечатка.</span>
              </div>
              <Toggle
                label="Вход по отпечатку"
                on={status.fingerprint.enabled}
                onChange={async (on) => {
                  try {
                    if (on) {
                      const key = messenger.quickUnlockKey();
                      await bridge!.quickUnlock.enableFingerprint(b64(key));
                      key.fill(0);
                    } else await bridge!.quickUnlock.disable('fingerprint');
                    refresh();
                  } catch (e) {
                    toast((e as Error).message, 'error');
                  }
                }}
              />
            </div>
          )}
          {bridge.platform === 'win32' && (
            <div className="notice">
              <Fingerprint size={16} />
              <span>Windows Hello пока не поддерживается: ему нужен подписанный системный модуль. Используйте PIN Veil.</span>
            </div>
          )}
          {bridge.platform === 'linux' && !status.fingerprint.available && (
            <div className="notice">
              <Fingerprint size={16} />
              <span>Вход по отпечатку появится, если установлен fprintd и в системе добавлен отпечаток (fprintd-enroll).</span>
            </div>
          )}
        </>
      )}
      {dialog && (
        <PinDialog
          messenger={messenger}
          onClose={() => setDialog(false)}
          onDone={() => {
            setDialog(false);
            refresh();
            toast('Быстрый вход по PIN включён', 'success');
          }}
        />
      )}
    </div>
  );
}

function PinDialog({ messenger, onClose, onDone }: { messenger: Messenger; onClose(): void; onDone(): void }) {
  const [password, setPassword] = useState('');
  const [pin, setPin] = useState('');
  const [repeat, setRepeat] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    if (!PIN_RE.test(pin)) return setError('PIN — от 4 до 8 цифр');
    if (pin !== repeat) return setError('PIN не совпадает');
    if (/^(\d)\1+$/.test(pin) || '0123456789'.includes(pin) || '9876543210'.includes(pin)) return setError('Слишком простой PIN');
    setBusy(true);
    try {
      if (!(await messenger.checkPassword(password))) {
        setError('Неверный пароль');
        return;
      }
      const key = messenger.quickUnlockKey();
      const blob = await wrapWithPin(key, pin);
      key.fill(0);
      await bridge!.quickUnlock.enablePin(JSON.stringify(blob));
      onDone();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal title="Вход по PIN" onClose={onClose} width={420}>
      <form className="modal-body" onSubmit={submit}>
        <p style={{ margin: 0, color: 'var(--text-2)' }}>
          <ShieldCheck size={15} style={{ verticalAlign: -2, color: 'var(--mint-text)' }} /> Сначала пароль Veil — чтобы PIN мог включить только
          хозяин.
        </p>
        <input className="input" type="password" placeholder="Пароль Veil" aria-label="Пароль Veil" autoFocus value={password} onChange={(e) => setPassword(e.target.value)} />
        <input
          className="input pin-input"
          type="password"
          inputMode="numeric"
          maxLength={8}
          placeholder="Новый PIN, 4–8 цифр"
          aria-label="Новый PIN"
          value={pin}
          onChange={(e) => setPin(e.target.value.replace(/\D/g, ''))}
        />
        <input
          className="input pin-input"
          type="password"
          inputMode="numeric"
          maxLength={8}
          placeholder="Повторите PIN"
          aria-label="Повторите PIN"
          value={repeat}
          onChange={(e) => setRepeat(e.target.value.replace(/\D/g, ''))}
        />
        {error && <span className="field-error">{error}</span>}
        <div className="form-actions">
          <button type="button" className="btn btn-secondary" onClick={onClose}>
            Отмена
          </button>
          <button className="btn btn-primary" style={{ flex: 1 }} disabled={busy || !password || !pin}>
            {busy ? <span className="spinner" /> : 'Включить'}
          </button>
        </div>
      </form>
    </Modal>
  );
}
