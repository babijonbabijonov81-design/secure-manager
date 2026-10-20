import { useEffect, useMemo, useRef, useState } from 'react';
import { hasAccount, type Messenger, type MessengerEvents } from '../../core/messenger.ts';
import { bridge } from '../../core/platform.ts';
import { defaultStorage } from '../../core/storage.ts';
import type { Accent, Contact, Message, Theme } from '../../core/types.ts';
import { ToastProvider } from './lib/ui.tsx';
import { LockScreen } from './screens/LockScreen.tsx';
import { MainScreen } from './screens/MainScreen.tsx';
import { Onboarding } from './screens/Onboarding.tsx';

type Phase = 'loading' | 'welcome' | 'locked' | 'ready';

const THEME_KEY = 'veil.appearance';

function rememberedAppearance(): { theme: Theme; accent: Accent } {
  try {
    const saved = JSON.parse(localStorage.getItem(THEME_KEY) ?? 'null');
    if (saved?.theme && saved?.accent) return saved;
  } catch {
    // storage unavailable
  }
  return { theme: 'dark', accent: 'violet' };
}

export function applyAppearance(theme: Theme, accent: Accent): void {
  const root = document.documentElement;
  const resolved = theme === 'system' ? (matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark') : theme;
  root.dataset.theme = resolved;
  root.dataset.accent = accent;
  bridge?.setTheme(resolved);
  try {
    localStorage.setItem(THEME_KEY, JSON.stringify({ theme, accent }));
  } catch {
    // storage unavailable
  }
}

if (bridge) {
  document.documentElement.dataset.desktop = '';
  document.documentElement.dataset.platform = bridge.platform;
}

export function App() {
  const storage = useMemo(defaultStorage, []);
  const [phase, setPhase] = useState<Phase>('loading');
  const [messenger, setMessenger] = useState<Messenger | null>(null);
  const incoming = useRef<(contact: Contact, message: Message) => void>(() => {});
  const events = useMemo<MessengerEvents>(() => ({ onIncoming: (c, m) => incoming.current(c, m) }), []);

  useEffect(() => {
    const { theme, accent } = rememberedAppearance();
    applyAppearance(theme, accent);
    void hasAccount(storage).then((exists) => setPhase(exists ? 'locked' : 'welcome'));
  }, [storage]);

  const ready = (m: Messenger) => {
    setMessenger(m);
    setPhase('ready');
  };

  const lock = async () => {
    const current = messenger;
    setMessenger(null);
    setPhase('locked');
    await current?.lock();
  };

  return (
    <ToastProvider>
      {phase === 'welcome' && <Onboarding storage={storage} events={events} onDone={ready} />}
      {phase === 'locked' && <LockScreen storage={storage} events={events} onUnlock={ready} onReset={() => setPhase('welcome')} />}
      {phase === 'ready' && messenger && (
        <MainScreen
          messenger={messenger}
          incomingRef={incoming}
          onLock={lock}
          onDeleted={() => {
            setMessenger(null);
            setPhase('welcome');
          }}
        />
      )}
    </ToastProvider>
  );
}
