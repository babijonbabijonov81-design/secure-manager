// «Показ экрана» in video calls (features.video). Windows and Linux on X11: Veil shows its own
// picker of screens and windows (thumbnails from desktopCapturer), then getDisplayMedia() in the
// renderer gets the chosen source here. Linux on Wayland: apps cannot list windows, so the
// system's xdg-desktop-portal dialog (PipeWire) asks which screen or window to share.

import { app, desktopCapturer, session } from 'electron';

export interface ScreenSource {
  id: string;
  name: string;
  kind: 'screen' | 'window';
  thumbnail: string;
}

/** Wayland: the portal picks the source, Veil's picker is not shown. */
export const usesPortal = process.platform === 'linux' && (process.env.XDG_SESSION_TYPE === 'wayland' || !!process.env.WAYLAND_DISPLAY);

if (process.platform === 'linux') app.commandLine.appendSwitch('enable-features', 'WebRTCPipeWireCapturer');

let chosen: string | null = null;

export async function listScreenSources(): Promise<ScreenSource[]> {
  if (usesPortal) return [];
  const sources = await desktopCapturer.getSources({ types: ['screen', 'window'], thumbnailSize: { width: 320, height: 200 }, fetchWindowIcons: false });
  return sources
    .filter((s) => !/^Veil$/.test(s.name) || s.id.startsWith('screen'))
    .map((s) => ({ id: s.id, name: s.name, kind: s.id.startsWith('screen') ? 'screen' : 'window', thumbnail: s.thumbnail.toDataURL() }));
}

/** The source the person picked in Veil's picker; used by the next getDisplayMedia(). */
export function chooseScreenSource(id: string | null): void {
  chosen = typeof id === 'string' && /^(screen|window):[\w:.-]+$/.test(id) ? id : null;
}

export function setupScreenShare(): void {
  session.defaultSession.setDisplayMediaRequestHandler(async (_request, callback) => {
    try {
      const sources = await desktopCapturer.getSources({ types: ['screen', 'window'] });
      const source = usesPortal ? sources[0] : sources.find((s) => s.id === chosen);
      chosen = null;
      // Nothing chosen (or the portal was cancelled): getDisplayMedia() fails with NotAllowedError.
      if (!source) return callback({});
      callback({ video: source });
    } catch {
      callback({});
    }
  });
}
