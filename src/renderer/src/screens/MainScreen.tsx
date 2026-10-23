import { Bookmark, DownloadCloud, Eye, EyeOff, FileArchive, Lock, LockKeyhole, Maximize2, MessageCircle, MessageSquarePlus, Minimize2, Phone, Settings, ShieldCheck, Timer, WifiOff, X } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type MutableRefObject, type ReactNode } from 'react';
import type { Messenger } from '../../../core/messenger.ts';
import { bridge, type NotificationCardData, type UpdateState } from '../../../core/platform.ts';
import { SAVED_ID, type Contact, type Message } from '../../../core/types.ts';
import { useAppearance } from '../App.tsx';
import { CallOverlay } from '../components/CallOverlay.tsx';
import { CallsList } from '../components/CallsList.tsx';
import { ChatList } from '../components/ChatList.tsx';
import { ChatView } from '../components/ChatView.tsx';
import { InfoPanel } from '../components/InfoPanel.tsx';
import { OpenInviteDialog } from '../components/Invites.tsx';
import { NewChatModal } from '../components/NewChatModal.tsx';
import { SettingsModal, type SettingsTab } from '../components/SettingsModal.tsx';
import { VaultView } from '../components/VaultView.tsx';
import { HiddenPinDialog } from '../components/HiddenChats.tsx';
import { revokeAttachmentUrls } from '../lib/attachments.ts';
import { CallManager } from '../lib/calls.ts';
import { snippetOf } from '../../../core/messenger.ts';
import { isLanServer } from '../../../core/invite.ts';
import { probeServer } from '../../../core/relay-client.ts';
import { avatarColor, initials } from '../lib/format.ts';
import { feature, useMediaQuery, veiledFor } from '../lib/hooks.ts';
import { playChime, setBadge, showNotification } from '../lib/notify.ts';
import { Avatar, Logo, useToast } from '../lib/ui.tsx';

interface Props {
  messenger: Messenger;
  incomingRef: MutableRefObject<(contact: Contact, message: Message) => void>;
  reminderRef: MutableRefObject<(message: Message) => void>;
  onLock(): void;
  onDeleted(): void;
}

type View = 'chats' | 'calls';

const STATUS_TEXT = { online: 'В сети', connecting: 'Подключение…', offline: 'Нет связи' } as const;
const SHIELD_KEY = 'veil.shield';

/** Data for Veil's own notification card, styled like the app right now. */
function cardData(contact: Contact, body: string, call = false): NotificationCardData {
  const root = document.documentElement;
  return {
    title: contact.displayName,
    body,
    initials: initials(contact.displayName),
    gradient: avatarColor(contact.id),
    theme: root.dataset.theme === 'light' ? 'light' : 'dark',
    accent: getComputedStyle(root).getPropertyValue('--accent').trim() || '#ff7a45',
    ...(call ? { call } : {}),
  };
}

const readShieldPreference = () => {
  try {
    return localStorage.getItem(SHIELD_KEY) !== '0';
  } catch {
    return true;
  }
};

const noSubscribe = () => () => {};
const noCall = () => null;

export function MainScreen({ messenger, incomingRef, reminderRef, onLock, onDeleted }: Props) {
  const full = useSyncExternalStore(messenger.subscribe, messenger.getSnapshot);
  const sharingRef = useRef(false);
  const settings = full.settings;
  // Hidden chats stay out of every list until the secret phrase and the PIN open them.
  const [hiddenOpen, setHiddenOpen] = useState(false);
  const [hiddenAsk, setHiddenAsk] = useState(false);
  const hiddenFeature = feature(settings, 'hiddenChats') && full.security.hiddenChats;
  const snapshot = useMemo(
    () => (hiddenOpen && hiddenFeature ? full : { ...full, contacts: full.contacts.filter((c) => !c.hidden) }),
    [full, hiddenOpen, hiddenFeature],
  );
  const [view, setView] = useState<View>('chats');
  const [activeId, setActiveId] = useState<string | null>(null);
  const [modal, setModal] = useState<{ kind: 'settings'; tab?: SettingsTab } | { kind: 'new' } | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const toast = useToast();
  const activeRef = useRef(activeId);
  activeRef.current = activeId;

  // Window layout: the chat shield sits on the right from 1100 px, below that it opens over the
  // chat from a header button; below 760 px the list and the chat are shown one at a time.
  const wide = useMediaQuery('(min-width: 1100px)');
  const narrow = useMediaQuery('(max-width: 759px)');
  const [shieldPinned, setShieldPinned] = useState(readShieldPreference);
  const [shieldOverlay, setShieldOverlay] = useState(false);
  const infoOpen = wide ? shieldPinned : shieldOverlay;
  const toggleInfo = useCallback(() => {
    if (wide) {
      setShieldPinned((open) => {
        try {
          localStorage.setItem(SHIELD_KEY, open ? '0' : '1');
        } catch {
          // storage unavailable
        }
        return !open;
      });
    } else setShieldOverlay((open) => !open);
  }, [wide]);
  const showInfo = useCallback(() => (wide ? setShieldPinned(true) : setShieldOverlay(true)), [wide]);
  useEffect(() => setShieldOverlay(false), [activeId, wide]);

  useAppearance(settings.theme);
  useEffect(() => () => revokeAttachmentUrls(), []);

  const screenProtection = settings.screenProtection;
  useEffect(() => {
    bridge?.setContentProtection(screenProtection);
    return () => bridge?.setContentProtection(false);
  }, [screenProtection]);

  // Notifications & sounds for incoming messages.
  useEffect(() => {
    reminderRef.current = (message) => {
      const body = message.note?.kind === 'password' ? 'Пароль из «Избранного» сгорит завтра' : 'Временная заметка из «Избранного» сгорит завтра';
      toast(body, 'info');
      if (!document.hasFocus()) showNotification('Избранное', body, SAVED_ID, () => setActiveId(SAVED_ID));
    };
    incomingRef.current = (contact, message) => {
      if (sharingRef.current) return;
      const focused = document.hasFocus() && !document.hidden;
      if (focused && activeRef.current === contact.id) return;
      const current = messenger.getSnapshot().settings;
      if (current.sounds) playChime();
      if (current.notifications && !focused) {
        if (contact.hidden) {
          // A hidden chat: no name, no text — just that something came.
          const body = 'Новое сообщение';
          if (bridge && current.notificationStyle === 'veil') bridge.notify({ title: 'Veil', body, tag: 'hidden', card: { ...cardData(contact, body), title: 'Veil', initials: 'V', gradient: '#e2582a' } });
          else showNotification('Veil', body, 'hidden', () => {});
          return;
        }
        const preview = current.notificationPreview && !veiledFor(current, contact);
        const author =
          contact.group && message.from
            ? (messenger.getSnapshot().contacts.find((c) => c.id === message.from)?.displayName ?? contact.group.members.find((m) => m.id === message.from)?.name)
            : undefined;
        const text = snippetOf(message) || 'Сообщение';
        const body = preview ? (author ? `${author}: ${text}` : text) : 'Новое зашифрованное сообщение';
        if (bridge && current.notificationStyle === 'veil') bridge.notify({ title: contact.displayName, body, tag: contact.id, card: cardData(contact, body) });
        else showNotification(contact.displayName, body, contact.id, () => setActiveId(contact.id));
      }
    };
    return () => {
      incomingRef.current = () => {};
      reminderRef.current = () => {};
    };
  }, [messenger, incomingRef, reminderRef, toast]);

  // Calls: one manager per unlocked account; locking hangs up.
  const [calls, setCalls] = useState<CallManager | null>(null);
  useEffect(() => {
    const manager = new CallManager(messenger, {
      onIncoming: (contact, callId) => {
        if (document.hasFocus() && !document.hidden) return;
        const current = messenger.getSnapshot().settings;
        const body = manager.getState()?.videoCall ? 'Входящий видеозвонок' : 'Входящий аудиозвонок';
        if (bridge && current.notificationStyle === 'veil') bridge.notify({ title: contact.displayName, body, tag: `call:${callId}`, card: cardData(contact, body, true) });
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
  const audio = settings.audio;
  useEffect(() => calls?.applySettings(), [calls, audio]);
  const startCall = useCallback(
    (contactId: string, video?: boolean) => {
      if (!calls) return;
      setActiveId(contactId);
      calls.start(contactId, { video }).catch((error: Error) => toast(error.message, 'error'));
    },
    [calls, toast],
  );

  // «Показ экрана»: while my screen is shown, Veil blurs every chat and keeps notifications away.
  const callState = useSyncExternalStore(calls?.subscribe ?? noSubscribe, calls?.getState ?? noCall);
  const sharing = !!callState?.screen;
  sharingRef.current = sharing;
  useEffect(() => {
    if (sharing) bridge?.closeAllNotifications();
  }, [sharing]);
  // During a call the window must not be throttled when minimized: the screen and the camera
  // would freeze for the other side, and the picture here would stop.
  const inCall = !!callState && callState.phase !== 'ended';
  const wasInCall = useRef(false);
  useEffect(() => {
    if (inCall === wasInCall.current) return;
    wasInCall.current = inCall;
    bridge?.setCallActive(inCall);
  }, [inCall]);
  useEffect(
    () => () => {
      if (wasInCall.current) bridge?.setCallActive(false);
    },
    [],
  );
  const viewSnapshot = useMemo(
    () => (sharing ? { ...snapshot, settings: { ...snapshot.settings, veil: true, veilScope: 'all' as const, features: { ...snapshot.settings.features, veil: true } } } : snapshot),
    [snapshot, sharing],
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

  // A monthly reminder about the .veil backup, put off for a week by the cross.
  const [snoozed, setSnoozed] = useState(() => {
    try {
      return Number(localStorage.getItem('veil.backup-snooze')) || 0;
    } catch {
      return 0;
    }
  });
  const snoozeBackup = () => {
    const until = Date.now() + 7 * 86_400_000;
    setSnoozed(until);
    try {
      localStorage.setItem('veil.backup-snooze', String(until));
    } catch {
      // storage unavailable
    }
  };
  const backupDue =
    feature(settings, 'backupFile') &&
    !full.decoy &&
    Date.now() > snoozed &&
    Date.now() - (settings.backupFileAt ?? full.me.createdAt) > 30 * 86_400_000;

  const [fullscreen, setFullscreen] = useState(false);
  useEffect(() => bridge?.onFullscreen(setFullscreen), []);

  const unread = snapshot.contacts.reduce((sum, c) => sum + (c.muted ? 0 : c.unread), 0);
  useEffect(() => setBadge(unread), [unread]);
  useEffect(() => () => setBadge(0), []);

  // «Свой сервер» on another computer of this Wi-Fi got a new address (the router hands them out):
  // offline for a while → look for the same server (by its id) on the network and switch to it.
  // Only for a server on the local network: someone on the same Wi-Fi must not be able to lure
  // a user of an internet server (Render, a VPS) away by announcing its id.
  const offline = snapshot.status === 'offline';
  const serverId = isLanServer(snapshot.me.serverUrl) ? snapshot.me.serverId : undefined;
  useEffect(() => {
    if (!bridge || !offline || !serverId) return;
    let alive = true;
    const timer = setTimeout(async () => {
      const found = (await bridge!.server.discover().catch(() => [])).find((r) => r.id === serverId);
      if (!alive || !found || found.address === messenger.getSnapshot().me.serverUrl) return;
      // The id is public: only a server that signs our challenge with the pinned key is the same one.
      const pinned = messenger.getSnapshot().me.serverKey;
      const proof = await probeServer(found.address).catch(() => null);
      if (!alive || !pinned || proof?.key !== pinned) return;
      messenger.moveServer(found.address);
      toast(`Сервер «${found.name}» теперь по адресу ${found.address} — переподключились`, 'info');
    }, 15_000);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [offline, serverId, messenger, toast]);

  // Locking together with the system's lock screen, and when hidden to the tray.
  useEffect(() => {
    if (!bridge) return;
    const inCall = () => !!calls?.getState();
    const offSystem = bridge.onSystemLock(() => messenger.getSnapshot().settings.lockOnSystemLock && !inCall() && onLock());
    const offHidden = bridge.onHidden(() => messenger.getSnapshot().settings.lockOnHide && !inCall() && onLock());
    return () => {
      offSystem();
      offHidden();
    };
  }, [messenger, calls, onLock]);

  // A search result to scroll to (in ChatView or «Избранное»).
  const [focus, setFocus] = useState<{ contactId: string; id: string; n: number } | null>(null);

  // A veil:// link the system opened Veil with (kept by the main process while Veil was locked).
  const [inviteLink, setInviteLink] = useState<string | null>(null);
  useEffect(() => {
    if (!bridge) return;
    const take = () =>
      void bridge!.takeInvite().then((link) => {
        if (!link) return;
        if (feature(messenger.getSnapshot().settings, 'invites')) setInviteLink(link);
        else toast('Приглашения veil:// выключены в настройках', 'info');
      });
    take();
    return bridge.onInvite(take);
  }, [messenger, toast]);

  // Auto-lock after inactivity.
  const lockAfter = settings.autoLockMinutes;
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

  const veilAvailable = feature(settings, 'veil');
  const toggleVeil = useCallback(() => {
    const next = !messenger.getSnapshot().settings.veil;
    messenger.updateSettings({ veil: next });
    toast(next ? 'Вуаль включена: входящие размыты, пока не наведёшь курсор' : 'Вуаль выключена', 'info');
  }, [messenger, toast]);

  // Chats in the order of the list, for Alt+↑/↓.
  const visibleChats = snapshot.contacts.filter((c) => !c.archived && !c.groupOnly);
  const step = useCallback(
    (delta: number) => {
      if (!visibleChats.length) return;
      const index = visibleChats.findIndex((c) => c.id === activeRef.current);
      const next = index < 0 ? (delta > 0 ? 0 : visibleChats.length - 1) : Math.max(0, Math.min(visibleChats.length - 1, index + delta));
      setView('chats');
      setActiveId(visibleChats[next].id);
    },
    [visibleChats],
  );

  // Keyboard shortcuts inside the window (no global ones: they are unreliable on Wayland).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.altKey && !e.ctrlKey && !e.metaKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
        e.preventDefault();
        step(e.key === 'ArrowDown' ? 1 : -1);
        return;
      }
      if (e.key === 'Escape' && !modal && !document.querySelector('.modal-backdrop, .lightbox, .context-menu')) {
        if (!wide && shieldOverlay) setShieldOverlay(false);
        return;
      }
      const mod = e.ctrlKey || e.metaKey;
      if (!mod) return;
      const key = e.key.toLowerCase();
      if (e.shiftKey && (key === 'v' || e.code === 'KeyV')) {
        if (!veilAvailable) return;
        e.preventDefault();
        toggleVeil();
      } else if (e.shiftKey) {
        return;
      } else if (key === 'k' || key === 'f' || e.code === 'KeyK') {
        e.preventDefault();
        setView('chats');
        requestAnimationFrame(() => searchRef.current?.focus());
      } else if (key === 'n' || e.code === 'KeyN') {
        e.preventDefault();
        setModal({ kind: 'new' });
      } else if (key === 'l' || e.code === 'KeyL') {
        e.preventDefault();
        lock();
      } else if (key === ',' || e.code === 'Comma') {
        e.preventDefault();
        setModal({ kind: 'settings' });
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [lock, step, modal, wide, shieldOverlay, veilAvailable, toggleVeil]);

  const active = snapshot.contacts.find((c) => c.id === activeId) ?? null;
  const select = useCallback((id: string) => setActiveId(id), []);
  const veilOn = veilAvailable && settings.veil;
  const savedActive = activeId === SAVED_ID;

  return (
    <div className={`shell${narrow ? ' narrow' : ''}${wide ? ' wide' : ''}${sharing ? ' sharing' : ''}`} data-pane={active ? 'chat' : 'list'} data-view={savedActive ? 'saved' : view}>
      {bridge && (
        <div className="titlebar">
          <span className={`status-pill ${snapshot.status}`}>
            <span className="status-dot" />
            {STATUS_TEXT[snapshot.status]}
          </span>
          <div className="titlebar-title">
            <Logo size={16} /> Veil
          </div>
          <button
            className="titlebar-btn"
            onClick={() => bridge!.toggleFullscreen()}
            aria-label={fullscreen ? 'Выйти из полноэкранного режима' : 'На весь экран'}
            title={fullscreen ? 'Выйти из полноэкранного режима (F11)' : 'На весь экран (F11)'}
          >
            {fullscreen ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
          </button>
        </div>
      )}
      {calls && <CallOverlay calls={calls} contacts={snapshot.contacts} showWords={feature(settings, 'callWords')} video={feature(settings, 'video')} />}
      {update && !updateHidden && ['available', 'downloading', 'ready'].includes(update.status) && (
        <div className="banner update">
          <DownloadCloud size={15} />
          {update.status === 'available' && <>Доступна новая версия Veil {update.version}</>}
          {update.status === 'downloading' && <>Загрузка обновления… {update.percent ?? 0}%</>}
          {update.status === 'ready' && <>Обновление {update.version} готово</>}
          {update.status === 'available' && (
            <button onClick={() => (update.packaged ? setModal({ kind: 'settings', tab: 'about' }) : bridge!.update.download())}>
              {update.packaged ? 'Как обновить' : update.manual ? 'Скачать' : 'Обновить'}
            </button>
          )}
          {update.status === 'ready' && <button onClick={() => bridge!.update.install()}>Перезапустить</button>}
          <button className="banner-close" onClick={() => setUpdateHidden(true)} aria-label="Скрыть">
            <X size={14} />
          </button>
        </div>
      )}
      {backupDue && (
        <div className="banner info" data-testid="backup-reminder">
          <FileArchive size={15} />
          Давно не сохраняли резервную копию .veil — без неё аккаунт не вернуть, если ПК сломается.
          <button onClick={() => setModal({ kind: 'settings', tab: 'security' })}>Сохранить</button>
          <button className="banner-close" onClick={snoozeBackup} aria-label="Напомнить позже">
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
      {snapshot.recoveryHold && (
        <div className="banner danger" data-testid="recovery-hold">
          <ShieldCheck size={14} />
          Кто-то восстанавливает ваш аккаунт по почте. {new Date(snapshot.recoveryHold.readyAt).toLocaleString('ru-RU', { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' })}{' '}
          он получит @{snapshot.me.username}. Если это не вы — отмените и смените пароль от почты.
          <button
            onClick={() =>
              void messenger.cancelRecovery().then(
                () => toast('Восстановление отменено', 'success'),
                (e: Error) => toast(e.message, 'error'),
              )
            }
          >
            Это не я — отменить
          </button>
        </div>
      )}
      {snapshot.serverKeyChanged && (
        <div className="banner warn" data-testid="server-key-banner">
          <ShieldCheck size={14} />
          Сервер показал другой ключ. Если вы не переустанавливали его, это может быть подмена: новых собеседников пока не добавить.
          <button onClick={() => setModal({ kind: 'settings', tab: 'server' })}>Проверить</button>
        </div>
      )}
      <div className="shell-body">
        <nav className="rail" aria-label="Разделы">
          <div className="rail-logo" aria-hidden="true">
            <Logo size={40} />
          </div>
          <RailButton
            label="Чаты"
            hint="Чаты · Ctrl+K — поиск"
            active={view === 'chats' && !savedActive}
            badge={unread}
            onClick={() => {
              setView('chats');
              if (savedActive) setActiveId(null);
            }}
          >
            <MessageCircle size={21} />
          </RailButton>
          <RailButton
            label="Избранное"
            active={view === 'chats' && savedActive}
            onClick={() => {
              setView('chats');
              setActiveId(SAVED_ID);
            }}
          >
            <Bookmark size={20} />
          </RailButton>
          <RailButton label="Звонки" active={view === 'calls'} onClick={() => setView('calls')}>
            <Phone size={20} />
          </RailButton>
          <RailButton label="Настройки" hint="Настройки · Ctrl+," onClick={() => setModal({ kind: 'settings' })}>
            <Settings size={21} />
          </RailButton>
          <div className="spacer" />
          {veilAvailable && (
            <RailButton label="Вуаль" hint={veilOn ? 'Вуаль включена · Ctrl+Shift+V' : 'Вуаль · Ctrl+Shift+V'} pressed={veilOn} onClick={toggleVeil}>
              {veilOn ? <EyeOff size={20} /> : <Eye size={20} />}
            </RailButton>
          )}
          <RailButton label="Заблокировать" hint="Заблокировать · Ctrl+L" onClick={lock}>
            <Lock size={20} />
          </RailButton>
          <div className="tooltip-wrap" data-tip={`@${snapshot.me.username}`}>
            <button className="me" aria-label="Профиль" onClick={() => setModal({ kind: 'settings', tab: 'profile' })}>
              <Avatar name={snapshot.me.displayName} seed={snapshot.me.userId} size={40} />
            </button>
          </div>
        </nav>

        {view === 'calls' ? (
          <CallsList snapshot={snapshot} activeId={activeId} onSelect={select} onCall={startCall} />
        ) : (
          <ChatList
            ref={searchRef}
            messenger={messenger}
            snapshot={viewSnapshot}
            activeId={activeId}
            onSelect={select}
            onNewChat={() => setModal({ kind: 'new' })}
            onDeleted={(id) => {
              if (id === activeId) setActiveId(null);
            }}
            onSecret={
              hiddenFeature
                ? async (query) => {
                    if (!(await messenger.isHiddenPhrase(query))) return false;
                    setHiddenAsk(true);
                    return true;
                  }
                : undefined
            }
            hiddenOpen={hiddenOpen && hiddenFeature}
            onCloseHidden={() => {
              setHiddenOpen(false);
              setActiveId(null);
            }}
            onOpenMessage={(contactId, id) => {
              select(contactId);
              setFocus((f) => ({ contactId, id, n: (f?.n ?? 0) + 1 }));
            }}
          />
        )}

        {active && savedActive ? (
          <VaultView messenger={messenger} snapshot={snapshot} focusId={focus?.contactId === SAVED_ID ? focus.id : undefined} />
        ) : active ? (
          <ChatView
            key={active.id}
            messenger={messenger}
            snapshot={viewSnapshot}
            contact={active}
            infoOpen={infoOpen}
            veiled={veiledFor(viewSnapshot.settings, active)}
            onToggleInfo={toggleInfo}
            onShowSafety={showInfo}
            onCall={startCall}
            onBack={() => setActiveId(null)}
            focus={focus?.contactId === active.id ? focus : undefined}
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

        {active && infoOpen && !savedActive && (
          <InfoPanel
            key={`info-${active.id}`}
            messenger={messenger}
            snapshot={snapshot}
            onOpenChat={select}
            contact={active}
            online={!!snapshot.online[active.id]}
            overlay={!wide}
            onCall={() => startCall(active.id)}
            onClose={toggleInfo}
            onOpenSettings={(tab) => setModal({ kind: 'settings', tab })}
            onDeleted={() => setActiveId(null)}
          />
        )}
      </div>

      {hiddenAsk && (
        <HiddenPinDialog
          messenger={messenger}
          onClose={() => setHiddenAsk(false)}
          onOpen={() => {
            setHiddenAsk(false);
            setHiddenOpen(true);
          }}
        />
      )}
      {modal?.kind === 'new' && <NewChatModal messenger={messenger} onClose={() => setModal(null)} onOpen={select} />}
      {inviteLink && <OpenInviteDialog messenger={messenger} link={inviteLink} onClose={() => setInviteLink(null)} onOpen={select} />}
      {modal?.kind === 'settings' && (
        <SettingsModal messenger={messenger} snapshot={snapshot} initialTab={modal.tab} onClose={() => setModal(null)} onDeleted={onDeleted} />
      )}
    </div>
  );
}

function RailButton({
  label,
  hint,
  active,
  pressed,
  badge,
  onClick,
  children,
}: {
  label: string;
  hint?: string;
  active?: boolean;
  pressed?: boolean;
  badge?: number;
  onClick(): void;
  children: ReactNode;
}) {
  return (
    <div className="tooltip-wrap" data-tip={hint ?? label}>
      <button
        className={`icon-btn rail-btn${active || pressed ? ' active' : ''}`}
        aria-label={label}
        aria-current={active ? 'page' : undefined}
        aria-pressed={pressed}
        onClick={onClick}
      >
        {children}
        {!!badge && <span className="rail-badge">{badge > 99 ? '99+' : badge}</span>}
      </button>
    </div>
  );
}
