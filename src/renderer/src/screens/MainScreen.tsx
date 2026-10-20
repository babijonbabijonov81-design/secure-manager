import { DownloadCloud, Lock, LockKeyhole, Maximize2, MessageCircle, MessageSquarePlus, Minimize2, Moon, Settings, ShieldCheck, Sun, Timer, WifiOff, X } from 'lucide-react';
import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type MutableRefObject } from 'react';
import type { Messenger } from '../../../core/messenger.ts';
import { bridge, type NotificationCardData, type UpdateState } from '../../../core/platform.ts';
import type { Contact, Message } from '../../../core/types.ts';
import { applyAppearance } from '../App.tsx';
import { CallOverlay } from '../components/CallOverlay.tsx';
import { ChatList } from '../components/ChatList.tsx';
import { ChatView } from '../components/ChatView.tsx';
import { InfoPanel } from '../components/InfoPanel.tsx';
import { NewChatModal } from '../components/NewChatModal.tsx';
import { SettingsModal, type SettingsTab } from '../components/SettingsModal.tsx';
import { revokeAttachmentUrls } from '../lib/attachments.ts';
import { CallManager } from '../lib/calls.ts';
import { snippetOf } from '../../../core/messenger.ts';
import { avatarGradient, initials } from '../lib/format.ts';
import { playChime, setBadge, showNotification } from '../lib/notify.ts';
import { Avatar, Logo, useToast } from '../lib/ui.tsx';

interface Props {
  messenger: Messenger;
  incomingRef: MutableRefObject<(contact: Contact, message: Message) => void>;
  onLock(): void;
  onDeleted(): void;
}

const STATUS_TEXT = { online: 'В сети', connecting: 'Подключение…', offline: 'Нет связи' } as const;

/** Data for Veil's own notification card, styled like the app right now. */
function cardData(contact: Contact, body: string, call = false): NotificationCardData {
  const root = document.documentElement;
  return {
    title: contact.displayName,
    body,
    initials: initials(contact.displayName),
    gradient: avatarGradient(contact.id),
    theme: root.dataset.theme === 'light' ? 'light' : 'dark',
    accent: getComputedStyle(root).getPropertyValue('--accent').trim() || '#7c5cff',
    ...(call ? { call } : {}),
  };
}

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
        const body = settings.notificationPreview ? snippetOf(message) || 'Сообщение' : 'Новое зашифрованное сообщение';
        if (bridge && settings.notificationStyle === 'veil') bridge.notify({ title: contact.displayName, body, tag: contact.id, card: cardData(contact, body) });
        else showNotification(contact.displayName, body, contact.id, () => setActiveId(contact.id));
      }
    };
    return () => {
      incomingRef.current = () => {};
    };
  }, [messenger, incomingRef]);

  // Audio calls: one manager per unlocked account; locking hangs up.
  const toast = useToast();
  const [calls, setCalls] = useState<CallManager | null>(null);
  useEffect(() => {
    const manager = new CallManager(messenger, {
      onIncoming: (contact, callId) => {
        if (document.hasFocus() && !document.hidden) return;
        const settings = messenger.getSnapshot().settings;
        const body = 'Входящий аудиозвонок';
        if (bridge && settings.notificationStyle === 'veil') bridge.notify({ title: contact.displayName, body, tag: `call:${callId}`, card: cardData(contact, body, true) });
        else showNotification(contact.displayName, body, `call:${callId}`, () => manager.setMinimized(false));
      },
      onSettled: (callId) => bridge?.closeNotification(`call:${callId}`),
    });
    setCalls(manager);
    const offAction = bridge?.onCallAction(({ tag, action }) => {
      const call = manager.getState();
      if (!call || tag !== `call:${call.id}`) return;
      if (action === 'accept') {
        setActiveId(call.contactId);
        manager.setMinimized(false);
        void manager.accept();
      } else manager.decline();
    });
    return () => {
      offAction?.();
      manager.dispose();
      setCalls(null);
    };
  }, [messenger]);
  // Locking hangs up first, while the call can still be logged and the other side told.
  const lock = useCallback(() => {
    calls?.hangup();
    onLock();
  }, [calls, onLock]);
  const audio = snapshot.settings.audio;
  useEffect(() => calls?.applySettings(), [calls, audio]);
  const startCall = useCallback(
    (contactId: string) => {
      if (!calls) return;
      setActiveId(contactId);
      calls.start(contactId).catch((error: Error) => toast(error.message, 'error'));
    },
    [calls, toast],
  );

  useEffect(
    () =>
      bridge?.onNotificationClick((tag) => {
        const call = calls?.getState();
        if (tag.startsWith('call:')) {
          if (call && tag === `call:${call.id}`) {
            setActiveId(call.contactId);
            calls!.setMinimized(false);
          }
        } else setActiveId(tag);
      }),
    [calls],
  );

  // In-app updates.
  const [update, setUpdate] = useState<UpdateState | null>(null);
  const [updateHidden, setUpdateHidden] = useState(false);
  useEffect(() => {
    if (!bridge) return;
    void bridge.update.state().then(setUpdate);
    return bridge.update.onState(setUpdate);
  }, []);

  const [fullscreen, setFullscreen] = useState(false);
  useEffect(() => bridge?.onFullscreen(setFullscreen), []);

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
    // Never lock in the middle of a call.
    const timer = setInterval(() => Date.now() - last > lockAfter * 60_000 && !calls?.getState() && onLock(), 10_000);
    return () => {
      clearInterval(timer);
      for (const e of events) window.removeEventListener(e, touch);
    };
  }, [lockAfter, onLock, calls]);

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
        lock();
      } else if (key === ',') {
        e.preventDefault();
        setModal({ kind: 'settings' });
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [lock]);

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
          <button className="titlebar-btn" onClick={() => bridge!.toggleFullscreen()} title={fullscreen ? 'Выйти из полноэкранного режима (F11)' : 'На весь экран (F11)'}>
            {fullscreen ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
          </button>
        </div>
      )}
      {calls && <CallOverlay calls={calls} contacts={snapshot.contacts} />}
      {update && !updateHidden && ['available', 'downloading', 'ready'].includes(update.status) && (
        <div className="banner update">
          <DownloadCloud size={15} />
          {update.status === 'available' && <>Доступна новая версия Veil {update.version}</>}
          {update.status === 'downloading' && <>Загрузка обновления… {update.percent ?? 0}%</>}
          {update.status === 'ready' && <>Обновление {update.version} готово</>}
          {update.status === 'available' && (
            <button onClick={() => bridge!.update.download()}>{update.manual ? 'Скачать' : 'Обновить'}</button>
          )}
          {update.status === 'ready' && <button onClick={() => bridge!.update.install()}>Перезапустить</button>}
          <button className="banner-close" onClick={() => setUpdateHidden(true)} aria-label="Скрыть">
            <X size={14} />
          </button>
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
            <button className="icon-btn" aria-label="Заблокировать" onClick={lock}>
              <Lock size={20} />
            </button>
          </div>
          <div className="tooltip-wrap" data-tip={`@${snapshot.me.username}`}>
            <button className="me" aria-label="Профиль" onClick={() => setModal({ kind: 'settings', tab: 'profile' })}>
              <Avatar name={snapshot.me.displayName} seed={snapshot.me.userId} size={40} />
            </button>
          </div>
        </nav>

        <ChatList
          ref={searchRef}
          messenger={messenger}
          snapshot={snapshot}
          activeId={activeId}
          onSelect={select}
          onNewChat={() => setModal({ kind: 'new' })}
          onDeleted={(id) => {
            if (id === activeId) {
              setActiveId(null);
              setInfoOpen(false);
            }
          }}
        />

        {active ? (
          <ChatView
            key={active.id}
            messenger={messenger}
            snapshot={snapshot}
            contact={active}
            infoOpen={infoOpen}
            onToggleInfo={() => setInfoOpen((v) => !v)}
            onShowSafety={() => setInfoOpen(true)}
            onCall={startCall}
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
            online={!!snapshot.online[active.id]}
            onCall={() => startCall(active.id)}
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
