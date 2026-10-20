import { useEffect, useState } from 'react';
import type { Messenger } from '../../../core/messenger.ts';
import { bridge } from '../../../core/platform.ts';
import type { Attachment } from '../../../core/types.ts';

// Decrypted attachments are kept as blob: URLs for the lifetime of the unlocked session.
const urls = new Map<string, Promise<string | null>>();

export function attachmentUrl(messenger: Messenger, att: Attachment): Promise<string | null> {
  let url = urls.get(att.id);
  if (!url) {
    url = messenger.getAttachment(att.id).then((bytes) => (bytes ? URL.createObjectURL(new Blob([bytes as BlobPart], { type: att.mime })) : null));
    urls.set(att.id, url);
  }
  return url;
}

export function useAttachmentUrl(messenger: Messenger, att: Attachment | undefined): string | null {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    if (att) void attachmentUrl(messenger, att).then((u) => alive && setUrl(u));
    return () => {
      alive = false;
    };
  }, [messenger, att]);
  return url;
}

export function revokeAttachmentUrls(): void {
  for (const url of urls.values()) void url.then((u) => u && URL.revokeObjectURL(u));
  urls.clear();
}

export async function saveAttachment(messenger: Messenger, att: Attachment): Promise<void> {
  const bytes = await messenger.getAttachment(att.id);
  if (!bytes) return;
  if (bridge) {
    await bridge.saveFile(att.name, bytes);
    return;
  }
  const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: att.mime }));
  const a = document.createElement('a');
  a.href = url;
  a.download = att.name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export async function readFile(file: File): Promise<{ name: string; mime: string; data: Uint8Array; w?: number; h?: number }> {
  const data = new Uint8Array(await file.arrayBuffer());
  let w: number | undefined;
  let h: number | undefined;
  if (file.type.startsWith('image/')) {
    try {
      const bitmap = await createImageBitmap(file);
      w = bitmap.width;
      h = bitmap.height;
      bitmap.close();
    } catch {
      // not a decodable image: send as a regular file
    }
  }
  return { name: file.name || 'file', mime: w ? file.type : file.type || 'application/octet-stream', data, w, h };
}
