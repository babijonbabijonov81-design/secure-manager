import { ArrowRightLeft, Check, KeyRound, ScrollText, ShieldAlert, ShieldCheck, Siren, X } from 'lucide-react';
import { useMemo, useState, type FormEvent } from 'react';
import { formatSafetyNumber } from '../../../core/crypto/fingerprint.ts';
import { WrongPasswordError } from '../../../core/crypto/vault.ts';
import type { Messenger } from '../../../core/messenger.ts';
import { isSavedChat, type MessengerSnapshot, type SecurityEvent, type SecurityEventKind } from '../../../core/types.ts';
import { formatDay, formatTime } from '../lib/format.ts';
import { ConfirmDialog, Modal, Toggle, useToast } from '../lib/ui.tsx';

const BACKUP_FRESH_MS = 31 * 24 * 60 * 60 * 1000;

/** «Защита: 4 из 5» at the top of Settings → Безопасность. */
export function ProtectionBar({ snapshot }: { snapshot: MessengerSnapshot }) {
  const { security, settings } = snapshot;
  // People only: a group has no safety number of its own.
  const contacts = snapshot.contacts.filter((c) => !isSavedChat(c.id) && !c.group && !c.blocked);
  const items = [
    { label: 'Пароль хранилища', ok: true },
    { label: 'Google Authenticator', ok: security.totp },
    { label: 'Резервная копия', ok: !!security.recoveryEmail || (!!settings.backupFileAt && Date.now() - settings.backupFileAt < BACKUP_FRESH_MS) },
    { label: 'Автоблокировка', ok: settings.autoLockMinutes > 0 && settings.autoLockMinutes <= 15 },
    { label: 'Коды сверены', ok: contacts.every((c) => c.verified) },
  ];
  const score = items.filter((i) => i.ok).length;
  return (
    <div className={`protection-bar${score === items.length ? ' ok' : ''}`} data-testid="protection-bar">
      <div className="protection-head">
        <ShieldCheck size={18} />
        <b>
          Защита: {score} из {items.length}
        </b>
      </div>
      <div className="protection-meter" aria-hidden="true">
        {items.map((i) => (
          <i key={i.label} className={i.ok ? 'on' : ''} />
        ))}
      </div>
      <ul className="protection-items">
        {items.map((i) => (
          <li key={i.label} className={i.ok ? 'ok' : ''}>
            {i.ok ? <Check size={13} /> : <X size={13} />} {i.label}
          </li>
        ))}
      </ul>
    </div>
  );
}

/** The 12-group safety number with one contact, picked from a list. */
export function SafetyCodeCard({ messenger, snapshot }: { messenger: Messenger; snapshot: MessengerSnapshot }) {
  const contacts = snapshot.contacts.filter((c) => !isSavedChat(c.id) && !c.group);
  const [id, setId] = useState(() => (contacts.find((c) => !c.verified) ?? contacts[0])?.id ?? '');
  const contact = contacts.find((c) => c.id === id);
  const groups = useMemo(() => (contact ? formatSafetyNumber(messenger.safetyNumber(contact.id)) : []), [messenger, contact]);
  return (
    <div className="section">
      <div className="section-title">
        <ShieldCheck size={16} /> Код безопасности
      </div>
      {!contact ? (
        <p>Появится, когда у вас будут собеседники: 12 групп по 5 цифр, одинаковые у вас обоих.</p>
      ) : (
        <>
          <select className="input" aria-label="Собеседник" value={id} onChange={(e) => setId(e.target.value)}>
            {contacts.map((c) => (
              <option key={c.id} value={c.id}>
                {c.displayName}
                {c.verified ? ' — сверен' : ''}
              </option>
            ))}
          </select>
          <div className={`safety-grid${contact.verified ? ' verified' : ''}`}>
            {groups.map((g, i) => (
              <span key={i}>{g}</span>
            ))}
          </div>
          <p>Сравните код с собеседником при встрече или по телефону. Совпал — значит, ключи никто не подменил.</p>
          {!contact.verified && (
            <button className="btn btn-sm btn-primary" onClick={() => messenger.setVerified(contact.id, true)}>
              Коды совпадают — отметить как сверенный
            </button>
          )}
        </>
      )}
    </div>
  );
}

export function BridgeCard({ onOpen }: { onOpen(): void }) {
  return (
    <div className="section">
      <div className="section-title">
        <ArrowRightLeft size={16} /> Мост
      </div>
      <p>Перенесите аккаунт на другой компьютер — по локальной сети, с проверкой шести цифр на обоих экранах.</p>
      <button className="btn btn-sm btn-secondary" onClick={onOpen}>
        Устройства и перенос
      </button>
    </div>
  );
}

/** «Аварийный пароль»: a second password that opens an empty Veil. */
export function DuressSection({ messenger, snapshot }: { messenger: Messenger; snapshot: MessengerSnapshot }) {
  const duress = snapshot.security.duress;
  const [dialog, setDialog] = useState(false);
  const [confirmOff, setConfirmOff] = useState(false);
  const toast = useToast();
  return (
    <div className="section" data-testid="duress">
      <div className="section-title">
        <Siren size={16} /> Аварийный пароль
        {duress && <span className={`chip ${duress.wipe ? 'danger' : 'success'}`} style={{ marginLeft: 'auto' }}>{duress.wipe ? 'Стирает всё' : 'Включён'}</span>}
      </div>
      <p>
        Если вас заставят открыть Veil, введите аварийный пароль: откроется пустой Veil с вашим именем — без чатов и «Избранного». Настоящие данные
        не трогаются и не видны, а время входа и экран те же.
      </p>
      <details className="threats">
        <summary>Схема угроз: от чего защищает, а от чего нет</summary>
        <ul>
          <li className="ok">Человек смотрит на экран и листает чаты — видит пустой Veil.</li>
          <li className="ok">Человек засекает время входа — оно одинаковое.</li>
          <li className="no">Человек знает про эту функцию и требует второй пароль — поможет только «Стереть всё при вводе».</li>
          <li className="no">Экспертиза диска покажет, что зашифрованных данных больше, чем видно. Прочитать их без настоящего пароля нельзя.</li>
          <li className="no">Собеседники видят, что вы не в сети, пока открыт пустой Veil. Быстрый вход по PIN открывает настоящий Veil.</li>
        </ul>
      </details>
      <div className="setting-row" style={{ padding: 0, border: 0 }}>
        <div className="grow">
          <b>Аварийный пароль</b>
        </div>
        <Toggle label="Аварийный пароль" on={!!duress} onChange={(on) => (on ? setDialog(true) : setConfirmOff(true))} />
      </div>
      {dialog && (
        <DuressDialog
          messenger={messenger}
          onClose={() => setDialog(false)}
          onDone={(wipe) => {
            setDialog(false);
            toast(wipe ? 'Аварийный пароль сотрёт всё при вводе' : 'Аварийный пароль включён', 'success');
          }}
        />
      )}
      {confirmOff && (
        <ConfirmDialog
          title="Выключить аварийный пароль?"
          text="Пустой Veil будет удалён, аварийный пароль перестанет работать."
          confirm="Выключить"
          onClose={() => setConfirmOff(false)}
          onConfirm={() => messenger.disableDuress()}
        />
      )}
    </div>
  );
}

function DuressDialog({ messenger, onClose, onDone }: { messenger: Messenger; onClose(): void; onDone(wipe: boolean): void }) {
  const [password, setPassword] = useState('');
  const [repeat, setRepeat] = useState('');
  const [wipe, setWipe] = useState(false);
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    if (password.length < 8) return setError('Аварийный пароль — не короче 8 символов');
    if (password !== repeat) return setError('Пароли не совпадают');
    if (wipe && typed.trim().toUpperCase() !== 'СТЕРЕТЬ') return setError('Чтобы включить стирание, введите слово СТЕРЕТЬ');
    setBusy(true);
    try {
      await messenger.enableDuress(password, { wipe });
      onDone(wipe);
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };
  return (
    <Modal title="Аварийный пароль" onClose={onClose} width={460}>
      <form className="modal-body" onSubmit={(e) => void submit(e)}>
        <p style={{ margin: 0, color: 'var(--text-2)' }}>
          Придумайте пароль, который не похож на настоящий и который вы вспомните в стрессе.
        </p>
        <input className="input" type="password" placeholder="Аварийный пароль" aria-label="Аварийный пароль" autoFocus value={password} onChange={(e) => setPassword(e.target.value)} />
        <input className="input" type="password" placeholder="Повторите аварийный пароль" aria-label="Повторите аварийный пароль" value={repeat} onChange={(e) => setRepeat(e.target.value)} />
        <label className="check-row">
          <input type="checkbox" checked={wipe} onChange={(e) => setWipe(e.target.checked)} />
          <span>
            <b>Стереть всё при вводе</b>
            <span>Аварийный пароль сначала удалит настоящую переписку, ключи и «Избранное» с этого ПК. Вернуть их будет нельзя.</span>
          </span>
        </label>
        {wipe && (
          <div className="notice warn">
            <ShieldAlert size={16} />
            <span>
              Второе подтверждение: введите слово <b>СТЕРЕТЬ</b>.
              <input className="input" aria-label="Подтверждение стирания" value={typed} onChange={(e) => setTyped(e.target.value)} style={{ marginTop: 8 }} />
            </span>
          </div>
        )}
        {error && <span className="field-error">{error}</span>}
        <div className="form-actions">
          <button type="button" className="btn btn-secondary" onClick={onClose}>
            Отмена
          </button>
          <button className={`btn ${wipe ? 'btn-danger' : 'btn-primary'}`} style={{ flex: 1 }} disabled={busy}>
            {busy ? <span className="spinner" /> : <KeyRound size={16} />} {wipe ? 'Включить со стиранием' : 'Включить'}
          </button>
        </div>
      </form>
    </Modal>
  );
}

const EVENT_TEXT: Record<SecurityEventKind, (detail?: string) => string> = {
  login: (d) => `Вход в Veil${d === 'pin' ? ' по PIN' : d === 'fingerprint' ? ' по отпечатку' : ' по паролю'}`,
  login_failed: (d) => `Неверный пароль или PIN перед входом: ${d ?? 1}`,
  device_new: (d) => `Новый компьютер в аккаунте${d ? `: ${d}` : ''}`,
  device_revoked: (d) => `Компьютер отвязан${d ? `: ${d}` : ''}`,
  transfer_in: () => 'Аккаунт перенесён на этот компьютер (Мост)',
  key_change: (d) => `Сменился ключ контакта${d ? ` «${d}»` : ''}`,
  password_change: () => 'Пароль Veil изменён',
  totp_on: () => 'Google Authenticator подключён',
  totp_off: () => 'Google Authenticator отключён',
  email_on: (d) => `Почта для восстановления: ${d ?? 'указана'}`,
  email_off: () => 'Восстановление по почте отключено',
  duress_on: (d) => `Аварийный пароль включён${d ? ` (${d})` : ''}`,
  duress_off: () => 'Аварийный пароль выключен',
  backup_export: () => 'Сохранена резервная копия .veil',
  cloud_on: () => 'Включена копия в OneDrive',
  cloud_off: () => 'Копия в OneDrive выключена',
  backup_import: () => 'Аккаунт восстановлен из файла .veil',
  username_change: (d) => `Имя пользователя изменено${d ? `: ${d}` : ''}`,
  invite_mismatch: (d) => `Ключ ${d ?? 'контакта'} не совпал с приглашением — контакт не добавлен`,
};

/** Events someone else could have caused: they get «Это не я». */
const SUSPICIOUS = new Set<SecurityEventKind>(['login', 'username_change', 'login_failed', 'device_new', 'password_change', 'totp_off', 'email_on', 'email_off', 'duress_off', 'backup_export', 'cloud_on']);

/** «Журнал безопасности»: local, encrypted, with «Это не я» on each event. */
export function SecurityLogSection({ messenger, snapshot, onDevices }: { messenger: Messenger; snapshot: MessengerSnapshot; onDevices(): void }) {
  const [all, setAll] = useState(false);
  const [notMe, setNotMe] = useState<SecurityEvent | null>(null);
  const events = snapshot.securityLog.slice(0, all ? 200 : 6);
  return (
    <div className="section" data-testid="security-log">
      <div className="section-title">
        <ScrollText size={16} /> Журнал безопасности
      </div>
      <p>Хранится только на этом компьютере, зашифрованным. Увидели то, чего не делали, — нажмите «Это не я».</p>
      {events.length === 0 && <span className="field-hint">Пока событий нет.</span>}
      <ul className="log-list">
        {events.map((e) => (
          <li key={e.id} className={`log-row ${e.kind}`}>
            <span className="grow">
              <b>{EVENT_TEXT[e.kind]?.(e.detail) ?? e.kind}</b>
              <span>
                {formatDay(e.ts)}, {formatTime(e.ts)}
              </span>
            </span>
            {SUSPICIOUS.has(e.kind) && (
              <button className="btn btn-sm btn-ghost" onClick={() => setNotMe(e)}>
                Это не я
              </button>
            )}
          </li>
        ))}
      </ul>
      {snapshot.securityLog.length > 6 && (
        <button className="link-btn" onClick={() => setAll((v) => !v)}>
          {all ? 'Свернуть' : `Показать всё (${snapshot.securityLog.length})`}
        </button>
      )}
      {notMe && <NotMeDialog messenger={messenger} event={notMe} onClose={() => setNotMe(null)} onDevices={onDevices} />}
    </div>
  );
}

/** «Это не я»: change the password and unlink other computers, step by step. */
function NotMeDialog({ messenger, event, onClose, onDevices }: { messenger: Messenger; event: SecurityEvent; onClose(): void; onDevices(): void }) {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [repeat, setRepeat] = useState('');
  const [changed, setChanged] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    if (next.length < 8) return setError('Новый пароль — не короче 8 символов');
    if (next !== repeat) return setError('Пароли не совпадают');
    setBusy(true);
    try {
      await messenger.changePassword(current, next);
      setChanged(true);
      toast('Пароль изменён', 'success');
    } catch (err) {
      setError(err instanceof WrongPasswordError ? 'Текущий пароль введён неверно' : (err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal title="Это не я" onClose={onClose} width={480}>
      <div className="modal-body">
        <div className="notice warn">
          <ShieldAlert size={16} />
          <span>
            «{EVENT_TEXT[event.kind]?.(event.detail)}» — {formatDay(event.ts).toLowerCase()} в {formatTime(event.ts)}. Если это были не вы, сделайте два
            шага ниже.
          </span>
        </div>
        <form className="section" onSubmit={(e) => void submit(e)}>
          <div className="section-title">
            <span className="step-num">1</span> Смените пароль Veil
          </div>
          {changed ? (
            <span className="chip success">Пароль изменён</span>
          ) : (
            <>
              <input className="input" type="password" placeholder="Текущий пароль" aria-label="Текущий пароль (это не я)" value={current} onChange={(e) => setCurrent(e.target.value)} />
              <input className="input" type="password" placeholder="Новый пароль" aria-label="Новый пароль (это не я)" value={next} onChange={(e) => setNext(e.target.value)} />
              <input className="input" type="password" placeholder="Повторите новый пароль" aria-label="Повторите новый пароль (это не я)" value={repeat} onChange={(e) => setRepeat(e.target.value)} />
              {error && <span className="field-error">{error}</span>}
              <button className="btn btn-primary btn-sm" disabled={busy || !current || !next}>
                {busy ? <span className="spinner" /> : 'Сменить пароль'}
              </button>
            </>
          )}
        </form>
        <div className="section">
          <div className="section-title">
            <span className="step-num">2</span> Отвяжите чужие компьютеры
          </div>
          <p>В «Устройствах» видно, с каких компьютеров входили в аккаунт. Отвяжите те, что не ваши.</p>
          <button
            className="btn btn-secondary btn-sm"
            onClick={() => {
              onClose();
              onDevices();
            }}
          >
            Открыть «Устройства»
          </button>
        </div>
        <p className="field-hint" style={{ margin: 0 }}>
          Если кто-то знает ваш пароль и скопировал файлы Veil, этого мало: заведите новый аккаунт и сообщите собеседникам. Включите Google Authenticator,
          чтобы без телефона войти было нельзя.
        </p>
      </div>
    </Modal>
  );
}
