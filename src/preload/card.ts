// Preload for notification cards: receives the card data, reports clicks.
import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('card', {
  onData: (callback: (data: unknown) => void) => ipcRenderer.on('card:data', (_event, data) => callback(data)),
  click: () => ipcRenderer.send('card:click'),
  close: () => ipcRenderer.send('card:close'),
});
