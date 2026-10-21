// Link previews made by the sender (features.linkPreviews). The recipient's Veil never opens the
// link: the title, description and a small picture travel inside the end-to-end encrypted message.
// Only public http(s) addresses are fetched — never this computer or the local network: every hop
// of a redirect is checked by name and by the addresses its name resolves to.

import { lookup } from 'node:dns/promises';
import { net } from 'electron';
import { isPrivateAddress, isPublicUrl, parsePreview } from '../core/link-preview.ts';

const TIMEOUT_MS = 6000;
const MAX_HTML = 1024 * 1024;
const MAX_IMAGE = 3 * 1024 * 1024;
const MAX_REDIRECTS = 4;

export interface FetchedPreview {
  url: string;
  title: string;
  desc?: string;
  site?: string;
  image?: Uint8Array;
  imageType?: string;
}

async function isPublicHost(url: URL): Promise<boolean> {
  try {
    const addresses = await lookup(url.hostname.replace(/^\[|\]$/g, ''), { all: true, verbatim: true });
    return addresses.length > 0 && addresses.every((a) => !isPrivateAddress(a.address));
  } catch {
    return false;
  }
}

/** Up to `max` bytes. A page is cut (its <head> comes first); a picture that is too big is dropped. */
async function readLimited(response: Response, max: number, cut: boolean): Promise<Uint8Array | null> {
  if (!response.body) return null;
  const reader = response.body.getReader();
  const parts: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (size + value.length > max) {
      await reader.cancel();
      if (!cut) return null;
      parts.push(value.subarray(0, max - size));
      size = max;
      break;
    }
    parts.push(value);
    size += value.length;
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) {
    bytes.set(part, offset);
    offset += part.length;
  }
  return bytes;
}

async function fetchLimited(start: string, max: number, accept: string, cut: boolean): Promise<{ bytes: Uint8Array; type: string; finalUrl: string } | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    let url = isPublicUrl(start);
    for (let hop = 0; url && hop <= MAX_REDIRECTS; hop++) {
      if (!(await isPublicHost(url))) return null;
      const response = await net.fetch(url.toString(), {
        signal: controller.signal,
        redirect: 'manual',
        headers: { accept, 'accept-language': 'ru,en;q=0.8', 'user-agent': 'Mozilla/5.0 (compatible; VeilPreview/2.0)' },
        credentials: 'omit',
      });
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get('location');
        url = location ? isPublicUrl(new URL(location, url).toString()) : null;
        continue;
      }
      if (!response.ok) return null;
      const bytes = await readLimited(response, max, cut);
      return bytes ? { bytes, type: response.headers.get('content-type') ?? '', finalUrl: url.toString() } : null;
    }
    return null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchLinkPreview(raw: string): Promise<FetchedPreview | null> {
  const url = isPublicUrl(String(raw));
  if (!url) return null;
  const page = await fetchLimited(url.toString(), MAX_HTML, 'text/html,application/xhtml+xml', true);
  if (!page || !/html/i.test(page.type)) return null;
  const parsed = parsePreview(new TextDecoder().decode(page.bytes), page.finalUrl);
  if (!parsed.title) return null;
  const { imageUrl, ...preview } = parsed;
  if (imageUrl) {
    const image = await fetchLimited(imageUrl, MAX_IMAGE, 'image/*', false);
    if (image && /^image\/(jpeg|png|webp|gif)/.test(image.type)) return { ...preview, url: url.toString(), image: image.bytes, imageType: image.type };
  }
  return { ...preview, url: url.toString() };
}
