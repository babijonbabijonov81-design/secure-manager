import {
  AlertTriangle,
  ArrowLeft,
  ArrowRight,
  ArrowRightLeft,
  AtSign,
  CheckCircle2,
  EyeOff,
  Eye,
  Globe,
  KeyRound,
  LockKeyhole,
  Server,
  ShieldCheck,
  Timer,
  UserRound,
  Wifi,
  XCircle,
} from 'lucide-react';
import { useEffect, useState, type FormEvent } from 'react';
import { USERNAME_RE } from '../../../../server/src/shared/protocol.ts';
import { createAccount, MessengerError, type Messenger, type MessengerEvents } from '../../../core/messenger.ts';
import { bridge, type EmbeddedServerStatus } from '../../../core/platform.ts';
import { probeServer } from '../../../core/relay-client.ts';
import { RestoreFileFlow } from '../components/BackupFile.tsx';
import { CloudRestoreFlow, useCloudAvailable } from '../components/CloudBackup.tsx';
import { BridgeGuestFlow } from '../components/BridgeFlows.tsx';
import type { StorageBackend } from '../../../core/storage.ts';
import { passwordStrength } from '../lib/format.ts';
import { Backdrop, Logo, Toggle } from '../lib/ui.tsx';
import { RecoveryFlow } from './Recovery.tsx';

type Step = 'welcome' | 'server' | 'profile' | 'creating';
const STEPS: Step[] = ['welcome', 'server', 'profile', 'creating'];
const STRENGTH_COLORS = ['var(--danger)', 'var(--danger)', 'var(--warning)', 'var(--success)', 'var(--success)'];
const STRENGTH_LABELS = ['Слишком короткий', 'Слабый', 'Средний', 'Хороший', 'Отличный'];

export function Onboarding({
  storage,
  events,
  onDone,
  onCancel,
}: {
  storage: StorageBackend;
  events: MessengerEvents;
  onDone(messenger: Messenger): void;
  /** Adding a second account: back to the one already on this device. */
  onCancel?: () => void;
}) {
  const [step, setStep] = useState<Step>('welcome');
  const [server, setServer] = useState('');
  const [probe, setProbe] = useState<{ state: 'idle' | 'checking' | 'ok' | 'error'; text?: string }>({ state: 'idle' });
  const [embedded, setEmbedded] = useState<EmbeddedServerStatus | null>(null);
  const [embeddedBusy, setEmbeddedBusy] = useState(false);
  // Servers other computers run on this Wi-Fi («Свой сервер» there), found over mDNS.
  const [nearby, setNearby] = useState<{ name: string; address: string; id?: string }[] | null>(null);

  const [displayName, setDisplayName] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [password2, setPassword2] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState<{ field?: 'username' | 'password' | 'server'; text: string } | null>(null);
  const [progress, setProgress] = useState({ text: '', value: 0 });
  const [recovering, setRecovering] = useState(false);
  const [transferring, setTransferring] = useState(false);
  const [restoringFile, setRestoringFile] = useState(false);
  const [restoringCloud, setRestoringCloud] = useState(false);
  const cloudAvailable = useCloudAvailable();

  useEffect(() => {
    if (!bridge) {
      setServer(location.hostname ? `${location.hostname}:8787` : 'localhost:8787');
      return;
    }
    void bridge.server.status().then((status) => {
      setEmbedded(status);
      if (status.running) setServer(`localhost:${status.port}`);
    });
    void bridge.server.discover().then(setNearby, () => setNearby([]));
  }, []);

  const toggleEmbedded = async (on: boolean) => {
    if (!bridge) return;
    setEmbeddedBusy(true);
    try {
      const status = on ? await bridge.server.start() : await bridge.server.stop();
      await bridge.server.setAutoStart(on, status.port);
      setEmbedded(status);
      if (status.error) setProbe({ state: 'error', text: status.error });
      else if (on) {
        setServer(`localhost:${status.port}`);
        setProbe({ state: 'idle' });
      }
    } finally {
      setEmbeddedBusy(false);
    }
  };

  const checkServer = async (): Promise<boolean> => {
    setProbe({ state: 'checking' });
    try {
      const info = await probeServer(server);
      setProbe({ state: 'ok', text: `Подключено: ${info.name}` });
      return true;
    } catch (e) {
      setProbe({ state: 'error', text: (e as Error).message });
      return false;
    }
  };

  const submitServer = async (e: FormEvent) => {
    e.preventDefault();
    if (await checkServer()) setStep('profile');
  };

  const strength = passwordStrength(password);
  const cleanUsername = username.trim().toLowerCase().replace(/^@/, '');

  const submitProfile = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!USERNAME_RE.test(cleanUsername))
      return setError({ field: 'username', text: 'От 3 до 32 символов: латинские буквы, цифры и «_»' });
    if (password.length < 8) return setError({ field: 'password', text: 'Пароль должен быть не короче 8 символов' });
    if (password !== password2) return setError({ field: 'password', text: 'Пароли не совпадают' });

    setStep('creating');
    setProgress({ text: 'Генерируем ключи шифрования…', value: 0.1 });
    try {
      const messenger = await createAccount(
        {
          storage,
          serverUrl: server,
          username: cleanUsername,
          displayName: displayName.trim() || cleanUsername,
          password,
          onProgress: (stage, p) => {
            if (stage === 'keys') setProgress({ text: 'Генерируем ключи шифрования…', value: 0.15 });
            if (stage === 'vault') setProgress({ text: 'Шифруем локальное хранилище…', value: 0.2 + (p ?? 0) * 0.6 });
            if (stage === 'register') setProgress({ text: 'Публикуем открытые ключи на сервере…', value: 0.9 });
          },
        },
        events,
      );
      setProgress({ text: 'Готово!', value: 1 });
      setTimeout(() => onDone(messenger), 450);
    } catch (e) {
      const err = e as MessengerError;
      if (err.code === 'username_taken') {
        setError({ field: 'username', text: 'Это имя уже занято — попробуйте другое' });
        setStep('profile');
      } else if (err.code === 'timeout' || err.code === 'offline') {
        setError({ field: 'server', text: err.message });
        setStep('server');
      } else {
        setError({ text: err.message || 'Не удалось создать аккаунт' });
        setStep('profile');
      }
    }
  };

  const index = STEPS.indexOf(step);

  return (
    <>
      <Backdrop />
      {bridge && <div className="titlebar" style={{ background: 'transparent', borderBottom: 0, position: 'fixed', inset: '0 0 auto 0' }} />}
      <div className="center-stage">
        {restoringCloud ? (
          <CloudRestoreFlow storage={storage} events={events} onBack={() => setRestoringCloud(false)} onDone={onDone} />
        ) : restoringFile ? (
          <RestoreFileFlow storage={storage} events={events} onBack={() => setRestoringFile(false)} onDone={onDone} />
        ) : transferring ? (
          <BridgeGuestFlow storage={storage} events={events} onBack={() => setTransferring(false)} onDone={onDone} />
        ) : recovering ? (
          <RecoveryFlow storage={storage} events={events} initialServer={server} onBack={() => setRecovering(false)} onDone={onDone} />
        ) : (
        <div className="glass-card" key={step}>
          {step === 'welcome' && (
            <>
              <div className="brand">
                <div className="brand-logo">
                  <Logo size={76} />
                </div>
                <h1>
                  <span className="gradient-text">{onCancel ? 'Второй аккаунт' : 'Veil'}</span>
                </h1>
                <p>
                  {onCancel
                    ? 'У него будет свой пароль: паролем одного аккаунта другой не открыть.'
                    : 'Мессенджер, в котором ваши слова принадлежат только вам и вашему собеседнику.'}
                </p>
              </div>
              {onCancel ? (
                <div className="features" data-testid="add-account">
                  <div className="feature">
                    <div className="feature-icon">
                      <ShieldCheck size={20} />
                    </div>
                    <div>
                      <b>Войти может только владелец</b>
                      <span>
                        Ключи аккаунта есть только на его устройствах. Войти можно с другого вашего устройства через «Мост» с кодом сверки, по коду
                        из письма или из файла .veil с его паролем.
                      </span>
                    </div>
                  </div>
                </div>
              ) : (
              <div className="features">
                <div className="feature">
                  <div className="feature-icon">
                    <LockKeyhole size={20} />
                  </div>
                  <div>
                    <b>Сквозное шифрование</b>
                    <span>Протокол как в Signal: X3DH + Double Ratchet. Новый ключ для каждого сообщения.</span>
                  </div>
                </div>
                <div className="feature">
                  <div className="feature-icon">
                    <ShieldCheck size={20} />
                  </div>
                  <div>
                    <b>Сервер ничего не знает</b>
                    <span>Он видит только шифротекст, не знает отправителя и удаляет сообщение после доставки.</span>
                  </div>
                </div>
                <div className="feature">
                  <div className="feature-icon">
                    <Timer size={20} />
                  </div>
                  <div>
                    <b>Исчезающие сообщения</b>
                    <span>Переписка удаляется сама, а данные на диске зашифрованы вашим паролем.</span>
                  </div>
                </div>
              </div>
              )}
              <button className="btn btn-primary btn-lg btn-block" onClick={() => setStep('server')}>
                {onCancel ? 'Создать новый аккаунт' : 'Создать аккаунт'} <ArrowRight size={18} />
              </button>
              <button className="btn btn-secondary btn-block" style={{ marginTop: 10 }} onClick={() => setTransferring(true)}>
                <ArrowRightLeft size={17} /> Перенести с другого ПК
              </button>
              <div style={{ textAlign: 'center', marginTop: 14 }}>
                <button className="link-btn" onClick={() => setRecovering(true)}>
                  У меня уже есть аккаунт — восстановить по почте
                </button>
              </div>
              <div style={{ textAlign: 'center', marginTop: 8 }}>
                <button className="link-btn" onClick={() => setRestoringFile(true)}>
                  Восстановить из файла .veil
                </button>
              </div>
              {cloudAvailable && (
                <div style={{ textAlign: 'center', marginTop: 8 }}>
                  <button className="link-btn" onClick={() => setRestoringCloud(true)}>
                    Восстановить из OneDrive
                  </button>
                </div>
              )}
              {onCancel && (
                <div style={{ textAlign: 'center', marginTop: 14 }}>
                  <button className="link-btn" onClick={onCancel}>
                    <ArrowLeft size={14} /> Вернуться к своему аккаунту
                  </button>
                </div>
              )}
            </>
          )}

          {step === 'server' && (
            <form className="form" onSubmit={submitServer}>
              <div className="step-head">
                <Dots index={index} />
                <h2>Подключение к серверу</h2>
                <p>Сервер только пересылает зашифрованные конверты. Прочитать их он не может.</p>
              </div>
              {nearby && nearby.length > 0 && (
                <div className="nearby-servers" data-testid="nearby-servers">
                  <span className="field-label">Серверы Veil в этой сети</span>
                  {nearby.map((n) => (
                    <button
                      key={n.address}
                      type="button"
                      className={`option-card${server === n.address ? ' on' : ''}`}
                      onClick={() => {
                        setServer(n.address);
                        setProbe({ state: 'idle' });
                      }}
                    >
                      <div className="feature-icon">
                        <Wifi size={20} />
                      </div>
                      <div className="grow">
                        <b>{n.name}</b>
                        <span>{n.address}</span>
                      </div>
                      {server === n.address ? <CheckCircle2 size={18} /> : <span className="chip">Выбрать</span>}
                    </button>
                  ))}
                  {embedded?.running && (
                    <span className="field-hint warn">
                      <AlertTriangle size={14} /> На этом компьютере тоже включён свой сервер. Люди с сервера «{nearby[0].name}» на нём не появятся —
                      выберите его выше, чтобы переписываться с ними.
                    </span>
                  )}
                </div>
              )}
              {bridge && (
                <div className={`option-card${embedded?.running ? ' on' : ''}`}>
                  <div className="feature-icon">
                    <Server size={20} />
                  </div>
                  <div className="grow">
                    <b>Свой сервер на этом компьютере</b>
                    <span>
                      Для общения в одной сети Wi-Fi. Включайте только на одном компьютере — остальные подключаются к нему: Veil найдёт его сам или
                      введите адрес, показанный здесь.
                      {bridge.platform === 'win32' && ' Если Windows спросит про брандмауэр, разрешите Veil доступ в частных сетях.'}
                    </span>
                    {embedded?.running && embedded.addresses.length > 0 && (
                      <div className="addresses">
                        {embedded.addresses.map((a) => (
                          <code key={a}>{a}</code>
                        ))}
                      </div>
                    )}
                  </div>
                  {embeddedBusy ? (
                    <span className="spinner" />
                  ) : (
                    <Toggle label="Свой сервер" on={!!embedded?.running} onChange={(v) => void toggleEmbedded(v)} />
                  )}
                </div>
              )}
              <div className="field">
                <label className="field-label" htmlFor="server">
                  Адрес сервера
                </label>
                <div className="input-wrap">
                  <Globe size={18} />
                  <input
                    id="server"
                    className={`input${probe.state === 'error' ? ' invalid' : ''}`}
                    placeholder="relay.example.com или 192.168.1.10:8787"
                    value={server}
                    autoFocus
                    onChange={(e) => {
                      setServer(e.target.value);
                      setProbe({ state: 'idle' });
                    }}
                  />
                </div>
                {probe.state === 'ok' && (
                  <span className="field-hint" style={{ color: 'var(--success)', display: 'flex', gap: 6, alignItems: 'center' }}>
                    <CheckCircle2 size={14} /> {probe.text}
                  </span>
                )}
                {probe.state === 'error' && (
                  <span className="field-error" style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                    <XCircle size={14} /> {probe.text}
                  </span>
                )}
                {error?.field === 'server' && <span className="field-error">{error.text}</span>}
                <span className="field-hint">Собеседник должен использовать тот же сервер. Как развернуть свой — в README.</span>
              </div>
              <div className="form-actions">
                <button type="button" className="btn btn-secondary" onClick={() => setStep('welcome')}>
                  <ArrowLeft size={18} />
                </button>
                <button className="btn btn-primary" disabled={!server.trim() || probe.state === 'checking'}>
                  {probe.state === 'checking' ? <span className="spinner" /> : 'Продолжить'}
                </button>
              </div>
            </form>
          )}

          {step === 'profile' && (
            <form className="form" onSubmit={submitProfile}>
              <div className="step-head">
                <Dots index={index} />
                <h2>Ваш профиль</h2>
                <p>Имя видят только ваши собеседники — оно передаётся в зашифрованном виде.</p>
              </div>
              <div className="field">
                <label className="field-label" htmlFor="name">
                  Имя
                </label>
                <div className="input-wrap">
                  <UserRound size={18} />
                  <input
                    id="name"
                    className="input"
                    placeholder="Как вас называть"
                    value={displayName}
                    maxLength={64}
                    autoFocus
                    onChange={(e) => setDisplayName(e.target.value)}
                  />
                </div>
              </div>
              <div className="field">
                <label className="field-label" htmlFor="username">
                  Имя пользователя
                </label>
                <div className="input-wrap">
                  <AtSign size={18} />
                  <input
                    id="username"
                    className={`input${error?.field === 'username' ? ' invalid' : ''}`}
                    placeholder="username"
                    value={username}
                    maxLength={33}
                    onChange={(e) => setUsername(e.target.value.replace(/\s/g, '').toLowerCase())}
                  />
                </div>
                {error?.field === 'username' ? (
                  <span className="field-error">{error.text}</span>
                ) : (
                  <span className="field-hint">По нему вас найдут. Латиница, цифры и «_»; большие и маленькие буквы не различаются.</span>
                )}
              </div>
              <div className="field">
                <label className="field-label" htmlFor="password">
                  Пароль для входа
                </label>
                <div className="input-wrap">
                  <KeyRound size={18} />
                  <input
                    id="password"
                    type={showPassword ? 'text' : 'password'}
                    className={`input${error?.field === 'password' ? ' invalid' : ''}`}
                    placeholder="Минимум 8 символов"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    style={{ paddingRight: 48 }}
                  />
                  <button
                    type="button"
                    className="icon-btn sm input-action"
                    onClick={() => setShowPassword((v) => !v)}
                    aria-label={showPassword ? 'Скрыть пароль' : 'Показать пароль'}
                  >
                    {showPassword ? <EyeOff size={16} /> : <Eye size={16} />}
                  </button>
                </div>
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
              </div>
              <div className="field">
                <input
                  id="password2"
                  aria-label="Повторите пароль"
                  type={showPassword ? 'text' : 'password'}
                  className={`input${error?.field === 'password' ? ' invalid' : ''}`}
                  placeholder="Повторите пароль"
                  value={password2}
                  onChange={(e) => setPassword2(e.target.value)}
                />
                {error?.field === 'password' && <span className="field-error">{error.text}</span>}
              </div>
              <div className="notice">
                <AlertTriangle size={16} />
                <span>
                  Пароль шифрует все данные на этом устройстве. <b>Его невозможно восстановить</b> — ни мы, ни сервер его не знаем.
                </span>
              </div>
              {error && !error.field && <span className="field-error">{error.text}</span>}
              <div className="form-actions">
                <button type="button" className="btn btn-secondary" onClick={() => setStep('server')}>
                  <ArrowLeft size={18} />
                </button>
                <button className="btn btn-primary">Создать аккаунт</button>
              </div>
            </form>
          )}

          {step === 'creating' && (
            <div className="creating">
              <div className="lock-anim">
                <div className="ring" />
                <div className="ring" />
                <div className="ring" />
                <div className="core">
                  <LockKeyhole size={30} />
                </div>
              </div>
              <div>
                <h2 style={{ margin: '0 0 6px', fontSize: 20 }}>Создаём защищённый аккаунт</h2>
                <p style={{ margin: 0, color: 'var(--text-2)' }}>{progress.text}</p>
              </div>
              <div className="progress">
                <div style={{ width: `${Math.round(progress.value * 100)}%` }} />
              </div>
            </div>
          )}
        </div>
        )}
      </div>
    </>
  );
}

function Dots({ index }: { index: number }) {
  return (
    <div className="steps-dots">
      {[1, 2, 3].map((i) => (
        <span key={i} className={i <= index ? 'on' : ''} />
      ))}
    </div>
  );
}
