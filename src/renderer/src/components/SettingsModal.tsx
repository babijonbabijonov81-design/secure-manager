import {
  ArrowRightLeft,
  AtSign,
  Copy,
  DownloadCloud,
  Info,
  KeyRound,
  LockKeyhole,
  Mail,
  Maximize,
  Mic,
  Monitor,
  MonitorSmartphone,
  Moon,
  Palette,
  RefreshCw,
  Server,
  ShieldCheck,
  Smartphone,
  Sun,
  ToggleRight,
  Trash2,
  TriangleAlert,
  UserRound,
  UsersRound,
  Volume2,
  Wifi,
  X,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type FormEvent, type ReactNode } from 'react';
import { WrongPasswordError } from '../../../core/crypto/vault.ts';
import { fingerprintOf, type DeviceInfo, type Messenger } from '../../../core/messenger.ts';
import type { AccountStatus } from '../../../../server/src/shared/protocol.ts';
import { bridge, type EmbeddedServerStatus, type UpdateState } from '../../../core/platform.ts';
import { probeServer } from '../../../core/relay-client.ts';
import { FEATURE_NAMES, type AudioSettings, type FeatureName, type MessengerSnapshot, type Settings, type Theme } from '../../../core/types.ts';
import { canChooseOutput, meterStream, openMicrophone, Tones, useAudioDevices } from '../lib/audio.ts';
import { formatDay, formatTime } from '../lib/format.ts';
import { feature } from '../lib/hooks.ts';
import { transcribeAvailable } from '../lib/transcribe.ts';
import { TranscribeSettings } from './Transcribe.tsx';
import { UsernameTab } from './UsernameTab.tsx';
import { AccountsTab } from './AccountsTab.tsx';
import { isOwnServer } from '../lib/shield.ts';
import { Avatar, ConfirmDialog, Logo, Modal, Toggle, useEscape, useToast } from '../lib/ui.tsx';
import { BackupFileSection } from './BackupFile.tsx';
import { CloudBackupSection } from './CloudBackup.tsx';
import { BridgeHostDialog } from './BridgeFlows.tsx';
import { HiddenChatsSettings } from './HiddenChats.tsx';
import { QuickUnlockSection } from './QuickUnlock.tsx';
import { BridgeCard, DuressSection, ProtectionBar, SafetyCodeCard, SecurityLogSection } from './SecurityCards.tsx';
import { CodeInput, RecoveryEmailDialog, TotpDisableDialog, TotpSetupDialog } from './SecurityDialogs.tsx';

export type SettingsTab = 'profile' | 'username' | 'accounts' | 'privacy' | 'appearance' | 'audio' | 'server' | 'security' | 'devices' | 'features' | 'about';

const TABS: { id: SettingsTab; label: string; icon: ReactNode }[] = [
  { id: 'profile', label: 'Профиль', icon: <UserRound size={18} /> },
  { id: 'username', label: 'Имя пользователя', icon: <AtSign size={18} /> },
  { id: 'accounts', label: 'Аккаунты', icon: <UsersRound size={18} /> },
  { id: 'privacy', label: 'Конфиденциальность', icon: <ShieldCheck size={18} /> },
  { id: 'appearance', label: 'Оформление', icon: <Palette size={18} /> },
  { id: 'audio', label: 'Аудио', icon: <Mic size={18} /> },
  { id: 'server', label: 'Сервер', icon: <Server size={18} /> },
  { id: 'security', label: 'Безопасность', icon: <KeyRound size={18} /> },
  { id: 'devices', label: 'Устройства', icon: <MonitorSmartphone size={18} /> },
  { id: 'features', label: 'Функции', icon: <ToggleRight size={18} /> },
  { id: 'about', label: 'О Veil', icon: <Info size={18} /> },
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
  const [systemLock, setSystemLock] = useState<boolean | null>(null);
  useEffect(() => void bridge?.systemLockSupported().then(setSystemLock), []);

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal settings-modal" role="dialog" aria-modal="true">
        <nav className="settings-nav">
          <h3>Настройки</h3>
          {TABS.filter((t) => t.id !== 'devices' || feature(s, 'bridge')).map((t) => (
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
            {tab === 'username' && <UsernameTab messenger={messenger} snapshot={snapshot} />}
            {tab === 'accounts' && <AccountsTab messenger={messenger} snapshot={snapshot} onSignedOut={onDeleted} />}
            {tab === 'privacy' && (
              <div>
                <div className="field-label" style={{ marginBottom: 2 }}>
                  Присутствие
                </div>
                <span className="field-hint">
                  Правило взаимности: что вы скрываете от других, того не видите и у них.
                  {feature(s, 'presence') && ' Для отдельного контакта это можно изменить в его Щите чата.'}
                </span>
                <Row
                  title="«В сети» и время захода"
                  text={s.lastSeen === 'everyone' ? 'Собеседники видят, когда вы в сети и когда заходили. Передаётся только им и в зашифрованном виде.' : 'Собеседники видят только «был(а) недавно».'}
                >
                  <Toggle label="В сети и время захода" on={s.lastSeen === 'everyone'} onChange={(v) => set({ lastSeen: v ? 'everyone' : 'nobody' })} />
                </Row>
                <Row title="Отчёты о прочтении" text="Собеседник увидит, что вы прочитали сообщение. Если выключить — вы тоже не увидите его отчёты.">
                  <Toggle label="Отчёты о прочтении" on={s.readReceipts} onChange={(v) => set({ readReceipts: v })} />
                </Row>
                <Row title="Индикатор набора" text="Показывать «печатает…». Если выключить — вы тоже не увидите, что собеседник печатает.">
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
                {bridge && bridge.platform !== 'linux' ? (
                  <Row title="Защита от снимков экрана" text="Окно Veil будет чёрным на скриншотах, записях и при демонстрации экрана.">
                    <Toggle label="Защита от снимков экрана" on={s.screenProtection} onChange={(v) => set({ screenProtection: v })} />
                  </Row>
                ) : (
                  <Row
                    title="Защита от снимков экрана"
                    text={
                      bridge
                        ? 'На Linux недоступно: ни X11, ни Wayland не дают приложению надёжно спрятать окно от записи. Включите Вуаль — она размывает входящие.'
                        : 'Работает только в приложении для Windows.'
                    }
                  >
                    <span className="chip">Недоступно</span>
                  </Row>
                )}
                {feature(s, 'veil') && (
                  <div className="field" style={{ margin: '14px 0 6px' }}>
                    <span className="field-label">Вуаль</span>
                    <div className="setting-row" style={{ paddingTop: 0 }}>
                      <div className="grow">
                        <span>Вуаль размывает входящие, пока не наведёшь курсор. Кнопка на панели слева или Ctrl+Shift+V.</span>
                      </div>
                      <Toggle label="Вуаль" on={s.veil} onChange={(v) => set({ veil: v })} />
                    </div>
                    <div className="segmented">
                      <button className={s.veilScope === 'all' ? 'active' : ''} onClick={() => set({ veilScope: 'all' })}>
                        Во всех чатах
                      </button>
                      <button className={s.veilScope === 'selected' ? 'active' : ''} onClick={() => set({ veilScope: 'selected' })}>
                        В выбранных
                      </button>
                    </div>
                    {s.veilScope === 'selected' && <span className="field-hint">Включите Вуаль для нужного чата в его Щите.</span>}
                  </div>
                )}
                {feature(s, 'hiddenChats') && <HiddenChatsSettings messenger={messenger} snapshot={snapshot} />}
                {feature(s, 'stripMeta') && (
                  <Row title="Удалять метаданные" text="Перед шифрованием из фото убираются геометка и данные камеры, из PDF и Office — автор и программа.">
                    <Toggle label="Удалять метаданные" on={s.stripMetadata} onChange={(v) => set({ stripMetadata: v })} />
                  </Row>
                )}
                {feature(s, 'clipboard') && (
                  <Row title="Очищать буфер обмена" text="Скопированный из «Избранного» пароль стирается, если в буфере всё ещё он.">
                    <select
                      className="input"
                      style={{ width: 150, height: 44 }}
                      aria-label="Очищать буфер обмена"
                      value={s.clipboardSeconds}
                      onChange={(e) => set({ clipboardSeconds: Number(e.target.value) })}
                    >
                      <option value={15}>Через 15 с</option>
                      <option value={30}>Через 30 с</option>
                      <option value={60}>Через 60 с</option>
                      <option value={0}>Не очищать</option>
                    </select>
                  </Row>
                )}
                {feature(s, 'linkPreviews') && (
                  <Row
                    title="Превью ссылок"
                    text="Превью делает ваш Veil при отправке и передаёт его зашифрованным; собеседник ссылку не открывает. Сайт при этом увидит ваш IP-адрес."
                  >
                    <Toggle label="Превью ссылок" on={s.linkPreviews} onChange={(v) => set({ linkPreviews: v })} />
                  </Row>
                )}
                {feature(s, 'keyGuard') && (
                  <Row title="Не отправлять, пока не сверю" text="Если ключ собеседника изменился, сообщения ему не уйдут, пока вы не сверите код безопасности.">
                    <Toggle label="Не отправлять, пока не сверю" on={s.holdUntilVerified} onChange={(v) => set({ holdUntilVerified: v })} />
                  </Row>
                )}
                <Row title="Автоблокировка" text="Заблокировать Veil после бездействия. Ключи удаляются из памяти.">
                  <select
                    className="input"
                    style={{ width: 150, height: 44 }}
                    aria-label="Автоблокировка"
                    value={s.autoLockMinutes}
                    onChange={(e) => set({ autoLockMinutes: Number(e.target.value) })}
                  >
                    <option value={1}>Через 1 минуту</option>
                    <option value={5}>Через 5 минут</option>
                    <option value={15}>Через 15 минут</option>
                    {![0, 1, 5, 15].includes(s.autoLockMinutes) && <option value={s.autoLockMinutes}>Через {s.autoLockMinutes} мин</option>}
                    <option value={0}>Никогда</option>
                  </select>
                </Row>
                {bridge && (
                  <Row title="Вместе с экраном компьютера" text={systemLock === false ? lockOnSystemMissing : lockOnSystemHint}>
                    {systemLock === false ? (
                      <span className="chip">Недоступно</span>
                    ) : (
                      <Toggle label="Блокировать вместе с экраном компьютера" on={s.lockOnSystemLock} onChange={(v) => set({ lockOnSystemLock: v })} />
                    )}
                  </Row>
                )}
                {bridge && (
                  <Row title="При сворачивании в трей" text="Закрыли окно — Veil заблокируется и продолжит принимать сообщения в фоне.">
                    <Toggle label="Блокировать при сворачивании в трей" on={s.lockOnHide} onChange={(v) => set({ lockOnHide: v })} />
                  </Row>
                )}
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
            {tab === 'audio' && <AudioTab messenger={messenger} snapshot={snapshot} />}
            {tab === 'server' && <ServerTab messenger={messenger} snapshot={snapshot} />}
            {tab === 'security' && <SecurityTab messenger={messenger} snapshot={snapshot} onDeleted={onDeleted} onDevices={() => setTab('devices')} />}
            {tab === 'devices' && <DevicesTab messenger={messenger} snapshot={snapshot} onMoved={onDeleted} />}
            {tab === 'features' && <FeaturesTab snapshot={snapshot} set={set} />}
            {tab === 'about' && <AboutTab />}
          </div>
        </div>
      </div>
    </div>
  );
}

const lockOnSystemMissing =
  'На этой системе блокировку экрана отследить нельзя (нет gdbus). Включите автоблокировку по времени или при сворачивании в трей.';

const lockOnSystemHint =
  bridge?.platform === 'linux'
    ? 'Когда вы блокируете экран (GNOME, KDE и другие окружения с logind или ScreenSaver).'
    : 'Когда вы блокируете компьютер (Win+L) или он уходит в сон.';

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

/** Microphone and speakers for calls and voice messages. */
function AudioTab({ messenger, snapshot }: { messenger: Messenger; snapshot: MessengerSnapshot }) {
  const audio = snapshot.settings.audio;
  const setAudio = (patch: Partial<AudioSettings>) => messenger.updateSettings({ audio: { ...audio, ...patch } });
  const { inputs, outputs, cameras, refresh } = useAudioDevices();
  const meter = useRef<HTMLDivElement>(null);
  const [micError, setMicError] = useState('');
  const tones = useMemo(() => new Tones(), []);
  useEffect(() => () => tones.stop(), [tones]);
  const { hasTurn } = messenger.iceServers;

  // Live level of the chosen microphone while this tab is open (this also reveals device names).
  const { input, echoCancellation, noiseSuppression, autoGainControl } = audio;
  useEffect(() => {
    let cancelled = false;
    let stopMeter = () => {};
    let stream: MediaStream | null = null;
    openMicrophone({ input, output: '', echoCancellation, noiseSuppression, autoGainControl, camera: '' })
      .then((opened) => {
        stream = opened;
        if (cancelled) return opened.getTracks().forEach((t) => t.stop());
        setMicError('');
        void refresh();
        stopMeter = meterStream(opened, (level) => meter.current?.style.setProperty('--level', level.toFixed(3)));
      })
      .catch((error: Error) => !cancelled && setMicError(error.message));
    return () => {
      cancelled = true;
      stopMeter();
      stream?.getTracks().forEach((t) => t.stop());
    };
  }, [input, echoCancellation, noiseSuppression, autoGainControl, refresh]);

  const missing = (list: MediaDeviceInfo[], id: string) => id && !list.some((d) => d.deviceId === id);
  return (
    <div>
      <div className="field" style={{ marginBottom: 16 }}>
        <label className="field-label" htmlFor="audio-input">
          Микрофон
        </label>
        <select id="audio-input" className="input" value={audio.input} onChange={(e) => setAudio({ input: e.target.value })}>
          <option value="">Как в системе</option>
          {inputs.map((d, i) => (
            <option key={d.deviceId} value={d.deviceId}>
              {d.label || `Микрофон ${i + 1}`}
            </option>
          ))}
          {missing(inputs, audio.input) && <option value={audio.input}>Отключённый микрофон</option>}
        </select>
        <div className="mic-meter" ref={meter} aria-hidden="true">
          {Array.from({ length: 24 }, (_, i) => (
            <i key={i} style={{ '--i': i / 24 } as CSSProperties} />
          ))}
        </div>
        <span className={micError ? 'field-error' : 'field-hint'}>{micError || 'Скажите что-нибудь — полоска должна двигаться.'}</span>
      </div>

      {canChooseOutput && (
        <div className="field" style={{ marginBottom: 12 }}>
          <label className="field-label" htmlFor="audio-output">
            Динамики или наушники
          </label>
          <div className="audio-output">
            <select id="audio-output" className="input" value={audio.output} onChange={(e) => setAudio({ output: e.target.value })}>
              <option value="">Как в системе</option>
              {outputs.map((d, i) => (
                <option key={d.deviceId} value={d.deviceId}>
                  {d.label || `Устройство ${i + 1}`}
                </option>
              ))}
              {missing(outputs, audio.output) && <option value={audio.output}>Отключённое устройство</option>}
            </select>
            <button
              className="btn btn-secondary btn-sm"
              onClick={() => {
                tones.setOutput(audio.output);
                tones.play('test');
              }}
            >
              <Volume2 size={15} /> Проверить
            </button>
          </div>
        </div>
      )}

      {feature(snapshot.settings, 'video') && (
        <div className="field" style={{ marginBottom: 12 }}>
          <label className="field-label" htmlFor="video-camera">
            Камера для видеозвонков
          </label>
          <select id="video-camera" className="input" value={audio.camera} onChange={(e) => setAudio({ camera: e.target.value })}>
            <option value="">Как в системе</option>
            {cameras.map((d, i) => (
              <option key={d.deviceId} value={d.deviceId}>
                {d.label || `Камера ${i + 1}`}
              </option>
            ))}
            {missing(cameras, audio.camera) && <option value={audio.camera}>Отключённая камера</option>}
          </select>
          <span className="field-hint">Камера включается только в видеозвонке, когда вы нажимаете «Камера» или «С видео».</span>
        </div>
      )}

      {feature(snapshot.settings, 'transcribe') && transcribeAvailable() && <TranscribeSettings messenger={messenger} snapshot={snapshot} />}

      <Row title="Шумоподавление" text="Убирает фоновый шум: вентилятор, клавиатуру, улицу.">
        <Toggle label="Шумоподавление" on={audio.noiseSuppression} onChange={(v) => setAudio({ noiseSuppression: v })} />
      </Row>
      <Row title="Эхоподавление" text="Нужно, если вы говорите без наушников.">
        <Toggle label="Эхоподавление" on={audio.echoCancellation} onChange={(v) => setAudio({ echoCancellation: v })} />
      </Row>
      <Row title="Автоматическая громкость" text="Выравнивает громкость голоса, если вы отходите от микрофона.">
        <Toggle label="Автоматическая громкость" on={audio.autoGainControl} onChange={(v) => setAudio({ autoGainControl: v })} />
      </Row>
      <Row
        title="Скрывать мой IP в звонках"
        text={
          hasTurn
            ? 'Звук пойдёт через TURN-сервер вашего ретранслятора. Расшифровать его сервер не может, но задержка может быть чуть больше.'
            : 'Недоступно: на сервере не настроен TURN. Звонки идут напрямую между компьютерами, поэтому собеседник видит ваш IP-адрес.'
        }
      >
        <Toggle
          label="Скрывать мой IP в звонках"
          on={snapshot.settings.callsRelayOnly}
          onChange={(v) => (hasTurn || !v) && messenger.updateSettings({ callsRelayOnly: v })}
        />
      </Row>
      <div className="notice info" style={{ marginTop: 14 }}>
        <LockKeyhole size={16} />
        <span>
          Звонки шифруются на устройствах (DTLS-SRTP). Ключи согласуются через сквозное шифрование Veil, поэтому ни сервер, ни посредник не
          могут подслушать разговор.
        </span>
      </div>
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
  const [nearby, setNearby] = useState<{ name: string; address: string }[] | null>(null);
  const [searching, setSearching] = useState(false);
  const toast = useToast();

  useEffect(() => {
    void bridge?.server.status().then(setEmbedded);
  }, []);

  const search = async () => {
    setSearching(true);
    setNearby(await bridge!.server.discover().catch(() => []));
    setSearching(false);
  };

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
      {snapshot.me.serverKey && (
        <Row
          title="Ключ сервера"
          text="Veil запомнил ключ этого сервера и проверяет им каждое подключение и каждый ответ «@имя → ключ». Сверьте цифры с тем, кто держит сервер."
        >
          <code className="selectable" data-testid="server-key">
            {fingerprintOf(snapshot.me.serverKey)}
          </code>
        </Row>
      )}
      {snapshot.serverKeyChanged && (
        <div className="callout danger" data-testid="server-key-changed">
          <TriangleAlert size={16} />
          <div>
            <b>Сервер показал не тот ключ, и Veil к нему не подключается.</b> Так бывает, если сервер переустановили, удалили его папку с
            данными или на Render не задан SERVER_SECRET. Если ничего такого не было, кто-то может выдавать себя за ваш сервер: в сети Wi-Fi или
            по пути к нему. Сверьте отпечаток ключа с владельцем сервера, прежде чем доверять.
            <div style={{ marginTop: 6 }}>
              {snapshot.serverKeyOffered ? (
                <>
                  Новый ключ: <code>{snapshot.serverKeyOffered}</code>
                </>
              ) : (
                'Сервер не подтвердил никакого ключа (старая версия сервера или подмена).'
              )}
            </div>
            <div style={{ marginTop: 8 }}>
              <button className="btn btn-secondary btn-sm" onClick={() => messenger.trustServerKey()}>
                Сервер переустанавливали — доверять новому ключу и подключиться
              </button>
            </div>
          </div>
        </div>
      )}
      <Row title="Это мой сервер" text="Сервер развернули вы или люди, которым вы доверяете. Щит чата учитывает это в оценке.">
        <Toggle label="Это мой сервер" on={isOwnServer(snapshot)} onChange={(v) => messenger.updateSettings({ ownServer: v })} />
      </Row>
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
        {bridge && (
          <div className="nearby-servers" style={{ marginTop: 8 }}>
            <button className="btn btn-secondary btn-sm" style={{ justifySelf: 'start' }} disabled={searching} onClick={() => void search()}>
              {searching ? <span className="spinner" /> : <Wifi size={15} />} Найти сервер в этой сети
            </button>
            {nearby?.length === 0 && <span className="field-hint">В этой сети других серверов Veil не видно.</span>}
            {nearby?.map((n) => (
              <button key={n.address} type="button" className={`option-card${url === n.address ? ' on' : ''}`} onClick={() => setUrl(n.address)}>
                <div className="grow">
                  <b>{n.name}</b>
                  <span>{n.address}</span>
                </div>
                <span className="chip">Выбрать</span>
              </button>
            ))}
          </div>
        )}
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

function SecurityTab({
  messenger,
  snapshot,
  onDeleted,
  onDevices,
}: {
  messenger: Messenger;
  snapshot: MessengerSnapshot;
  onDeleted(): void;
  onDevices(): void;
}) {
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
      <ProtectionBar snapshot={snapshot} />
      <SafetyCodeCard messenger={messenger} snapshot={snapshot} />
      {feature(snapshot.settings, 'bridge') && <BridgeCard onOpen={onDevices} />}
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

      {feature(snapshot.settings, 'duress') && <DuressSection messenger={messenger} snapshot={snapshot} />}

      {feature(snapshot.settings, 'backupFile') && <BackupFileSection messenger={messenger} snapshot={snapshot} />}
      <CloudBackupSection messenger={messenger} snapshot={snapshot} />

      {feature(snapshot.settings, 'securityLog') && <SecurityLogSection messenger={messenger} snapshot={snapshot} onDevices={onDevices} />}

      {feature(snapshot.settings, 'quickUnlock') && <QuickUnlockSection messenger={messenger} />}

      <div className="section" style={{ borderColor: 'rgba(var(--danger-rgb), 0.3)' }}>
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
      {state.status === 'available' && state.packaged && (
        <div className="update-command" data-testid="update-command">
          <span>
            {state.packaged.kind === 'flatpak' ? 'Veil установлен через Flatpak.' : `Veil установлен пакетом .${state.packaged.kind}.`} Обновите через
            менеджер пакетов: скачайте новый пакет на странице загрузки и выполните в папке с ним:
          </span>
          <code className="selectable">{state.packaged.command}</code>
          <button className="btn btn-secondary btn-sm" onClick={() => bridge!.copyText(state.packaged!.command)}>
            <Copy size={15} /> Копировать команду
          </button>
        </div>
      )}
      <div className="form-actions" style={{ marginTop: 0 }}>
        {state.status === 'available' && (
          <button className="btn btn-primary btn-sm" onClick={() => bridge!.update.download()}>
            {state.packaged ? 'Открыть страницу загрузки' : state.manual ? 'Скачать новую версию' : 'Загрузить и установить'}
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

/** «Устройства»: computers that signed in to this account, and «Мост» to move to another one. */
function DevicesTab({ messenger, snapshot, onMoved }: { messenger: Messenger; snapshot: MessengerSnapshot; onMoved(): void }) {
  const [devices, setDevices] = useState<DeviceInfo[] | null>(null);
  const [error, setError] = useState('');
  const [revoke, setRevoke] = useState<DeviceInfo | null>(null);
  const [moving, setMoving] = useState(false);
  const online = snapshot.status === 'online';
  const load = useCallback(() => {
    setError('');
    messenger
      .listDevices()
      .then(setDevices)
      .catch((e: Error) => setError(e.message));
  }, [messenger]);
  useEffect(() => {
    if (online) load();
  }, [online, load]);

  return (
    <>
      <div className="section bridge-card">
        <div className="section-title">
          <ArrowRightLeft size={16} /> Мост: перенести на другой ПК
        </div>
        <p>Аккаунт, чаты, «Избранное» и файлы переедут на другой компьютер, например с Windows на Linux, напрямую по локальной сети.</p>
        <button className="btn btn-primary btn-sm" onClick={() => setMoving(true)} data-testid="bridge-start">
          Перенести на другой ПК
        </button>
      </div>
      <div className="section">
        <div className="section-title">
          <MonitorSmartphone size={16} /> Компьютеры с этим аккаунтом
        </div>
        {!online && <p>Нужно подключение к серверу.</p>}
        {error && <span className="field-error">{error}</span>}
        {devices?.map((d) => (
          <div className="device-row" key={d.id} data-testid="device-row">
            <MonitorSmartphone size={20} />
            <div className="grow">
              <b>
                {d.name}
                {d.current && <span className="chip success">Этот ПК</span>}
              </b>
              <span>
                {d.online ? 'в сети' : `был в сети ${formatDay(d.last).toLowerCase()} в ${formatTime(d.last)}`} · с {formatDay(d.first).toLowerCase()}
              </span>
            </div>
            {!d.current && (
              <button className="btn btn-secondary btn-sm" onClick={() => setRevoke(d)}>
                Отвязать
              </button>
            )}
          </div>
        ))}
        <p>
          Названия компьютеров зашифрованы: сервер хранит их, но прочитать не может. «Отвязать» запрещает серверу принимать вход с этого ПК — так
          забытый или проданный компьютер перестанет получать ваши сообщения.
        </p>
      </div>
      {revoke && (
        <ConfirmDialog
          title="Отвязать компьютер?"
          text={`«${revoke.name}» больше не сможет войти в этот аккаунт. Если вы думаете, что пароль и ключи украдены, этого мало — смените пароль и заведите новый аккаунт.`}
          confirm="Отвязать"
          danger
          onClose={() => setRevoke(null)}
          onConfirm={async () => {
            await messenger.revokeDevice(revoke.id);
            load();
          }}
        />
      )}
      {moving && <BridgeHostDialog messenger={messenger} onClose={() => setMoving(false)} onMoved={onMoved} />}
    </>
  );
}

const FEATURE_TEXT: Record<FeatureName, [string, string]> = {
  veil: ['Вуаль', 'Размывает входящие, пока не наведёшь курсор. Ctrl+Shift+V.'],
  shield: ['Щит чата', 'Панель справа с оценкой защиты чата.'],
  keyGuard: ['Предупреждение о смене ключа', 'Красная строка в чате и запрет отправки до сверки (по желанию).'],
  viewOnce: ['Фото на один просмотр', 'Фото и видео, которые открываются один раз.'],
  clipboard: ['Очистка буфера обмена', 'Скопированный из «Избранного» пароль стирается из буфера.'],
  stripMeta: ['Удаление метаданных', 'Геометка, данные камеры, автор документа — до шифрования.'],
  quickUnlock: ['Быстрый вход', 'PIN вместо пароля; ключ — в защищённом хранилище системы.'],
  bridge: ['Мост', 'Перенос аккаунта на другой ПК по локальной сети.'],
  callWords: ['Слова-сверка в звонке', 'Два слова из отпечатков шифрования: совпали — посредника нет.'],
  tempNotes: ['Временные заметки', 'Заметки в «Избранном», которые сгорают через 1, 7 или 30 дней.'],
  duress: ['Аварийный пароль', 'Второй пароль открывает пустой Veil.'],
  scheduled: ['Отложенная отправка и капсула времени', 'Сообщения по расписанию и сообщения, которые откроются в нужный день.'],
  presence: ['Скрытие присутствия', 'Отдельно «в сети», «прочитано» и «печатает», для каждого контакта.'],
  hiddenChats: ['Скрытые чаты', 'Чаты за отдельным PIN, открываются секретной фразой в поиске.'],
  securityLog: ['Журнал безопасности', 'Входы, смена ключей и пароля — с кнопкой «Это не я».'],
  backupFile: ['Резервная копия .veil', 'Один файл, зашифрованный отдельным паролем.'],
  linkPreviews: ['Превью ссылок', 'Превью делает отправитель, получатель ссылку не открывает.'],
  invites: ['Приглашения veil://', 'Ссылка или QR-код с отпечатком ключа: контакт сразу сверен.'],
  groups: ['Группы', 'Групповые чаты со сквозным шифрованием (Sender Keys).'],
  video: ['Видеозвонки и показ экрана', 'Камера и экран в звонке; при показе экрана включается Вуаль.'],
  transcribe: ['Голосовые в текст', 'Распознавание на этом устройстве, модель — только с вашего согласия.'],
  search: ['Поиск по переписке', 'Поиск по всем чатам только на этом устройстве.'],
  requests: ['Запросы на переписку', 'Незнакомцы попадают в отдельный список: без «прочитано», звонков и картинок, пока вы не примете.'],
};

/** Every v2 feature can be switched off; a switched-off feature leaves no trace in the interface. */
function FeaturesTab({ snapshot, set }: { snapshot: MessengerSnapshot; set(patch: Partial<Settings>): void }) {
  const features = snapshot.settings.features;
  return (
    <div>
      <p className="field-hint" style={{ marginTop: 0 }}>
        Выключенная функция пропадает из интерфейса и ничего не отправляет. Данные, которые она уже сохранила, остаются на этом устройстве.
      </p>
      {FEATURE_NAMES.map((name) => (
        <Row key={name} title={FEATURE_TEXT[name][0]} text={FEATURE_TEXT[name][1]}>
          <Toggle label={FEATURE_TEXT[name][0]} on={features[name] !== false} onChange={(on) => set({ features: { ...features, [name]: on } })} />
        </Row>
      ))}
    </div>
  );
}

function AboutTab() {
  const items = [
    ['Обмен ключами', 'X3DH: X25519 + подписанные Ed25519 предключи'],
    ['Шифрование сообщений', 'Double Ratchet, XChaCha20-Poly1305, HKDF-SHA256'],
    ['Метаданные', 'Sealed sender: сообщения знакомым уходят без входа в аккаунт, сервер не знает отправителя; размер скрыт дополнением Padmé'],
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
        <p>Версия {bridge?.version ?? '2.2.2'} · открытый исходный код</p>
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
