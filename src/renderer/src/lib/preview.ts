import { isPublicUrl } from '../../../core/link-preview.ts';
import { bridge } from '../../../core/platform.ts';
import type { LinkPreview } from '../../../core/types.ts';

const cache = new Map<string, Promise<LinkPreview | null>>();

/** A small JPEG of the page picture, as a data: URL that fits inside the message. */
async function thumbnail(bytes: Uint8Array, type: string): Promise<string | undefined> {
  try {
    const bitmap = await createImageBitmap(new Blob([bytes as BlobPart], { type }));
    const scale = Math.min(1, 360 / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    canvas.getContext('2d')!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close();
    for (const quality of [0.72, 0.55, 0.4]) {
      const url = canvas.toDataURL('image/jpeg', quality);
      if (url.length < 80_000) return url;
    }
  } catch {
    // not a picture we can read
  }
  return undefined;
}

/**
 * The sender's side only: the desktop app fetches the page (public addresses only). The browser
 * version cannot read other sites, so there are no previews there.
 */
export function makePreview(url: string): Promise<LinkPreview | null> {
  if (!bridge || !isPublicUrl(url)) return Promise.resolve(null);
  let pending = cache.get(url);
  if (!pending) {
    pending = bridge
      .linkPreview(url)
      .then(async (raw) => {
        if (!raw) return null;
        const img = raw.image && raw.imageType ? await thumbnail(raw.image, raw.imageType) : undefined;
        return { url, title: raw.title, ...(raw.desc ? { desc: raw.desc } : {}), ...(raw.site ? { site: raw.site } : {}), ...(img ? { img } : {}) };
      })
      .catch(() => null);
    cache.set(url, pending);
  }
  return pending;
}
