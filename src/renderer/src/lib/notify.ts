import { bridge } from '../../../core/platform.ts';

let audio: AudioContext | null = null;

/** A soft two-note chime generated on the fly (no audio files to ship). */
export function playChime(): void {
  try {
    audio ??= new AudioContext();
    const now = audio.currentTime;
    for (const [i, freq] of [880, 1318.5].entries()) {
      const osc = audio.createOscillator();
      const gain = audio.createGain();
      osc.type = 'sine';
      osc.frequency.value = freq;
      const start = now + i * 0.09;
      gain.gain.setValueAtTime(0, start);
      gain.gain.linearRampToValueAtTime(0.08, start + 0.015);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.35);
      osc.connect(gain).connect(audio.destination);
      osc.start(start);
      osc.stop(start + 0.4);
    }
  } catch {
    // audio not available
  }
}

export function showNotification(title: string, body: string, tag: string, onClick: () => void): void {
  if (bridge) {
    bridge.notify({ title, body, tag, silent: true });
    return;
  }
  if (typeof Notification === 'undefined') return;
  const show = () => {
    const n = new Notification(title, { body, tag, silent: true });
    n.onclick = () => {
      window.focus();
      onClick();
      n.close();
    };
  };
  if (Notification.permission === 'granted') show();
  else if (Notification.permission !== 'denied') void Notification.requestPermission().then((p) => p === 'granted' && show());
}

export function setBadge(count: number): void {
  bridge?.setBadge(count);
  document.title = count ? `(${count}) Veil` : 'Veil';
}
