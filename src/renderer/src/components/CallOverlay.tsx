import { AppWindow, ChevronDown, LockKeyhole, Maximize2, Mic, MicOff, Monitor, MonitorOff, MonitorUp, Phone, PhoneOff, Video, VideoOff } from 'lucide-react';
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { bridge } from '../../../core/platform.ts';
import type { Contact } from '../../../core/types.ts';
import { meterStream } from '../lib/audio.ts';
import type { CallManager, CallState } from '../lib/calls.ts';
import { formatClock } from '../lib/format.ts';
import { Avatar, Modal, useEscape, useToast } from '../lib/ui.tsx';
import { ScreenCancelled } from '../lib/video.ts';

const STATUS: Record<Exclude<CallState['phase'], 'active' | 'ended'>, string> = {
  outgoing: 'Вызов…',
  ringing: 'Ожидание ответа…',
  incoming: 'Входящий аудиозвонок',
  connecting: 'Соединение…',
  reconnecting: 'Восстанавливаем связь…',
};

function useClock(since: number | undefined): string {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!since) return;
    const timer = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(timer);
  }, [since]);
  return since ? formatClock((now - since) / 1000) : '';
}

function statusText(call: CallState, clock: string): string {
  if (call.phase === 'ended') return call.endText ?? 'Звонок завершён';
  if (call.phase === 'active') return clock;
  if (call.phase === 'incoming' && call.videoCall) return 'Входящий видеозвонок';
  return STATUS[call.phase];
}

/** The call window: full card while ringing or talking, a slim bar when minimized. */
export function CallOverlay({ calls, contacts, showWords, video }: { calls: CallManager; contacts: Contact[]; showWords: boolean; video: boolean }) {
  const call = useSyncExternalStore(calls.subscribe, calls.getState);
  if (!call) return null;
  const contact = contacts.find((c) => c.id === call.contactId);
  if (!contact) return null;
  return call.minimized && call.phase !== 'ended' ? (
    <CallBar calls={calls} call={call} contact={contact} />
  ) : (
    <CallCard calls={calls} call={call} contact={contact} showWords={showWords} video={video} />
  );
}

function VideoView({ stream, className, label, mirror }: { stream: MediaStream | null; className: string; label: string; mirror?: boolean }) {
  const ref = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.srcObject = stream;
  }, [stream]);
  // Chromium pauses video while the window is hidden; back in view it must play on, not stay frozen.
  useEffect(() => {
    const video = ref.current;
    if (!video) return;
    const resume = () => {
      if (video.srcObject && video.paused && document.visibilityState === 'visible') void video.play().catch(() => {});
    };
    document.addEventListener('visibilitychange', resume);
    window.addEventListener('focus', resume);
    video.addEventListener('pause', resume);
    return () => {
      document.removeEventListener('visibilitychange', resume);
      window.removeEventListener('focus', resume);
      video.removeEventListener('pause', resume);
    };
  }, []);
  // Muted: the voice plays through the call's own audio element.
  return <video ref={ref} className={`${className}${mirror ? ' mirror' : ''}`} autoPlay playsInline muted aria-label={label} />;
}

/** Camera and screen buttons and their errors, shared by the card and the bar. */
function useVideoActions(calls: CallManager) {
  const toast = useToast();
  const [picker, setPicker] = useState<Awaited<ReturnType<NonNullable<typeof bridge>['screen']['sources']>>['sources'] | null>(null);
  const fail = (error: unknown) => !(error instanceof ScreenCancelled) && toast((error as Error).message, 'error');
  const toggleCamera = (on: boolean) => void calls.setCamera(on).catch(fail);
  const share = async () => {
    try {
      if (bridge) {
        const { portal, sources } = await bridge.screen.sources();
        if (!portal) return setPicker(sources);
      }
      await calls.startScreen();
    } catch (error) {
      fail(error);
    }
  };
  const pick = async (id: string) => {
    setPicker(null);
    await bridge!.screen.choose(id);
    await calls.startScreen().catch(fail);
  };
  const pickerView = picker && <ScreenPicker sources={picker} onPick={(id) => void pick(id)} onClose={() => setPicker(null)} />;
  return { toggleCamera, share, pickerView };
}

function CallCard({ calls, call, contact, showWords, video }: { calls: CallManager; call: CallState; contact: Contact; showWords: boolean; video: boolean }) {
  const clock = useClock(call.connectedAt);
  const avatar = useRef<HTMLDivElement>(null);
  const remote = calls.remoteStream;
  const { toggleCamera, share, pickerView } = useVideoActions(calls);
  useEscape(() => !pickerView && call.phase !== 'ended' && calls.setMinimized(true));

  // The avatar glows with the other person's voice.
  useEffect(() => {
    if (!remote || call.phase !== 'active') return;
    return meterStream(remote, (level) => avatar.current?.style.setProperty('--level', level.toFixed(3)));
  }, [remote, call.phase]);

  const ringing = call.phase === 'incoming' || call.phase === 'outgoing' || call.phase === 'ringing';
  const talking = call.phase !== 'incoming' && call.phase !== 'ended';
  const remoteMain = call.remoteScreen ? calls.remoteScreenStream : call.remoteCam ? calls.remoteCameraStream : null;
  const stage = talking && !!(remoteMain || call.cam);

  const words = showWords && call.words && call.phase === 'active' && (
    <div className={`call-words${call.wordsChecked ? ' checked' : ''}`} data-testid="call-words">
      <span className="call-words-label">Слова-сверка</span>
      <b>
        {call.words[0]} · {call.words[1]}
      </b>
      {call.wordsChecked ? (
        <span className="call-words-hint">Отмечено в Щите чата</span>
      ) : (
        <>
          <span className="call-words-hint">Произнесите вслух: если у собеседника те же слова, посредника нет.</span>
          <div className="call-words-actions">
            <button className="btn btn-sm btn-secondary" onClick={() => calls.checkWords(false)}>
              Не совпало
            </button>
            <button className="btn btn-sm btn-primary" onClick={() => calls.checkWords(true)}>
              Совпало
            </button>
          </div>
        </>
      )}
    </div>
  );

  const controls =
    call.phase === 'incoming' ? (
      <div className="call-controls">
        <button className="call-btn decline" onClick={() => calls.decline()} aria-label="Отклонить звонок">
          <PhoneOff size={26} />
          <span>Отклонить</span>
        </button>
        <button className="call-btn accept" onClick={() => void calls.accept()} aria-label="Принять звонок">
          <Phone size={26} />
          <span>Ответить</span>
        </button>
        {video && (
          <button className="call-btn accept" onClick={() => void calls.accept({ video: true })} aria-label="Ответить с видео">
            <Video size={26} />
            <span>С видео</span>
          </button>
        )}
      </div>
    ) : talking ? (
      <div className="call-controls">
        <button className={`call-btn mute${call.muted ? ' on' : ''}`} onClick={() => calls.toggleMute()} aria-label={call.muted ? 'Включить микрофон' : 'Выключить микрофон'}>
          {call.muted ? <MicOff size={26} /> : <Mic size={26} />}
          <span>{call.muted ? 'Включить' : 'Микрофон'}</span>
        </button>
        {call.video && (
          <>
            <button className={`call-btn mute${call.cam ? '' : ' on'}`} onClick={() => toggleCamera(!call.cam)} aria-label={call.cam ? 'Выключить камеру' : 'Включить камеру'}>
              {call.cam ? <Video size={26} /> : <VideoOff size={26} />}
              <span>{call.cam ? 'Камера' : 'Включить'}</span>
            </button>
            <button
              className={`call-btn${call.screen ? ' active' : ''}`}
              onClick={() => (call.screen ? void calls.stopScreen() : void share())}
              aria-label={call.screen ? 'Остановить показ экрана' : 'Показать экран'}
              disabled={call.phase !== 'active' && !call.screen}
            >
              {call.screen ? <MonitorOff size={26} /> : <MonitorUp size={26} />}
              <span>{call.screen ? 'Остановить' : 'Экран'}</span>
            </button>
          </>
        )}
        <button className="call-btn decline" onClick={() => calls.hangup()} aria-label="Завершить звонок">
          <PhoneOff size={26} />
          <span>Завершить</span>
        </button>
      </div>
    ) : (
      <div className="call-controls" />
    );

  if (stage)
    return (
      <div className="call-overlay video" role="dialog" aria-label={`Видеозвонок: ${contact.displayName}`}>
        <div className="call-stage" data-testid="call-stage">
          {remoteMain ? (
            <VideoView
              stream={remoteMain}
              className={`call-main${call.remoteScreen ? ' screen' : ''}`}
              label={call.remoteScreen ? `Экран: ${contact.displayName}` : `Камера: ${contact.displayName}`}
            />
          ) : (
            <div className="call-main placeholder">
              <Avatar name={contact.displayName} seed={contact.id} size={116} />
              <span>Камера собеседника выключена</span>
            </div>
          )}
          <div className="call-stage-top">
            <span className="call-e2e">
              <LockKeyhole size={12} /> Сквозное шифрование
            </span>
            <div className="call-stage-title">
              <b>{contact.displayName}</b>
              <span data-testid="call-status">{statusText(call, clock)}</span>
            </div>
            <button className="icon-btn sm" onClick={() => calls.setMinimized(true)} aria-label="Свернуть звонок" title="Свернуть (Esc)">
              <ChevronDown size={18} />
            </button>
          </div>
          {call.screen && (
            <div className="call-sharing" role="status">
              <Monitor size={15} /> Вы показываете экран · Вуаль включена, уведомления скрыты
            </div>
          )}
          <div className="call-tiles">
            {call.remoteScreen && call.remoteCam && <VideoView stream={calls.remoteCameraStream} className="call-tile" label={`Камера: ${contact.displayName}`} />}
            {call.cam && <VideoView stream={calls.cameraStream} className="call-tile" label="Ваша камера" mirror />}
          </div>
          {words && <div className="call-stage-words">{words}</div>}
          <div className="call-stage-controls">{controls}</div>
        </div>
        {pickerView}
      </div>
    );

  return (
    <div className={`call-overlay${call.phase === 'ended' ? ' ended' : ''}`} role="dialog" aria-label={`Звонок: ${contact.displayName}`}>
      <div className="call-card">
        <div className="call-top">
          <span className="call-e2e">
            <LockKeyhole size={12} /> Сквозное шифрование
          </span>
          {call.phase !== 'ended' && (
            <button className="icon-btn sm" onClick={() => calls.setMinimized(true)} aria-label="Свернуть звонок" title="Свернуть (Esc)">
              <ChevronDown size={18} />
            </button>
          )}
        </div>
        <div ref={avatar} className={`call-avatar${ringing ? ' ringing' : ''}${call.phase === 'active' ? ' talking' : ''}`}>
          <span className="ring" />
          <span className="ring" />
          <span className="ring" />
          <Avatar name={contact.displayName} seed={contact.id} size={116} />
        </div>
        <h2 className="call-name">{contact.displayName}</h2>
        <p className={`call-status${call.phase === 'active' ? ' clock' : ''}`} data-testid="call-status">
          {statusText(call, clock)}
          {call.muted && call.phase !== 'ended' && <span className="call-muted"> · микрофон выключен</span>}
        </p>
        {call.screen && (
          <div className="call-sharing inline" role="status">
            <Monitor size={15} /> Вы показываете экран · Вуаль включена, уведомления скрыты
          </div>
        )}
        {words}
        {controls}
      </div>
      {pickerView}
    </div>
  );
}

type Source = { id: string; name: string; kind: 'screen' | 'window'; thumbnail: string };

/** Windows and X11: which screen or window to show (Wayland uses the system's own dialog). */
function ScreenPicker({ sources, onPick, onClose }: { sources: Source[]; onPick(id: string): void; onClose(): void }) {
  const [tab, setTab] = useState<'screen' | 'window'>('screen');
  const list = sources.filter((s) => s.kind === tab);
  return (
    <Modal title="Что показать собеседнику?" onClose={onClose} width={720}>
      <div className="modal-body">
        <div className="segmented" role="tablist">
          <button role="tab" aria-selected={tab === 'screen'} className={tab === 'screen' ? 'active' : ''} onClick={() => setTab('screen')}>
            <Monitor size={15} /> Весь экран
          </button>
          <button role="tab" aria-selected={tab === 'window'} className={tab === 'window' ? 'active' : ''} onClick={() => setTab('window')}>
            <AppWindow size={15} /> Окно
          </button>
        </div>
        <div className="screen-grid" data-testid="screen-sources">
          {list.map((s) => (
            <button key={s.id} className="screen-source" onClick={() => onPick(s.id)}>
              <img src={s.thumbnail} alt="" />
              <span>{s.name}</span>
            </button>
          ))}
          {!list.length && <span className="field-hint">Нет доступных {tab === 'screen' ? 'экранов' : 'окон'}</span>}
        </div>
        <span className="field-hint">Пока идёт показ, Veil размывает переписку (Вуаль) и не показывает уведомления.</span>
      </div>
    </Modal>
  );
}

function CallBar({ calls, call, contact }: { calls: CallManager; call: CallState; contact: Contact }) {
  const clock = useClock(call.connectedAt);
  return (
    <div className={`call-bar ${call.phase}`} role="status">
      <button className="call-bar-main" onClick={() => calls.setMinimized(false)} aria-label="Развернуть звонок">
        <span className="call-bar-dot" />
        <Avatar name={contact.displayName} seed={contact.id} size={26} />
        <b>{contact.displayName}</b>
        <span className="call-bar-status">{statusText(call, clock)}</span>
        <Maximize2 size={14} />
      </button>
      {call.phase === 'incoming' ? (
        <>
          <button className="call-bar-btn accept" onClick={() => void calls.accept()} aria-label="Принять звонок">
            <Phone size={16} />
          </button>
          <button className="call-bar-btn decline" onClick={() => calls.decline()} aria-label="Отклонить звонок">
            <PhoneOff size={16} />
          </button>
        </>
      ) : (
        <>
          {call.screen && (
            <button className="call-bar-btn on" onClick={() => void calls.stopScreen()} aria-label="Остановить показ экрана" title="Остановить показ экрана">
              <MonitorOff size={16} />
            </button>
          )}
          <button className={`call-bar-btn${call.muted ? ' on' : ''}`} onClick={() => calls.toggleMute()} aria-label={call.muted ? 'Включить микрофон' : 'Выключить микрофон'}>
            {call.muted ? <MicOff size={16} /> : <Mic size={16} />}
          </button>
          <button className="call-bar-btn decline" onClick={() => calls.hangup()} aria-label="Завершить звонок">
            <PhoneOff size={16} />
          </button>
        </>
      )}
    </div>
  );
}
