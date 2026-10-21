import { bridge } from '../../../core/platform.ts';
import { SecretClipboard } from '../../../core/secret-clipboard.ts';

// Outside Electron (development, tests) the browser clipboard is used the same way.
const web = new SecretClipboard({
  write: (text) => navigator.clipboard.writeText(text),
  read: () => navigator.clipboard.readText(),
  clear: () => navigator.clipboard.writeText(''),
});

/** Copies a password; erased after `seconds` (0 = never) if the clipboard still holds it. */
export async function copySecret(text: string, seconds: number): Promise<void> {
  if (bridge) await bridge.copySecret(text, seconds);
  else await web.copy(text, seconds);
}

export function clearSecret(): Promise<boolean> {
  return bridge ? bridge.clearSecret() : web.clear();
}
