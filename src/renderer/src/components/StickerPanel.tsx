import { Plus, Trash2 } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { Messenger } from '../../../core/messenger.ts';
import type { StickerMeta } from '../../../core/types.ts';
import { prepareSticker } from '../lib/media.ts';
import { ContextMenu, useToast } from '../lib/ui.tsx';

const stickerUrls = new Map<string, Promise<string | null>>();

export function stickerUrl(messenger: Messenger, meta: StickerMeta): Promise<string | null> {
  let url = stickerUrls.get(meta.id);
  if (!url) {
    url = messenger
      .getSticker(meta.id)
      .then((bytes) => (bytes ? URL.createObjectURL(new Blob([bytes as BlobPart], { type: meta.mime })) : null));
    stickerUrls.set(meta.id, url);
  }
  return url;
}

function StickerThumb({ messenger, meta, onPick, onMenu }: { messenger: Messenger; meta: StickerMeta; onPick(): void; onMenu(x: number, y: number): void }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    void stickerUrl(messenger, meta).then((u) => alive && setUrl(u));
    return () => {
      alive = false;
    };
  }, [messenger, meta]);
  return (
    <button
      className="sticker-cell"
      onClick={onPick}
      onContextMenu={(e) => {
        e.preventDefault();
        onMenu(e.clientX, e.clientY);
      }}
      title="Отправить стикер"
    >
      {url && <img src={url} alt="" draggable={false} />}
    </button>
  );
}

/** My sticker collection: send, add from images, remove. */
export function StickerPanel({ messenger, stickers, onPick }: { messenger: Messenger; stickers: StickerMeta[]; onPick(id: string): void }) {
  const input = useRef<HTMLInputElement>(null);
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [menu, setMenu] = useState<{ x: number; y: number; id: string } | null>(null);

  const add = async (files: File[]) => {
    setBusy(true);
    try {
      for (const file of files) {
        const sticker = await prepareSticker(file);
        await messenger.addSticker(sticker.data, sticker.mime, sticker.w, sticker.h);
      }
      toast(files.length > 1 ? 'Стикеры добавлены' : 'Стикер добавлен', 'success');
    } catch {
      toast('Не удалось добавить: выберите картинку PNG, JPG, WebP или GIF', 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="sticker-grid">
      <button className="sticker-cell add" onClick={() => input.current?.click()} disabled={busy} title="Добавить свои стикеры">
        {busy ? <span className="spinner" /> : <Plus size={26} />}
        <span>Добавить</span>
      </button>
      <input
        ref={input}
        type="file"
        accept="image/png,image/jpeg,image/webp,image/gif"
        multiple
        hidden
        onChange={(e) => {
          if (e.target.files?.length) void add([...e.target.files]);
          e.target.value = '';
        }}
      />
      {stickers.map((meta) => (
        <StickerThumb key={meta.id} messenger={messenger} meta={meta} onPick={() => onPick(meta.id)} onMenu={(x, y) => setMenu({ x, y, id: meta.id })} />
      ))}
      {!stickers.length && <p className="sticker-empty">Загрузите картинки — они станут вашими стикерами. Собеседник сможет сохранить их себе.</p>}
      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          onClose={() => setMenu(null)}
          items={[{ label: 'Удалить из набора', icon: <Trash2 size={16} />, danger: true, onClick: () => void messenger.removeSticker(menu.id) }]}
        />
      )}
    </div>
  );
}
