// Image, clipboard and audio helpers for the UI.

import { bridge } from '../../../core/platform.ts';

async function loadBitmap(blob: Blob): Promise<ImageBitmap> {
  return createImageBitmap(blob);
}

function canvasFor(width: number, height: number): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

const toBlob = (canvas: HTMLCanvasElement, type: string, quality?: number) =>
  new Promise<Blob>((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('encode failed'))), type, quality));

export interface PreparedFile {
  name: string;
  mime: string;
  data: Uint8Array;
  w?: number;
  h?: number;
}

/**
 * Photos are scaled down to 2560 px and re-encoded (JPEG, or WebP to keep transparency)
 * unless the user chose to send originals. GIFs and other files stay untouched.
 */
export async function prepareFile(file: File, compressImages: boolean): Promise<PreparedFile> {
  const isImage = /^image\/(png|jpe?g|webp|bmp|avif|gif)$/.test(file.type);
  if (!isImage) return { name: file.name || 'file', mime: file.type || 'application/octet-stream', data: new Uint8Array(await file.arrayBuffer()) };
  let bitmap: ImageBitmap;
  try {
    bitmap = await loadBitmap(file);
  } catch {
    return { name: file.name || 'file', mime: 'application/octet-stream', data: new Uint8Array(await file.arrayBuffer()) };
  }
  const { width, height } = bitmap;
  if (!compressImages || file.type === 'image/gif') {
    bitmap.close();
    return { name: file.name, mime: file.type, data: new Uint8Array(await file.arrayBuffer()), w: width, h: height };
  }
  const scale = Math.min(1, 2560 / Math.max(width, height));
  const w = Math.round(width * scale);
  const h = Math.round(height * scale);
  const canvas = canvasFor(w, h);
  canvas.getContext('2d')!.drawImage(bitmap, 0, 0, w, h);
  bitmap.close();
  const keepAlpha = file.type === 'image/png' || file.type === 'image/webp';
  const type = keepAlpha ? 'image/webp' : 'image/jpeg';
  const blob = await toBlob(canvas, type, 0.86);
  // Re-encoding a small, already-compressed file can make it bigger: keep the original then.
  if (blob.size >= file.size && scale === 1) {
    return { name: file.name, mime: file.type, data: new Uint8Array(await file.arrayBuffer()), w, h };
  }
  const name = file.name.replace(/\.[^.]+$/, '') + (type === 'image/webp' ? '.webp' : '.jpg');
  return { name, mime: type, data: new Uint8Array(await blob.arrayBuffer()), w, h };
}

/** Stickers: fit into 512×512 WebP (animated GIFs are kept as they are). */
export async function prepareSticker(file: File): Promise<{ data: Uint8Array; mime: string; w: number; h: number }> {
  const bitmap = await loadBitmap(file);
  const { width, height } = bitmap;
  if (file.type === 'image/gif' && file.size < 1024 * 1024) {
    bitmap.close();
    return { data: new Uint8Array(await file.arrayBuffer()), mime: 'image/gif', w: width, h: height };
  }
  const scale = Math.min(1, 512 / Math.max(width, height));
  const w = Math.round(width * scale);
  const h = Math.round(height * scale);
  const canvas = canvasFor(w, h);
  canvas.getContext('2d')!.drawImage(bitmap, 0, 0, w, h);
  bitmap.close();
  const blob = await toBlob(canvas, 'image/webp', 0.9);
  return { data: new Uint8Array(await blob.arrayBuffer()), mime: 'image/webp', w, h };
}

export async function copyText(text: string): Promise<void> {
  if (bridge) bridge.copyText(text);
  else await navigator.clipboard.writeText(text);
}

/** Copies an image; anything that is not PNG is converted first. */
export async function copyImage(data: Uint8Array, mime: string): Promise<void> {
  let png = data;
  if (mime !== 'image/png') {
    const bitmap = await loadBitmap(new Blob([data as BlobPart], { type: mime }));
    const canvas = canvasFor(bitmap.width, bitmap.height);
    canvas.getContext('2d')!.drawImage(bitmap, 0, 0);
    bitmap.close();
    png = new Uint8Array(await (await toBlob(canvas, 'image/png')).arrayBuffer());
  }
  if (bridge) bridge.copyImage(png);
  else await navigator.clipboard.write([new ClipboardItem({ 'image/png': new Blob([png as BlobPart], { type: 'image/png' }) })]);
}

/** Duration and a 48-bar waveform (0–31) of a recorded voice message. */
export async function analyseAudio(blob: Blob): Promise<{ dur: number; wave: number[] }> {
  const context = new AudioContext();
  try {
    const buffer = await context.decodeAudioData(await blob.arrayBuffer());
    const channel = buffer.getChannelData(0);
    const bars = 48;
    const size = Math.max(1, Math.floor(channel.length / bars));
    const peaks: number[] = [];
    for (let i = 0; i < bars; i++) {
      let peak = 0;
      for (let j = i * size; j < Math.min(channel.length, (i + 1) * size); j++) peak = Math.max(peak, Math.abs(channel[j]));
      peaks.push(peak);
    }
    const max = Math.max(...peaks, 0.01);
    return { dur: buffer.duration, wave: peaks.map((p) => Math.round((p / max) * 31)) };
  } catch {
    return { dur: 0, wave: [] };
  } finally {
    void context.close();
  }
}

export const formatDuration = (seconds: number) => {
  const s = Math.max(0, Math.round(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};
