// In-app updates from GitHub Releases.
// The Windows installer and the Linux AppImage update themselves (electron-updater);
// the portable .exe, .deb and unsigned macOS builds get a link to the release page.

import { app, ipcMain, net, shell, type BrowserWindow } from 'electron';
import electronUpdater from 'electron-updater';
import type { UpdateState } from '../core/platform.ts';

const { autoUpdater } = electronUpdater;

export const RELEASES_REPO = 'babijonbabijonov81-design/secure-manager';
const RELEASES_PAGE = `https://github.com/${RELEASES_REPO}/releases/latest`;
const CHECK_EVERY_MS = 6 * 60 * 60 * 1000;


const selfUpdating = () =>
  app.isPackaged &&
  ((process.platform === 'win32' && !process.env.PORTABLE_EXECUTABLE_DIR) || (process.platform === 'linux' && !!process.env.APPIMAGE));

const newer = (a: string, b: string) => {
  const pa = a.replace(/^v/, '').split('.').map(Number);
  const pb = b.replace(/^v/, '').split('.').map(Number);
  for (let i = 0; i < 3; i++) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) > (pb[i] ?? 0);
  return false;
};

export function setupUpdater(getWindow: () => BrowserWindow | null, beforeInstall: () => void): void {
  let state: UpdateState = { status: 'idle', current: app.getVersion(), manual: !selfUpdating() };
  const set = (patch: Partial<UpdateState>) => {
    state = { ...state, ...patch };
    getWindow()?.webContents.send('update:state', state);
  };

  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.on('checking-for-update', () => set({ status: 'checking', error: undefined }));
  autoUpdater.on('update-available', (info) => set({ status: 'available', version: info.version }));
  autoUpdater.on('update-not-available', () => set({ status: 'none' }));
  autoUpdater.on('download-progress', (progress) => set({ status: 'downloading', percent: Math.round(progress.percent) }));
  autoUpdater.on('update-downloaded', (info) => set({ status: 'ready', version: info.version, percent: 100 }));
  autoUpdater.on('error', (error) => set({ status: 'error', error: friendlyError(error) }));

  /** Builds that cannot self-update just compare with the latest GitHub release. */
  const checkManually = async () => {
    set({ status: 'checking', error: undefined });
    try {
      const response = await net.fetch(`https://api.github.com/repos/${RELEASES_REPO}/releases/latest`, {
        headers: { accept: 'application/vnd.github+json' },
      });
      if (!response.ok) throw new Error(String(response.status));
      const release = (await response.json()) as { tag_name: string };
      if (newer(release.tag_name, app.getVersion())) set({ status: 'available', version: release.tag_name.replace(/^v/, '') });
      else set({ status: 'none' });
    } catch (error) {
      set({ status: 'error', error: friendlyError(error as Error) });
    }
  };

  const check = async () => {
    if (!app.isPackaged) return set({ status: 'none' });
    if (state.manual) return checkManually();
    try {
      await autoUpdater.checkForUpdates();
    } catch (error) {
      set({ status: 'error', error: friendlyError(error as Error) });
    }
  };

  ipcMain.handle('update:state', () => state);
  ipcMain.handle('update:check', () => check());
  ipcMain.on('update:download', () => {
    if (state.manual) void shell.openExternal(RELEASES_PAGE);
    else {
      set({ status: 'downloading', percent: 0 });
      autoUpdater.downloadUpdate().catch((error: Error) => set({ status: 'error', error: friendlyError(error) }));
    }
  });
  ipcMain.on('update:install', () => {
    if (state.status !== 'ready') return;
    beforeInstall();
    autoUpdater.quitAndInstall(false, true);
  });
  ipcMain.on('update:page', () => void shell.openExternal(RELEASES_PAGE));

  if (app.isPackaged) {
    setTimeout(() => void check(), 15_000);
    setInterval(() => void check(), CHECK_EVERY_MS);
  }
}

function friendlyError(error: Error): string {
  const text = String(error?.message ?? error);
  if (/404|Not Found/i.test(text)) return 'Обновления недоступны: репозиторий с релизами закрыт или не найден';
  if (/ENOTFOUND|ECONNREFUSED|ETIMEDOUT|net::/i.test(text)) return 'Нет соединения с интернетом';
  return 'Не удалось проверить обновления';
}
