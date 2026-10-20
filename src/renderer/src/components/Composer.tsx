import { CornerUpLeft, LockKeyhole, Mic, Paperclip, SendHorizontal, Smile, Square, Trash2, X } from 'lucide-react';
import { useEffect, useLayoutEffect, useRef, useState, type ChangeEvent, type KeyboardEvent } from 'react';
import { snippetOf, type Messenger } from '../../../core/messenger.ts';
import { bridge } from '../../../core/platform.ts';
import type { Contact, Message, Settings, StickerMeta } from '../../../core/types.ts';
import { EMOJI_GROUPS } from '../lib/emoji.ts';
import { MicrophoneError, openMicrophone } from '../lib/audio.ts';
import { analyseAudio, formatDuration } from '../lib/media.ts';
import { autocorrect, ignoreWord } from '../lib/text.ts';
import { useToast } from '../lib/ui.tsx';
import { StickerPanel } from './StickerPanel.tsx';

interface Props {
  messenger: Messenger;
  contact: Contact;
  settings: Pick<Settings, 'enterToSend' | 'autocorrect' | 'spellcheck' | 'audio'>;
  stickers: StickerMeta[];
  replyTo: Message | null;
  onCancelReply(): void;
  onFiles(files: File[]): void;
}

const MAX_VOICE_SECONDS = 300;

interface Recording {
  recorder: MediaRecorder;
  stream: MediaStream;
  chunks: Blob[];
  startedAt: number;
  analyser: AnalyserNode;
  context: AudioContext;
}

export function Composer({ messenger, contact, settings, stickers, replyTo, onCancelReply, onFiles }: Props) {
  const [text, setText] = useState(contact.draft ?? '');
  const [panel, setPanel] = useState<'closed' | 'emoji' | 'stickers'>('closed');
  const [emojiTab, setEmojiTab] = useState(0);
  const [hint, setHint] = useState<{ from: string; to: string } | null>(null);
  const [recording, setRecording] = useState<Recording | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [levels, setLevels] = useState<number[]>([]);
  const area = useRef<HTMLTextAreaElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const draftTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const latest = useRef(text);
  const corrected = useRef<{ original: string; fixed: string; end: number } | null>(null);
  const toast = useToast();
  const contactId = contact.id;

  // Each chat keeps its own draft; it is saved when switching away.
  useEffect(() => {
    const draft = messenger.getSnapshot().contacts.find((c) => c.id === contactId)?.draft ?? '';
    setText(draft);
    latest.current = draft;
    setPanel('closed');
    area.current?.focus();
    return () => {
      clearTimeout(draftTimer.current);
      messenger.setDraft(contactId, latest.current.trim() ? latest.current : '');
    };
  }, [contactId, messenger]);

  useEffect(() => {
    if (replyTo) area.current?.focus();
  }, [replyTo]);

  useEffect(() => {
    bridge?.spell.setEnabled(settings.spellcheck);
  }, [settings.spellcheck]);

  useLayoutEffect(() => {
    const el = area.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
  }, [text]);

  useEffect(() => {
    if (!hint) return;
    const t = setTimeout(() => setHint(null), 3500);
    return () => clearTimeout(t);
  }, [hint]);

  const store = (value: string) => {
    setText(value);
    latest.current = value;
    clearTimeout(draftTimer.current);
    draftTimer.current = setTimeout(() => messenger.setDraft(contactId, value), 500);
    messenger.sendTyping(contactId, value.trim().length > 0);
  };

  /** Fixes the word just finished with a space or punctuation, like on a phone. */
  const onChange = (e: ChangeEvent<HTMLTextAreaElement>) => {
    const el = e.target;
    let value = el.value;
    corrected.current = null;
    const caret = el.selectionStart ?? value.length;
    if (settings.autocorrect && value.length === latest.current.length + 1 && caret > 1 && /[\s.,!?;:)]/.test(value[caret - 1])) {
      const before = value.slice(0, caret - 1);
      const match = /([\p{L}'’-]+)$/u.exec(before);
      const fixed = match ? autocorrect(match[1]) : null;
      if (match && fixed) {
        value = before.slice(0, before.length - match[1].length) + fixed + value.slice(caret - 1);
        const end = caret + fixed.length - match[1].length;
        corrected.current = { original: match[1], fixed, end };
        setHint({ from: match[1], to: fixed });
        requestAnimationFrame(() => el.setSelectionRange(end, end));
      }
    }
    store(value);
  };

  const undoCorrection = () => {
    const fix = corrected.current;
    const el = area.current;
    if (!fix || !el) return false;
    const start = fix.end - 1 - fix.fixed.length;
    if (latest.current.slice(start, fix.end - 1) !== fix.fixed) return false;
    const value = latest.current.slice(0, start) + fix.original + latest.current.slice(fix.end - 1);
    ignoreWord(fix.original);
    corrected.current = null;
    setHint(null);
    store(value);
    const caret = start + fix.original.length + 1;
    requestAnimationFrame(() => el.setSelectionRange(caret, caret));
    return true;
  };

  const send = () => {
    const value = text.trim();
    if (!value) return;
    setText('');
    latest.current = '';
    corrected.current = null;
    clearTimeout(draftTimer.current);
    messenger.sendTyping(contactId, false);
    void messenger.sendText(contactId, value, { replyTo: replyTo?.id }).catch((e) => toast((e as Error).message, 'error'));
    onCancelReply();
    area.current?.focus();
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Backspace' && corrected.current && area.current?.selectionStart === corrected.current.end) {
      if (undoCorrection()) {
        e.preventDefault();
        return;
      }
    }
    if (e.key === 'Escape' && replyTo) {
      onCancelReply();
      return;
    }
    if (e.key !== 'Enter' || e.nativeEvent.isComposing) return;
    const modifier = e.ctrlKey || e.metaKey;
    if ((settings.enterToSend && !e.shiftKey && !modifier) || (!settings.enterToSend && modifier)) {
      e.preventDefault();
      send();
    }
  };

  const insertEmoji = (emoji: string) => {
    const el = area.current;
    if (!el) return store(text + emoji);
    const start = el.selectionStart ?? text.length;
    const end = el.selectionEnd ?? text.length;
    store(text.slice(0, start) + emoji + text.slice(end));
    requestAnimationFrame(() => {
      el.focus();
      el.selectionStart = el.selectionEnd = start + emoji.length;
    });
  };

  const sendSticker = (id: string) => {
    setPanel('closed');
    void messenger.sendSticker(contactId, id, { replyTo: replyTo?.id }).catch((e) => toast((e as Error).message, 'error'));
    onCancelReply();
  };

  // ---- voice messages ----

  useEffect(() => {
    if (!recording) return;
    const data = new Uint8Array(recording.analyser.fftSize);
    const timer = setInterval(() => {
      const seconds = (Date.now() - recording.startedAt) / 1000;
      setElapsed(seconds);
      recording.analyser.getByteTimeDomainData(data);
      let peak = 0;
      for (const v of data) peak = Math.max(peak, Math.abs(v - 128));
      setLevels((l) => [...l.slice(-39), Math.min(1, peak / 64)]);
      if (seconds >= MAX_VOICE_SECONDS) void stopRecording(true);
    }, 100);
    return () => clearInterval(timer);
  }, [recording]);

  const startRecording = async () => {
    try {
      const stream = await openMicrophone(settings.audio);
      const mime = MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ? 'audio/webm;codecs=opus' : 'audio/webm';
      const recorder = new MediaRecorder(stream, { mimeType: mime, audioBitsPerSecond: 32_000 });
      const chunks: Blob[] = [];
      recorder.ondataavailable = (e) => e.data.size && chunks.push(e.data);
      const context = new AudioContext();
      const analyser = context.createAnalyser();
      analyser.fftSize = 512;
      context.createMediaStreamSource(stream).connect(analyser);
      recorder.start(250);
      setLevels([]);
      setElapsed(0);
      setRecording({ recorder, stream, chunks, startedAt: Date.now(), analyser, context });
    } catch (error) {
      toast(error instanceof MicrophoneError ? error.message : 'Нет доступа к микрофону. Разрешите его в настройках системы', 'error');
    }
  };

  const stopRecording = async (sendIt: boolean) => {
    const current = recording;
    if (!current) return;
    setRecording(null);
    await new Promise<void>((resolve) => {
      current.recorder.onstop = () => resolve();
      current.recorder.stop();
    });
    current.stream.getTracks().forEach((t) => t.stop());
    void current.context.close();
    if (!sendIt) return;
    const blob = new Blob(current.chunks, { type: 'audio/webm' });
    if ((Date.now() - current.startedAt) / 1000 < 0.7 || !blob.size) {
      toast('Слишком короткое сообщение — удерживайте запись дольше', 'info');
      return;
    }
    const { dur, wave } = await analyseAudio(blob);
    const data = new Uint8Array(await blob.arrayBuffer());
    void messenger
      .sendVoice(contactId, { data, mime: 'audio/webm', dur: dur || (Date.now() - current.startedAt) / 1000, wave }, { replyTo: replyTo?.id })
      .catch((e) => toast((e as Error).message, 'error'));
    onCancelReply();
  };

  return (
    <div className="composer-wrap">
      {panel !== 'closed' && (
        <>
          <div style={{ position: 'fixed', inset: 0, zIndex: 19 }} onMouseDown={() => setPanel('closed')} />
          <div className="emoji-pop" role="dialog" aria-label="Эмодзи и стикеры">
            <div className="pop-tabs">
              <button className={panel === 'emoji' ? 'active' : ''} onClick={() => setPanel('emoji')}>
                Эмодзи
              </button>
              <button className={panel === 'stickers' ? 'active' : ''} onClick={() => setPanel('stickers')}>
                Стикеры
              </button>
            </div>
            {panel === 'emoji' ? (
              <>
                <div className="emoji-tabs">
                  {EMOJI_GROUPS.map((group, i) => (
                    <button key={group.label} className={i === emojiTab ? 'active' : ''} onClick={() => setEmojiTab(i)} title={group.label}>
                      {group.icon}
                    </button>
                  ))}
                </div>
                <div className="emoji-grid">
                  {EMOJI_GROUPS[emojiTab].items.map((emoji, i) => (
                    <button key={`${emoji}${i}`} onClick={() => insertEmoji(emoji)}>
                      {emoji}
                    </button>
                  ))}
                </div>
              </>
            ) : (
              <StickerPanel messenger={messenger} stickers={stickers} onPick={sendSticker} />
            )}
          </div>
        </>
      )}

      {replyTo && (
        <div className="reply-bar">
          <CornerUpLeft size={18} />
          <div className="grow">
            <b>{replyTo.dir === 'out' ? 'Ответ на ваше сообщение' : `Ответ ${contact.displayName}`}</b>
            <span>{snippetOf(replyTo) || 'Сообщение'}</span>
          </div>
          <button className="icon-btn sm" onClick={onCancelReply} aria-label="Отменить ответ">
            <X size={16} />
          </button>
        </div>
      )}

      {recording ? (
        <div className="composer recording">
          <button className="icon-btn" onClick={() => void stopRecording(false)} aria-label="Удалить запись" title="Удалить запись">
            <Trash2 size={19} />
          </button>
          <span className="rec-dot" />
          <span className="rec-time">{formatDuration(elapsed)}</span>
          <div className="rec-levels">
            {levels.map((v, i) => (
              <i key={i} style={{ height: `${Math.max(10, v * 100)}%` }} />
            ))}
          </div>
          <button className="send-btn" onClick={() => void stopRecording(true)} aria-label="Отправить голосовое">
            <SendHorizontal size={19} />
          </button>
        </div>
      ) : (
        <div className="composer">
          <button className="icon-btn" onClick={() => fileInput.current?.click()} aria-label="Прикрепить файл" title="Фото или файл">
            <Paperclip size={20} />
          </button>
          <input
            ref={fileInput}
            type="file"
            multiple
            hidden
            onChange={(e) => {
              if (e.target.files?.length) onFiles([...e.target.files]);
              e.target.value = '';
            }}
          />
          <textarea
            ref={area}
            rows={1}
            value={text}
            placeholder="Сообщение"
            aria-label="Сообщение"
            spellCheck={settings.spellcheck}
            lang="ru"
            onChange={onChange}
            onBlur={() => messenger.sendTyping(contactId, false)}
            onPaste={(e) => {
              const files = [...e.clipboardData.files];
              if (files.length) {
                e.preventDefault();
                onFiles(files);
              }
            }}
            onKeyDown={onKeyDown}
          />
          <button className={`icon-btn${panel !== 'closed' ? ' active' : ''}`} onClick={() => setPanel(panel === 'closed' ? 'emoji' : 'closed')} aria-label="Эмодзи и стикеры">
            <Smile size={20} />
          </button>
          {text.trim() ? (
            <button className="send-btn" onClick={send} aria-label="Отправить">
              <SendHorizontal size={19} />
            </button>
          ) : (
            <button className="send-btn mic" onClick={() => void startRecording()} aria-label="Записать голосовое" title="Записать голосовое сообщение">
              <Mic size={19} />
            </button>
          )}
        </div>
      )}
      <div className="composer-note">
        {hint ? (
          <span className="autocorrect-hint">
            Исправлено «{hint.from}» → «{hint.to}» · Backspace — отменить
          </span>
        ) : recording ? (
          <>
            <Square size={10} fill="currentColor" /> Идёт запись · нажмите «Отправить» или корзину
          </>
        ) : (
          <>
            <LockKeyhole size={11} /> Сквозное шифрование · {settings.enterToSend ? 'Enter — отправить, Shift+Enter — новая строка' : 'Ctrl+Enter — отправить'}
          </>
        )}
      </div>
    </div>
  );
}
