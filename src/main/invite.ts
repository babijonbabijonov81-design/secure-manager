// veil:// links («Приглашение veil://»). Windows: the protocol is registered in the registry for
// this user (installed and portable builds alike). Linux: deb, rpm and Flatpak register it with
// `MimeType=x-scheme-handler/veil` in their .desktop file; an AppImage has no installed .desktop
// file, so it writes its own small one to ~/.local/share/applications.

import { execFile } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { app } from 'electron';

const LINK = /veil:\/\/add\/[^\s"'<>]+/i;

/** A veil:// link among command-line arguments (how Windows and Linux pass it to the app). */
export const findInvite = (argv: string[]): string | null => argv.map((a) => LINK.exec(a)?.[0]).find(Boolean) ?? null;

export async function registerInviteProtocol(): Promise<void> {
  if (!app.isPackaged) return;
  if (process.platform === 'win32') {
    app.setAsDefaultProtocolClient('veil');
    return;
  }
  const appImage = process.env.APPIMAGE;
  if (process.platform !== 'linux' || !appImage) return;
  const dir = join(process.env.XDG_DATA_HOME || join(homedir(), '.local', 'share'), 'applications');
  const quoted = `"${appImage.replace(/(["`$\\])/g, '\\$1')}"`;
  const entry = [
    '[Desktop Entry]',
    'Type=Application',
    'Name=Veil',
    'Comment=Ссылки-приглашения veil://',
    `Exec=${quoted} %U`,
    'Icon=veil',
    'Terminal=false',
    'NoDisplay=true',
    'MimeType=x-scheme-handler/veil;',
    '',
  ].join('\n');
  try {
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'veil-appimage.desktop'), entry);
    execFile('xdg-mime', ['default', 'veil-appimage.desktop', 'x-scheme-handler/veil'], () => {});
  } catch {
    // a read-only home: links can still be pasted into «Новый чат»
  }
}
