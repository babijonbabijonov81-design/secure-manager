// Notification card window: shows one message preview, closes itself after a while.
import '@fontsource-variable/inter';
import './card.css';

interface CardData {
  title: string;
  body: string;
  initials: string;
  gradient: string;
  theme: 'dark' | 'light';
  accent: string;
  call?: boolean;
}

const api = (
  window as unknown as {
    card: { onData(cb: (d: CardData) => void): void; click(): void; close(): void; action(a: 'accept' | 'decline'): void };
  }
).card;
const LIFETIME_MS = 6500;
const el = (id: string) => document.getElementById(id)!;

let remaining = LIFETIME_MS;
let startedAt = 0;
let timer: ReturnType<typeof setTimeout> | null = null;

function dismiss(): void {
  el('card').classList.add('leaving');
  setTimeout(() => api.close(), 220);
}

let isCall = false;

function run(): void {
  if (isCall) return; // a ringing call stays until it is answered, declined or over
  startedAt = Date.now();
  timer = setTimeout(dismiss, remaining);
  const bar = el('bar');
  bar.style.transition = `transform ${remaining}ms linear`;
  bar.style.transform = 'scaleX(0)';
}

function pause(): void {
  if (!timer) return;
  clearTimeout(timer);
  timer = null;
  remaining = Math.max(800, remaining - (Date.now() - startedAt));
  const bar = el('bar');
  const scale = getComputedStyle(bar).transform;
  bar.style.transition = 'none';
  bar.style.transform = scale === 'none' ? 'scaleX(1)' : scale;
}

api.onData((data) => {
  document.documentElement.dataset.theme = data.theme;
  document.documentElement.style.setProperty('--accent', data.accent);
  el('title').textContent = data.title;
  el('body').textContent = data.body;
  el('initials').textContent = data.initials;
  isCall = !!data.call;
  if (isCall) {
    // Its own buttons must stay reachable, so the card itself is not a button.
    el('card').setAttribute('role', 'alertdialog');
    el('card').setAttribute('aria-label', `${data.title}: ${data.body}`);
    el('card').classList.add('call');
    el('actions').hidden = false;
    el('close').hidden = true;
  }
  (el('initials').parentElement as HTMLElement).style.background = data.gradient;
  requestAnimationFrame(() => {
    el('card').classList.add('shown');
    run();
  });
});

el('card').addEventListener('click', () => api.click());
el('close').addEventListener('click', (event) => {
  event.stopPropagation();
  dismiss();
});
for (const action of ['accept', 'decline'] as const) {
  el(action).addEventListener('click', (event) => {
    event.stopPropagation();
    api.action(action);
  });
}
el('card').addEventListener('mouseenter', pause);
el('card').addEventListener('mouseleave', run);
