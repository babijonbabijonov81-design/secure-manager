import { AtSign, Check, Copy, Loader, TriangleAlert, X } from 'lucide-react';
import { useEffect, useState, type FormEvent } from 'react';
import type { Messenger } from '../../../core/messenger.ts';
import type { MessengerSnapshot } from '../../../core/types.ts';
import { ConfirmDialog, useToast } from '../lib/ui.tsx';

type Availability = 'idle' | 'checking' | 'free' | 'taken' | 'invalid' | 'mine' | 'error';

const HINT: Record<Exclude<Availability, 'idle'>, string> = {
  checking: 'Проверяем…',
  free: 'Свободно — можно занять',
  taken: 'Уже занято другим человеком',
  invalid: 'От 3 до 32 символов: латинские буквы, цифры и _',
  mine: 'Это ваше нынешнее имя',
  error: 'Нет связи с сервером — проверить не получилось',
};

/** Settings → «Имя пользователя»: the @name others find you by, and changing it. */
export function UsernameTab({ messenger, snapshot }: { messenger: Messenger; snapshot: MessengerSnapshot }) {
  const current = snapshot.me.username;
  const [value, setValue] = useState(current);
  const [check, setCheck] = useState<Availability>('mine');
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const toast = useToast();
  const wanted = value.trim().toLowerCase().replace(/^@/, '');

  // Ask the server a moment after typing stops, not on every key.
  useEffect(() => {
    setError('');
    if (wanted === current) return setCheck('mine');
    if (!/^[a-z0-9_]{3,32}$/.test(wanted)) return setCheck('invalid');
    setCheck('checking');
    let alive = true;
    const timer = setTimeout(() => {
      messenger
        .checkUsername(wanted)
        .then((result) => alive && setCheck(result))
        .catch(() => alive && setCheck('error'));
    }, 450);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [wanted, current, messenger]);

  const save = async () => {
    setBusy(true);
    try {
      await messenger.changeUsername(wanted);
      toast(`Теперь вы @${wanted}`, 'success');
    } catch (err) {
      setError((err as Error).message);
      if ((err as { code?: string }).code === 'username_taken') setCheck('taken');
    } finally {
      setBusy(false);
      setConfirm(false);
    }
  };
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (check === 'free') setConfirm(true);
  };

  const Icon = check === 'free' ? Check : check === 'checking' ? Loader : check === 'mine' ? AtSign : check === 'error' ? TriangleAlert : X;
  return (
    <div data-testid="username-tab">
      <div className="username-card">
        <span className="username-at">
          <AtSign size={22} />
        </span>
        <div className="grow">
          <span>Ваше имя пользователя</span>
          <b className="selectable">@{current}</b>
        </div>
        <button
          type="button"
          className="btn btn-secondary btn-sm"
          onClick={() => {
            void navigator.clipboard.writeText(`@${current}`);
            toast('Скопировано', 'success');
          }}
        >
          <Copy size={15} /> Копировать
        </button>
      </div>

      <form className="field" onSubmit={submit} style={{ marginTop: 18 }}>
        <label className="field-label" htmlFor="new-username">
          Новое имя пользователя
        </label>
        <div className="input-wrap">
          <AtSign size={18} />
          <input
            id="new-username"
            className={`input${check === 'taken' || check === 'invalid' ? ' invalid' : ''}`}
            value={value}
            maxLength={33}
            autoComplete="off"
            spellCheck={false}
            aria-describedby="username-hint"
            onChange={(e) => setValue(e.target.value.replace(/\s/g, '').toLowerCase())}
          />
        </div>
        <span id="username-hint" className={`username-hint ${check}`} role="status" aria-live="polite">
          <Icon size={14} className={check === 'checking' ? 'spin' : undefined} /> {HINT[check === 'idle' ? 'mine' : check]}
        </span>
        {error && <span className="field-error">{error}</span>}
        <button className="btn btn-primary" disabled={check !== 'free' || busy} style={{ alignSelf: 'flex-start', marginTop: 4 }}>
          {busy ? <span className="spinner" /> : 'Сменить имя'}
        </button>
      </form>

      <div className="section" style={{ marginTop: 18 }}>
        <div className="section-title">Как это работает</div>
        <ul className="username-facts">
          <li>По имени пользователя вас находят через «Новый чат». Переписка, ключи шифрования и контакты при смене не меняются.</li>
          <li>Собеседники увидят новое имя сами: Veil узнаёт его у сервера, а не из сообщения, поэтому подделать его нельзя.</li>
          <li>Старое имя сразу освобождается, и его может занять кто-то другой. Veil не перепутает: у каждого человека свой ключ.</li>
          <li>Большие и маленькие буквы не различаются: @Anna и @anna — одно имя.</li>
          <li>Менять имя можно до трёх раз в сутки.</li>
        </ul>
      </div>

      {confirm && (
        <ConfirmDialog
          title={`Сменить на @${wanted}?`}
          text={`Имя @${current} освободится, и его сможет занять другой человек. Ссылки-приглашения со старым именем перестанут работать.`}
          confirm="Сменить"
          onClose={() => setConfirm(false)}
          onConfirm={save}
        />
      )}
    </div>
  );
}
