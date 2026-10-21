// Removes identifying metadata before a file is encrypted and sent:
//   photos (JPEG, PNG, WebP) — EXIF with GPS and camera data, XMP, IPTC, text chunks;
//   PDF — author, creator and producer in the info dictionary, and the XMP metadata stream;
//   Office (docx/xlsx/pptx) and OpenDocument — author, last editor, application, company.
// The picture or document itself is not changed. A JPEG keeps only its orientation tag, so the
// photo is not shown sideways.

import { strFromU8, strToU8, unzipSync, zipSync, type Zippable } from 'fflate';

export type StripResult = { data: Uint8Array; stripped: 'photo' | 'document' | null };

const OFFICE_MIME = /officedocument|ms-word|ms-excel|ms-powerpoint|opendocument/;
const OFFICE_EXT = /\.(docx|docm|xlsx|xlsm|pptx|pptm|odt|ods|odp)$/i;

export const isStrippable = (mime: string, name = '') =>
  /^image\/(jpeg|png|webp)$/.test(mime) || mime === 'application/pdf' || /\.pdf$/i.test(name) || OFFICE_MIME.test(mime) || OFFICE_EXT.test(name);

/** Never throws: a file it cannot clean is returned unchanged with `stripped: null`. */
export async function stripMetadata(data: Uint8Array, mime: string, name = ''): Promise<StripResult> {
  try {
    if (mime === 'image/jpeg' || isJpeg(data)) return { data: stripJpeg(data), stripped: 'photo' };
    if (mime === 'image/png' || isPng(data)) return { data: stripPng(data), stripped: 'photo' };
    if (mime === 'image/webp' || isWebp(data)) return { data: stripWebp(data), stripped: 'photo' };
    if (mime === 'application/pdf' || /\.pdf$/i.test(name)) return { data: await stripPdf(data), stripped: 'document' };
    if (OFFICE_MIME.test(mime) || OFFICE_EXT.test(name)) return { data: stripOffice(data), stripped: 'document' };
  } catch {
    // damaged or encrypted file: send as it is
  }
  return { data, stripped: null };
}

// ---- JPEG ----------------------------------------------------------------------------------

const isJpeg = (d: Uint8Array) => d[0] === 0xff && d[1] === 0xd8;

/** EXIF orientation (1–8) from an APP1 segment payload, or 1. */
function exifOrientation(payload: Uint8Array): number {
  if (payload.length < 14 || String.fromCharCode(...payload.subarray(0, 4)) !== 'Exif') return 1;
  const tiff = payload.subarray(6);
  const little = tiff[0] === 0x49;
  const view = new DataView(tiff.buffer, tiff.byteOffset, tiff.byteLength);
  const u16 = (o: number) => view.getUint16(o, little);
  const u32 = (o: number) => view.getUint32(o, little);
  const ifd = u32(4);
  const count = u16(ifd);
  for (let i = 0; i < count; i++) {
    const entry = ifd + 2 + i * 12;
    if (u16(entry) === 0x0112) {
      const value = u16(entry + 8);
      return value >= 1 && value <= 8 ? value : 1;
    }
  }
  return 1;
}

/** A minimal APP1 Exif segment holding just the orientation tag. */
function orientationSegment(orientation: number): Uint8Array {
  const tiff = [0x4d, 0x4d, 0x00, 0x2a, 0, 0, 0, 8, 0, 1, 0x01, 0x12, 0, 3, 0, 0, 0, 1, 0, orientation, 0, 0, 0, 0, 0, 0];
  const payload = [0x45, 0x78, 0x69, 0x66, 0, 0, ...tiff];
  const length = payload.length + 2;
  return Uint8Array.from([0xff, 0xe1, length >> 8, length & 0xff, ...payload]);
}

export function stripJpeg(data: Uint8Array): Uint8Array {
  const out: Uint8Array[] = [data.subarray(0, 2)];
  let orientation = 1;
  let offset = 2;
  let scan = false;
  while (offset + 4 <= data.length) {
    if (data[offset] !== 0xff) throw new Error('bad JPEG');
    const marker = data[offset + 1];
    if (marker === 0xd9 || marker === 0xda) {
      scan = true; // image data follows untouched
      break;
    }
    if (marker >= 0xd0 && marker <= 0xd7) {
      offset += 2;
      continue;
    }
    const length = (data[offset + 2] << 8) | data[offset + 3];
    const segment = data.subarray(offset, offset + 2 + length);
    const payload = segment.subarray(4);
    // APP1 (EXIF/XMP), APP12–APP13 (IPTC, Photoshop), APP15, COM: dropped. APP0 (JFIF),
    // APP2 (ICC colour profile) and APP14 (Adobe colour transform) are needed to show it right.
    if (marker === 0xe1) orientation = Math.max(orientation, exifOrientation(payload));
    const drop = marker === 0xe1 || marker === 0xec || marker === 0xed || marker === 0xef || marker === 0xfe || (marker >= 0xe3 && marker <= 0xeb);
    if (!drop) out.push(segment);
    offset += 2 + length;
  }
  if (!scan) throw new Error('bad JPEG');
  if (orientation !== 1) out.splice(1, 0, orientationSegment(orientation));
  out.push(data.subarray(offset));
  return concatAll(out);
}

// ---- PNG -----------------------------------------------------------------------------------

const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const isPng = (d: Uint8Array) => PNG_SIG.every((b, i) => d[i] === b);
const PNG_DROP = new Set(['tEXt', 'zTXt', 'iTXt', 'eXIf', 'tIME']);

export function stripPng(data: Uint8Array): Uint8Array {
  if (!isPng(data)) throw new Error('bad PNG');
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const out: Uint8Array[] = [data.subarray(0, 8)];
  let offset = 8;
  while (offset + 12 <= data.length) {
    const length = view.getUint32(offset);
    const type = String.fromCharCode(...data.subarray(offset + 4, offset + 8));
    const end = offset + 12 + length;
    if (end > data.length) throw new Error('bad PNG');
    if (!PNG_DROP.has(type)) out.push(data.subarray(offset, end));
    offset = end;
    if (type === 'IEND') break;
  }
  return concatAll(out);
}

// ---- WebP ----------------------------------------------------------------------------------

const isWebp = (d: Uint8Array) => String.fromCharCode(...d.subarray(0, 4)) === 'RIFF' && String.fromCharCode(...d.subarray(8, 12)) === 'WEBP';

export function stripWebp(data: Uint8Array): Uint8Array {
  if (!isWebp(data)) throw new Error('bad WebP');
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const chunks: Uint8Array[] = [];
  let offset = 12;
  while (offset + 8 <= data.length) {
    const type = String.fromCharCode(...data.subarray(offset, offset + 4));
    const size = view.getUint32(offset + 4, true);
    const end = offset + 8 + size + (size & 1);
    if (type !== 'EXIF' && type !== 'XMP ') {
      const chunk = data.slice(offset, Math.min(end, data.length));
      // VP8X flags: clear the "has EXIF" (0x08) and "has XMP" (0x04) bits.
      if (type === 'VP8X') chunk[8] &= ~0x0c;
      chunks.push(chunk);
    }
    offset = end;
  }
  const body = concatAll(chunks);
  const header = new Uint8Array(12);
  header.set(data.subarray(0, 12));
  new DataView(header.buffer).setUint32(4, body.length + 4, true);
  return concatAll([header, body]);
}

// ---- PDF -----------------------------------------------------------------------------------

async function stripPdf(data: Uint8Array): Promise<Uint8Array> {
  const { PDFDocument, PDFName } = await import('pdf-lib');
  const pdf = await PDFDocument.load(data, { updateMetadata: false });
  const info = pdf.context.lookup(pdf.context.trailerInfo.Info);
  if (info && 'delete' in info) {
    for (const key of ['Author', 'Creator', 'Producer']) (info as { delete(name: unknown): void }).delete(PDFName.of(key));
  }
  pdf.catalog.delete(PDFName.of('Metadata'));
  return pdf.save({ updateFieldAppearances: false });
}

// ---- Office Open XML and OpenDocument ------------------------------------------------------

const blank = (xml: string, tags: string[]) =>
  tags.reduce((text, tag) => text.replace(new RegExp(`<${tag}(\\s[^>]*)?>[\\s\\S]*?</${tag}>`, 'g'), `<${tag}$1></${tag}>`), xml);

export function stripOffice(data: Uint8Array): Uint8Array {
  const files = unzipSync(data);
  const out: Zippable = {};
  for (const [path, bytes] of Object.entries(files)) {
    let content = bytes;
    if (path === 'docProps/core.xml') content = strToU8(blank(strFromU8(bytes), ['dc:creator', 'cp:lastModifiedBy']));
    else if (path === 'docProps/app.xml') content = strToU8(blank(strFromU8(bytes), ['Application', 'AppVersion', 'Company', 'Manager']));
    else if (path === 'meta.xml') content = strToU8(blank(strFromU8(bytes), ['meta:initial-creator', 'dc:creator', 'meta:generator', 'meta:printed-by']));
    else if (path === 'docProps/custom.xml') continue;
    // OpenDocument wants "mimetype" first and uncompressed.
    out[path] = path === 'mimetype' ? [content, { level: 0 }] : content;
  }
  return zipSync(out);
}

function concatAll(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}
