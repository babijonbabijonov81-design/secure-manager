import { Fingerprint, KeyRound, ShieldCheck } from 'lucide-react';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { b64 } from '../../../../server/src/shared/wire.ts';
import type { Messenger } from '../../../core/messenger.ts';
import { bridge, type QuickUnlockStatus } from '../../../core/platform.ts';
import { isOldPin, isTrivialPin, PIN_RE, wrapWithPin, type PinBlob } from '../../../core/quick-unlock.ts';
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
  const [oldPin, setOldPin] = useState(false);
  const toast = useToast();
  // A PIN from before 2.2.3 (maybe 4 digits, faster scrypt): suggest a new one.
  useEffect(() => {
    if (!status?.pin) return setOldPin(false);
    void bridge?.quickUnlock.loadPin().then((blob) => {
      try {
        setOldPin(!!blob && isOldPin(JSON.parse(blob) as PinBlob));
      } catch {
        setOldPin(false);
      }
    });
  }, [status?.pin]);

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
            PIN из 6–12 цифр вместо пароля. {KEYCHAIN_TEXT[status.keychain]} Пять неверных PIN подряд — и войти можно только по паролю. PIN
            защищает от того, кто сел за ваш компьютер. От вредоносной программы, запущенной под вашим пользователем, — нет: она может скопировать
            зашифрованный ключ и перебирать PIN у себя, без счётчика попыток. Поэтому PIN не бывает короче 6 цифр, а каждая проверка нарочно
            занимает около секунды. Если на компьютере могут быть чужие программы, входите по паролю.
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
          {oldPin && (
            <div className="callout danger" data-testid="old-pin">
              <KeyRound size={16} />
              <div>
                Этот PIN задан в прежней версии Veil: он может быть из 4 цифр и проверяется быстро, поэтому подобрать его легче.{' '}
                <button type="button" className="link-btn" onClick={() => setDialog(true)}>
                  Задать новый PIN
                </button>
              </div>
            </div>
          )}
          {status.fingerprint.available && (
            <div className="setting-row" style={{ padding: 0, border: 0 }}>
              <div className="grow">
                <b>{bridge.platform === 'darwin' ? 'Touch ID' : 'Отпечаток пальца'}</b>
                <span>
                  {bridge.platform === 'darwin' ? 'Через Touch ID' : 'Через fprintd'}. Ключ выдаётся только после совпадения отпечатка.
                </span>
              </div>
              <Toggle
                label={bridge.platform === 'darwin' ? 'Вход по Touch ID' : 'Вход по отпечатку'}
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
    if (!PIN_RE.test(pin)) return setError('PIN — от 6 до 12 цифр');
    if (pin !== repeat) return setError('PIN не совпадает');
    if (isTrivialPin(pin)) return setError('Слишком простой PIN: не повторяйте цифры и не идите подряд');
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
          maxLength={12}
          placeholder="Новый PIN, 6–12 цифр"
          aria-label="Новый PIN"
          value={pin}
          onChange={(e) => setPin(e.target.value.replace(/\D/g, ''))}
        />
        <input
          className="input pin-input"
          type="password"
          inputMode="numeric"
          maxLength={12}
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
