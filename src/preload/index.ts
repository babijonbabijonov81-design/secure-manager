// Preload: exposes a minimal, typed bridge to the sandboxed renderer.
import { contextBridge, ipcRenderer } from 'electron';
import type { VeilBridge } from '../core/platform.ts';

const bridge: VeilBridge = {
  platform: process.platform as VeilBridge['platform'],
  version: ipcRenderer.sendSync('app:version') as string,
  storage: {
    get: (key) => ipcRenderer.invoke('storage:get', key),
    set: (key, value) => ipcRenderer.invoke('storage:set', key, value),
    delete: (key) => ipcRenderer.invoke('storage:delete', key),
    list: () => ipcRenderer.invoke('storage:list'),
    clear: () => ipcRenderer.invoke('storage:clear'),
  },
  notify: (options) => ipcRenderer.send('notify', options),
  onNotificationClick: (callback) => {
    const listener = (_event: unknown, tag: string) => callback(tag);
    ipcRenderer.on('notification-click', listener);
    return () => ipcRenderer.removeListener('notification-click', listener);
  },
  setBadge: (count) => ipcRenderer.send('badge', count),
  setTheme: (theme) => ipcRenderer.send('theme', theme),
  setContentProtection: (enabled) => ipcRenderer.send('content-protection', enabled),
  focus: () => ipcRenderer.send('focus'),
  openExternal: (url) => ipcRenderer.send('open-external', url),
  saveFile: (name, data) => ipcRenderer.invoke('save-file', name, data),
  server: {
    start: (port) => ipcRenderer.invoke('server:start', port),
    stop: () => ipcRenderer.invoke('server:stop'),
    status: () => ipcRenderer.invoke('server:status'),
    setAutoStart: (enabled, port) => ipcRenderer.invoke('server:autostart', enabled, port),
  },
};

contextBridge.exposeInMainWorld('veil', bridge);
