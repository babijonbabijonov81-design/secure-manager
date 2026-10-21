import {
  Bookmark,
  Copy,
  Download,
  Eraser,
  ExternalLink,
  Eye,
  EyeOff,
  FileText,
  Flame,
  Forward,
  KeyRound,
  Link2,
  LockKeyhole,
  Paperclip,
  SendHorizontal,
  StickyNote,
  Trash2,
} from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type DragEvent } from 'react';
import type { Messenger } from '../../../core/messenger.ts';
import { bridge } from '../../../core/platform.ts';
import {
  attachmentsOf,
  MAX_ATTACHMENT_BYTES,
  NOTE_BURN_DAYS,
  SAVED_ID,
  type Attachment,
  type Message,
  type MessengerSnapshot,
} from '../../../core/types.ts';
import { saveAttachment, useAttachmentUrl } from '../lib/attachments.ts';
import { clearSecret, copySecret } from '../lib/clipboard.ts';
import { formatDay, formatSize, formatTime, plural } from '../lib/format.ts';
import { feature, useNow } from '../lib/hooks.ts';
import { copyText, prepareFile } from '../lib/media.ts';
import { ConfirmDialog, Toggle, useToast } from '../lib/ui.tsx';
import { AttachmentPreview } from './AttachmentPreview.tsx';
import { Lightbox } from './ChatView.tsx';
import { VoicePlayer } from './VoicePlayer.tsx';

type Filter = 'all' | 'notes' | 'passwords' | 'files' | 'links' | 'chats';

const FILTERS: { id: Filter; label: string }[] = [
  { id: 'all', label: 'Всё' },
  { id: 'notes', label: 'Заметки' },
  { id: 'passwords', label: 'Пароли' },
  { id: 'files', label: 'Файлы' },
  { id: 'links', label: 'Ссылки' },
  { id: 'chats', label: 'Из чатов' },
];

const URL_RE = /https?:\/\/[^\s<>"']+/i;

function matches(message: Message, filter: Filter): boolean {
  const atts = attachmentsOf(message);
  const kind = message.note?.kind;
  switch (filter) {
    case 'all':
      return true;
    case 'passwords':
      return kind === 'password';
    case 'files':
      return atts.length > 0;
    case 'links':
      return kind === 'link' || (kind !== 'password' && !atts.length && URL_RE.test(message.text ?? ''));
    case 'chats':
      return !!message.fwd;
    case 'notes':
      return !atts.length && !message.fwd && kind !== 'password' && kind !== 'link' && !!message.text;
  }
}

/** «Избранное» as a vault: notes, passwords, links and files kept only on this computer. */
export function VaultView({ messenger, snapshot }: { messenger: Messenger; snapshot: MessengerSnapshot }) {
  const entries = useMemo(
    () => (snapshot.conversations[SAVED_ID] ?? []).filter((m) => m.dir !== 'system' && !m.call).slice().reverse(),
    [snapshot.conversations],
  );
  const [filter, setFilter] = useState<Filter>('all');
  const [pending, setPending] = useState<File[]>([]);
  const [lightbox, setLightbox] = useState<Attachment | null>(null);
  const [confirmClear, setConfirmClear] = useState(false);
  const [copied, setCopied] = useState<{ until: number; seconds: number } | null>(null);
  const [dragging, setDragging] = useState(false);
  const toast = useToast();
  const settings = snapshot.settings;
  const visible = entries.filter((m) => matches(m, filter));

  const copyPassword = async (text: string) => {
    try {
      if (!feature(settings, 'clipboard')) {
        await copyText(text);
        toast('Пароль скопирован', 'success');
        return;
      }
      const seconds = settings.clipboardSeconds;
      await copySecret(text, seconds);
      setCopied({ until: Date.now() + seconds * 1000, seconds });
    } catch {
      toast('Не удалось скопировать', 'error');
    }
  };

  const queue = (files: File[]) => {
    const ok = files.filter((f) => {
      if (f.size > MAX_ATTACHMENT_BYTES) toast(`«${f.name}» больше 20 МБ`, 'error');
      return f.size <= MAX_ATTACHMENT_BYTES;
    });
    if (ok.length) setPending((list) => [...list, ...ok]);
  };
  const sendFiles = async (caption: string, compress: boolean) => {
    const files = pending;
    setPending([]);
    try {
      const prepared = await Promise.all(files.map((f) => prepareFile(f, compress, settings.stripMetadata && feature(settings, 'stripMeta'))));
      await messenger.sendMedia(SAVED_ID, prepared, { caption });
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  };

  return (
    <section
      className="vault"
      aria-label="Избранное"
      onDragEnter={(e: DragEvent) => e.dataTransfer.types.includes('Files') && setDragging(true)}
      onDragOver={(e) => e.preventDefault()}
      onDragLeave={(e) => e.currentTarget === e.target && setDragging(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDragging(false);
        if (e.dataTransfer.files.length) queue([...e.dataTransfer.files]);
      }}
    >
      <div className="chat-bg" />
      <header className="vault-head">
        <span className="vault-mark">
          <Bookmark size={20} />
        </span>
        <div className="grow">
          <h2>Избранное</h2>
          <span className="vault-sub">
            <LockKeyhole size={13} /> Только на этом ПК · ключ scrypt 128 МиБ
          </span>
        </div>
        {entries.length > 0 && (
          <button className="icon-btn" aria-label="Очистить «Избранное»" title="Очистить" onClick={() => setConfirmClear(true)}>
            <Eraser size={19} />
          </button>
        )}
      </header>
      <div className="vault-filters" role="tablist" aria-label="Фильтр">
        {FILTERS.map((f) => {
          const count = entries.filter((m) => matches(m, f.id)).length;
          return (
            <button key={f.id} role="tab" aria-selected={filter === f.id} className={filter === f.id ? 'active' : ''} onClick={() => setFilter(f.id)}>
              {f.label}
              {f.id !== 'all' && count > 0 && <span className="count">{count}</span>}
            </button>
          );
        })}
      </div>

      <div className="vault-scroll">
        {visible.length ? (
          <div className="vault-grid">
            {visible.map((m) => (
              <VaultCard
                key={m.id}
                message={m}
                messenger={messenger}
                onCopyPassword={copyPassword}
                onOpenImage={setLightbox}
                onCopied={() => toast('Скопировано', 'success')}
              />
            ))}
          </div>
        ) : (
          <div className="vault-empty">
            <Bookmark size={30} />
            <b>{filter === 'all' ? 'Здесь пока пусто' : 'Ничего не найдено'}</b>
            <span>
              Заметки, пароли, ссылки и файлы для себя. Из чатов — правый клик по сообщению → «В избранное». Всё хранится зашифрованным только на
              этом компьютере и никуда не отправляется.
            </span>
          </div>
        )}
      </div>

      {copied && <ClipboardNotice copied={copied} onClear={() => void clearSecret().then(() => setCopied(null))} onDone={() => setCopied(null)} />}
      <VaultComposer messenger={messenger} snapshot={snapshot} onFiles={queue} />

      {dragging && (
        <div className="drop-zone" onDragLeave={() => setDragging(false)}>
          <div>
            <Paperclip size={32} />
            Отпустите, чтобы сохранить в «Избранное»
          </div>
        </div>
      )}
      {pending.length > 0 && (
        <AttachmentPreview
          files={pending}
          stripMetadata={settings.stripMetadata && feature(settings, 'stripMeta')}
          onAdd={queue}
          onRemove={(i) => setPending((list) => list.filter((_, j) => j !== i))}
          onClose={() => setPending([])}
          onSend={(caption, compress) => void sendFiles(caption, compress)}
        />
      )}
      {lightbox && <Lightbox messenger={messenger} items={[lightbox]} start={0} onClose={() => setLightbox(null)} />}
      {confirmClear && (
        <ConfirmDialog
          title="Очистить «Избранное»?"
          text="Все заметки, пароли и файлы в «Избранном» будут удалены с этого устройства. Вернуть их будет нельзя."
          confirm="Очистить"
          danger
          onClose={() => setConfirmClear(false)}
          onConfirm={() => messenger.clearChat(SAVED_ID)}
        />
      )}
    </section>
  );
}

/** «Пароль скопирован · буфер очистится через 30 с» with a shrinking bar. */
function ClipboardNotice({ copied, onClear, onDone }: { copied: { until: number; seconds: number }; onClear(): void; onDone(): void }) {
  const now = useNow(250);
  const left = Math.max(0, Math.ceil((copied.until - now) / 1000));
  useEffect(() => {
    if (copied.seconds && left === 0) onDone();
    if (!copied.seconds) {
      const timer = setTimeout(onDone, 4000);
      return () => clearTimeout(timer);
    }
  }, [left, copied.seconds, onDone]);
  return (
    <div className="clip-notice" role="status" data-testid="clipboard-notice">
      <KeyRound size={16} />
      <span className="grow">
        {copied.seconds ? (
          <>
            Пароль скопирован · буфер очистится через <b>{left}</b> с
          </>
        ) : (
          'Пароль скопирован · буфер не очищается (см. Настройки → Конфиденциальность)'
        )}
      </span>
      {copied.seconds > 0 && (
        <button className="btn btn-sm btn-ghost" onClick={onClear}>
          Очистить сейчас
        </button>
      )}
      {copied.seconds > 0 && <i className="clip-bar" style={{ width: `${Math.min(100, ((copied.until - now) / (copied.seconds * 1000)) * 100)}%` }} />}
    </div>
  );
}

function burnLabel(expiresAt: number, now: number): string {
  const left = expiresAt - now;
  const days = Math.floor(left / 86_400_000);
  if (days >= 1) return `Сгорит через ${days} ${plural(days, ['день', 'дня', 'дней'])}`;
  const hours = Math.floor(left / 3_600_000);
  if (hours >= 1) return `Сгорит через ${hours} ${plural(hours, ['час', 'часа', 'часов'])}`;
  const minutes = Math.max(1, Math.ceil(left / 60_000));
  return `Сгорит через ${minutes} мин`;
}

function VaultCard({
  message,
  messenger,
  onCopyPassword,
  onOpenImage,
  onCopied,
}: {
  message: Message;
  messenger: Messenger;
  onCopyPassword(text: string): void;
  onOpenImage(att: Attachment): void;
  onCopied(): void;
}) {
  const [shown, setShown] = useState(false);
  const now = useNow(30_000);
  const atts = attachmentsOf(message);
  const kind = message.note?.kind;
  const link = kind === 'link' || (!kind && !atts.length && URL_RE.test(message.text ?? '')) ? (message.text ?? '').match(URL_RE)?.[0] : undefined;
  const temp = !!message.expiresAt;
  const remove = () => void messenger.deleteMessage(SAVED_ID, message.id, false);
  const type = kind === 'password' ? 'password' : atts.length ? 'file' : link ? 'link' : 'note';
  const Icon = { password: KeyRound, file: FileText, link: Link2, note: StickyNote }[type];
  const title = { password: message.note?.title || 'Пароль', file: atts.length > 1 ? `Файлы · ${atts.length}` : 'Файл', link: 'Ссылка', note: 'Заметка' }[type];

  return (
    <article className={`vault-card ${type}${temp ? ' temp' : ''}`} data-testid="vault-card" data-kind={type}>
      <div className="vault-card-head">
        <Icon size={16} />
        <b>{title}</b>
        <span className="when">
          {formatDay(message.ts)}, {formatTime(message.ts)}
        </span>
      </div>
      {message.fwd && (
        <div className="fwd">
          <Forward size={13} /> Из чата · <b>{message.fwd.name}</b>
        </div>
      )}
      {atts.map((att) =>
        att.kind === 'image' || att.kind === 'sticker' ? (
          <VaultImage key={att.id} messenger={messenger} att={att} onOpen={() => onOpenImage(att)} />
        ) : att.kind === 'voice' ? (
          <VoicePlayer key={att.id} messenger={messenger} att={att} />
        ) : (
          <div className="file-card" key={att.id}>
            <button className="file-icon" onClick={() => void saveAttachment(messenger, att)} aria-label={`Сохранить «${att.name}»`}>
              <Download size={20} />
            </button>
            <div className="file-info">
              <span className="file-name" title={att.name}>
                {att.name}
              </span>
              <span className="file-size">{formatSize(att.size)}</span>
            </div>
          </div>
        ),
      )}
      {type === 'password' ? (
        <div className="secret-row">
          <code className={shown ? 'selectable' : 'masked'} aria-label={shown ? undefined : 'Пароль скрыт'}>
            {shown ? message.text : '•'.repeat(Math.min(14, Math.max(8, message.text?.length ?? 8)))}
          </code>
        </div>
      ) : link ? (
        <div className="link-body">
          <span className="link-host">{hostOf(link)}</span>
          <span className="link-url selectable">{message.text}</span>
          <span className="link-note">Без превью: Veil не открывал ссылку</span>
        </div>
      ) : (
        message.text && <div className={`note-text selectable${atts.length ? ' caption' : ''}`}>{message.text}</div>
      )}
      {temp && (
        <div className="burn">
          <Flame size={14} /> {burnLabel(message.expiresAt!, now)} · удаление окончательное
        </div>
      )}
      <div className="vault-actions">
        {type === 'password' && (
          <>
            <button className="btn btn-sm btn-secondary" onClick={() => setShown((v) => !v)}>
              {shown ? <EyeOff size={15} /> : <Eye size={15} />} {shown ? 'Скрыть' : 'Показать'}
            </button>
            <button className="btn btn-sm btn-secondary" onClick={() => onCopyPassword(message.text ?? '')}>
              <Copy size={15} /> Копировать
            </button>
          </>
        )}
        {link && (
          <button className="btn btn-sm btn-secondary" onClick={() => (bridge ? bridge.openExternal(link) : window.open(link, '_blank', 'noopener,noreferrer'))}>
            <ExternalLink size={15} /> Открыть
          </button>
        )}
        {type !== 'password' && message.text && (
          <button className="icon-btn sm" aria-label="Копировать" title="Копировать" onClick={() => void copyText(message.text!).then(onCopied)}>
            <Copy size={16} />
          </button>
        )}
        <span className="spacer" />
        <button className="icon-btn sm" aria-label="Удалить" title="Удалить" onClick={remove}>
          <Trash2 size={16} />
        </button>
      </div>
    </article>
  );
}

const hostOf = (url: string) => {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
};

function VaultImage({ messenger, att, onOpen }: { messenger: Messenger; att: Attachment; onOpen(): void }) {
  const url = useAttachmentUrl(messenger, att);
  const ratio = att.w && att.h ? att.w / att.h : 4 / 3;
  return (
    <button className="vault-image" style={{ aspectRatio: String(Math.max(0.6, Math.min(2, ratio))) }} onClick={onOpen} aria-label="Открыть фото">
      {url && <img src={url} alt="" draggable={false} />}
    </button>
  );
}

/** «Заметка, пароль или ссылка — для себя», with «Как пароль» and «Сгорит через». */
function VaultComposer({ messenger, snapshot, onFiles }: { messenger: Messenger; snapshot: MessengerSnapshot; onFiles(files: File[]): void }) {
  const [text, setText] = useState('');
  const [asPassword, setAsPassword] = useState(false);
  const [title, setTitle] = useState('');
  const [reveal, setReveal] = useState(false);
  const [burn, setBurn] = useState(0);
  const fileInput = useRef<HTMLInputElement>(null);
  const toast = useToast();
  const tempNotes = feature(snapshot.settings, 'tempNotes');

  const save = () => {
    if (!text.trim()) return;
    try {
      messenger.addNote({ text, kind: asPassword ? 'password' : undefined, title: asPassword ? title : undefined, burnDays: tempNotes ? burn : 0 });
      setText('');
      setTitle('');
      setReveal(false);
      setAsPassword(false);
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  };

  return (
    <form
      className="vault-composer"
      onSubmit={(e) => {
        e.preventDefault();
        save();
      }}
    >
      <div className="vault-options">
        <label className="chip-toggle">
          <Toggle label="Как пароль" on={asPassword} onChange={setAsPassword} />
          Как пароль
        </label>
        {tempNotes && (
          <label className="burn-select">
            <Flame size={15} />
            <select aria-label="Сгорит через" value={burn} onChange={(e) => setBurn(Number(e.target.value))}>
              <option value={0}>Хранить всегда</option>
              {NOTE_BURN_DAYS.map((d) => (
                <option key={d} value={d}>
                  Сгорит через {d} {plural(d, ['день', 'дня', 'дней'])}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>
      <div className="vault-input">
        <button type="button" className="icon-btn" aria-label="Прикрепить файл" title="Файл" onClick={() => fileInput.current?.click()}>
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
        {asPassword && (
          <input className="input title-input" placeholder="Для чего (например, Wi-Fi дома)" aria-label="Для чего пароль" value={title} onChange={(e) => setTitle(e.target.value)} />
        )}
        {asPassword ? (
          <input
            className="input"
            type={reveal ? 'text' : 'password'}
            autoComplete="off"
            placeholder="Пароль"
            aria-label="Пароль для сохранения"
            value={text}
            onChange={(e) => setText(e.target.value)}
          />
        ) : (
          <textarea
            className="input"
            rows={1}
            placeholder="Заметка, пароль или ссылка — для себя"
            aria-label="Заметка, пароль или ссылка — для себя"
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                save();
              }
            }}
          />
        )}
        {asPassword && (
          <button type="button" className="icon-btn" aria-label={reveal ? 'Спрятать' : 'Показать'} title={reveal ? 'Спрятать' : 'Показать'} onClick={() => setReveal((v) => !v)}>
            {reveal ? <EyeOff size={19} /> : <Eye size={19} />}
          </button>
        )}
        <button className="icon-btn send" aria-label="Сохранить" title="Сохранить" disabled={!text.trim()}>
          <SendHorizontal size={19} />
        </button>
      </div>
      {asPassword && (
        <span className="vault-hint">
          Пароль виден только по кнопке «Показать». Скопированный пароль стирается из буфера обмена.
        </span>
      )}
    </form>
  );
}
