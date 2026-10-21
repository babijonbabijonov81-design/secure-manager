// Microphone and speaker selection, plus ring tones synthesised with WebAudio
// (nothing to ship or download).
import { useCallback, useEffect, useState } from 'react';
import { bridge } from '../../../core/platform.ts';
import type { AudioSettings } from '../../../core/types.ts';

export class MicrophoneError extends Error {}

function micErrorText(error: unknown): string {
  switch ((error as DOMException)?.name) {
    case 'NotAllowedError':
    case 'SecurityError':
      return 'Нет доступа к микрофону. Разрешите его в настройках системы';
    case 'NotFoundError':
      return 'Микрофон не найден. Подключите его и попробуйте снова';
    case 'NotReadableError':
    case 'AbortError':
      return 'Микрофон занят другой программой';
    default:
      return 'Не удалось включить микрофон';
  }
}

function constraints(audio: AudioSettings, withDevice: boolean): MediaTrackConstraints {
  return {
    ...(withDevice && audio.input ? { deviceId: { exact: audio.input } } : {}),
    echoCancellation: audio.echoCancellation,
    noiseSuppression: audio.noiseSuppression,
    autoGainControl: audio.autoGainControl,
  };
}

/** Opens the microphone chosen in Settings → Audio, or the default one if it was unplugged. */
export async function openMicrophone(audio: AudioSettings): Promise<MediaStream> {
  if (bridge && !(await bridge.requestMicrophone())) throw new MicrophoneError(micErrorText({ name: 'NotAllowedError' }));
  try {
    return await navigator.mediaDevices.getUserMedia({ audio: constraints(audio, true) });
  } catch (error) {
    const name = (error as DOMException)?.name;
    if (audio.input && (name === 'OverconstrainedError' || name === 'NotFoundError')) {
      try {
        return await navigator.mediaDevices.getUserMedia({ audio: constraints(audio, false) });
      } catch (fallback) {
        throw new MicrophoneError(micErrorText(fallback));
      }
    }
    throw new MicrophoneError(micErrorText(error));
  }
}

export const canChooseOutput = typeof HTMLMediaElement !== 'undefined' && 'setSinkId' in HTMLMediaElement.prototype;

type SinkTarget = { setSinkId?(id: string): Promise<void> };

/** Routes sound to the chosen speakers; silently keeps the default if that fails. */
export async function routeOutput(target: HTMLMediaElement | AudioContext, output: string): Promise<void> {
  const sink = target as unknown as SinkTarget;
  if (!sink.setSinkId) return;
  try {
    await sink.setSinkId(output);
  } catch {
    if (output) await sink.setSinkId('').catch(() => {});
  }
}

export interface AudioDevices {
  inputs: MediaDeviceInfo[];
  outputs: MediaDeviceInfo[];
  cameras: MediaDeviceInfo[];
  /** Device names are only visible once microphone access was granted. */
  labeled: boolean;
  refresh(): Promise<void>;
}

export function useAudioDevices(): AudioDevices {
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const refresh = useCallback(async () => {
    try {
      setDevices(await navigator.mediaDevices.enumerateDevices());
    } catch {
      setDevices([]);
    }
  }, []);
  useEffect(() => {
    void refresh();
    navigator.mediaDevices?.addEventListener('devicechange', refresh);
    return () => navigator.mediaDevices?.removeEventListener('devicechange', refresh);
  }, [refresh]);
  // "default"/"communications" are Chromium aliases of real devices; the empty value covers them.
  const real = (d: MediaDeviceInfo) => d.deviceId && d.deviceId !== 'default' && d.deviceId !== 'communications';
  const inputs = devices.filter((d) => d.kind === 'audioinput' && real(d));
  const outputs = devices.filter((d) => d.kind === 'audiooutput' && real(d));
  const cameras = devices.filter((d) => d.kind === 'videoinput' && real(d));
  return { inputs, outputs, cameras, labeled: inputs.some((d) => d.label), refresh };
}

/** 0…1 loudness of a stream, read on every animation frame. */
export function meterStream(stream: MediaStream, onLevel: (level: number) => void): () => void {
  const context = new AudioContext();
  const analyser = context.createAnalyser();
  analyser.fftSize = 512;
  context.createMediaStreamSource(stream).connect(analyser);
  const data = new Uint8Array(analyser.fftSize);
  let frame = 0;
  const tick = () => {
    analyser.getByteTimeDomainData(data);
    let sum = 0;
    for (const v of data) sum += ((v - 128) / 128) ** 2;
    onLevel(Math.min(1, Math.sqrt(sum / data.length) * 3.2));
    frame = requestAnimationFrame(tick);
  };
  tick();
  return () => {
    cancelAnimationFrame(frame);
    void context.close();
  };
}

export type ToneKind = 'incoming' | 'ringback' | 'busy' | 'end' | 'connected' | 'test';

/** Ring tones. One at a time; `stop()` silences it at once. */
export class Tones {
  private context: AudioContext | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private output = '';

  setOutput(output: string): void {
    this.output = output;
    if (this.context) void routeOutput(this.context, output);
  }

  play(kind: ToneKind): void {
    this.stop();
    const context = new AudioContext();
    this.context = context;
    void routeOutput(context, this.output);
    const note = (freq: number, start: number, length: number, volume: number, type: OscillatorType = 'sine') => {
      const t = context.currentTime + start;
      const osc = context.createOscillator();
      const gain = context.createGain();
      osc.type = type;
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0, t);
      gain.gain.linearRampToValueAtTime(volume, t + 0.012);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + length);
      osc.connect(gain).connect(context.destination);
      osc.start(t);
      osc.stop(t + length + 0.05);
    };
    const pattern: Record<ToneKind, { play(): void; every?: number }> = {
      // A soft rising arpeggio, twice, every 2.6 s.
      incoming: {
        play: () => {
          [659.25, 783.99, 1046.5, 783.99, 1046.5, 1318.5].forEach((f, i) => note(f, i * 0.11 + (i > 2 ? 0.16 : 0), 0.5, 0.16, 'triangle'));
        },
        every: 2600,
      },
      // European ringback: 425 Hz, 1 s on, 3 s off.
      ringback: { play: () => note(425, 0, 1.0, 0.07), every: 4000 },
      busy: { play: () => [0, 0.5, 1.0].forEach((s) => note(425, s, 0.3, 0.08)) },
      end: { play: () => [880, 660, 440].forEach((f, i) => note(f, i * 0.14, 0.22, 0.09, 'triangle')) },
      connected: { play: () => [523.25, 783.99].forEach((f, i) => note(f, i * 0.1, 0.25, 0.08, 'triangle')) },
      test: { play: () => [523.25, 659.25, 783.99, 1046.5].forEach((f, i) => note(f, i * 0.16, 0.6, 0.14, 'triangle')) },
    };
    const { play, every } = pattern[kind];
    play();
    if (every) this.timer = setInterval(play, every);
    else setTimeout(() => this.context === context && this.stop(), 2000);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    void this.context?.close().catch(() => {});
    this.context = null;
  }
}
