// Camera and screen for video calls (features.video). The pictures go through the same
// DTLS-SRTP connection as the voice, keyed through Veil's end-to-end encrypted channel.
import { bridge } from '../../../core/platform.ts';

export class MediaAccessError extends Error {}

function cameraErrorText(error: unknown): string {
  switch ((error as DOMException)?.name) {
    case 'NotAllowedError':
    case 'SecurityError':
      return bridge?.platform === 'darwin'
        ? 'Нет доступа к камере. Разрешите его: Системные настройки → Конфиденциальность и безопасность → Камера'
        : 'Нет доступа к камере. Разрешите его в настройках системы (Конфиденциальность → Камера)';
    case 'NotFoundError':
    case 'OverconstrainedError':
      return 'Камера не найдена';
    case 'NotReadableError':
    case 'AbortError':
      return 'Камера занята другой программой';
    default:
      return 'Не удалось включить камеру';
  }
}

export async function openCamera(deviceId: string): Promise<MediaStream> {
  if (bridge && !(await bridge.requestCamera())) throw new MediaAccessError(cameraErrorText({ name: 'NotAllowedError' }));
  const base = { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30, max: 30 } };
  try {
    return await navigator.mediaDevices.getUserMedia({ video: deviceId ? { ...base, deviceId: { exact: deviceId } } : base, audio: false });
  } catch (error) {
    const name = (error as DOMException)?.name;
    if (deviceId && (name === 'OverconstrainedError' || name === 'NotFoundError')) {
      try {
        return await navigator.mediaDevices.getUserMedia({ video: base, audio: false });
      } catch (fallback) {
        throw new MediaAccessError(cameraErrorText(fallback));
      }
    }
    throw new MediaAccessError(cameraErrorText(error));
  }
}

/** The person closed the screen picker: not an error. */
export class ScreenCancelled extends Error {}

/**
 * The screen or a window. In the desktop app the source was chosen in Veil's own picker (or, on
 * Wayland, in the system's PipeWire portal dialog); in a browser, in the browser's picker.
 */
export async function openScreen(): Promise<MediaStream> {
  try {
    return await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: { ideal: 15, max: 30 } }, audio: false });
  } catch (error) {
    const name = (error as DOMException)?.name;
    if (name === 'NotAllowedError' || name === 'AbortError') throw new ScreenCancelled();
    throw new MediaAccessError(bridge?.platform === 'linux' ? 'Не удалось показать экран. На Wayland нужен xdg-desktop-portal с PipeWire' : 'Не удалось показать экран');
  }
}
