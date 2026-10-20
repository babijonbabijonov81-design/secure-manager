// Preload for notification cards: receives the card data, reports clicks.
import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('card', {
  onData: (callback: (data: unknown) => void) => ipcRenderer.on('card:data', (_event, data) => callback(data)),
  click: () => ipcRenderer.send('card:click'),
  action: (action: 'accept' | 'decline') => ipcRenderer.send('card:action', action === 'accept' ? 'accept' : 'decline'),
  close: () => ipcRenderer.send('card:close'),
});
