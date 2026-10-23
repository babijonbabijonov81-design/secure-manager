import { Play, VolumeX } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { Messenger } from '../../../core/messenger.ts';
import type { Attachment } from '../../../core/types.ts';
import { useAttachmentUrl } from '../lib/attachments.ts';
import { formatDuration } from '../lib/media.ts';
import { takePlayback } from './VoicePlayer.tsx';

const RING = 2 * Math.PI * 49;

/**
 * «Кружок» in the chat: plays silently in a loop while on screen; a click starts it from the
 * beginning with sound, another click pauses.
 */
export function CirclePlayer({ messenger, att }: { messenger: Messenger; att: Attachment }) {
  const url = useAttachmentUrl(messenger, att);
  const video = useRef<HTMLVideoElement>(null);
  const [sound, setSound] = useState(false);
  const [paused, setPaused] = useState(false);
  const [progress, setProgress] = useState(0);
  const [elapsed, setElapsed] = useState(0);
  const still = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

  // The silent preview runs only while the circle is visible.
  useEffect(() => {
    const el = video.current;
    if (!el || !url || still) return;
    const observer = new IntersectionObserver(([entry]) => {
      if (!el.muted) return;
      if (entry.isIntersecting) void el.play().catch(() => {});
      else el.pause();
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [url, still]);

  const toSilent = () => {
    const el = video.current;
    if (!el) return;
    el.muted = true;
    el.loop = true;
    setSound(false);
    setPaused(false);
    setProgress(0);
    setElapsed(0);
    if (!still) void el.play().catch(() => {});
  };

  const click = () => {
    const el = video.current;
    if (!el) return;
    if (!sound) {
      takePlayback(el);
      el.muted = false;
      el.loop = false;
      el.currentTime = 0;
      setSound(true);
      setPaused(false);
      void el.play();
    } else if (el.paused) {
      takePlayback(el);
      void el.play();
    } else el.pause();
  };

  const duration = att.dur ?? 0;
  return (
    <button
      className={`circle${sound ? ' sounding' : ''}`}
      onClick={click}
      disabled={!url}
      aria-label={sound && !paused ? 'Пауза' : 'Воспроизвести кружок'}
      data-testid="circle"
    >
      <video
        ref={video}
        src={url ?? undefined}
        muted
        loop
        playsInline
        preload="metadata"
        onPlay={() => setPaused(false)}
        onPause={() => setPaused(true)}
        onEnded={toSilent}
        onTimeUpdate={(e) => {
          const el = e.currentTarget;
          if (el.muted) return;
          const total = Number.isFinite(el.duration) && el.duration > 0 ? el.duration : duration || 1;
          setProgress(Math.min(1, el.currentTime / total));
          setElapsed(el.currentTime);
        }}
      />
      {sound && (
        <svg className="circle-ring" viewBox="0 0 100 100" aria-hidden>
          <circle cx="50" cy="50" r="49" strokeDasharray={RING} strokeDashoffset={RING * (1 - progress)} />
        </svg>
      )}
      {sound && paused && (
        <span className="circle-play">
          <Play size={26} fill="currentColor" />
        </span>
      )}
      <span className="circle-time">
        {!sound && <VolumeX size={12} />}
        {formatDuration(sound ? Math.max(0, duration - elapsed) : duration)}
      </span>
    </button>
  );
}
