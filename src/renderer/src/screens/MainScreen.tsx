import { Lock, LockKeyhole, MessageCircle, MessageSquarePlus, Moon, Settings, ShieldCheck, Sun, Timer, WifiOff } from 'lucide-react';
import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type MutableRefObject } from 'react';
import type { Messenger } from '../../../core/messenger.ts';
import { bridge } from '../../../core/platform.ts';
import type { Contact, Message } from '../../../core/types.ts';
import { applyAppearance } from '../App.tsx';
import { ChatList } from '../components/ChatList.tsx';
import { ChatView } from '../components/ChatView.tsx';
import { InfoPanel } from '../components/InfoPanel.tsx';
import { NewChatModal } from '../components/NewChatModal.tsx';
import { SettingsModal, type SettingsTab } from '../components/SettingsModal.tsx';
import { revokeAttachmentUrls } from '../lib/attachments.ts';
import { previewOf } from '../lib/format.ts';
import { playChime, setBadge, showNotification } from '../lib/notify.ts';
import { Avatar, Logo } from '../lib/ui.tsx';

interface Props {
  messenger: Messenger;
  incomingRef: MutableRefObject<(contact: Contact, message: Message) => void>;
  onLock(): void;
  onDeleted(): void;
}

const STATUS_TEXT = { online: 'В сети', connecting: 'Подключение…', offline: 'Нет связи' } as const;

export function MainScreen({ messenger, incomingRef, onLock, onDeleted }: Props) {
  const snapshot = useSyncExternalStore(messenger.subscribe, messenger.getSnapshot);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [infoOpen, setInfoOpen] = useState(false);
  const [modal, setModal] = useState<{ kind: 'settings'; tab?: SettingsTab } | { kind: 'new' } | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const activeRef = useRef(activeId);
  activeRef.current = activeId;

  const { theme, accent } = snapshot.settings;
  useEffect(() => {
    applyAppearance(theme, accent);
    if (theme !== 'system') return;
    const media = matchMedia('(prefers-color-scheme: light)');
    const onChange = () => applyAppearance(theme, accent);
    media.addEventListener('change', onChange);
    return () => media.removeEventListener('change', onChange);
  }, [theme, accent]);

  useEffect(() => () => revokeAttachmentUrls(), []);

  const screenProtection = snapshot.settings.screenProtection;
  useEffect(() => {
    bridge?.setContentProtection(screenProtection);
    return () => bridge?.setContentProtection(false);
  }, [screenProtection]);

  // Notifications & sounds for incoming messages.
  useEffect(() => {
    incomingRef.current = (contact, message) => {
      const focused = document.hasFocus() && !document.hidden;
      if (focused && activeRef.current === contact.id) return;
      const settings = messenger.getSnapshot().settings;
      if (settings.sounds) playChime();
      if (settings.notifications && !focused) {
        showNotification(contact.displayName, settings.notificationPreview ? previewOf(message) : 'Новое зашифрованное сообщение', contact.id, () =>
          setActiveId(contact.id),
        );
      }
    };
    return () => {
      incomingRef.current = () => {};
    };
  }, [messenger, incomingRef]);

  useEffect(() => bridge?.onNotificationClick((id) => setActiveId(id)), []);

  const unread = snapshot.contacts.reduce((sum, c) => sum + (c.muted ? 0 : c.unread), 0);
  useEffect(() => setBadge(unread), [unread]);
  useEffect(() => () => setBadge(0), []);

  // Auto-lock after inactivity.
  const lockAfter = snapshot.settings.autoLockMinutes;
  useEffect(() => {
    if (!lockAfter) return;
    let last = Date.now();
    const touch = () => (last = Date.now());
    const events = ['mousemove', 'keydown', 'mousedown', 'wheel', 'focus'] as const;
    for (const e of events) window.addEventListener(e, touch, { passive: true });
    const timer = setInterval(() => Date.now() - last > lockAfter * 60_000 && onLock(), 10_000);
    return () => {
      clearInterval(timer);
      for (const e of events) window.removeEventListener(e, touch);
    };
  }, [lockAfter, onLock]);

  // Keyboard shortcuts.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;
      if (!mod) return;
      const key = e.key.toLowerCase();
      if (key === 'k' || key === 'f') {
        e.preventDefault();
        searchRef.current?.focus();
      } else if (key === 'n') {
        e.preventDefault();
        setModal({ kind: 'new' });
      } else if (key === 'l') {
        e.preventDefault();
        onLock();
      } else if (key === ',') {
        e.preventDefault();
        setModal({ kind: 'settings' });
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onLock]);

  const active = snapshot.contacts.find((c) => c.id === activeId) ?? null;
  const select = useCallback((id: string) => setActiveId(id), []);
  const dark = theme === 'dark' || (theme === 'system' && !matchMedia('(prefers-color-scheme: light)').matches);

  return (
    <div className="shell">
      {bridge && (
        <div className="titlebar">
          <span className={`status-pill ${snapshot.status}`}>
            <span className="status-dot" />
            {STATUS_TEXT[snapshot.status]}
          </span>
          <div className="titlebar-title">
            <Logo size={16} /> Veil
          </div>
        </div>
      )}
      {snapshot.fatal && (
        <div className="banner">
          {snapshot.fatal}
          <button onClick={() => messenger.reconnect()}>Подключиться здесь</button>
        </div>
      )}
      {!snapshot.fatal && snapshot.status === 'offline' && (
        <div className="banner warn">
          <WifiOff size={14} />
          Нет соединения с сервером{snapshot.statusError ? `: ${snapshot.statusError}` : ''}. Сообщения отправятся автоматически.
          <button onClick={() => messenger.reconnect()}>Повторить</button>
        </div>
      )}
      <div className="shell-body">
        <nav className="rail">
          <div className="logo-btn">
            <Logo size={40} />
          </div>
          <div className="tooltip-wrap" data-tip="Чаты">
            <button className="icon-btn active" aria-label="Чаты" onClick={() => setActiveId(null)}>
              <MessageCircle size={21} />
            </button>
          </div>
          <div className="tooltip-wrap" data-tip="Новый чат">
            <button className="icon-btn" aria-label="Новый чат" onClick={() => setModal({ kind: 'new' })}>
              <MessageSquarePlus size={21} />
            </button>
          </div>
          <div className="tooltip-wrap" data-tip="Настройки">
            <button className="icon-btn" aria-label="Настройки" onClick={() => setModal({ kind: 'settings' })}>
              <Settings size={21} />
            </button>
          </div>
          <div className="spacer" />
          <div className="tooltip-wrap" data-tip={dark ? 'Светлая тема' : 'Тёмная тема'}>
            <button
              className="icon-btn"
              aria-label="Сменить тему"
              onClick={() => messenger.updateSettings({ theme: dark ? 'light' : 'dark' })}
            >
              {dark ? <Sun size={20} /> : <Moon size={20} />}
            </button>
          </div>
          <div className="tooltip-wrap" data-tip="Заблокировать">
            <button className="icon-btn" aria-label="Заблокировать" onClick={onLock}>
              <Lock size={20} />
            </button>
          </div>
          <div className="tooltip-wrap" data-tip={`@${snapshot.me.username}`}>
            <button className="me" aria-label="Профиль" onClick={() => setModal({ kind: 'settings', tab: 'profile' })}>
              <Avatar name={snapshot.me.displayName} seed={snapshot.me.userId} size={40} />
            </button>
          </div>
        </nav>

        <ChatList ref={searchRef} snapshot={snapshot} activeId={activeId} onSelect={select} onNewChat={() => setModal({ kind: 'new' })} />

        {active ? (
          <ChatView
            key={active.id}
            messenger={messenger}
            snapshot={snapshot}
            contact={active}
            infoOpen={infoOpen}
            onToggleInfo={() => setInfoOpen((v) => !v)}
            onShowSafety={() => setInfoOpen(true)}
          />
        ) : (
          <section className="chat">
            <div className="chat-bg" />
            <div className="welcome-pane">
              <div className="inner">
                <Logo size={84} />
                <h2>
                  Добро пожаловать, <span className="gradient-text">{snapshot.me.displayName}</span>
                </h2>
                <p>Выберите чат слева или начните новый. Всё, что вы пишете, шифруется прямо на этом компьютере.</p>
                <div className="pills">
                  <span className="chip success">
                    <LockKeyhole size={13} /> Сквозное шифрование
                  </span>
                  <span className="chip accent">
                    <ShieldCheck size={13} /> Сервер не видит переписку
                  </span>
                  <span className="chip">
                    <Timer size={13} /> Исчезающие сообщения
                  </span>
                </div>
                <button className="btn btn-primary" onClick={() => setModal({ kind: 'new' })}>
                  <MessageSquarePlus size={18} /> Новый чат
                </button>
              </div>
            </div>
          </section>
        )}

        {active && infoOpen && (
          <InfoPanel
            key={`info-${active.id}`}
            messenger={messenger}
            contact={active}
            onClose={() => setInfoOpen(false)}
            onDeleted={() => {
              setInfoOpen(false);
              setActiveId(null);
            }}
          />
        )}
      </div>

      {modal?.kind === 'new' && <NewChatModal messenger={messenger} onClose={() => setModal(null)} onOpen={select} />}
      {modal?.kind === 'settings' && (
        <SettingsModal messenger={messenger} snapshot={snapshot} initialTab={modal.tab} onClose={() => setModal(null)} onDeleted={onDeleted} />
      )}
    </div>
  );
}
