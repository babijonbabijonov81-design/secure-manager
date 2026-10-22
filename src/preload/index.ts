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

// The account whose quick unlock the calls below use (Settings → «Аккаунты»).
let quickSlot: 1 | 2 = 1;

const bridge: VeilBridge = {
  platform: process.platform as VeilBridge['platform'],
  version: ipcRenderer.sendSync('app:version') as string,
  deviceName: ipcRenderer.sendSync('app:device-name') as string,
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
  closeAllNotifications: () => ipcRenderer.send('notify:close-all'),
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
  requestCamera: () => ipcRenderer.invoke('camera:request'),
  quickUnlock: {
    select: (slot) => {
      quickSlot = slot === 2 ? 2 : 1;
    },
    status: () => ipcRenderer.invoke('quick:status', quickSlot),
    enablePin: (blob) => ipcRenderer.invoke('quick:enable-pin', quickSlot, blob),
    loadPin: () => ipcRenderer.invoke('quick:load-pin', quickSlot),
    pinFailed: () => ipcRenderer.invoke('quick:pin-failed', quickSlot),
    pinSucceeded: () => ipcRenderer.invoke('quick:pin-ok', quickSlot),
    enableFingerprint: (key) => ipcRenderer.invoke('quick:enable-fingerprint', quickSlot, key),
    fingerprint: () => ipcRenderer.invoke('quick:fingerprint', quickSlot),
    disable: (what) => ipcRenderer.invoke('quick:disable', quickSlot, what),
  },
  onSystemLock: (callback) => listen('system-lock', callback),
  systemLockSupported: () => ipcRenderer.invoke('system:lock-supported'),
  onHidden: (callback) => listen('window-hidden', callback),
  lan: {
    host: () => ipcRenderer.invoke('bridge:host'),
    discover: () => ipcRenderer.invoke('bridge:discover'),
    connect: (host, port) => ipcRenderer.invoke('bridge:connect', host, port),
    send: (data) => ipcRenderer.send('bridge:send', data),
    drop: () => ipcRenderer.send('bridge:drop'),
    stop: () => ipcRenderer.send('bridge:stop'),
    onPeer: (callback) => listen('bridge:peer', callback),
    onData: (callback) => listen<Uint8Array>('bridge:data', callback),
    onClosed: (callback) => listen('bridge:closed', callback),
  },
  toggleFullscreen: () => ipcRenderer.send('fullscreen:toggle'),
  onFullscreen: (callback) => listen('fullscreen', callback),
  openExternal: (url) => ipcRenderer.send('open-external', url),
  linkPreview: (url) => ipcRenderer.invoke('preview:fetch', url),
  models: {
    status: () => ipcRenderer.invoke('models:status'),
    download: (id) => ipcRenderer.invoke('models:download', id),
    cancel: () => ipcRenderer.invoke('models:cancel'),
    remove: (id) => ipcRenderer.invoke('models:delete', id),
    onProgress: (callback) => listen('models:progress', callback),
  },
  screen: {
    sources: () => ipcRenderer.invoke('screen:sources'),
    choose: (id) => ipcRenderer.invoke('screen:choose', id),
  },
  cloud: {
    status: () => ipcRenderer.invoke('cloud:status'),
    signIn: () => ipcRenderer.invoke('cloud:signin'),
    cancel: () => ipcRenderer.invoke('cloud:cancel'),
    list: (refresh) => ipcRenderer.invoke('cloud:list', refresh),
    upload: (refresh, name, data) => ipcRenderer.invoke('cloud:upload', refresh, name, data),
    download: (refresh, name) => ipcRenderer.invoke('cloud:download', refresh, name),
    remove: (refresh, name) => ipcRenderer.invoke('cloud:remove', refresh, name),
    forget: (refresh) => ipcRenderer.invoke('cloud:forget', refresh),
  },
  takeInvite: () => ipcRenderer.invoke('invite:take'),
  onInvite: (callback) => listen('invite', callback),
  saveFile: (name, data) => ipcRenderer.invoke('save-file', name, data),
  server: {
    discover: () => ipcRenderer.invoke('server:discover'),
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
