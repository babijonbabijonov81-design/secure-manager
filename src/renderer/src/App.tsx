import { Component, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  deviceAccounts,
  duplicateOf,
  forgetAccount,
  freeSlot,
  lastSlot,
  rememberAccount,
  setLastSlot,
  setNameHidden,
  SpaceStorage,
  type DeviceAccount,
  type Slot,
} from '../../core/accounts.ts';
import { setCloudTransport, setThisDevice, type Messenger, type MessengerEvents } from '../../core/messenger.ts';
import { bridge, cloudApi } from '../../core/platform.ts';
import { defaultStorage } from '../../core/storage.ts';
import type { Contact, Message, Theme } from '../../core/types.ts';
import { AccountsContext, type AccountsApi } from './lib/accounts.tsx';
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

/** A random id for this installation (Settings → «Устройства»); it never leaves with «Мост». */
function deviceId(): string {
  try {
    let id = localStorage.getItem('veil.device');
    if (!id) {
      id = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(16)))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
      localStorage.setItem('veil.device', id);
    }
    return id;
  } catch {
    return 'browser-without-storage';
  }
}
setCloudTransport(cloudApi);
setThisDevice({ id: deviceId(), name: bridge?.deviceName ?? `Браузер · ${navigator.platform || 'веб'}` });

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
  const root = useMemo(defaultStorage, []);
  const [slot, setSlot] = useState<Slot>(1);
  const [accounts, setAccounts] = useState<DeviceAccount[]>([]);
  const storage = useMemo(() => new SpaceStorage(root, slot), [root, slot]);
  const [phase, setPhase] = useState<Phase>('loading');
  const [messenger, setMessenger] = useState<Messenger | null>(null);
  // Adding an account: the one to go back to if that is cancelled.
  const [returnTo, setReturnTo] = useState<Slot | null>(null);
  const [notice, setNotice] = useState('');
  const incoming = useRef<(contact: Contact, message: Message) => void>(() => {});
  const reminder = useRef<(message: Message) => void>(() => {});
  const events = useMemo<MessengerEvents>(
    () => ({ onIncoming: (c, m) => incoming.current(c, m), onNoteReminder: (m) => reminder.current(m) }),
    [],
  );

  // Once unlocked, the account's own setting takes over (in MainScreen).
  useAppearance(phase === 'ready' ? null : rememberedTheme());

  const select = (next: Slot) => {
    bridge?.quickUnlock.select(next);
    setSlot(next);
  };

  /** The lock screen of `prefer` (or of the account used last), or the welcome screen. */
  const show = async (prefer?: Slot) => {
    const list = await deviceAccounts(root);
    setAccounts(list);
    const target = list.find((a) => a.slot === prefer)?.slot ?? (await lastSlot(root, list));
    if (target) {
      select(target);
      setPhase('locked');
    } else {
      select(1);
      setPhase('welcome');
    }
  };

  useEffect(() => {
    void show();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [root]);

  const ready = async (m: Messenger) => {
    const me = m.getSnapshot().me;
    if (!m.decoy) {
      const twin = await duplicateOf(root, slot, me.userId);
      if (twin) {
        // Two copies of one account would take each other's messages: keep the one already here.
        await m.lock();
        await storage.clear();
        setReturnTo(null);
        setNotice(`@${me.username} уже есть на этом устройстве — откройте его здесь.`);
        return show(twin);
      }
      await rememberAccount(root, slot, me);
    } else await setLastSlot(root, slot);
    setAccounts(await deviceAccounts(root));
    setReturnTo(null);
    setNotice('');
    setMessenger(m);
    setPhase('ready');
  };

  const lockCurrent = async () => {
    const current = messenger;
    setMessenger(null);
    // Locked means no message text anywhere on screen, notification cards included.
    bridge?.closeAllNotifications();
    await current?.lock();
  };

  const lock = async () => {
    setPhase('locked');
    await lockCurrent();
  };

  /** The account is gone from this device (deleted, moved by «Мост», signed out, reset). */
  const gone = async () => {
    setMessenger(null);
    await bridge?.quickUnlock.disable('all');
    await forgetAccount(root, slot);
    await show();
  };

  const api: AccountsApi = {
    slot,
    accounts,
    switchTo: (next) => {
      void lockCurrent().then(async () => {
        await setLastSlot(root, next);
        await show(next);
      });
    },
    add: () => {
      void (async () => {
        const free = await freeSlot(root);
        if (!free) return;
        await lockCurrent();
        setReturnTo(slot);
        select(free);
        setPhase('welcome');
      })();
    },
    setNameHidden: async (hidden) => {
      const m = messenger;
      await setNameHidden(root, slot, hidden, m && !m.decoy ? m.getSnapshot().me : null);
      setAccounts(await deviceAccounts(root));
    },
  };

  return (
    <ErrorBoundary>
      <ToastProvider>
        {phase === 'welcome' && (
          <Onboarding
            key={slot}
            storage={storage}
            events={events}
            onDone={(m) => void ready(m)}
            onCancel={returnTo ? () => void show(returnTo) : undefined}
          />
        )}
        {phase === 'locked' && (
          <LockScreen
            key={slot}
            slot={slot}
            accounts={accounts}
            notice={notice}
            storage={storage}
            events={events}
            onUnlock={(m) => void ready(m)}
            onSwitch={(next) => {
              setNotice('');
              void show(next);
            }}
            onReset={() => void gone()}
          />
        )}
        {phase === 'ready' && messenger && (
          <AccountsContext.Provider value={api}>
            <MainScreen
              messenger={messenger}
              incomingRef={incoming}
              reminderRef={reminder}
              onLock={lock}
              onDeleted={() => void gone()}
            />
          </AccountsContext.Provider>
        )}
      </ToastProvider>
    </ErrorBoundary>
  );
}
