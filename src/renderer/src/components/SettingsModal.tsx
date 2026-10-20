import {
  Check,
  DownloadCloud,
  Info,
  KeyRound,
  LockKeyhole,
  Mail,
  Maximize,
  Monitor,
  Moon,
  Palette,
  RefreshCw,
  Server,
  ShieldCheck,
  Smartphone,
  Sun,
  Trash2,
  TriangleAlert,
  UserRound,
  X,
} from 'lucide-react';
import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { WrongPasswordError } from '../../../core/crypto/vault.ts';
import type { Messenger } from '../../../core/messenger.ts';
import type { AccountStatus } from '../../../../server/src/shared/protocol.ts';
import { bridge, type EmbeddedServerStatus, type UpdateState } from '../../../core/platform.ts';
import { probeServer } from '../../../core/relay-client.ts';
import type { Accent, MessengerSnapshot, Settings, Theme } from '../../../core/types.ts';
import { formatDay, formatTime } from '../lib/format.ts';
import { Avatar, ConfirmDialog, Logo, Modal, Toggle, useEscape, useToast } from '../lib/ui.tsx';
import { CodeInput, RecoveryEmailDialog, TotpDisableDialog, TotpSetupDialog } from './SecurityDialogs.tsx';

export type SettingsTab = 'profile' | 'privacy' | 'appearance' | 'server' | 'security' | 'about';

const TABS: { id: SettingsTab; label: string; icon: ReactNode }[] = [
  { id: 'profile', label: 'Профиль', icon: <UserRound size={18} /> },
  { id: 'privacy', label: 'Конфиденциальность', icon: <ShieldCheck size={18} /> },
  { id: 'appearance', label: 'Оформление', icon: <Palette size={18} /> },
  { id: 'server', label: 'Сервер', icon: <Server size={18} /> },
  { id: 'security', label: 'Безопасность', icon: <KeyRound size={18} /> },
  { id: 'about', label: 'О Veil', icon: <Info size={18} /> },
];

const ACCENTS: { id: Accent; colors: [string, string] }[] = [
  { id: 'violet', colors: ['#7c5cff', '#4f8cff'] },
  { id: 'blue', colors: ['#2f7bff', '#00b3d6'] },
  { id: 'teal', colors: ['#0fb59d', '#3fbf5a'] },
  { id: 'rose', colors: ['#f0437a', '#ff7a59'] },
  { id: 'amber', colors: ['#f59e0b', '#f2555a'] },
];

interface Props {
  messenger: Messenger;
  snapshot: MessengerSnapshot;
  initialTab?: SettingsTab;
  onClose(): void;
  onDeleted(): void;
}

export function SettingsModal({ messenger, snapshot, initialTab = 'profile', onClose, onDeleted }: Props) {
  const [tab, setTab] = useState<SettingsTab>(initialTab);
  useEscape(onClose);
  const set = (patch: Partial<Settings>) => messenger.updateSettings(patch);
  const s = snapshot.settings;

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal settings-modal" role="dialog" aria-modal="true">
        <nav className="settings-nav">
          <h3>Настройки</h3>
          {TABS.map((t) => (
            <button key={t.id} className={tab === t.id ? 'active' : ''} onClick={() => setTab(t.id)}>
              {t.icon}
              {t.label}
            </button>
          ))}
        </nav>
        <div className="settings-content">
          <div className="modal-head">
            <h3>{TABS.find((t) => t.id === tab)?.label}</h3>
            <button className="icon-btn sm" onClick={onClose} aria-label="Закрыть">
              <X size={18} />
            </button>
          </div>
          <div className="modal-body">
            {tab === 'profile' && <ProfileTab messenger={messenger} snapshot={snapshot} />}
            {tab === 'privacy' && (
              <div>
                <div className="field" style={{ marginBottom: 6 }}>
                  <span className="field-label">Время последнего захода</span>
                  <div className="segmented">
                    <button className={s.lastSeen === 'everyone' ? 'active' : ''} onClick={() => set({ lastSeen: 'everyone' })}>
                      «в сети» и время захода
                    </button>
                    <button className={s.lastSeen === 'nobody' ? 'active' : ''} onClick={() => set({ lastSeen: 'nobody' })}>
                      «был(а) недавно»
                    </button>
                  </div>
                  <span className="field-hint">
                    {s.lastSeen === 'everyone'
                      ? 'Собеседники видят, когда вы в сети и когда заходили. Статус передаётся только им и в зашифрованном виде.'
                      : 'Собеседники видят только «был(а) недавно» — ни статуса «в сети», ни точного времени.'}
                  </span>
                </div>
                <Row title="Отчёты о прочтении" text="Собеседник увидит, что вы прочитали сообщение. Если выключить — вы тоже не увидите его отчёты.">
                  <Toggle label="Отчёты о прочтении" on={s.readReceipts} onChange={(v) => set({ readReceipts: v })} />
                </Row>
                <Row title="Индикатор набора" text="Показывать «печатает…». Передаётся только в зашифрованном виде.">
                  <Toggle label="Индикатор набора" on={s.typingIndicators} onChange={(v) => set({ typingIndicators: v })} />
                </Row>
                <Row title="Уведомления" text="Системные уведомления о новых сообщениях.">
                  <Toggle label="Уведомления" on={s.notifications} onChange={(v) => set({ notifications: v })} />
                </Row>
                <Row title="Текст в уведомлениях" text="Если выключено, уведомление покажет только имя — текст не попадёт в системный журнал.">
                  <Toggle label="Текст в уведомлениях" on={s.notificationPreview} onChange={(v) => set({ notificationPreview: v })} />
                </Row>
                {bridge && (
                  <Row title="Красивые уведомления" text="Карточки Veil в углу экрана вместо системных уведомлений.">
                    <Toggle
                      label="Красивые уведомления"
                      on={s.notificationStyle === 'veil'}
                      onChange={(v) => set({ notificationStyle: v ? 'veil' : 'system' })}
                    />
                  </Row>
                )}
                <Row title="Звуки" text="Короткий сигнал при новом сообщении.">
                  <Toggle label="Звуки" on={s.sounds} onChange={(v) => set({ sounds: v })} />
                </Row>
                {bridge && bridge.platform !== 'linux' && (
                  <Row title="Защита от снимков экрана" text="Окно Veil будет чёрным на скриншотах, записях и при демонстрации экрана.">
                    <Toggle label="Защита от снимков экрана" on={s.screenProtection} onChange={(v) => set({ screenProtection: v })} />
                  </Row>
                )}
                <Row title="Автоблокировка" text="Заблокировать Veil после бездействия. Ключи удаляются из памяти.">
                  <select
                    className="input"
                    style={{ width: 150, height: 38 }}
                    value={s.autoLockMinutes}
                    onChange={(e) => set({ autoLockMinutes: Number(e.target.value) })}
                  >
                    <option value={0}>Никогда</option>
                    <option value={1}>1 минута</option>
                    <option value={5}>5 минут</option>
                    <option value={15}>15 минут</option>
                    <option value={60}>1 час</option>
                  </select>
                </Row>
              </div>
            )}
            {tab === 'appearance' && (
              <div>
                <div className="field" style={{ marginBottom: 18 }}>
                  <span className="field-label">Тема</span>
                  <div className="segmented">
                    {(
                      [
                        ['dark', 'Тёмная', <Moon size={15} key="d" />],
                        ['light', 'Светлая', <Sun size={15} key="l" />],
                        ['system', 'Системная', <Monitor size={15} key="s" />],
                      ] as [Theme, string, ReactNode][]
                    ).map(([id, label, icon]) => (
                      <button key={id} className={s.theme === id ? 'active' : ''} onClick={() => set({ theme: id })}>
                        {icon}
                        {label}
                      </button>
                    ))}
                  </div>
                </div>
                <div className="field" style={{ marginBottom: 10 }}>
                  <span className="field-label">Акцентный цвет</span>
                  <div className="accent-swatches">
                    {ACCENTS.map((a) => (
                      <button
                        key={a.id}
                        className={s.accent === a.id ? 'active' : ''}
                        style={{ background: `linear-gradient(135deg, ${a.colors[0]}, ${a.colors[1]})` }}
                        onClick={() => set({ accent: a.id })}
                        aria-label={a.id}
                      >
                        {s.accent === a.id && <Check size={16} />}
                      </button>
                    ))}
                  </div>
                </div>
                <Row title="Отправка по Enter" text="Иначе — Ctrl+Enter (⌘+Enter на Mac), а Enter переносит строку.">
                  <Toggle label="Отправка по Enter" on={s.enterToSend} onChange={(v) => set({ enterToSend: v })} />
                </Row>
                <Row title="Проверка орфографии" text="Подчёркивать слова с ошибками. Правый клик — варианты исправления.">
                  <Toggle label="Проверка орфографии" on={s.spellcheck} onChange={(v) => set({ spellcheck: v })} />
                </Row>
                <Row title="Автоисправление" text="Исправлять опечатки после пробела. Backspace сразу после исправления — отменить.">
                  <Toggle label="Автоисправление" on={s.autocorrect} onChange={(v) => set({ autocorrect: v })} />
                </Row>
                {bridge && (
                  <Row title="Во весь экран" text="Также клавиша F11 (на Mac — ⌃⌘F).">
                    <button className="btn btn-secondary btn-sm" onClick={() => bridge!.toggleFullscreen()}>
                      <Maximize size={15} /> Переключить
                    </button>
                  </Row>
                )}
              </div>
            )}
            {tab === 'server' && <ServerTab messenger={messenger} snapshot={snapshot} />}
            {tab === 'security' && <SecurityTab messenger={messenger} snapshot={snapshot} onDeleted={onDeleted} />}
            {tab === 'about' && <AboutTab />}
          </div>
        </div>
      </div>
    </div>
  );
}

function Row({ title, text, children }: { title: string; text?: string; children: ReactNode }) {
  return (
    <div className="setting-row">
      <div className="grow">
        <b>{title}</b>
        {text && <span>{text}</span>}
      </div>
      {children}
    </div>
  );
}

function ProfileTab({ messenger, snapshot }: { messenger: Messenger; snapshot: MessengerSnapshot }) {
  const [name, setName] = useState(snapshot.me.displayName);
  const toast = useToast();
  return (
    <>
      <div className="profile-hero" style={{ flexDirection: 'row', textAlign: 'left', gap: 16 }}>
        <Avatar name={snapshot.me.displayName} seed={snapshot.me.userId} size={72} />
        <div>
          <h4>{snapshot.me.displayName}</h4>
          <span className="handle selectable">@{snapshot.me.username}</span>
        </div>
      </div>
      <form
        className="field"
        onSubmit={(e) => {
          e.preventDefault();
          void messenger.updateProfile(name).then(() => toast('Имя обновлено', 'success'));
        }}
      >
        <label className="field-label" htmlFor="display-name">
          Отображаемое имя
        </label>
        <div style={{ display: 'flex', gap: 8 }}>
          <input id="display-name" className="input" value={name} maxLength={64} onChange={(e) => setName(e.target.value)} />
          <button className="btn btn-primary" disabled={!name.trim() || name.trim() === snapshot.me.displayName}>
            Сохранить
          </button>
        </div>
        <span className="field-hint">Передаётся собеседникам внутри зашифрованных сообщений, сервер его не знает.</span>
      </form>
      <div className="field">
        <span className="field-label">Ключ личности</span>
        <code className="selectable" style={{ fontFamily: 'var(--mono)', fontSize: 12, color: 'var(--text-2)', wordBreak: 'break-all' }}>
          {snapshot.me.userId}
        </code>
        <span className="field-hint">Публичный ключ Ed25519. Приватный ключ никогда не покидает это устройство.</span>
      </div>
    </>
  );
}

function ServerTab({ messenger, snapshot }: { messenger: Messenger; snapshot: MessengerSnapshot }) {
  const [url, setUrl] = useState(snapshot.me.serverUrl);
  const [embedded, setEmbedded] = useState<EmbeddedServerStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const toast = useToast();

  useEffect(() => {
    void bridge?.server.status().then(setEmbedded);
  }, []);

  const statusText = { online: 'Подключено', connecting: 'Подключение…', offline: 'Нет соединения' }[snapshot.status];

  return (
    <>
      <div className="option-card" style={{ cursor: 'default' }}>
        <span className={`status-pill ${snapshot.status}`}>
          <span className="status-dot" />
          {statusText}
        </span>
        <div className="grow">
          <b className="selectable" style={{ wordBreak: 'break-all' }}>
            {snapshot.me.serverUrl}
          </b>
          {snapshot.statusError && <span style={{ color: 'var(--danger)' }}>{snapshot.statusError}</span>}
        </div>
        <button className="btn btn-secondary btn-sm" onClick={() => messenger.reconnect()}>
          <RefreshCw size={15} /> Переподключить
        </button>
      </div>
      <div className="field">
        <label className="field-label" htmlFor="server-url">
          Сменить сервер
        </label>
        <div style={{ display: 'flex', gap: 8 }}>
          <input id="server-url" className="input" value={url} onChange={(e) => setUrl(e.target.value)} />
          <button className="btn btn-secondary" disabled={!url.trim() || url.trim() === snapshot.me.serverUrl} onClick={() => setConfirm(true)}>
            Применить
          </button>
        </div>
        <span className="field-hint">На новом сервере вы зарегистрируетесь заново с теми же ключами. Собеседники тоже должны перейти на него.</span>
      </div>
      {bridge && (
        <div className="section">
          <div className="section-title">
            <Server size={16} /> Встроенный сервер
          </div>
          <p>
            Запускает ретранслятор Veil прямо на этом компьютере. Друзья в той же сети могут подключиться по адресам ниже. Для общения через
            интернет разверните сервер на хостинге (см. README).
          </p>
          <div className="setting-row" style={{ padding: 0, border: 0 }}>
            <div className="grow">
              <b>{embedded?.running ? `Работает на порту ${embedded.port}` : 'Выключен'}</b>
              {embedded?.error && <span style={{ color: 'var(--danger)' }}>{embedded.error}</span>}
            </div>
            {busy ? (
              <span className="spinner" />
            ) : (
              <Toggle
                label="Встроенный сервер"
                on={!!embedded?.running}
                onChange={async (on) => {
                  setBusy(true);
                  try {
                    const status = on ? await bridge!.server.start() : await bridge!.server.stop();
                    await bridge!.server.setAutoStart(on, status.port);
                    setEmbedded(status);
                  } finally {
                    setBusy(false);
                  }
                }}
              />
            )}
          </div>
          {embedded?.running && (
            <div className="addresses">
              {embedded.addresses.map((a) => (
                <code key={a}>{a}</code>
              ))}
            </div>
          )}
        </div>
      )}
      {confirm && (
        <ConfirmDialog
          title="Сменить сервер?"
          text="Вы переподключитесь к новому серверу. Сообщения со старого сервера больше не будут приходить."
          confirm="Сменить"
          onClose={() => setConfirm(false)}
          onConfirm={async () => {
            try {
              await probeServer(url);
            } catch (e) {
              toast((e as Error).message, 'error');
              return;
            }
            messenger.setServerUrl(url);
            toast('Сервер изменён', 'success');
          }}
        />
      )}
    </>
  );
}

function SecurityTab({ messenger, snapshot, onDeleted }: { messenger: Messenger; snapshot: MessengerSnapshot; onDeleted(): void }) {
  const [oldPassword, setOld] = useState('');
  const [newPassword, setNew] = useState('');
  const [repeat, setRepeat] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [dialog, setDialog] = useState<'totp' | 'totp-off' | 'email' | 'email-off' | 'delete' | null>(null);
  const [status, setStatus] = useState<AccountStatus | null>(null);
  const [backingUp, setBackingUp] = useState(false);
  const toast = useToast();
  const { security } = snapshot;

  useEffect(() => {
    messenger
      .accountStatus()
      .then(setStatus)
      .catch(() => setStatus(null));
  }, [messenger, security.totp, security.recoveryEmail]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    if (newPassword.length < 8) return setError('Новый пароль должен быть не короче 8 символов');
    if (newPassword !== repeat) return setError('Пароли не совпадают');
    setBusy(true);
    try {
      await messenger.changePassword(oldPassword, newPassword);
      setOld('');
      setNew('');
      setRepeat('');
      toast('Пароль изменён', 'success');
    } catch (err) {
      setError(err instanceof WrongPasswordError ? 'Текущий пароль введён неверно' : (err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const mailMissing = status && !status.mail;

  return (
    <>
      <div className="section">
        <div className="section-title">
          <Smartphone size={16} /> Двухфакторная аутентификация
          {security.totp && <span className="chip success" style={{ marginLeft: 'auto' }}>Включена</span>}
        </div>
        <p>
          Код из Google Authenticator будет нужен при каждом входе в Veil и при восстановлении аккаунта. Даже зная пароль, без вашего телефона
          войти не получится.
        </p>
        {security.totp ? (
          <button className="btn btn-secondary btn-sm" onClick={() => setDialog('totp-off')}>
            Отключить
          </button>
        ) : (
          <button className="btn btn-primary btn-sm" onClick={() => setDialog('totp')} disabled={snapshot.status !== 'online'}>
            Подключить Google Authenticator
          </button>
        )}
      </div>

      <div className="section">
        <div className="section-title">
          <Mail size={16} /> Восстановление по почте
          {security.recoveryEmail && <span className="chip success" style={{ marginLeft: 'auto' }}>Включено</span>}
        </div>
        {security.recoveryEmail ? (
          <>
            <p>
              Почта: <b className="selectable">{security.recoveryEmail}</b>
              <br />
              Резервная копия (ключи, контакты, текст переписки, зашифровано паролем):{' '}
              {security.lastBackupAt ? `обновлена ${formatDay(security.lastBackupAt).toLowerCase()} в ${formatTime(security.lastBackupAt)}` : 'ещё не создана'}
            </p>
            <div className="form-actions" style={{ marginTop: 0 }}>
              <button
                className="btn btn-secondary btn-sm"
                disabled={backingUp || snapshot.status !== 'online'}
                onClick={async () => {
                  setBackingUp(true);
                  try {
                    await messenger.backupNow();
                    toast('Резервная копия обновлена', 'success');
                  } catch (e) {
                    toast((e as Error).message, 'error');
                  } finally {
                    setBackingUp(false);
                  }
                }}
              >
                {backingUp ? <span className="spinner" /> : <RefreshCw size={15} />} Обновить копию
              </button>
              <button className="btn btn-ghost btn-sm" onClick={() => setDialog('email')}>
                Сменить почту
              </button>
              <button className="btn btn-ghost btn-sm" onClick={() => setDialog('email-off')}>
                Отключить
              </button>
            </div>
          </>
        ) : (
          <>
            <p>Если вы смените компьютер или переустановите Veil, аккаунт и переписку можно будет вернуть по коду из письма и вашему паролю.</p>
            <button className="btn btn-primary btn-sm" onClick={() => setDialog('email')} disabled={snapshot.status !== 'online' || !!mailMissing}>
              Указать почту
            </button>
          </>
        )}
        {mailMissing && (
          <div className="notice">
            <TriangleAlert size={16} />
            <span>Ваш сервер не настроен для отправки писем. Владельцу сервера нужно указать почтовый сервис (инструкция в README, раздел «Почта»).</span>
          </div>
        )}
      </div>

      <form className="section" onSubmit={submit}>
        <div className="section-title">
          <LockKeyhole size={16} /> Смена пароля
        </div>
        <input className="input" type="password" placeholder="Текущий пароль" aria-label="Текущий пароль" value={oldPassword} onChange={(e) => setOld(e.target.value)} />
        <input className="input" type="password" placeholder="Новый пароль" aria-label="Новый пароль" value={newPassword} onChange={(e) => setNew(e.target.value)} />
        <input className="input" type="password" placeholder="Повторите новый пароль" aria-label="Повторите новый пароль" value={repeat} onChange={(e) => setRepeat(e.target.value)} />
        {error && <span className="field-error">{error}</span>}
        <button className="btn btn-primary" disabled={busy || !oldPassword || !newPassword}>
          {busy ? <span className="spinner" /> : 'Изменить пароль'}
        </button>
      </form>

      <div className="section" style={{ borderColor: 'rgba(255,92,122,0.25)' }}>
        <div className="section-title" style={{ color: 'var(--danger)' }}>
          <Trash2 size={16} style={{ color: 'var(--danger)' }} /> Удаление аккаунта
        </div>
        <p>Аккаунт будет удалён с сервера вместе с резервной копией, а все ключи и переписка — с этого устройства. Отменить это нельзя.</p>
        <button className="btn btn-danger btn-sm" onClick={() => setDialog('delete')}>
          Удалить аккаунт навсегда
        </button>
      </div>

      {dialog === 'totp' && <TotpSetupDialog messenger={messenger} onClose={() => setDialog(null)} />}
      {dialog === 'totp-off' && <TotpDisableDialog messenger={messenger} onClose={() => setDialog(null)} />}
      {dialog === 'email' && <RecoveryEmailDialog messenger={messenger} onClose={() => setDialog(null)} />}
      {dialog === 'email-off' && <RemoveEmailDialog messenger={messenger} needsTotp={security.totp} onClose={() => setDialog(null)} />}
      {dialog === 'delete' && <DeleteAccountDialog messenger={messenger} needsTotp={security.totp} onClose={() => setDialog(null)} onDeleted={onDeleted} />}
    </>
  );
}

function RemoveEmailDialog({ messenger, needsTotp, onClose }: { messenger: Messenger; needsTotp: boolean; onClose(): void }) {
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  return (
    <Modal title="Отключить восстановление?" onClose={onClose} width={420}>
      <form
        className="modal-body"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          try {
            await messenger.removeRecoveryEmail(needsTotp ? code : undefined);
            onClose();
          } catch (err) {
            setError((err as Error).message);
            setBusy(false);
          }
        }}
      >
        <p>Резервная копия будет удалена с сервера. Без неё аккаунт нельзя будет вернуть на новом устройстве.</p>
        {needsTotp && <CodeInput value={code} onChange={setCode} label="Код из Google Authenticator" autoFocus />}
        {error && <span className="field-error">{error}</span>}
        <div className="form-actions">
          <button type="button" className="btn btn-secondary" onClick={onClose}>
            Отмена
          </button>
          <button className="btn btn-danger" style={{ flex: 1 }} disabled={busy || (needsTotp && code.length !== 6)}>
            {busy ? <span className="spinner" /> : 'Отключить'}
          </button>
        </div>
      </form>
    </Modal>
  );
}

function DeleteAccountDialog({
  messenger,
  needsTotp,
  onClose,
  onDeleted,
}: {
  messenger: Messenger;
  needsTotp: boolean;
  onClose(): void;
  onDeleted(): void;
}) {
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  return (
    <Modal title="Удалить аккаунт?" onClose={onClose} width={420}>
      <form
        className="modal-body"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          try {
            await messenger.deleteAccount(needsTotp ? code : undefined);
            onDeleted();
          } catch (err) {
            setError((err as Error).message);
            setBusy(false);
          }
        }}
      >
        <p>Все сообщения, контакты и ключи будут уничтожены. Имя пользователя освободится.</p>
        {needsTotp && <CodeInput value={code} onChange={setCode} label="Код из Google Authenticator" autoFocus />}
        {error && <span className="field-error">{error}</span>}
        <div className="form-actions">
          <button type="button" className="btn btn-secondary" onClick={onClose}>
            Отмена
          </button>
          <button className="btn btn-danger" style={{ flex: 1 }} disabled={busy || (needsTotp && code.length !== 6)}>
            {busy ? <span className="spinner" /> : 'Удалить навсегда'}
          </button>
        </div>
      </form>
    </Modal>
  );
}

function UpdatesSection() {
  const [state, setState] = useState<UpdateState | null>(null);
  useEffect(() => {
    if (!bridge) return;
    void bridge.update.state().then(setState);
    return bridge.update.onState(setState);
  }, []);
  if (!bridge || !state) return null;
  const text: Record<UpdateState['status'], string> = {
    idle: 'Обновления проверяются автоматически',
    checking: 'Проверяем обновления…',
    available: `Доступна версия ${state.version}`,
    none: 'У вас последняя версия',
    downloading: `Загрузка обновления… ${state.percent ?? 0}%`,
    ready: `Версия ${state.version} загружена и готова к установке`,
    error: state.error ?? 'Не удалось проверить обновления',
  };
  return (
    <div className="section">
      <div className="section-title">
        <DownloadCloud size={16} /> Обновления
      </div>
      <p style={state.status === 'error' ? { color: 'var(--danger)' } : undefined}>{text[state.status]}</p>
      {state.status === 'downloading' && (
        <div className="progress">
          <div style={{ width: `${state.percent ?? 0}%` }} />
        </div>
      )}
      <div className="form-actions" style={{ marginTop: 0 }}>
        {state.status === 'available' && (
          <button className="btn btn-primary btn-sm" onClick={() => bridge!.update.download()}>
            {state.manual ? 'Скачать новую версию' : 'Загрузить и установить'}
          </button>
        )}
        {state.status === 'ready' && (
          <button className="btn btn-primary btn-sm" onClick={() => bridge!.update.install()}>
            Перезапустить и обновить
          </button>
        )}
        {['idle', 'none', 'error'].includes(state.status) && (
          <button className="btn btn-secondary btn-sm" onClick={() => void bridge!.update.check()}>
            <RefreshCw size={15} /> Проверить сейчас
          </button>
        )}
      </div>
    </div>
  );
}

function AboutTab() {
  const items = [
    ['Обмен ключами', 'X3DH: X25519 + подписанные Ed25519 предключи'],
    ['Шифрование сообщений', 'Double Ratchet, XChaCha20-Poly1305, HKDF-SHA256'],
    ['Метаданные', 'Sealed sender: сервер не знает отправителя; размер скрыт дополнением Padmé'],
    ['Хранение на диске', 'Все данные зашифрованы ключом из пароля (scrypt, 128 МиБ)'],
    ['Проверка собеседника', '60-значный код безопасности'],
    ['Вход', 'Пароль + Google Authenticator (TOTP), по желанию'],
  ];
  return (
    <>
      <div className="brand" style={{ marginBottom: 8 }}>
        <Logo size={64} />
        <h1 style={{ fontSize: 24 }}>
          <span className="gradient-text">Veil</span>
        </h1>
        <p>Версия {bridge?.version ?? '1.1.0'} · открытый исходный код</p>
      </div>
      <UpdatesSection />
      <div className="section">
        {items.map(([title, text]) => (
          <div key={title} className="setting-row" style={{ padding: '8px 0' }}>
            <div className="grow">
              <b>{title}</b>
              <span>{text}</span>
            </div>
          </div>
        ))}
      </div>
    </>
  );
}
