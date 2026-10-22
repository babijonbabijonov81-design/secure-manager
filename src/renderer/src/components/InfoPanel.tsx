import {
  Archive,
  ArchiveRestore,
  Ban,
  Bell,
  BellOff,
  ChevronRight,
  Eraser,
  EyeOff,
  Hourglass,
  Phone,
  Pin,
  PinOff,
  RotateCcw,
  Shield,
  ShieldAlert,
  ShieldCheck,
  ShieldQuestion,
  Trash2,
  TriangleAlert,
  X,
} from 'lucide-react';
import { useMemo, useRef, useState } from 'react';
import { formatSafetyNumber } from '../../../core/crypto/fingerprint.ts';
import type { Messenger } from '../../../core/messenger.ts';
import { isSavedChat, sharesWith, TIMER_OPTIONS, type Contact, type MessengerSnapshot, type PresenceKind } from '../../../core/types.ts';
import { timerLabel } from '../lib/format.ts';
import { feature } from '../lib/hooks.ts';
import { chatShield, SHIELD_SUMMARY, type ShieldItem } from '../lib/shield.ts';
import { presenceText } from '../lib/text.ts';
import { Avatar, ConfirmDialog, Toggle, useToast } from '../lib/ui.tsx';
import { GroupDetails } from './GroupPanel.tsx';
import type { SettingsTab } from './SettingsModal.tsx';

type Confirm = 'clear' | 'delete' | 'block' | 'reset' | null;

const STATE_ICON = { ok: ShieldCheck, weak: Shield, alert: ShieldAlert, na: ShieldQuestion } as const;

/** «Щит чата» on the right: the protection score, then the contact, safety code, timer and actions. */
export function InfoPanel({
  messenger,
  snapshot,
  contact,
  online,
  overlay,
  onCall,
  onClose,
  onOpenSettings,
  onDeleted,
  onOpenChat,
}: {
  messenger: Messenger;
  snapshot: MessengerSnapshot;
  contact: Contact;
  online: boolean;
  /** Narrow window: the panel floats over the chat. */
  overlay: boolean;
  onCall(): void;
  onClose(): void;
  onOpenSettings(tab: SettingsTab): void;
  onDeleted(): void;
  /** Open another chat (a group member's). */
  onOpenChat?(id: string): void;
}) {
  const toast = useToast();
  const [confirm, setConfirm] = useState<Confirm>(null);
  const body = useRef<HTMLDivElement>(null);
  const safety = useMemo(
    () => (isSavedChat(contact.id) || contact.group ? [] : formatSafetyNumber(messenger.safetyNumber(contact.id))),
    [messenger, contact.id, contact.group],
  );
  if (isSavedChat(contact.id)) return <SavedInfo messenger={messenger} contact={contact} overlay={overlay} onClose={onClose} />;

  const { settings } = snapshot;
  const shield = feature(settings, 'shield') ? chatShield(contact, snapshot, messenger.iceServers.hasTurn) : null;
  const ShieldIcon = shield ? STATE_ICON[shield.level] : Shield;
  const open = (item: ShieldItem) => {
    if ('settings' in item.target) return onOpenSettings(item.target.settings);
    if (item.target.panel === 'about') return onOpenSettings('about');
    const section = body.current?.querySelector<HTMLElement>(`#shield-${item.target.panel}`);
    section?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    section?.classList.add('flash');
    setTimeout(() => section?.classList.remove('flash'), 1200);
  };
  const veilScoped = settings.veilScope === 'selected';
  const veilOn = settings.veil && (!veilScoped || !!contact.veil);

  return (
    <aside className={`info-panel${overlay ? ' overlay' : ''}`} aria-label={shield ? 'Щит чата' : 'Информация о чате'}>
      <div className="panel-head">
        <h3>{shield ? 'Щит чата' : 'Информация'}</h3>
        <button className="icon-btn sm" onClick={onClose} aria-label="Закрыть панель">
          <X size={18} />
        </button>
      </div>
      <div className="panel-body" ref={body}>
        {shield && (
          <div className={`shield-card ${shield.level}`} data-testid="chat-shield">
            <div className="shield-score">
              <span className="shield-mark">
                <ShieldIcon size={30} />
              </span>
              <div>
                <b>
                  {shield.score} из {shield.total}
                </b>
                <span>{SHIELD_SUMMARY[shield.level]}</span>
              </div>
            </div>
            <ul className="shield-items">
              {shield.items.map((item) => {
                const Icon = STATE_ICON[item.state];
                return (
                  <li key={item.id}>
                    <button className={`shield-item ${item.state}`} onClick={() => open(item)} data-testid={`shield-${item.id}`}>
                      <Icon size={17} />
                      <span className="grow">
                        <b>{item.title}</b>
                        <span>{item.value}</span>
                      </span>
                      <ChevronRight size={16} className="chev" />
                    </button>
                  </li>
                );
              })}
            </ul>
            {feature(settings, 'veil') && (
              <div className="shield-veil">
                <EyeOff size={17} />
                <span className="grow">
                  <b>Вуаль</b>
                  <span>Вуаль размывает входящие, пока не наведёшь курсор</span>
                </span>
                <Toggle
                  label="Вуаль для этого чата"
                  on={veilOn}
                  onChange={(on) => {
                    if (veilScoped) {
                      messenger.setVeil(contact.id, on);
                      if (on && !settings.veil) messenger.updateSettings({ veil: true });
                    } else messenger.updateSettings({ veil: on });
                  }}
                />
              </div>
            )}
          </div>
        )}

        {contact.group ? (
          <GroupDetails messenger={messenger} snapshot={snapshot} contact={contact} onOpenChat={onOpenChat} />
        ) : (
          <>
        <div className="profile-hero">
          <Avatar name={contact.displayName} seed={contact.id} size={96} />
          <h4>
            {contact.displayName}
            {contact.verified && <ShieldCheck size={18} style={{ color: 'var(--success)' }} />}
          </h4>
          {contact.username && <span className="handle selectable">@{contact.username}</span>}
          {presenceText(contact, online, snapshot.settings) && <span className={`presence${online ? ' online' : ''}`}>{presenceText(contact, online, snapshot.settings)}</span>}
          <div style={{ marginTop: 8 }}>
            {contact.verified ? (
              <span className="chip success">
                <ShieldCheck size={13} /> Проверен
              </span>
            ) : contact.keyWarning ? (
              <span className="chip warning">
                <TriangleAlert size={13} /> Ключ изменился
              </span>
            ) : (
              <span className="chip">
                <ShieldQuestion size={13} /> Не проверен
              </span>
            )}
          </div>
          {!contact.blocked && (
            <button className="btn btn-sm btn-secondary hero-call" onClick={onCall}>
              <Phone size={15} /> Позвонить
            </button>
          )}
        </div>

        <div className="section" id="shield-safety">
          <div className="section-title">
            <ShieldCheck size={16} /> Код безопасности
          </div>
          <div className={`safety-grid${contact.verified ? ' verified' : ''}`} data-testid="safety-number">
            {safety.map((group, i) => (
              <span key={i}>{group}</span>
            ))}
          </div>
          <p>
            Сравните эти цифры с собеседником лично или по телефону. Если они совпадают — никто не подменил ключи, и переписку не может
            прочитать посредник.
          </p>
          <button
            className={`btn btn-sm ${contact.verified ? 'btn-secondary' : 'btn-primary'}`}
            onClick={() => {
              messenger.setVerified(contact.id, !contact.verified);
              if (!contact.verified) toast('Контакт отмечен как проверенный', 'success');
            }}
          >
            {contact.verified ? 'Снять отметку' : 'Коды совпадают — отметить как проверенный'}
          </button>
          {contact.keyWarning && (
            <button className="btn btn-sm btn-ghost" onClick={() => messenger.acceptKeyChange(contact.id)}>
              Принять новый ключ без сверки
            </button>
          )}
        </div>

        <div className="section" id="shield-timer">
          <div className="section-title">
            <Hourglass size={16} /> Исчезающие сообщения
          </div>
          <div className="timer-options">
            {TIMER_OPTIONS.map((seconds) => (
              <button
                key={seconds}
                className={contact.timer === seconds ? 'active' : ''}
                onClick={() => void messenger.setTimer(contact.id, seconds).catch((e) => toast((e as Error).message, 'error'))}
              >
                {timerLabel(seconds, true)}
              </button>
            ))}
          </div>
          <p>Новые сообщения будут удаляться у обоих собеседников через выбранное время.</p>
        </div>

        {feature(settings, 'presence') && <ContactPrivacy messenger={messenger} snapshot={snapshot} contact={contact} />}
          </>
        )}

        <div className="section action-list">
          <button className="action-item" onClick={() => messenger.setPinned(contact.id, !contact.pinned)}>
            {contact.pinned ? <PinOff size={18} /> : <Pin size={18} />}
            <span className="grow">{contact.pinned ? 'Открепить чат' : 'Закрепить чат'}</span>
          </button>
          <button className="action-item" onClick={() => messenger.setArchived(contact.id, !contact.archived)}>
            {contact.archived ? <ArchiveRestore size={18} /> : <Archive size={18} />}
            <span className="grow">{contact.archived ? 'Вернуть из архива' : 'В архив'}</span>
          </button>
          <button className="action-item" onClick={() => messenger.setMuted(contact.id, !contact.muted)}>
            {contact.muted ? <Bell size={18} /> : <BellOff size={18} />}
            <span className="grow">{contact.muted ? 'Включить уведомления' : 'Без звука'}</span>
          </button>
          {feature(settings, 'hiddenChats') && (
            <button
              className="action-item"
              onClick={() => {
                if (!snapshot.security.hiddenChats) return onOpenSettings('privacy');
                messenger.setHidden(contact.id, !contact.hidden);
                toast(contact.hidden ? 'Чат вернулся в список' : 'Чат скрыт. Откройте его секретной фразой в поиске', 'success');
              }}
            >
              <EyeOff size={18} />
              <span className="grow">{contact.hidden ? 'Вернуть в список' : snapshot.security.hiddenChats ? 'Скрыть чат' : 'Скрыть чат — сначала настройте PIN'}</span>
            </button>
          )}
          {!contact.group && (
            <button className="action-item" onClick={() => setConfirm('reset')}>
              <RotateCcw size={18} />
              <span className="grow">Сбросить сеанс шифрования</span>
            </button>
          )}
          <button className="action-item" onClick={() => setConfirm('clear')}>
            <Eraser size={18} />
            <span className="grow">Очистить историю</span>
          </button>
          {!contact.group && (
            <button
              className="action-item danger"
              onClick={() => (contact.blocked ? messenger.setBlocked(contact.id, false) : setConfirm('block'))}
            >
              <Ban size={18} />
              <span className="grow">{contact.blocked ? 'Разблокировать' : 'Заблокировать'}</span>
            </button>
          )}
          <button className="action-item danger" onClick={() => setConfirm('delete')}>
            <Trash2 size={18} />
            <span className="grow">{contact.group ? (contact.group.left ? 'Удалить группу' : 'Выйти и удалить группу') : 'Удалить чат'}</span>
          </button>
        </div>
      </div>

      {confirm === 'clear' && (
        <ConfirmDialog
          title="Очистить историю?"
          text="Все сообщения и файлы этого чата будут удалены с этого устройства."
          confirm="Очистить"
          danger
          onClose={() => setConfirm(null)}
          onConfirm={() => messenger.clearChat(contact.id)}
        />
      )}
      {confirm === 'delete' && (
        <ConfirmDialog
          title={contact.group ? 'Удалить группу?' : 'Удалить чат?'}
          text={
            contact.group
              ? `Переписка группы «${contact.displayName}» будет удалена с этого устройства${contact.group.left ? '' : ', а вы выйдете из группы'}.`
              : `Переписка с ${contact.displayName} и ключи сеанса будут удалены с этого устройства.`
          }
          confirm="Удалить"
          danger
          onClose={() => setConfirm(null)}
          onConfirm={async () => {
            await messenger.deleteChat(contact.id);
            onDeleted();
          }}
        />
      )}
      {confirm === 'block' && (
        <ConfirmDialog
          title="Заблокировать?"
          text={`${contact.displayName} не сможет присылать вам сообщения. Об этом он не узнает.`}
          confirm="Заблокировать"
          danger
          onClose={() => setConfirm(null)}
          onConfirm={() => messenger.setBlocked(contact.id, true)}
        />
      )}
      {confirm === 'reset' && (
        <ConfirmDialog
          title="Сбросить сеанс?"
          text="Следующее сообщение начнёт новый сеанс шифрования с новыми ключами. Помогает, если сообщения перестали расшифровываться."
          confirm="Сбросить"
          onClose={() => setConfirm(null)}
          onConfirm={() => messenger.resetSession(contact.id)}
        />
      )}
    </aside>
  );
}

const PRESENCE_ROWS: [PresenceKind, string][] = [
  ['online', '«В сети» и время захода'],
  ['read', 'Отчёты о прочтении'],
  ['typing', '«Печатает»'],
];

/** What this one contact sees of me; «как в настройках» follows the global switches. */
function ContactPrivacy({ messenger, snapshot, contact }: { messenger: Messenger; snapshot: MessengerSnapshot; contact: Contact }) {
  return (
    <div className="section" data-testid="contact-privacy">
      <div className="section-title">
        <EyeOff size={16} /> Что видит {contact.displayName}
      </div>
      {PRESENCE_ROWS.map(([kind, label]) => {
        const own = contact.privacy?.[kind];
        const value = own === undefined ? 'default' : own ? 'show' : 'hide';
        const effective = sharesWith(snapshot.settings, contact, kind);
        return (
          <label className="privacy-row" key={kind}>
            <span className="grow">
              {label}
              <small>{effective ? 'видит' : 'скрыто — и вы не видите это у него'}</small>
            </span>
            <select
              className="input"
              aria-label={label}
              value={value}
              onChange={(e) => messenger.setContactPrivacy(contact.id, { [kind]: e.target.value === 'default' ? undefined : e.target.value === 'show' })}
            >
              <option value="default">Как в настройках</option>
              <option value="show">Показывать</option>
              <option value="hide">Скрывать</option>
            </select>
          </label>
        );
      })}
    </div>
  );
}

/** «Избранное» has no keys, presence or calls: only pin, archive and clear. */
function SavedInfo({ messenger, contact, overlay, onClose }: { messenger: Messenger; contact: Contact; overlay: boolean; onClose(): void }) {
  const [confirm, setConfirm] = useState(false);
  const count = (messenger.getSnapshot().conversations[contact.id] ?? []).filter((m) => m.dir !== 'system').length;
  return (
    <aside className={`info-panel${overlay ? ' overlay' : ''}`} aria-label="Информация об «Избранном»">
      <div className="panel-head">
        <h3>Информация</h3>
        <button className="icon-btn sm" onClick={onClose} aria-label="Закрыть панель">
          <X size={18} />
        </button>
      </div>
      <div className="panel-body">
        <div className="profile-hero">
          <Avatar name={contact.displayName} seed={contact.id} size={96} />
          <h4>{contact.displayName}</h4>
          <span className="handle">
            {count} {count % 10 === 1 && count % 100 !== 11 ? 'запись' : count % 10 >= 2 && count % 10 <= 4 && (count % 100 < 10 || count % 100 >= 20) ? 'записи' : 'записей'}
          </span>
        </div>
        <div className="section">
          <div className="section-title">
            <ShieldCheck size={16} /> Только на этом устройстве
          </div>
          <p>
            Заметки и файлы из «Избранного» никуда не отправляются: они хранятся в зашифрованном хранилище Veil на этом компьютере. Текст попадает
            и в резервную копию для восстановления по почте, если она включена.
          </p>
        </div>
        <div className="section action-list">
          <button className="action-item" onClick={() => messenger.setPinned(contact.id, !contact.pinned)}>
            {contact.pinned ? <PinOff size={18} /> : <Pin size={18} />}
            <span className="grow">{contact.pinned ? 'Открепить' : 'Закрепить'}</span>
          </button>
          <button className="action-item" onClick={() => messenger.setArchived(contact.id, !contact.archived)}>
            {contact.archived ? <ArchiveRestore size={18} /> : <Archive size={18} />}
            <span className="grow">{contact.archived ? 'Вернуть из архива' : 'В архив'}</span>
          </button>
          <button className="action-item danger" onClick={() => setConfirm(true)}>
            <Eraser size={18} />
            <span className="grow">Очистить «Избранное»</span>
          </button>
        </div>
      </div>
      {confirm && (
        <ConfirmDialog
          title="Очистить «Избранное»?"
          text="Все заметки и файлы в «Избранном» будут удалены с этого устройства."
          confirm="Очистить"
          danger
          onClose={() => setConfirm(false)}
          onConfirm={() => messenger.clearChat(contact.id)}
        />
      )}
    </aside>
  );
}
