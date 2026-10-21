import { ChevronDown, LockKeyhole, Maximize2, Mic, MicOff, Phone, PhoneOff } from 'lucide-react';
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { Contact } from '../../../core/types.ts';
import { meterStream } from '../lib/audio.ts';
import type { CallManager, CallState } from '../lib/calls.ts';
import { formatClock } from '../lib/format.ts';
import { Avatar, useEscape } from '../lib/ui.tsx';

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
  return STATUS[call.phase];
}

/** The call window: full card while ringing or talking, a slim bar when minimized. */
export function CallOverlay({ calls, contacts, showWords }: { calls: CallManager; contacts: Contact[]; showWords: boolean }) {
  const call = useSyncExternalStore(calls.subscribe, calls.getState);
  if (!call) return null;
  const contact = contacts.find((c) => c.id === call.contactId);
  if (!contact) return null;
  return call.minimized && call.phase !== 'ended' ? (
    <CallBar calls={calls} call={call} contact={contact} />
  ) : (
    <CallCard calls={calls} call={call} contact={contact} showWords={showWords} />
  );
}

function CallCard({ calls, call, contact, showWords }: { calls: CallManager; call: CallState; contact: Contact; showWords: boolean }) {
  const clock = useClock(call.connectedAt);
  const avatar = useRef<HTMLDivElement>(null);
  const remote = calls.remoteStream;
  useEscape(() => call.phase !== 'ended' && calls.setMinimized(true));

  // The avatar glows with the other person's voice.
  useEffect(() => {
    if (!remote || call.phase !== 'active') return;
    return meterStream(remote, (level) => avatar.current?.style.setProperty('--level', level.toFixed(3)));
  }, [remote, call.phase]);

  const ringing = call.phase === 'incoming' || call.phase === 'outgoing' || call.phase === 'ringing';
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

        {showWords && call.words && call.phase === 'active' && (
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
        )}

        {call.phase === 'incoming' ? (
          <div className="call-controls">
            <button className="call-btn decline" onClick={() => calls.decline()} aria-label="Отклонить звонок">
              <PhoneOff size={26} />
              <span>Отклонить</span>
            </button>
            <button className="call-btn accept" onClick={() => void calls.accept()} aria-label="Принять звонок">
              <Phone size={26} />
              <span>Ответить</span>
            </button>
          </div>
        ) : call.phase !== 'ended' ? (
          <div className="call-controls">
            <button className={`call-btn mute${call.muted ? ' on' : ''}`} onClick={() => calls.toggleMute()} aria-label={call.muted ? 'Включить микрофон' : 'Выключить микрофон'}>
              {call.muted ? <MicOff size={26} /> : <Mic size={26} />}
              <span>{call.muted ? 'Включить' : 'Микрофон'}</span>
            </button>
            <button className="call-btn decline" onClick={() => calls.hangup()} aria-label="Завершить звонок">
              <PhoneOff size={26} />
              <span>Завершить</span>
            </button>
          </div>
        ) : (
          <div className="call-controls" />
        )}
      </div>
    </div>
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
