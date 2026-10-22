import { ArrowLeftRight, Check, HardDriveDownload, KeyRound, LogOut, Mail, MonitorSmartphone, ShieldCheck, TriangleAlert, UserPlus } from 'lucide-react';
import { useEffect, useState, type FormEvent } from 'react';
import { accountTitle, MAX_ACCOUNTS } from '../../../core/accounts.ts';
import type { DeviceInfo, Messenger } from '../../../core/messenger.ts';
import type { MessengerSnapshot } from '../../../core/types.ts';
import { useAccounts } from '../lib/accounts.tsx';
import { formatDay } from '../lib/format.ts';
import { Avatar, ConfirmDialog, Modal, Toggle } from '../lib/ui.tsx';
import { ExportDialog } from './BackupFile.tsx';

/** Settings → «Аккаунты»: up to two accounts on this device, switching, adding and signing out. */
export function AccountsTab({ messenger, snapshot, onSignedOut }: { messenger: Messenger; snapshot: MessengerSnapshot; onSignedOut(): void }) {
  const api = useAccounts();
  const [adding, setAdding] = useState(false);
  const [leaving, setLeaving] = useState(false);
  if (!api) return null;
  const { me } = snapshot;
  const others = api.accounts.filter((a) => a.slot !== api.slot);
  const hidden = !!api.accounts.find((a) => a.slot === api.slot)?.label?.hidden;

  return (
    <div data-testid="accounts-tab">
      <div className="field-label" style={{ marginBottom: 8 }}>
        На этом устройстве · {api.accounts.length} из {MAX_ACCOUNTS}
      </div>
      <div className="account-list">
        <div className="account-row current">
          <Avatar name={me.displayName} seed={me.userId} size={44} />
          <div className="grow">
            <b>{me.displayName}</b>
            <span>@{me.username}</span>
          </div>
          <span className="chip">
            <Check size={13} /> Открыт
          </span>
        </div>
        {others.map((a) => (
          <div className="account-row" key={a.slot}>
            <span className="account-dot lg">{accountTitle(a).slice(0, 1).toUpperCase()}</span>
            <div className="grow">
              <b>{accountTitle(a)}</b>
              <span>{a.label?.username && !a.label.hidden ? `@${a.label.username} · заблокирован` : 'Заблокирован'}</span>
            </div>
            <button className="btn btn-secondary btn-sm" onClick={() => api.switchTo(a.slot)}>
              <ArrowLeftRight size={15} /> Переключиться
            </button>
          </div>
        ))}
      </div>
      {api.accounts.length < MAX_ACCOUNTS && (
        <button className="btn btn-secondary" style={{ marginTop: 12 }} onClick={() => setAdding(true)}>
          <UserPlus size={16} /> Добавить аккаунт
        </button>
      )}

      <div className="setting-row" style={{ marginTop: 18 }}>
        <div className="grow">
          <b>Скрывать имя на экране входа</b>
          <span>Пока Veil заблокирован, вместо имени будет «Аккаунт {api.slot}» — никто не узнает, чей это аккаунт.</span>
        </div>
        <Toggle label="Скрывать имя на экране входа" on={hidden} onChange={(v) => void api.setNameHidden(v)} />
      </div>

      <div className="section" style={{ marginTop: 18 }}>
        <div className="section-title">
          <ShieldCheck size={16} /> Как это устроено
        </div>
        <ul className="username-facts">
          <li>У каждого аккаунта свой пароль, PIN и отпечаток. Паролем одного аккаунта другой не открыть, данные на диске зашифрованы раздельно.</li>
          <li>Открыт всегда один аккаунт. Сообщения для другого ждут на сервере зашифрованными и придут, когда вы на него переключитесь.</li>
          <li>Войти в аккаунт может только владелец: ключи есть лишь на его устройствах. Пароля от сервера для этого мало.</li>
        </ul>
      </div>

      <div className="section danger-zone" style={{ marginTop: 18 }}>
        <div className="section-title">
          <LogOut size={16} /> Выйти из аккаунта
        </div>
        <p>
          Аккаунт останется на сервере и на других ваших устройствах, а с этого устройства исчезнет вместе с перепиской. Войти снова можно будет так
          же, как на новом устройстве.
        </p>
        <button className="btn btn-danger btn-sm" style={{ alignSelf: 'flex-start' }} onClick={() => setLeaving(true)}>
          <LogOut size={15} /> Выйти из аккаунта
        </button>
      </div>

      {adding && (
        <ConfirmDialog
          title="Добавить аккаунт?"
          text={`Аккаунт @${me.username} заблокируется. Затем можно создать новый аккаунт или войти в существующий: через «Мост» с другого вашего устройства, по коду из письма или из файла .veil.`}
          confirm="Продолжить"
          onClose={() => setAdding(false)}
          onConfirm={() => api.add()}
        />
      )}
      {leaving && <SignOutDialog messenger={messenger} snapshot={snapshot} onClose={() => setLeaving(false)} onSignedOut={onSignedOut} />}
    </div>
  );
}

/**
 * Signing out needs the password (a stranger at an unlocked computer cannot do it), and shows
 * first how the owner will get back in — and a loud warning if there is no way.
 */
function SignOutDialog({
  messenger,
  snapshot,
  onClose,
  onSignedOut,
}: {
  messenger: Messenger;
  snapshot: MessengerSnapshot;
  onClose(): void;
  onSignedOut(): void;
}) {
  const [devices, setDevices] = useState<DeviceInfo[] | null>(null);
  const [password, setPassword] = useState('');
  const [understood, setUnderstood] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    messenger
      .listDevices()
      .then(setDevices)
      .catch(() => setDevices([]));
  }, [messenger]);

  const others = devices?.filter((d) => !d.current).length ?? 0;
  const fileAt = snapshot.settings.backupFileAt;
  const email = snapshot.security.recoveryEmail;
  const ways = [
    { on: others > 0, icon: <MonitorSmartphone size={16} />, title: '«Мост» с другого устройства', text: others > 0 ? `Устройств с этим аккаунтом: ${others}` : 'Других устройств нет' },
    { on: !!email, icon: <Mail size={16} />, title: 'Код из письма', text: email ? `На ${email}. Чаты вернутся из зашифрованной копии на сервере` : 'Почта для восстановления не указана' },
    { on: !!fileAt, icon: <HardDriveDownload size={16} />, title: 'Файл .veil', text: fileAt ? `Копия от ${formatDay(fileAt).toLowerCase()}` : 'Копий ещё не было' },
  ];
  const noWay = devices !== null && !ways.some((w) => w.on);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!password || busy || (noWay && !understood)) return;
    setBusy(true);
    setError('');
    try {
      if (!(await messenger.checkPassword(password))) {
        setPassword('');
        setBusy(false);
        return setError('Неверный пароль');
      }
      await messenger.signOut();
      onSignedOut();
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };

  return (
    <Modal title="Выйти из аккаунта?" onClose={busy ? () => {} : onClose} width={460}>
      <form className="modal-body" onSubmit={(e) => void submit(e)} data-testid="sign-out">
        <span className="field-hint">Как вы войдёте в @{snapshot.me.username} снова:</span>
        <div className="signout-ways">
          {ways.map((w) => (
            <div key={w.title} className={`signout-way${w.on ? ' on' : ''}`}>
              {w.icon}
              <div className="grow">
                <b>{w.title}</b>
                <span>{devices === null ? 'Проверяем…' : w.text}</span>
              </div>
              {w.on && <Check size={16} />}
            </div>
          ))}
        </div>
        <button type="button" className="btn btn-secondary btn-sm" style={{ alignSelf: 'flex-start' }} onClick={() => setExporting(true)}>
          <HardDriveDownload size={15} /> Сохранить копию .veil
        </button>
        {noWay && (
          <div className="callout danger">
            <TriangleAlert size={16} />
            <div>
              <b>Ключи этого аккаунта есть только здесь.</b> После выхода войти в него не сможет никто, даже вы: сервер ваших ключей не хранит.
              Сохраните копию .veil или включите восстановление по почте.
              <label className="check-row">
                <input type="checkbox" checked={understood} onChange={(e) => setUnderstood(e.target.checked)} /> Понимаю, переписка будет потеряна
              </label>
            </div>
          </div>
        )}
        <div className="input-wrap">
          <KeyRound size={18} />
          <input
            className={`input${error ? ' invalid' : ''}`}
            type="password"
            placeholder="Пароль Veil"
            aria-label="Пароль Veil"
            autoFocus
            value={password}
            disabled={busy}
            onChange={(e) => setPassword(e.target.value)}
          />
        </div>
        {error && <span className="field-error">{error}</span>}
        <div className="form-actions">
          <button type="button" className="btn btn-secondary" disabled={busy} onClick={onClose}>
            Отмена
          </button>
          <button className="btn btn-danger" style={{ flex: 1 }} disabled={busy || !password || (noWay && !understood)}>
            {busy ? <span className="spinner" /> : 'Выйти'}
          </button>
        </div>
      </form>
      {exporting && <ExportDialog messenger={messenger} username={snapshot.me.username} onClose={() => setExporting(false)} />}
    </Modal>
  );
}
