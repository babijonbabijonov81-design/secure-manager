// Veil's own notification cards: small frameless windows stacked in the corner of the
// screen, styled like the app (avatar, name, text), shown without stealing focus.

import { BrowserWindow, ipcMain, screen } from 'electron';
import { join } from 'node:path';

export interface NotificationCard {
  title: string;
  body: string;
  tag?: string;
  initials: string;
  gradient: string;
  theme: 'dark' | 'light';
  accent: string;
}

const WIDTH = 372;
const HEIGHT = 96;
const GAP = 10;
const MARGIN = 14;
const MAX_CARDS = 4;

interface Card {
  id: number;
  window: BrowserWindow;
  tag?: string;
}

let counter = 0;
const cards: Card[] = [];
let onClick: (tag?: string) => void = () => {};

function layout(): void {
  const area = screen.getPrimaryDisplay().workArea;
  const fromTop = process.platform === 'darwin';
  cards.forEach((card, index) => {
    const x = area.x + area.width - WIDTH - MARGIN;
    const offset = index * (HEIGHT + GAP);
    const y = fromTop ? area.y + MARGIN + offset : area.y + area.height - MARGIN - HEIGHT - offset;
    if (!card.window.isDestroyed()) card.window.setBounds({ x, y, width: WIDTH, height: HEIGHT });
  });
}

function close(id: number): void {
  const index = cards.findIndex((c) => c.id === id);
  if (index < 0) return;
  const [card] = cards.splice(index, 1);
  if (!card.window.isDestroyed()) card.window.destroy();
  layout();
}

export function setupNotificationCards(clickHandler: (tag?: string) => void): void {
  onClick = clickHandler;
  ipcMain.on('card:click', (event) => {
    const card = cards.find((c) => c.window.webContents === event.sender);
    if (!card) return;
    onClick(card.tag);
    close(card.id);
  });
  ipcMain.on('card:close', (event) => {
    const card = cards.find((c) => c.window.webContents === event.sender);
    if (card) close(card.id);
  });
}

export function showNotificationCard(data: NotificationCard): void {
  // Newest on top of the stack; drop the oldest beyond the limit.
  while (cards.length >= MAX_CARDS) close(cards[cards.length - 1].id);
  const window = new BrowserWindow({
    width: WIDTH,
    height: HEIGHT,
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    focusable: false,
    hasShadow: false,
    show: false,
    webPreferences: {
      preload: join(__dirname, '../preload/card.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      devTools: false,
    },
  });
  window.setAlwaysOnTop(true, 'screen-saver');
  window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  const card: Card = { id: ++counter, window, tag: data.tag };
  cards.unshift(card);
  layout();
  window.webContents.once('did-finish-load', () => {
    window.webContents.send('card:data', data);
    window.showInactive();
  });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event) => event.preventDefault());
  if (process.env.ELECTRON_RENDERER_URL) void window.loadURL(`${process.env.ELECTRON_RENDERER_URL}/card.html`);
  else void window.loadFile(join(__dirname, '../renderer/card.html'));
}

export function closeAllCards(): void {
  for (const card of [...cards]) close(card.id);
}
