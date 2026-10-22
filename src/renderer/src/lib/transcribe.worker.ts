// «Голосовые в текст»: Whisper runs here, in a worker, on this computer. The model comes from
// <userData>/models through the private veil-model:// scheme (downloaded only with consent); the
// ONNX runtime is bundled with the app, so nothing is fetched from the internet.
import { env, pipeline, type AutomaticSpeechRecognitionPipeline } from '@huggingface/transformers';
import ortMjs from 'onnxruntime-web/ort-wasm-simd-threaded.asyncify.mjs?url';
import ortWasm from 'onnxruntime-web/ort-wasm-simd-threaded.asyncify.wasm?url';

env.allowRemoteModels = false;
env.allowLocalModels = true;
env.localModelPath = 'veil-model://models/';
env.useBrowserCache = false;
env.useWasmCache = false;
const wasm = env.backends.onnx.wasm!;
wasm.wasmPaths = { mjs: new URL(ortMjs, self.location.href).href, wasm: new URL(ortWasm, self.location.href).href };
wasm.numThreads = 1;
wasm.proxy = false;

export interface TranscribeRequest {
  id: number;
  repo: string;
  /** 16 kHz mono samples. */
  audio: Float32Array;
}

export type TranscribeReply = { id: number; text: string } | { id: number; error: string };

let loaded: { repo: string; asr: Promise<AutomaticSpeechRecognitionPipeline> } | null = null;

self.onmessage = async (event: MessageEvent<TranscribeRequest>) => {
  const { id, repo, audio } = event.data;
  try {
    if (!loaded || loaded.repo !== repo) {
      loaded = {
        repo,
        asr: pipeline('automatic-speech-recognition', repo, {
          dtype: 'q8',
          device: 'wasm',
          // The newer runtime's QDQ rewrites reject these quantized Whisper exports; basic
          // optimisations are enough here.
          session_options: { graphOptimizationLevel: 'basic' },
        }) as Promise<AutomaticSpeechRecognitionPipeline>,
      };
    }
    const asr = await loaded.asr;
    // No language given: Whisper recognises it (Russian, English, …) and writes in it.
    const out = await asr(audio, { task: 'transcribe', chunk_length_s: 30, stride_length_s: 5 });
    const text = (Array.isArray(out) ? out.map((o) => o.text).join(' ') : out.text).trim();
    self.postMessage({ id, text } satisfies TranscribeReply);
  } catch (error) {
    loaded = null;
    self.postMessage({ id, error: (error as Error)?.message ?? String(error) } satisfies TranscribeReply);
  }
};
