import { FileText, ImagePlus, SendHorizontal, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { canSendOnce } from '../../../core/messenger.ts';
import { MAX_ALBUM_ITEMS } from '../../../core/types.ts';
import { formatSize } from '../lib/format.ts';
import { Modal, Toggle } from '../lib/ui.tsx';

interface Props {
  files: File[];
  /** View-once sending is available (feature on, not «Избранное»). */
  allowOnce?: boolean;
  onAdd(files: File[]): void;
  onRemove(index: number): void;
  onClose(): void;
  onSend(caption: string, compress: boolean, once: boolean): void;
}

/** Telegram-style "send files" dialog: thumbnails, caption and photo compression. */
export function AttachmentPreview({ files, allowOnce, onAdd, onRemove, onClose, onSend }: Props) {
  const [caption, setCaption] = useState('');
  const [compress, setCompress] = useState(true);
  const [onceChosen, setOnce] = useState(false);
  const onceAvailable = !!allowOnce && files.length === 1 && canSendOnce(files[0].type);
  const once = onceAvailable && onceChosen;
  const input = useRef<HTMLInputElement>(null);
  const [urls, setUrls] = useState<(string | null)[]>([]);
  useEffect(() => {
    const created = files.map((f) => (f.type.startsWith('image/') ? URL.createObjectURL(f) : null));
    setUrls(created);
    return () => created.forEach((u) => u && URL.revokeObjectURL(u));
  }, [files]);
  const images = files.filter((f) => f.type.startsWith('image/')).length;
  const total = files.reduce((sum, f) => sum + f.size, 0);
  const title = images === files.length ? (images === 1 ? 'Отправить фото' : `Отправить ${images} фото`) : `Отправить файлы: ${files.length}`;

  return (
    <Modal title={title} onClose={onClose} width={520}>
      <div className="modal-body">
        <div className={`preview-grid${files.length === 1 ? ' single' : ''}`}>
          {files.map((file, i) => (
            <div className="preview-item" key={`${file.name}${i}`}>
              {urls[i] ? (
                <img src={urls[i]!} alt={file.name} />
              ) : (
                <div className="preview-file">
                  <FileText size={26} />
                  <span>{file.name}</span>
                  <small>{formatSize(file.size)}</small>
                </div>
              )}
              <button className="preview-remove" onClick={() => onRemove(i)} aria-label="Убрать">
                <X size={14} />
              </button>
            </div>
          ))}
          {files.length < MAX_ALBUM_ITEMS * 3 && (
            <button className="preview-add" onClick={() => input.current?.click()}>
              <ImagePlus size={24} />
              Добавить
            </button>
          )}
        </div>
        <input
          ref={input}
          type="file"
          multiple
          hidden
          onChange={(e) => {
            if (e.target.files?.length) onAdd([...e.target.files]);
            e.target.value = '';
          }}
        />
        <textarea
          className="input caption-input"
          placeholder="Добавьте подпись…"
          aria-label="Подпись"
          value={caption}
          autoFocus
          rows={2}
          onChange={(e) => setCaption(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              onSend(caption, compress, once);
            }
          }}
        />
        {onceAvailable && (
          <div className="setting-row" style={{ padding: 0, border: 0 }}>
            <div className="grow">
              <b>Открыть один раз</b>
              <span>Собеседник откроет {files[0].type.startsWith('video/') ? 'видео' : 'фото'} один раз, потом оно исчезнет у вас обоих. Переслать и сохранить его нельзя.</span>
            </div>
            <Toggle label="Открыть один раз" on={onceChosen} onChange={setOnce} />
          </div>
        )}
        {images > 0 && (
          <div className="setting-row" style={{ padding: 0, border: 0 }}>
            <div className="grow">
              <b>Сжать фото</b>
              <span>Быстрее отправляется. Выключите, чтобы отправить в исходном качестве.</span>
            </div>
            <Toggle label="Сжать фото" on={compress} onChange={setCompress} />
          </div>
        )}
        <div className="form-actions" style={{ marginTop: 0 }}>
          <span className="field-hint" style={{ alignSelf: 'center', flex: 1 }}>
            {files.length} {files.length === 1 ? 'файл' : 'файлов'} · {formatSize(total)}
          </span>
          <button className="btn btn-secondary" onClick={onClose}>
            Отмена
          </button>
          <button className="btn btn-primary" onClick={() => onSend(caption, compress, once)} disabled={!files.length}>
            <SendHorizontal size={17} /> Отправить
          </button>
        </div>
      </div>
    </Modal>
  );
}
