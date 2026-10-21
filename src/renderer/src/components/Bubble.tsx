import {
  AlertCircle,
  Check,
  CheckCheck,
  Clock,
  Copy,
  CornerUpLeft,
  Download,
  FileText,
  Film,
  Flame,
  Forward,
  ImageIcon,
  MoreHorizontal,
  Phone,
  PhoneIncoming,
  PhoneMissed,
  PhoneOutgoing,
  RotateCcw,
  SmilePlus,
  Timer,
} from 'lucide-react';
import { memo, useCallback, useEffect, useState, type MouseEvent, type ReactNode } from 'react';
import { callTitle, type Messenger } from '../../../core/messenger.ts';
import { bridge } from '../../../core/platform.ts';
import { attachmentsOf, type Attachment, type Message } from '../../../core/types.ts';
import { saveAttachment, useAttachmentUrl } from '../lib/attachments.ts';
import { formatCallDuration, formatDay, formatSize, formatTime, isEmojiOnly, remaining } from '../lib/format.ts';
import { ReactionPicker } from './ReactionPicker.tsx';
import { VoicePlayer } from './VoicePlayer.tsx';

const URL_RE = /(https?:\/\/[^\s<>"']+[^\s<>"'.,;:!?)\]])/g;

function openLink(e: MouseEvent, href: string) {
  e.preventDefault();
  if (bridge) bridge.openExternal(href);
  else window.open(href, '_blank', 'noopener,noreferrer');
}

function linkify(text: string): ReactNode[] {
  const parts = text.split(URL_RE);
  return parts.map((part, i) =>
    i % 2 === 1 ? (
      <a key={i} href={part} onClick={(e) => openLink(e, part)}>
        {part}
      </a>
    ) : (
      part
    ),
  );
}

function StatusIcon({ status }: { status: Message['status'] }) {
  switch (status) {
    case 'pending':
      return <Clock size={13} aria-label="Отправляется" />;
    case 'sent':
      return <Check size={14} aria-label="Отправлено" />;
    case 'delivered':
      return <CheckCheck size={14} aria-label="Доставлено" />;
    case 'read':
      return <CheckCheck size={14} className="read" aria-label="Прочитано" strokeWidth={2.6} />;
    case 'failed':
      return <AlertCircle size={13} className="failed" aria-label="Не отправлено" />;
    default:
      return null;
  }
}

function Countdown({ expiresAt }: { expiresAt: number }) {
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, []);
  return (
    <>
      <Timer size={11} />
      {remaining(expiresAt)}
    </>
  );
}

/** Display box for one picture: fits 340×380, small pictures at least 160 px wide. */
function imageBox(w = 320, h = 240): { width: number; height: number } {
  let scale = Math.min(1, 340 / w, 380 / h);
  if (w * scale < 160) scale = Math.min(160 / w, 380 / h);
  return { width: Math.round(w * scale), height: Math.round(h * scale) };
}

function AlbumImage({ messenger, att, style, onOpen }: { messenger: Messenger; att: Attachment; style?: object; onOpen(): void }) {
  const url = useAttachmentUrl(messenger, att);
  return url ? (
    <img src={url} alt={att.name} style={style} onClick={onOpen} draggable={false} />
  ) : (
    <div className="img-placeholder" style={style}>
      <ImageIcon size={26} />
    </div>
  );
}

function Album({ messenger, images, onOpen }: { messenger: Messenger; images: Attachment[]; onOpen(index: number): void }) {
  if (images.length === 1) {
    const box = imageBox(images[0].w, images[0].h);
    return (
      <div className="album one">
        <AlbumImage messenger={messenger} att={images[0]} style={box} onOpen={() => onOpen(0)} />
      </div>
    );
  }
  return (
    <div className={`album n${Math.min(images.length, 5)}`}>
      {images.map((att, i) => (
        <AlbumImage key={att.id} messenger={messenger} att={att} onOpen={() => onOpen(i)} />
      ))}
    </div>
  );
}

function StickerImage({ messenger, att }: { messenger: Messenger; att: Attachment }) {
  const url = useAttachmentUrl(messenger, att);
  const ratio = (att.w ?? 1) / (att.h ?? 1);
  const size = ratio >= 1 ? { width: 168, height: 168 / ratio } : { width: 168 * ratio, height: 168 };
  return url ? <img className="sticker" src={url} alt="Стикер" style={size} draggable={false} /> : <div className="sticker" style={size} />;
}

interface BubbleProps {
  message: Message;
  messenger: Messenger;
  contactName: string;
  groupStart: boolean;
  groupEnd: boolean;
  highlighted: boolean;
  /** «Вуаль»: blurred until hovered or focused, so the bubble takes keyboard focus. */
  veiled?: boolean;
  onContext(e: MouseEvent, message: Message): void;
  onOpenMedia(message: Message, index: number): void;
  onRetry(message: Message): void;
  onReply(message: Message): void;
  onReact(message: Message, emoji: string): void;
  onCopy(message: Message): void;
  onJump(id: string): void;
  onCallBack(): void;
  onOpenOnce(message: Message): void;
}

/** A call in the chat history: direction, outcome, length and a call-back button. */
function CallRow({ message, onContext, onCallBack }: { message: Message; onContext: BubbleProps['onContext']; onCallBack(): void }) {
  const call = message.call!;
  const failed = call.status !== 'done';
  const missedIn = message.dir === 'in' && failed && call.status !== 'declined';
  const Icon = missedIn ? PhoneMissed : message.dir === 'out' ? PhoneOutgoing : PhoneIncoming;
  return (
    <div className={`msg-row ${message.dir} group-start group-end`} data-testid="call-record" id={`msg-${message.id}`}>
      <div className="msg-col">
        <div className={`bubble call-bubble${missedIn ? ' missed' : ''}${failed ? ' failed' : ''}`} onContextMenu={(e) => onContext(e, message)}>
          <span className="call-icon">
            <Icon size={18} />
          </span>
          <span className="call-info">
            <b>{callTitle(message)}</b>
            <span>
              {formatTime(message.ts)}
              {call.dur ? ` · ${formatCallDuration(call.dur)}` : ''}
            </span>
          </span>
          <button className="icon-btn sm call-back" onClick={onCallBack} aria-label="Перезвонить" title="Перезвонить">
            <Phone size={17} />
          </button>
        </div>
      </div>
    </div>
  );
}

/** A view-once photo or video: a card that opens it full screen, then says it was opened. */
function OnceCard({ message, onOpen }: { message: Message; onOpen(): void }) {
  const video = attachmentsOf(message)[0]?.mime.startsWith('video/');
  const what = video ? 'Видео' : 'Фото';
  const opened = !!message.once?.opened;
  const canOpen = message.dir === 'in' && !opened && !!message.once?.k;
  const label = opened ? (message.dir === 'in' ? `${what} открыто` : 'Открыто') : `${what} · откроется один раз`;
  return (
    <button className={`once-card${opened ? ' opened' : ''}`} onClick={onOpen} disabled={!canOpen} data-testid="once-card">
      <span className="once-icon">{video ? <Film size={18} /> : <Flame size={18} />}</span>
      <span className="once-text">
        <b>{label}</b>
        <span>{canOpen ? 'Нажмите, чтобы открыть' : message.dir === 'out' && !opened ? 'Собеседник ещё не открывал' : 'Ключ удалён у обоих'}</span>
      </span>
    </button>
  );
}

export const Bubble = memo(function Bubble(props: BubbleProps) {
  const { message, messenger, contactName, groupStart, groupEnd, highlighted } = props;
  const [pickerAnchor, setPickerAnchor] = useState<HTMLElement | null>(null);
  const closePicker = useCallback(() => setPickerAnchor(null), []);
  const atts = attachmentsOf(message);
  const images = atts.filter((a) => a.kind === 'image');
  const files = atts.filter((a) => a.kind === 'file');
  const voice = atts.find((a) => a.kind === 'voice');
  const sticker = atts.find((a) => a.kind === 'sticker');
  const out = message.dir === 'out';

  const meta = (
    <span className="meta">
      {message.expiresAt && <Countdown expiresAt={message.expiresAt} />}
      {formatTime(message.ts)}
      {out && <StatusIcon status={message.status} />}
    </span>
  );

  let bubbleClass = 'bubble';
  const mediaOnly = images.length > 0 && !message.text && !files.length && !message.reply && !message.fwd && !message.once;
  if (message.once) bubbleClass += ' once-bubble';
  else if (sticker) bubbleClass += ' sticker-bubble';
  else if (mediaOnly) bubbleClass += ' media';
  else if (images.length) bubbleClass += ' with-media';
  else if (!atts.length && isEmojiOnly(message.text)) bubbleClass += ' emoji-only';
  if (voice) bubbleClass += ' voice-bubble';

  const reactions = message.reactions;
  const chips: { emoji: string; count: number; mine: boolean }[] = [];
  if (reactions?.me && reactions.me === reactions.them) chips.push({ emoji: reactions.me, count: 2, mine: true });
  else {
    if (reactions?.them) chips.push({ emoji: reactions.them, count: 1, mine: false });
    if (reactions?.me) chips.push({ emoji: reactions.me, count: 1, mine: true });
  }

  const react = (emoji: string) => {
    setPickerAnchor(null);
    props.onReact(message, emoji);
  };

  if (message.call) return <CallRow message={message} onContext={props.onContext} onCallBack={props.onCallBack} />;

  return (
    <div
      className={`msg-row ${message.dir}${groupStart ? ' group-start' : ''}${groupEnd ? ' group-end' : ''}${highlighted ? ' highlight' : ''}${pickerAnchor ? ' picking' : ''}`}
      data-testid="message"
      data-dir={message.dir}
      id={`msg-${message.id}`}
    >
      <div className="msg-col">
        <div className="bubble-line">
          <div
            className={bubbleClass}
            onContextMenu={(e) => props.onContext(e, message)}
            onDoubleClick={() => react('❤️')}
            tabIndex={props.veiled && !out ? 0 : undefined}
          >
            {message.fwd && (
              <div className="fwd" title={`${formatDay(message.fwd.ts)}, ${formatTime(message.fwd.ts)}`}>
                <Forward size={13} /> Переслано от <b>{message.fwd.name}</b>
              </div>
            )}
            {message.reply && (
              <button className="quote" onClick={() => props.onJump(message.reply!.id)}>
                <b>{message.reply.out ? 'Вы' : contactName}</b>
                <span>{message.reply.text || 'Сообщение'}</span>
              </button>
            )}
            {message.once && <OnceCard message={message} onOpen={() => props.onOpenOnce(message)} />}
            {!message.once && sticker && <StickerImage messenger={messenger} att={sticker} />}
            {!message.once && images.length > 0 && <Album messenger={messenger} images={images} onOpen={(i) => props.onOpenMedia(message, i)} />}
            {!message.once && files.map((att) => (
              <div className="file-card" key={att.id}>
                <button className="file-icon" onClick={() => void saveAttachment(messenger, att)} aria-label="Сохранить файл">
                  <Download size={20} />
                </button>
                <div className="file-info">
                  <span className="file-name" title={att.name}>
                    <FileText size={13} style={{ verticalAlign: -2, marginRight: 4 }} />
                    {att.name}
                  </span>
                  <span className="file-size">{formatSize(att.size)}</span>
                </div>
              </div>
            ))}
            {voice && <VoicePlayer messenger={messenger} att={voice} />}
            {message.text && <div className={images.length && !message.once ? 'caption' : 'text'}>{linkify(message.text)}</div>}
            {meta}
          </div>

          <div className="msg-actions">
            <button
              className={`icon-btn sm${pickerAnchor ? ' active' : ''}`}
              title="Реакция"
              aria-label="Реакция"
              aria-expanded={!!pickerAnchor}
              onMouseDown={(e) => e.stopPropagation()}
              onClick={(e) => setPickerAnchor(pickerAnchor ? null : e.currentTarget)}
            >
              <SmilePlus size={17} />
            </button>
            <button className="icon-btn sm" title="Ответить" aria-label="Ответить" onClick={() => props.onReply(message)}>
              <CornerUpLeft size={17} />
            </button>
            {(message.text || images.length === 1) && !message.once && (
              <button className="icon-btn sm" title="Копировать" aria-label="Копировать" onClick={() => props.onCopy(message)}>
                <Copy size={16} />
              </button>
            )}
            <button className="icon-btn sm" title="Ещё" aria-label="Ещё" onClick={(e) => props.onContext(e, message)}>
              <MoreHorizontal size={17} />
            </button>
          </div>

          {pickerAnchor && <ReactionPicker anchor={pickerAnchor} current={reactions?.me} onPick={react} onClose={closePicker} />}
        </div>

        {chips.length > 0 && (
          <div className="reactions">
            {chips.map((chip) => (
              <button key={`${chip.emoji}${chip.mine}`} className={chip.mine ? 'mine' : ''} onClick={() => react(chip.emoji)}>
                {chip.emoji}
                {chip.count > 1 && <span>{chip.count}</span>}
              </button>
            ))}
          </div>
        )}
        {message.status === 'failed' && (
          <button className="retry" onClick={() => props.onRetry(message)}>
            <RotateCcw size={12} /> Не отправлено — повторить
          </button>
        )}
      </div>
    </div>
  );
});
