import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import { PDFDocument } from 'pdf-lib';
import { describe, expect, it } from 'vitest';
import { stripJpeg, stripMetadata, stripPng, stripWebp } from '../src/core/metadata.ts';

const has = (data: Uint8Array, text: string) => Buffer.from(data).includes(Buffer.from(text, 'latin1'));

/** A JPEG skeleton: SOI, APP0, APP1 Exif (orientation 6 + a GPS-looking string), COM, SOS + data, EOI. */
function jpegWithExif(): Uint8Array {
  const tiff = [0x4d, 0x4d, 0x00, 0x2a, 0, 0, 0, 8, 0, 1, 0x01, 0x12, 0, 3, 0, 0, 0, 1, 0, 6, 0, 0, 0, 0, 0, 0];
  const gps = [...Buffer.from('GPS 55.7558N 37.6173E Canon EOS R6', 'latin1')];
  const exif = [0x45, 0x78, 0x69, 0x66, 0, 0, ...tiff, ...gps];
  const app1 = [0xff, 0xe1, (exif.length + 2) >> 8, (exif.length + 2) & 0xff, ...exif];
  const jfif = [0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0];
  const app0 = [0xff, 0xe0, 0, jfif.length + 2, ...jfif];
  const comment = [...Buffer.from('Ivanov family trip', 'latin1')];
  const com = [0xff, 0xfe, 0, comment.length + 2, ...comment];
  const scan = [0xff, 0xda, 0, 4, 1, 2, 0x11, 0x22, 0x33, 0x44, 0xff, 0xd9];
  return Uint8Array.from([0xff, 0xd8, ...app0, ...app1, ...com, ...scan]);
}

describe('metadata removal (P0-6)', () => {
  it('JPEG: drops EXIF/GPS and comments, keeps the orientation and the picture', () => {
    const input = jpegWithExif();
    expect(has(input, 'GPS 55.7558N')).toBe(true);
    const out = stripJpeg(input);
    expect(has(out, 'GPS')).toBe(false);
    expect(has(out, 'Canon')).toBe(false);
    expect(has(out, 'Ivanov')).toBe(false);
    expect(has(out, 'JFIF')).toBe(true);
    // A tiny Exif with orientation 6 remains, so the photo is not shown sideways.
    const i = Buffer.from(out).indexOf(Buffer.from([0x01, 0x12, 0, 3, 0, 0, 0, 1, 0, 6]));
    expect(i).toBeGreaterThan(0);
    expect(Buffer.from(out.subarray(-12)).equals(Buffer.from([0xff, 0xda, 0, 4, 1, 2, 0x11, 0x22, 0x33, 0x44, 0xff, 0xd9]))).toBe(true);
  });

  it('PNG: drops text, EXIF and time chunks', () => {
    const chunk = (type: string, data: number[]) => {
      const len = Buffer.alloc(4);
      len.writeUInt32BE(data.length);
      return [...len, ...Buffer.from(type, 'latin1'), ...data, 0, 0, 0, 0];
    };
    const png = Uint8Array.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
      ...chunk('IHDR', Array(13).fill(1)),
      ...chunk('tEXt', [...Buffer.from('Author\0Ivan Petrov', 'latin1')]),
      ...chunk('eXIf', [...Buffer.from('GPS 59.93N', 'latin1')]),
      ...chunk('IDAT', [9, 9, 9]),
      ...chunk('IEND', []),
    ]);
    const out = stripPng(png);
    expect(has(out, 'Ivan Petrov')).toBe(false);
    expect(has(out, 'GPS')).toBe(false);
    expect(has(out, 'IDAT')).toBe(true);
    expect(has(out, 'IEND')).toBe(true);
  });

  it('WebP: drops EXIF and XMP chunks and clears their flags', () => {
    const chunk = (type: string, data: number[]) => {
      const size = Buffer.alloc(4);
      size.writeUInt32LE(data.length);
      return [...Buffer.from(type, 'latin1'), ...size, ...data, ...(data.length & 1 ? [0] : [])];
    };
    const body = [...Buffer.from('WEBP', 'latin1'), ...chunk('VP8X', [0x0c, 0, 0, 0, 1, 0, 0, 1, 0, 0]), ...chunk('EXIF', [...Buffer.from('GPS 48.85N', 'latin1')]), ...chunk('VP8 ', [7, 7, 7, 7]), ...chunk('XMP ', [...Buffer.from('<x:creator>Anna</x:creator>', 'latin1')])];
    const size = Buffer.alloc(4);
    size.writeUInt32LE(body.length);
    const out = stripWebp(Uint8Array.from([...Buffer.from('RIFF', 'latin1'), ...size, ...body]));
    expect(has(out, 'GPS')).toBe(false);
    expect(has(out, 'Anna')).toBe(false);
    expect(out[20] & 0x0c).toBe(0);
    expect(Buffer.from(out).readUInt32LE(4)).toBe(out.length - 8);
  });

  it('PDF: author, creator and producer are gone', async () => {
    const doc = await PDFDocument.create();
    doc.addPage().drawText('Contract');
    doc.setAuthor('Иван Петров');
    doc.setCreator('Microsoft Word');
    doc.setProducer('Acrobat Distiller 11');
    doc.setTitle('Договор аренды');
    const { data, stripped } = await stripMetadata(await doc.save(), 'application/pdf', 'договор.pdf');
    expect(stripped).toBe('document');
    expect(has(data, 'Acrobat')).toBe(false);
    expect(has(data, 'Microsoft Word')).toBe(false);
    const clean = await PDFDocument.load(data, { updateMetadata: false });
    expect(clean.getAuthor()).toBeUndefined();
    expect(clean.getCreator()).toBeUndefined();
    expect(clean.getProducer()).toBeUndefined();
    expect(clean.getTitle()).toBe('Договор аренды');
    expect(clean.getPageCount()).toBe(1);
  });

  it('Office and OpenDocument: author, last editor and application are blanked', async () => {
    const docx = zipSync({
      '[Content_Types].xml': strToU8('<Types/>'),
      'docProps/core.xml': strToU8('<cp:coreProperties><dc:title>План</dc:title><dc:creator>Анна Смирнова</dc:creator><cp:lastModifiedBy>Борис</cp:lastModifiedBy></cp:coreProperties>'),
      'docProps/app.xml': strToU8('<Properties><Application>Microsoft Office Word</Application><Company>ООО Ромашка</Company></Properties>'),
      'word/document.xml': strToU8('<w:document>Текст</w:document>'),
    });
    const { data } = await stripMetadata(docx, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'план.docx');
    const files = unzipSync(data);
    const core = strFromU8(files['docProps/core.xml']);
    const app = strFromU8(files['docProps/app.xml']);
    expect(core).not.toContain('Анна');
    expect(core).not.toContain('Борис');
    expect(core).toContain('<dc:title>План</dc:title>');
    expect(app).not.toContain('Microsoft');
    expect(app).not.toContain('Ромашка');
    expect(strFromU8(files['word/document.xml'])).toContain('Текст');

    const odt = zipSync({ mimetype: [strToU8('application/vnd.oasis.opendocument.text'), { level: 0 }], 'meta.xml': strToU8('<office:meta><meta:initial-creator>Анна</meta:initial-creator><meta:generator>LibreOffice/7.6</meta:generator></office:meta>') });
    const cleanOdt = unzipSync((await stripMetadata(odt, 'application/vnd.oasis.opendocument.text', 'a.odt')).data);
    expect(Object.keys(cleanOdt)[0]).toBe('mimetype');
    expect(strFromU8(cleanOdt['meta.xml'])).not.toMatch(/Анна|LibreOffice/);
  });

  it('a damaged file is sent unchanged instead of failing', async () => {
    const junk = Uint8Array.from([0xff, 0xd8, 1, 2, 3]);
    const result = await stripMetadata(junk, 'image/jpeg');
    expect(result.stripped).toBeNull();
    expect(result.data).toBe(junk);
  });
});
