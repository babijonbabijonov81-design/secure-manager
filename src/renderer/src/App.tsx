import { Component, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { hasAccount, type Messenger, type MessengerEvents } from '../../core/messenger.ts';
import { bridge } from '../../core/platform.ts';
import { defaultStorage } from '../../core/storage.ts';
import type { Contact, Message, Theme } from '../../core/types.ts';
import { ToastProvider } from './lib/ui.tsx';
import { LockScreen } from './screens/LockScreen.tsx';
import { MainScreen } from './screens/MainScreen.tsx';
import { Onboarding } from './screens/Onboarding.tsx';

type Phase = 'loading' | 'welcome' | 'locked' | 'ready';

const THEME_KEY = 'veil.appearance';

/** The theme chosen last time, so the lock screen opens in it; by default it follows the system. */
function rememberedTheme(): Theme {
  try {
    const saved = JSON.parse(localStorage.getItem(THEME_KEY) ?? 'null');
    if (['dark', 'light', 'system'].includes(saved?.theme)) return saved.theme;
  } catch {
    // storage unavailable
  }
  return 'system';
}

export const systemPrefersLight = () => matchMedia('(prefers-color-scheme: light)').matches;

export function applyAppearance(theme: Theme): void {
  const root = document.documentElement;
  const resolved = theme === 'system' ? (systemPrefersLight() ? 'light' : 'dark') : theme;
  root.dataset.theme = resolved;
  bridge?.setTheme(resolved);
  try {
    localStorage.setItem(THEME_KEY, JSON.stringify({ theme }));
  } catch {
    // storage unavailable
  }
}

/** Applies the theme and keeps following the system while it is set to 'system'; null leaves it alone. */
export function useAppearance(theme: Theme | null): void {
  useEffect(() => {
    if (!theme) return;
    applyAppearance(theme);
    if (theme !== 'system') return;
    const media = matchMedia('(prefers-color-scheme: light)');
    const onChange = () => applyAppearance(theme);
    media.addEventListener('change', onChange);
    return () => media.removeEventListener('change', onChange);
  }, [theme]);
}

if (bridge) {
  document.documentElement.dataset.desktop = '';
  document.documentElement.dataset.platform = bridge.platform;
}

/** A rendering error shows a way out instead of an empty window. Nothing about it is logged. */
class ErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <div className="center-stage">
        <div className="glass-card" style={{ maxWidth: 420, textAlign: 'center' }}>
          <h1 style={{ fontSize: 20 }}>Что-то пошло не так</h1>
          <p style={{ color: 'var(--text-2)' }}>Окно Veil нужно перезапустить. Ваши данные на месте: они зашифрованы на диске.</p>
          <button className="btn btn-primary btn-block" onClick={() => location.reload()}>
            Перезапустить окно
          </button>
        </div>
      </div>
    );
  }
}

export function App() {
  const storage = useMemo(defaultStorage, []);
  const [phase, setPhase] = useState<Phase>('loading');
  const [messenger, setMessenger] = useState<Messenger | null>(null);
  const incoming = useRef<(contact: Contact, message: Message) => void>(() => {});
  const reminder = useRef<(message: Message) => void>(() => {});
  const events = useMemo<MessengerEvents>(
    () => ({ onIncoming: (c, m) => incoming.current(c, m), onNoteReminder: (m) => reminder.current(m) }),
    [],
  );

  // Once unlocked, the account's own setting takes over (in MainScreen).
  useAppearance(phase === 'ready' ? null : rememberedTheme());
  useEffect(() => {
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
    <ErrorBoundary>
      <ToastProvider>
        {phase === 'welcome' && <Onboarding storage={storage} events={events} onDone={ready} />}
        {phase === 'locked' && <LockScreen storage={storage} events={events} onUnlock={ready} onReset={() => setPhase('welcome')} />}
        {phase === 'ready' && messenger && (
          <MainScreen
            messenger={messenger}
            incomingRef={incoming}
            reminderRef={reminder}
            onLock={lock}
            onDeleted={() => {
              setMessenger(null);
              setPhase('welcome');
            }}
          />
        )}
      </ToastProvider>
    </ErrorBoundary>
  );
}
