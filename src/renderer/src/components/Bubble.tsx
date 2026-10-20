import { AlertCircle, Ban, Check, CheckCheck, Clock, Download, FileText, ImageIcon, RotateCcw, Timer } from 'lucide-react';
import { memo, useEffect, useState, type MouseEvent, type ReactNode } from 'react';
import type { Messenger } from '../../../core/messenger.ts';
import { bridge } from '../../../core/platform.ts';
import type { Message } from '../../../core/types.ts';
import { saveAttachment, useAttachmentUrl } from '../lib/attachments.ts';
import { formatSize, formatTime, isEmojiOnly, remaining } from '../lib/format.ts';

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

/** Display size for an image bubble: fits 320×360, small pictures are shown at least 140px wide. */
function imageBox(w = 320, h = 240): { width: number; height: number } {
  let scale = Math.min(1, 320 / w, 360 / h);
  if (w * scale < 140) scale = Math.min(140 / w, 360 / h);
  return { width: Math.round(w * scale), height: Math.round(h * scale) };
}

interface BubbleProps {
  message: Message;
  messenger: Messenger;
  groupStart: boolean;
  groupEnd: boolean;
  onContext(e: MouseEvent, message: Message): void;
  onOpenImage(url: string, message: Message): void;
  onRetry(message: Message): void;
}

export const Bubble = memo(function Bubble({ message, messenger, groupStart, groupEnd, onContext, onOpenImage, onRetry }: BubbleProps) {
  const url = useAttachmentUrl(messenger, message.att);
  const meta = (
    <span className="meta">
      {message.expiresAt && <Countdown expiresAt={message.expiresAt} />}
      {formatTime(message.ts)}
      {message.dir === 'out' && <StatusIcon status={message.status} />}
    </span>
  );
  const rowClass = `msg-row ${message.dir}${groupStart ? ' group-start' : ''}${groupEnd ? ' group-end' : ''}`;

  let content: ReactNode;
  let bubbleClass = 'bubble';
  if (message.deleted) {
    bubbleClass += ' deleted';
    content = (
      <>
        <Ban size={14} style={{ verticalAlign: -2, marginRight: 6 }} />
        Сообщение удалено
        {meta}
      </>
    );
  } else if (message.att?.kind === 'image') {
    bubbleClass += ' media';
    const size = imageBox(message.att.w, message.att.h);
    content = (
      <>
        {url ? (
          <img src={url} alt={message.att.name} style={size} onClick={() => onOpenImage(url, message)} draggable={false} />
        ) : (
          <div className="img-placeholder" style={size}>
            <ImageIcon size={28} />
          </div>
        )}
        {message.text && <div style={{ padding: '6px 8px 2px' }}>{linkify(message.text)}</div>}
        {meta}
      </>
    );
  } else if (message.att) {
    const att = message.att;
    content = (
      <>
        <div className="file-card">
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
        {meta}
      </>
    );
  } else {
    if (isEmojiOnly(message.text)) bubbleClass += ' emoji-only';
    content = (
      <>
        {linkify(message.text ?? '')}
        {meta}
      </>
    );
  }

  return (
    <div className={rowClass} data-testid="message" data-dir={message.dir}>
      <div className="msg-col">
        <div className={bubbleClass} onContextMenu={(e) => onContext(e, message)}>
          {content}
        </div>
        {message.status === 'failed' && (
          <button className="retry" onClick={() => onRetry(message)}>
            <RotateCcw size={12} /> Не отправлено — повторить
          </button>
        )}
      </div>
    </div>
  );
});
