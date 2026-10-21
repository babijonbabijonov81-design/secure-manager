import type { LinkPreview } from './types.ts';

// Link previews: which addresses may be fetched, and reading the title, description and picture
// from a page. Used by the sender only (src/main/preview.ts); the recipient never opens a link.

const PRIVATE = /^(localhost|127\.|10\.|0\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|\[?::1\]?$|\[?f[cd][0-9a-f]{2}:|\[?fe80:)|\.(local|lan|internal|home|corp)$/i;

export function isPublicUrl(raw: string): URL | null {
  try {
    const url = new URL(raw);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    if (url.username || url.password) return null;
    if (PRIVATE.test(url.hostname) || !url.hostname.includes('.')) return null;
    return url;
  } catch {
    return null;
  }
}

/** A resolved IP address that belongs to this computer or a local network (checked after DNS). */
export function isPrivateAddress(ip: string): boolean {
  const v4 = /^(?:::ffff:)?(\d+)\.(\d+)\.(\d+)\.(\d+)$/i.exec(ip);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    return a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b < 128) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b < 32) || (a === 192 && b === 168);
  }
  const v6 = ip.toLowerCase();
  return v6 === '::' || v6 === '::1' || /^f[cd]/.test(v6) || /^fe[89ab]/.test(v6) || v6.startsWith('ff');
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', laquo: '«', raquo: '»', mdash: '—', ndash: '–', hellip: '…' };
const decode = (text: string) =>
  text
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(Number(dec)))
    .replace(/&([a-z]+);/gi, (m, name) => ENTITIES[name.toLowerCase()] ?? m)
    .replace(/\s+/g, ' ')
    .trim();

/** <meta property="og:title" content="…"> in either attribute order, plus <title>. */
export function parsePreview(html: string, url: string): { url: string; title: string; desc?: string; site?: string; imageUrl?: string } {
  const head = html.slice(0, 300_000);
  const meta = (names: string[]) => {
    for (const name of names) {
      const a = new RegExp(`<meta[^>]+(?:property|name)=["']${name}["'][^>]*content=["']([^"']*)["']`, 'i').exec(head);
      const b = new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]*(?:property|name)=["']${name}["']`, 'i').exec(head);
      const value = (a ?? b)?.[1];
      if (value) return decode(value);
    }
    return undefined;
  };
  const title = meta(['og:title', 'twitter:title']) ?? decode(/<title[^>]*>([^<]*)<\/title>/i.exec(head)?.[1] ?? '');
  const image = meta(['og:image', 'og:image:url', 'twitter:image']);
  let imageUrl: string | undefined;
  try {
    imageUrl = image ? new URL(image, url).toString() : undefined;
  } catch {
    imageUrl = undefined;
  }
  return {
    url,
    title: title.slice(0, 200),
    desc: meta(['og:description', 'description', 'twitter:description'])?.slice(0, 400),
    site: meta(['og:site_name'])?.slice(0, 80) ?? new URL(url).hostname.replace(/^www\./, ''),
    imageUrl,
  };
}

const IMAGE_DATA = /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/]+=*$/;
const MAX_IMAGE_DATA = 90_000;

/** Checks a preview from the other side: only for a link that is in the text, with sane sizes. */
export function cleanPreview(raw: unknown, text: string | undefined): LinkPreview | undefined {
  if (!raw || typeof raw !== 'object' || !text) return undefined;
  const p = raw as Record<string, unknown>;
  const url = typeof p.url === 'string' ? p.url : '';
  if (!/^https?:\/\//i.test(url) || !text.includes(url) || typeof p.title !== 'string' || !p.title.trim()) return undefined;
  const str = (value: unknown, max: number) => (typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : undefined);
  const img = typeof p.img === 'string' && p.img.length <= MAX_IMAGE_DATA && IMAGE_DATA.test(p.img) ? p.img : undefined;
  return {
    url,
    title: p.title.trim().slice(0, 200),
    ...(str(p.desc, 400) ? { desc: str(p.desc, 400) } : {}),
    ...(str(p.site, 80) ? { site: str(p.site, 80) } : {}),
    ...(img ? { img } : {}),
  };
}

/** The first http(s) link in a text. */
export const firstLink = (text: string): string | undefined => /https?:\/\/[^\s<>"']+[^\s<>"'.,;:!?)\]]/.exec(text)?.[0];
