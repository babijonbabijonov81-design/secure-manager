import { ArchiveRestore, ArrowLeft, Cloud, CloudUpload, EyeOff, Loader2, LockKeyhole, ShieldCheck } from 'lucide-react';
import { useEffect, useState, type FormEvent } from 'react';
import { readBackupHeader, type BackupHeader } from '../../../core/backup-file.ts';
import { CLOUD_PASSWORD_MIN, restoreBackupFile, type Messenger, type MessengerEvents } from '../../../core/messenger.ts';
import { bridge, cloudApi, type CloudFile } from '../../../core/platform.ts';
import type { StorageBackend } from '../../../core/storage.ts';
import type { MessengerSnapshot } from '../../../core/types.ts';
import { formatDay, formatSize, formatTime, passwordStrength } from '../lib/format.ts';
import { Modal, useToast } from '../lib/ui.tsx';

const STRENGTH_COLORS = ['var(--danger)', 'var(--danger)', 'var(--warning)', 'var(--success)', 'var(--success)'];
const STRENGTH_LABELS = ['Слишком короткий', 'Слабый', 'Средний', 'Хороший', 'Отличный'];

/** Whether this build can sign in with Microsoft at all (desktop app with a client ID). */
export function useCloudAvailable(): boolean | null {
  const [configured, setConfigured] = useState<boolean | null>(bridge ? null : false);
  useEffect(() => {
    void cloudApi?.status().then((s) => setConfigured(s.configured));
  }, []);
  return configured;
}

const when = (ts: number) => `${formatDay(ts).toLowerCase()} в ${formatTime(ts)}`;

/** What Microsoft does and does not get — the same words in settings and before restoring. */
function PrivacyFacts() {
  return (
    <ul className="username-facts">
      <li>Файл шифруется на этом компьютере отдельным паролем копии, и только потом уходит в OneDrive. Microsoft видит зашифрованный файл, его размер и время изменения — ни переписки, ни контактов, ни имени.</li>
      <li>Veil получает доступ только к своей папке «Приложения/Veil», а не ко всему OneDrive. Сервер Veil в этом не участвует.</li>
      <li>Пароль копии Veil не хранит и восстановить не может. Без него копию не откроет никто — ни Microsoft, ни мы.</li>
    </ul>
  );
}

/** Settings → Безопасность: «Копия в OneDrive». */
export function CloudBackupSection({ messenger, snapshot }: { messenger: Messenger; snapshot: MessengerSnapshot }) {
  const available = useCloudAvailable();
  const [enabling, setEnabling] = useState(false);
  const [disabling, setDisabling] = useState(false);
  const toast = useToast();
  const cloud = snapshot.cloud;
  if (!bridge || snapshot.decoy) return null;

  return (
    <div className="section" data-testid="cloud-backup">
      <div className="section-title">
        <Cloud size={16} /> Копия в OneDrive
      </div>
      {available === false ? (
        <p>В этой сборке Veil вход через Microsoft не настроен.</p>
      ) : !cloud ? (
        <>
          <p>
            Раз в день Veil сохраняет зашифрованную копию аккаунта в ваш OneDrive. Потеряли компьютер — войдите через Microsoft на новом и введите пароль
            копии: чаты, контакты и «Избранное» вернутся.
          </p>
          <PrivacyFacts />
          <button className="btn btn-primary btn-sm" style={{ alignSelf: 'flex-start' }} disabled={available === null} onClick={() => setEnabling(true)}>
            <Cloud size={15} /> Подключить OneDrive
          </button>
        </>
      ) : (
        <>
          <span className="field-hint">
            {cloud.busy
              ? 'Сохраняем копию…'
              : cloud.lastAt
                ? `Последняя копия: ${when(cloud.lastAt)}${cloud.size ? ` · ${formatSize(cloud.size)}` : ''}. Следующая — через сутки.`
                : 'Копий ещё не было.'}
          </span>
          {cloud.error && !cloud.busy && <span className="field-error">Не получилось: {cloud.error}</span>}
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button
              className="btn btn-secondary btn-sm"
              disabled={cloud.busy}
              onClick={() =>
                void messenger.cloudUploadNow().then(
                  () => toast('Копия сохранена в OneDrive', 'success'),
                  (e: Error) => toast(e.message, 'error'),
                )
              }
            >
              {cloud.busy ? <Loader2 size={15} className="spin" /> : <CloudUpload size={15} />} Сохранить сейчас
            </button>
            {cloud.error && /заново/.test(cloud.error) && (
              <button className="btn btn-secondary btn-sm" onClick={() => setEnabling(true)}>
                Подключить заново
              </button>
            )}
            <button className="btn btn-secondary btn-sm" disabled={cloud.busy} onClick={() => setDisabling(true)}>
              Отключить
            </button>
          </div>
        </>
      )}
      {enabling && <CloudEnableDialog messenger={messenger} onClose={() => setEnabling(false)} />}
      {disabling && <CloudDisableDialog messenger={messenger} onClose={() => setDisabling(false)} />}
    </div>
  );
}

function CopyPasswordFields({ password, repeat, onPassword, onRepeat }: { password: string; repeat: string; onPassword(v: string): void; onRepeat(v: string): void }) {
  const strength = passwordStrength(password);
  return (
    <>
      <input className="input" type="password" placeholder="Пароль копии" aria-label="Пароль копии" autoFocus value={password} onChange={(e) => onPassword(e.target.value)} />
      {password && (
        <>
          <div className="strength">
            {[0, 1, 2, 3].map((i) => (
              <span key={i} style={{ background: i < strength ? STRENGTH_COLORS[strength] : undefined }} />
            ))}
          </div>
          <span className="field-hint">{STRENGTH_LABELS[strength]}</span>
        </>
      )}
      <input className="input" type="password" placeholder="Повторите пароль копии" aria-label="Повторите пароль копии" value={repeat} onChange={(e) => onRepeat(e.target.value)} />
    </>
  );
}

/** The copy is only as strong as its password: Microsoft (or anyone in the OneDrive) could try guesses offline. */
function copyPasswordProblem(password: string, repeat: string): string {
  if (password.normalize('NFKC').length < CLOUD_PASSWORD_MIN) return `Пароль копии — не короче ${CLOUD_PASSWORD_MIN} символов`;
  if (passwordStrength(password) < 3) return 'Пароль слишком простой: добавьте слов, цифр или знаков';
  if (password !== repeat) return 'Пароли не совпадают';
  return '';
}

function CloudEnableDialog({ messenger, onClose }: { messenger: Messenger; onClose(): void }) {
  const [refresh, setRefresh] = useState<string | null>(null);
  const [waiting, setWaiting] = useState(false);
  const [password, setPassword] = useState('');
  const [repeat, setRepeat] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const toast = useToast();

  const signIn = async () => {
    setError('');
    setWaiting(true);
    try {
      setRefresh(await messenger.cloudSignIn());
    } catch (err) {
      if ((err as { code?: string }).code !== 'cancelled') setError((err as Error).message);
    } finally {
      setWaiting(false);
    }
  };
  const cancel = () => {
    if (waiting) void cloudApi?.cancel();
    onClose();
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const problem = copyPasswordProblem(password, repeat);
    if (problem) return setError(problem);
    setBusy(true);
    setError('');
    try {
      await messenger.enableCloud(refresh!, password);
      toast('Копия сохранена в OneDrive', 'success');
      onClose();
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };

  return (
    <Modal title="Копия в OneDrive" onClose={busy ? () => {} : cancel} width={460}>
      {!refresh ? (
        <div className="modal-body" data-testid="cloud-signin">
          <p>Откроется страница Microsoft в браузере. Veil попросит доступ только к своей папке в OneDrive.</p>
          {error && <span className="field-error">{error}</span>}
          {waiting ? (
            <div className="field-hint" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <Loader2 size={16} className="spin" /> Завершите вход в браузере…
            </div>
          ) : (
            <button className="btn btn-primary btn-block" onClick={() => void signIn()}>
              <Cloud size={16} /> Войти через Microsoft
            </button>
          )}
          {waiting && (
            <button className="btn btn-secondary btn-block" onClick={cancel}>
              Отмена
            </button>
          )}
        </div>
      ) : (
        <form className="modal-body" onSubmit={(e) => void submit(e)} data-testid="cloud-password">
          <span className="field-hint" style={{ display: 'flex', gap: 8 }}>
            <LockKeyhole size={16} style={{ flex: 'none' }} /> OneDrive подключён. Придумайте пароль копии — не такой, как пароль Veil и Microsoft. Veil его не
            запомнит: запишите его и храните отдельно.
          </span>
          <CopyPasswordFields password={password} repeat={repeat} onPassword={setPassword} onRepeat={setRepeat} />
          {error && <span className="field-error">{error}</span>}
          <button className="btn btn-primary btn-block" disabled={busy || !password}>
            {busy ? <span className="spinner" /> : <CloudUpload size={16} />} Зашифровать и сохранить
          </button>
        </form>
      )}
    </Modal>
  );
}

function CloudDisableDialog({ messenger, onClose }: { messenger: Messenger; onClose(): void }) {
  const [remove, setRemove] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  return (
    <Modal title="Отключить копию в OneDrive?" onClose={busy ? () => {} : onClose} width={420}>
      <div className="modal-body">
        <p>Veil перестанет сохранять копию и забудет вход в OneDrive.</p>
        <label className="check-row">
          <input type="checkbox" checked={remove} onChange={(e) => setRemove(e.target.checked)} /> Удалить и саму копию из OneDrive
        </label>
        {error && <span className="field-error">{error}</span>}
        <div className="form-actions">
          <button className="btn btn-secondary" disabled={busy} onClick={onClose}>
            Отмена
          </button>
          <button
            className="btn btn-danger"
            style={{ flex: 1 }}
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              try {
                await messenger.disableCloud(remove);
                onClose();
              } catch (err) {
                setError((err as Error).message);
                setBusy(false);
              }
            }}
          >
            {busy ? <span className="spinner" /> : 'Отключить'}
          </button>
        </div>
      </div>
    </Modal>
  );
}

/** Onboarding → «Восстановить из OneDrive». */
export function CloudRestoreFlow({
  storage,
  events,
  onBack,
  onDone,
}: {
  storage: StorageBackend;
  events: MessengerEvents;
  onBack(): void;
  onDone(messenger: Messenger): void;
}) {
  const [refresh, setRefresh] = useState<string | null>(null);
  const [files, setFiles] = useState<CloudFile[] | null>(null);
  const [copy, setCopy] = useState<{ file: CloudFile; data: Uint8Array; header: BackupHeader } | null>(null);
  const [waiting, setWaiting] = useState(false);
  const [backupPassword, setBackupPassword] = useState('');
  const [password, setPassword] = useState('');
  const [repeat, setRepeat] = useState('');
  const [keepCopying, setKeepCopying] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const fail = (err: unknown) => setError((err as Error).message || 'Не получилось');

  const open = async (token: string, file: CloudFile) => {
    setWaiting(true);
    setError('');
    try {
      const { refresh: next, data } = await cloudApi!.download(token, file.name);
      setRefresh(next);
      setCopy({ file, data, header: readBackupHeader(data).header });
    } catch (err) {
      fail(err);
    } finally {
      setWaiting(false);
    }
  };

  const signIn = async () => {
    setError('');
    setWaiting(true);
    try {
      const token = await cloudApi!.signIn();
      const { refresh: next, files: found } = await cloudApi!.list(token);
      setRefresh(next);
      setFiles(found);
      setWaiting(false);
      if (found.length === 1) await open(next, found[0]);
    } catch (err) {
      fail(err);
      setWaiting(false);
    }
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    if (password.length < 8) return setError('Пароль Veil — не короче 8 символов');
    if (password !== repeat) return setError('Пароли не совпадают');
    setBusy(true);
    try {
      const messenger = await restoreBackupFile({ storage, file: copy!.data, backupPassword, password }, events);
      // The same copy keeps being updated, under the same password.
      if (keepCopying) await messenger.enableCloud(refresh!, backupPassword, { file: copy!.file.name }).catch(() => {});
      else void cloudApi!.forget(refresh!);
      onDone(messenger);
    } catch (err) {
      setError((err as Error).name === 'WrongPasswordError' ? 'Неверный пароль копии' : (err as Error).message);
      setBusy(false);
    }
  };

  return (
    <div className="glass-card bridge-guest" data-testid="cloud-restore">
      <div className="step-head">
        <button
          className="icon-btn sm back"
          onClick={() => {
            if (waiting) void cloudApi?.cancel();
            onBack();
          }}
          aria-label="Назад"
        >
          <ArrowLeft size={18} />
        </button>
        <h2>Восстановление из OneDrive</h2>
        <p>Войдите в тот аккаунт Microsoft, куда Veil сохранял копию, и введите пароль копии.</p>
      </div>
      {!files ? (
        <div className="form">
          <div className="option-card" style={{ cursor: 'default' }}>
            <ShieldCheck size={20} />
            <div className="grow">
              <b>Microsoft не видит вашу переписку</b>
              <span>Копия зашифрована паролем копии. Вход через Microsoft только даёт доступ к файлу.</span>
            </div>
          </div>
          {error && <span className="field-error">{error}</span>}
          <button className="btn btn-primary btn-lg btn-block" disabled={waiting} onClick={() => void signIn()}>
            {waiting ? (
              <>
                <Loader2 size={18} className="spin" /> Завершите вход в браузере…
              </>
            ) : (
              <>
                <Cloud size={18} /> Войти через Microsoft
              </>
            )}
          </button>
        </div>
      ) : !copy ? (
        <div className="form">
          {files.length === 0 ? (
            <p className="field-hint">В этом OneDrive нет копий Veil. Возможно, вы сохраняли её в другой аккаунт Microsoft.</p>
          ) : (
            <>
              <span className="field-hint">Выберите копию:</span>
              {files.map((f) => (
                <button key={f.name} className="option-card" disabled={waiting} onClick={() => void open(refresh!, f)}>
                  <ArchiveRestore size={20} />
                  <div className="grow">
                    <b>Копия от {when(f.modified)}</b>
                    <span>{formatSize(f.size)}</span>
                  </div>
                </button>
              ))}
            </>
          )}
          {waiting && <span className="spinner" />}
          {error && <span className="field-error">{error}</span>}
        </div>
      ) : (
        <form className="form" onSubmit={(e) => void submit(e)}>
          <div className="option-card" style={{ cursor: 'default' }}>
            <ArchiveRestore size={20} />
            <div className="grow">
              <b>Копия от {when(copy.header.createdAt)}</b>
              <span>
                {formatSize(copy.file.size)} · записей: {copy.header.records}
              </span>
            </div>
          </div>
          <div className="input-wrap">
            <EyeOff size={18} />
            <input className="input" type="password" placeholder="Пароль копии" aria-label="Пароль копии" autoFocus value={backupPassword} onChange={(e) => setBackupPassword(e.target.value)} />
          </div>
          <span className="field-hint">Новый пароль Veil для этого компьютера:</span>
          <input className="input" type="password" placeholder="Пароль Veil" aria-label="Новый пароль Veil" value={password} onChange={(e) => setPassword(e.target.value)} />
          <input className="input" type="password" placeholder="Повторите пароль" aria-label="Повторите новый пароль Veil" value={repeat} onChange={(e) => setRepeat(e.target.value)} />
          <label className="check-row">
            <input type="checkbox" checked={keepCopying} onChange={(e) => setKeepCopying(e.target.checked)} /> Продолжать сохранять копию в OneDrive
          </label>
          {error && <span className="field-error">{error}</span>}
          <button className="btn btn-primary btn-lg btn-block" disabled={busy || !backupPassword || !password}>
            {busy ? <span className="spinner" /> : 'Восстановить'}
          </button>
        </form>
      )}
    </div>
  );
}
