import { SendHorizontal, SwitchCamera, Trash2 } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { MAX_CIRCLE_SECONDS, type AudioSettings } from '../../../core/types.ts';
import { openMicrophone } from '../lib/audio.ts';
import { formatDuration } from '../lib/media.ts';
import { MediaAccessError, openCamera } from '../lib/video.ts';

/** Side of the recorded square, in pixels. */
const SIZE = 384;
const RING = 2 * Math.PI * 49;

export interface RecordedCircle {
  data: Uint8Array;
  mime: string;
  dur: number;
  size: number;
}

interface Session {
  video: HTMLVideoElement;
  camera: MediaStream | null;
  mic: MediaStream | null;
  recorder: MediaRecorder | null;
  chunks: Blob[];
  startedAt: number;
  frame: number;
  cameraIndex: number;
  done: boolean;
}

const newSession = (): Session => ({
  video: document.createElement('video'),
  camera: null,
  mic: null,
  recorder: null,
  chunks: [],
  startedAt: 0,
  frame: 0,
  cameraIndex: 0,
  done: false,
});

function pickMime(): string {
  for (const mime of ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm', 'video/mp4']) {
    if (MediaRecorder.isTypeSupported(mime)) return mime;
  }
  return '';
}

/**
 * Records a «кружок»: the camera, cropped to a square and mirrored like a selfie, drawn onto a
 * canvas that is recorded together with the microphone. The camera can be switched mid-way.
 */
export function CircleRecorder({
  audio,
  onSend,
  onCancel,
  onError,
}: {
  audio: AudioSettings;
  onSend(circle: RecordedCircle): void;
  onCancel(): void;
  onError(text: string): void;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [elapsed, setElapsed] = useState(0);
  const [cameras, setCameras] = useState<MediaDeviceInfo[]>([]);
  const [ready, setReady] = useState(false);
  const state = useRef<Session>(newSession());

  const stopAll = (s = state.current) => {
    s.done = true;
    cancelAnimationFrame(s.frame);
    s.camera?.getTracks().forEach((t) => t.stop());
    s.mic?.getTracks().forEach((t) => t.stop());
    s.video.srcObject = null;
  };

  const attachCamera = async (deviceId: string, s = state.current) => {
    const stream = await openCamera(deviceId);
    if (s.done) return stream.getTracks().forEach((t) => t.stop());
    s.camera?.getTracks().forEach((t) => t.stop());
    s.camera = stream;
    s.video.srcObject = stream;
    s.video.muted = true;
    s.video.playsInline = true;
    await s.video.play();
  };

  useEffect(() => {
    // Each run is its own session (React runs effects twice in development).
    const s = (state.current = newSession());
    const draw = () => {
      const ctx = canvas.current?.getContext('2d');
      const v = s.video;
      if (ctx && v.videoWidth) {
        const side = Math.min(v.videoWidth, v.videoHeight);
        ctx.save();
        ctx.translate(SIZE, 0);
        ctx.scale(-1, 1);
        ctx.drawImage(v, (v.videoWidth - side) / 2, (v.videoHeight - side) / 2, side, side, 0, 0, SIZE, SIZE);
        ctx.restore();
      }
      if (s.startedAt) {
        const seconds = (Date.now() - s.startedAt) / 1000;
        setElapsed(seconds);
        if (seconds >= MAX_CIRCLE_SECONDS) return void finish(true);
      }
      s.frame = requestAnimationFrame(draw);
    };
    void (async () => {
      try {
        await attachCamera(audio.camera, s);
        try {
          s.mic = await openMicrophone(audio);
        } catch {
          s.mic = null; // a silent circle is still a circle
        }
        if (s.done) return stopAll(s);
        void navigator.mediaDevices
          .enumerateDevices()
          .then((all) => setCameras(all.filter((d) => d.kind === 'videoinput')))
          .catch(() => {});
        s.frame = requestAnimationFrame(draw);
        const stream = canvas.current!.captureStream(30);
        for (const track of s.mic?.getAudioTracks() ?? []) stream.addTrack(track);
        const mime = pickMime();
        const recorder = new MediaRecorder(stream, { ...(mime ? { mimeType: mime } : {}), videoBitsPerSecond: 1_000_000, audioBitsPerSecond: 48_000 });
        recorder.ondataavailable = (e) => e.data.size && s.chunks.push(e.data);
        recorder.start(250);
        s.recorder = recorder;
        s.startedAt = Date.now();
        setReady(true);
      } catch (error) {
        if (s.done) return;
        stopAll(s);
        onError(error instanceof MediaAccessError ? error.message : 'Не удалось включить камеру');
        onCancel();
      }
    })();
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && void finish(false);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      if (s.recorder?.state === 'recording') s.recorder.stop();
      stopAll(s);
    };
  }, []);

  const finish = async (sendIt: boolean) => {
    const s = state.current;
    if (s.done) return;
    const recorder = s.recorder;
    const seconds = s.startedAt ? (Date.now() - s.startedAt) / 1000 : 0;
    if (recorder && recorder.state === 'recording') {
      await new Promise<void>((resolve) => {
        recorder.onstop = () => resolve();
        recorder.stop();
      });
    }
    stopAll();
    if (!sendIt) return onCancel();
    const mime = (recorder?.mimeType || 'video/webm').split(';')[0];
    const blob = new Blob(s.chunks, { type: mime });
    if (seconds < 1 || !blob.size) {
      onError('Слишком короткий кружок — запишите хотя бы секунду');
      return onCancel();
    }
    onSend({ data: new Uint8Array(await blob.arrayBuffer()), mime, dur: Math.min(MAX_CIRCLE_SECONDS, seconds), size: SIZE });
  };

  const switchCamera = async () => {
    const s = state.current;
    if (cameras.length < 2) return;
    s.cameraIndex = (s.cameraIndex + 1) % cameras.length;
    try {
      await attachCamera(cameras[s.cameraIndex].deviceId);
    } catch (error) {
      onError(error instanceof MediaAccessError ? error.message : 'Не удалось переключить камеру');
    }
  };

  const progress = Math.min(1, elapsed / MAX_CIRCLE_SECONDS);
  return (
    <div className="circle-recorder" role="dialog" aria-label="Запись кружка" data-testid="circle-recorder">
      <div className="circle-stage">
        <canvas ref={canvas} width={SIZE} height={SIZE} />
        <svg className="circle-ring rec" viewBox="0 0 100 100" aria-hidden>
          <circle cx="50" cy="50" r="49" strokeDasharray={RING} strokeDashoffset={RING * (1 - progress)} />
        </svg>
        {!ready && <span className="spinner" />}
      </div>
      <div className="circle-controls">
        <button className="icon-btn" onClick={() => void finish(false)} aria-label="Удалить кружок" title="Удалить (Esc)">
          <Trash2 size={19} />
        </button>
        <span className="rec-dot" />
        <span className="rec-time">
          {formatDuration(elapsed)} / {formatDuration(MAX_CIRCLE_SECONDS)}
        </span>
        {cameras.length > 1 && (
          <button className="icon-btn" onClick={() => void switchCamera()} aria-label="Сменить камеру" title="Сменить камеру">
            <SwitchCamera size={19} />
          </button>
        )}
        <button className="send-btn" onClick={() => void finish(true)} disabled={!ready} aria-label="Отправить кружок">
          <SendHorizontal size={19} />
        </button>
      </div>
    </div>
  );
}
