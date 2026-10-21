import { ArrowRightLeft, Check, KeyRound, ShieldAlert, ShieldCheck, Siren, X } from 'lucide-react';
import { useMemo, useState, type FormEvent } from 'react';
import { formatSafetyNumber } from '../../../core/crypto/fingerprint.ts';
import type { Messenger } from '../../../core/messenger.ts';
import { isSavedChat, type MessengerSnapshot } from '../../../core/types.ts';
import { ConfirmDialog, Modal, Toggle, useToast } from '../lib/ui.tsx';

const BACKUP_FRESH_MS = 31 * 24 * 60 * 60 * 1000;

/** «Защита: 4 из 5» at the top of Settings → Безопасность. */
export function ProtectionBar({ snapshot }: { snapshot: MessengerSnapshot }) {
  const { security, settings } = snapshot;
  const contacts = snapshot.contacts.filter((c) => !isSavedChat(c.id) && !c.blocked);
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
  const contacts = snapshot.contacts.filter((c) => !isSavedChat(c.id));
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
