import { Pause, Play } from 'lucide-react';
import { useEffect, useRef, useState, type MouseEvent } from 'react';
import type { Messenger } from '../../../core/messenger.ts';
import type { Attachment } from '../../../core/types.ts';
import { useAttachmentUrl } from '../lib/attachments.ts';
import { formatDuration } from '../lib/media.ts';

let playing: HTMLMediaElement | null = null;

/** One voice message or circle sounds at a time: starting one pauses the other. */
export function takePlayback(el: HTMLMediaElement): void {
  if (playing && playing !== el) playing.pause();
  playing = el;
}

export function VoicePlayer({ messenger, att }: { messenger: Messenger; att: Attachment }) {
  const url = useAttachmentUrl(messenger, att);
  const audio = useRef<HTMLAudioElement | null>(null);
  const [isPlaying, setPlaying] = useState(false);
  const [progress, setProgress] = useState(0);
  const [elapsed, setElapsed] = useState(0);
  const bars = att.wave?.length ? att.wave : Array.from({ length: 40 }, (_, i) => 6 + ((i * 7) % 11));
  const duration = att.dur ?? 0;

  useEffect(() => {
    if (!url) return;
    const el = new Audio(url);
    audio.current = el;
    const update = () => {
      const total = Number.isFinite(el.duration) && el.duration > 0 ? el.duration : duration || 1;
      setProgress(Math.min(1, el.currentTime / total));
      setElapsed(el.currentTime);
    };
    el.addEventListener('timeupdate', update);
    el.addEventListener('ended', () => {
      setPlaying(false);
      setProgress(0);
      setElapsed(0);
    });
    el.addEventListener('pause', () => setPlaying(false));
    el.addEventListener('play', () => setPlaying(true));
    return () => {
      el.pause();
      if (playing === el) playing = null;
    };
  }, [url, duration]);

  const toggle = () => {
    const el = audio.current;
    if (!el) return;
    if (el.paused) {
      takePlayback(el);
      void el.play();
    } else el.pause();
  };

  const seek = (e: MouseEvent<HTMLDivElement>) => {
    const el = audio.current;
    if (!el) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const ratio = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
    const total = Number.isFinite(el.duration) && el.duration > 0 ? el.duration : duration;
    if (total) el.currentTime = ratio * total;
    setProgress(ratio);
  };

  return (
    <div className="voice">
      <button className="voice-play" onClick={toggle} disabled={!url} aria-label={isPlaying ? 'Пауза' : 'Воспроизвести'}>
        {isPlaying ? <Pause size={18} fill="currentColor" /> : <Play size={18} fill="currentColor" style={{ marginLeft: 2 }} />}
      </button>
      <div className="voice-body">
        <div className="voice-wave" onClick={seek} role="slider" aria-valuenow={Math.round(progress * 100)} aria-label="Перемотка">
          {bars.map((v, i) => (
            <i key={i} className={i / bars.length < progress ? 'on' : ''} style={{ height: `${Math.max(12, (v / 31) * 100)}%` }} />
          ))}
        </div>
        <span className="voice-time">{formatDuration(isPlaying || elapsed ? elapsed : duration)}</span>
      </div>
    </div>
  );
}
