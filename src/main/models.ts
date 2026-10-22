// «Голосовые в текст» (features.transcribe): Whisper speech-recognition models, downloaded only
// after the person agrees, into <userData>/models, and served to the renderer's worker through
// the private veil-model:// scheme. Voice messages never leave the computer; Hugging Face only
// sees that this IP downloaded a public model.

import { createWriteStream } from 'node:fs';
import { mkdir, readdir, rename, rm, stat } from 'node:fs/promises';
import { join, normalize, sep } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { pathToFileURL } from 'node:url';
import { app, net, protocol } from 'electron';

export const MODEL_SCHEME = 'veil-model';

/** The files transformers.js reads for a quantized Whisper model. */
const FILES = [
  'config.json',
  'generation_config.json',
  'preprocessor_config.json',
  'tokenizer.json',
  'tokenizer_config.json',
  'special_tokens_map.json',
  'added_tokens.json',
  'normalizer.json',
  'vocab.json',
  'merges.txt',
  'onnx/encoder_model_quantized.onnx',
  'onnx/decoder_model_merged_quantized.onnx',
];

export const MODELS = {
  tiny: { repo: 'Xenova/whisper-tiny', size: 41 },
  base: { repo: 'Xenova/whisper-base', size: 77 },
  small: { repo: 'Xenova/whisper-small', size: 249 },
} as const;
export type ModelId = keyof typeof MODELS;

const root = () => join(app.getPath('userData'), 'models');
const dirOf = (id: ModelId) => join(root(), ...MODELS[id].repo.split('/'));
const isModel = (id: unknown): id is ModelId => typeof id === 'string' && id in MODELS;

export async function modelStatus(): Promise<Record<ModelId, { installed: boolean; mb: number }>> {
  const out = {} as Record<ModelId, { installed: boolean; mb: number }>;
  for (const id of Object.keys(MODELS) as ModelId[]) {
    let bytes = 0;
    let installed = true;
    for (const file of FILES) {
      try {
        bytes += (await stat(join(dirOf(id), file))).size;
      } catch {
        installed = false;
      }
    }
    out[id] = { installed, mb: installed ? Math.round(bytes / 1048576) : MODELS[id].size };
  }
  return out;
}

let downloading: AbortController | null = null;

/** Downloads one model file by file (each to .part, then renamed), reporting overall progress. */
export async function downloadModel(id: unknown, onProgress: (done: number, total: number) => void): Promise<void> {
  if (!isModel(id)) throw new Error('Неизвестная модель');
  if (downloading) throw new Error('Модель уже скачивается');
  const controller = new AbortController();
  downloading = controller;
  const dir = dirOf(id);
  const total = MODELS[id].size * 1048576;
  let done = 0;
  try {
    for (const file of FILES) {
      const target = join(dir, ...file.split('/'));
      await mkdir(join(target, '..'), { recursive: true });
      const response = await net.fetch(`https://huggingface.co/${MODELS[id].repo}/resolve/main/${file}`, { signal: controller.signal, credentials: 'omit' });
      if (!response.ok || !response.body) throw new Error(`Не удалось скачать модель (${response.status})`);
      const counted = Readable.fromWeb(response.body as never);
      counted.on('data', (chunk: Buffer) => {
        done += chunk.length;
        onProgress(Math.min(done, total), total);
      });
      await pipeline(counted, createWriteStream(`${target}.part`));
      await rename(`${target}.part`, target);
    }
    onProgress(total, total);
  } catch (error) {
    await rm(dir, { recursive: true, force: true });
    throw controller.signal.aborted ? new Error('Загрузка отменена') : error;
  } finally {
    downloading = null;
  }
}

export function cancelModelDownload(): void {
  downloading?.abort();
}

export async function deleteModel(id: unknown): Promise<void> {
  if (!isModel(id)) return;
  await rm(dirOf(id), { recursive: true, force: true });
  // Drop empty owner folders.
  const owner = join(dirOf(id), '..');
  if (!(await readdir(owner).catch(() => [])).length) await rm(owner, { recursive: true, force: true });
}

/** Must run before the app is ready. */
export function registerModelScheme(): void {
  protocol.registerSchemesAsPrivileged([{ scheme: MODEL_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } }]);
}

/** veil-model://models/<owner>/<name>/<file> → a file under <userData>/models, nothing else. */
export function serveModels(): void {
  protocol.handle(MODEL_SCHEME, async (request) => {
    const url = new URL(request.url);
    const rel = decodeURIComponent(url.pathname).replace(/^\/+/, '');
    const path = normalize(join(root(), ...rel.split('/')));
    const headers = { 'access-control-allow-origin': '*' };
    if (url.host !== 'models' || !path.startsWith(root() + sep) || !FILES.some((f) => rel.endsWith(`/${f}`))) return new Response('', { status: 404, headers });
    try {
      const response = await net.fetch(pathToFileURL(path).toString());
      return new Response(response.body, { status: response.status, headers: { ...headers, 'content-type': 'application/octet-stream' } });
    } catch {
      return new Response('', { status: 404, headers });
    }
  });
}
