// «Голосовые в текст» (features.transcribe), the renderer side: decodes a voice message to 16 kHz
// mono and hands it to the worker. Desktop app only — the model lives in the app's own folder.
import { bridge } from '../../../core/platform.ts';
import type { TranscribeModel } from '../../../core/types.ts';
import type { TranscribeReply, TranscribeRequest } from './transcribe.worker.ts';

export const MODEL_INFO: Record<TranscribeModel, { label: string; repo: string; hint: string }> = {
  tiny: { label: 'Быстрая', repo: 'Xenova/whisper-tiny', hint: 'Быстро даже на слабом ПК, но ошибается чаще' },
  base: { label: 'Обычная', repo: 'Xenova/whisper-base', hint: 'Хороший выбор для большинства компьютеров' },
  small: { label: 'Точная', repo: 'Xenova/whisper-small', hint: 'Лучше понимает речь, но в несколько раз медленнее' },
};

export const transcribeAvailable = () => !!bridge?.models;

/** «Error invoking remote method 'x': Error: text» → «text». */
export const ipcError = (error: unknown) => ((error as Error)?.message ?? String(error)).replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '');

/** Whisper wants 16 kHz mono; the browser's decoder resamples. */
export async function decodeVoice(data: Uint8Array): Promise<Float32Array> {
  const context = new OfflineAudioContext(1, 1, 16_000);
  const buffer = await context.decodeAudioData(data.slice().buffer);
  if (buffer.numberOfChannels === 1) return new Float32Array(buffer.getChannelData(0));
  const mono = new Float32Array(buffer.length);
  for (let c = 0; c < buffer.numberOfChannels; c++) {
    const channel = buffer.getChannelData(c);
    for (let i = 0; i < mono.length; i++) mono[i] += channel[i] / buffer.numberOfChannels;
  }
  return mono;
}

let worker: Worker | null = null;
let nextId = 1;
const pending = new Map<number, { resolve(text: string): void; reject(error: Error): void }>();

function getWorker(): Worker {
  if (!worker) {
    worker = new Worker(new URL('./transcribe.worker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (event: MessageEvent<TranscribeReply>) => {
      const reply = event.data;
      const waiting = pending.get(reply.id);
      pending.delete(reply.id);
      if (!waiting) return;
      if ('error' in reply) waiting.reject(new Error(reply.error));
      else waiting.resolve(reply.text);
    };
    worker.onerror = () => {
      for (const waiting of pending.values()) waiting.reject(new Error('Распознавание остановилось'));
      pending.clear();
      worker?.terminate();
      worker = null;
    };
  }
  return worker;
}

export function transcribe(audio: Float32Array, model: TranscribeModel): Promise<string> {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    getWorker().postMessage({ id, repo: MODEL_INFO[model].repo, audio } satisfies TranscribeRequest, [audio.buffer]);
  });
}

/** Frees the model's memory (it is loaded again on the next voice message). */
export function stopTranscriber(): void {
  worker?.terminate();
  worker = null;
  for (const waiting of pending.values()) waiting.reject(new Error('Распознавание остановлено'));
  pending.clear();
}
