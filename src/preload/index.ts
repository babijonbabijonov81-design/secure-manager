// Preload: exposes a minimal, typed bridge to the sandboxed renderer.
import { contextBridge, ipcRenderer, webFrame } from 'electron';
import type { UpdateState, VeilBridge } from '../core/platform.ts';

const listen = <T>(channel: string, callback: (value: T) => void) => {
  const listener = (_event: unknown, value: T) => callback(value);
  ipcRenderer.on(channel, listener);
  return () => {
    ipcRenderer.removeListener(channel, listener);
  };
};

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
  onNotificationClick: (callback) => listen('notification-click', callback),
  closeNotification: (tag) => ipcRenderer.send('notify:close', tag),
  onCallAction: (callback) => listen('call-action', callback),
  setBadge: (count) => ipcRenderer.send('badge', count),
  setTheme: (theme) => ipcRenderer.send('theme', theme),
  setContentProtection: (enabled) => ipcRenderer.send('content-protection', enabled),
  focus: () => ipcRenderer.send('focus'),
  copyText: (text) => ipcRenderer.send('clipboard:text', text),
  copySecret: (text, seconds) => ipcRenderer.invoke('clipboard:secret', text, seconds),
  clearSecret: () => ipcRenderer.invoke('clipboard:clear-secret'),
  copyImage: (png) => ipcRenderer.send('clipboard:image', png),
  spell: {
    suggestions: (word) => (webFrame.isWordMisspelled(word) ? webFrame.getWordSuggestions(word) : null),
    addWord: (word) => ipcRenderer.send('spell:add', word),
    setEnabled: (enabled) => ipcRenderer.send('spell:enable', enabled),
  },
  requestMicrophone: () => ipcRenderer.invoke('mic:request'),
  toggleFullscreen: () => ipcRenderer.send('fullscreen:toggle'),
  onFullscreen: (callback) => listen('fullscreen', callback),
  openExternal: (url) => ipcRenderer.send('open-external', url),
  saveFile: (name, data) => ipcRenderer.invoke('save-file', name, data),
  server: {
    start: (port) => ipcRenderer.invoke('server:start', port),
    stop: () => ipcRenderer.invoke('server:stop'),
    status: () => ipcRenderer.invoke('server:status'),
    setAutoStart: (enabled, port) => ipcRenderer.invoke('server:autostart', enabled, port),
  },
  update: {
    state: () => ipcRenderer.invoke('update:state'),
    check: () => ipcRenderer.invoke('update:check'),
    download: () => ipcRenderer.send('update:download'),
    install: () => ipcRenderer.send('update:install'),
    openPage: () => ipcRenderer.send('update:page'),
    onState: (callback) => listen<UpdateState>('update:state', callback),
  },
};

contextBridge.exposeInMainWorld('veil', bridge);
