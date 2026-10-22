import { Check, Crown, LogOut, MessageCircle, Pencil, Search, ShieldCheck, ShieldQuestion, Star, UserMinus, UserPlus, Users } from 'lucide-react';
import { useMemo, useState, type FormEvent } from 'react';
import { MAX_GROUP_MEMBERS, ROLE_LABEL, type GroupMember } from '../../../core/groups.ts';
import type { Messenger } from '../../../core/messenger.ts';
import { isSavedChat, type Contact, type MessengerSnapshot } from '../../../core/types.ts';
import { plural } from '../lib/format.ts';
import { groupVerification } from '../lib/shield.ts';
import { Avatar, ConfirmDialog, ContextMenu, Modal, useToast, type MenuItem } from '../lib/ui.tsx';

/** People who can be put into a group: my contacts, not groups, not blocked. */
export function pickableContacts(snapshot: MessengerSnapshot, exclude: string[] = []): Contact[] {
  return snapshot.contacts
    .filter((c) => !c.group && !isSavedChat(c.id) && !c.blocked && c.username && !exclude.includes(c.id))
    .sort((a, b) => Number(!!a.groupOnly) - Number(!!b.groupOnly) || a.displayName.localeCompare(b.displayName, 'ru'));
}

/** A checklist of contacts with a search field (creating a group, adding members). */
export function ContactPicker({ contacts, chosen, onChange, max }: { contacts: Contact[]; chosen: string[]; onChange(ids: string[]): void; max: number }) {
  const [query, setQuery] = useState('');
  const q = query.trim().toLowerCase();
  const shown = q ? contacts.filter((c) => c.displayName.toLowerCase().includes(q) || c.username.includes(q)) : contacts;
  return (
    <div className="contact-picker">
      <div className="input-wrap search">
        <Search size={16} />
        <input className="input" placeholder="Поиск по контактам" aria-label="Поиск по контактам" value={query} onChange={(e) => setQuery(e.target.value)} />
      </div>
      <div className="picker-list" role="group" aria-label="Контакты">
        {shown.map((c) => {
          const on = chosen.includes(c.id);
          return (
            <label key={c.id} className={`picker-row${on ? ' on' : ''}`}>
              <input
                type="checkbox"
                checked={on}
                disabled={!on && chosen.length >= max}
                onChange={() => onChange(on ? chosen.filter((id) => id !== c.id) : [...chosen, c.id])}
              />
              <Avatar name={c.displayName} seed={c.id} size={34} />
              <span className="grow">
                <b>{c.displayName}</b>
                <span>@{c.username}</span>
              </span>
              {c.verified && <ShieldCheck size={15} className="ok" aria-label="Ключ сверен" />}
              <span className="picker-check" aria-hidden="true">
                {on && <Check size={14} />}
              </span>
            </label>
          );
        })}
        {!shown.length && <span className="field-hint">{contacts.length ? 'Никого не нашли' : 'Сначала начните чат хотя бы с одним человеком'}</span>}
      </div>
    </div>
  );
}

/** «Новый чат» → «Новая группа». */
export function GroupCreate({ messenger, snapshot, onDone }: { messenger: Messenger; snapshot: MessengerSnapshot; onDone(id: string): void }) {
  const [name, setName] = useState('');
  const [chosen, setChosen] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const contacts = useMemo(() => pickableContacts(snapshot), [snapshot]);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const group = await messenger.createGroup(name, chosen);
      onDone(group.id);
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };
  return (
    <form className="modal-body" onSubmit={(e) => void submit(e)} data-testid="group-create">
      <input className="input" placeholder="Название группы" aria-label="Название группы" maxLength={64} autoFocus value={name} onChange={(e) => setName(e.target.value)} />
      <ContactPicker contacts={contacts} chosen={chosen} onChange={setChosen} max={MAX_GROUP_MEMBERS - 1} />
      <span className="field-hint">Сообщения шифруются на вашем устройстве для каждого участника. Сервер не знает ни названия, ни состава группы.</span>
      {error && <span className="field-error">{error}</span>}
      <button className="btn btn-primary btn-block" disabled={busy || !name.trim() || !chosen.length}>
        {busy ? <span className="spinner" /> : <Users size={16} />} Создать группу
        {chosen.length ? ` · ${chosen.length + 1} ${plural(chosen.length + 1, ['участник', 'участника', 'участников'])}` : ''}
      </button>
    </form>
  );
}

/** The group in «Щит чата»: members with roles and verification, and what I may change. */
export function GroupDetails({
  messenger,
  snapshot,
  contact,
  onOpenChat,
}: {
  messenger: Messenger;
  snapshot: MessengerSnapshot;
  contact: Contact;
  onOpenChat?(id: string): void;
}) {
  const group = contact.group!;
  const me = snapshot.me.userId;
  const myRole = group.members.find((m) => m.id === me)?.role;
  const canManage = !group.left && (myRole === 'owner' || myRole === 'admin');
  const { verified, total } = groupVerification(contact, snapshot);
  const toast = useToast();
  const [menu, setMenu] = useState<{ x: number; y: number; member: GroupMember } | null>(null);
  const [adding, setAdding] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [confirm, setConfirm] = useState<{ title: string; text: string; button: string; action(): Promise<void> } | null>(null);
  const run = (action: Promise<void>) => void action.catch((e: Error) => toast(e.message, 'error'));
  const known = (id: string) => snapshot.contacts.find((c) => c.id === id);
  const nameOf = (m: GroupMember) => (m.id === me ? 'Вы' : (known(m.id)?.displayName ?? m.name));
  const order = { owner: 0, admin: 1, member: 2 } as const;
  const members = [...group.members].sort((a, b) => order[a.role] - order[b.role] || nameOf(a).localeCompare(nameOf(b), 'ru'));

  const itemsFor = (m: GroupMember): MenuItem[] => {
    const items: MenuItem[] = [];
    if (m.id !== me && onOpenChat)
      items.push({
        label: known(m.id)?.verified ? 'Написать лично' : 'Написать и сверить код',
        icon: <MessageCircle size={16} />,
        onClick: () => run(messenger.addContact(m.username).then((c) => onOpenChat(c.id))),
      });
    if (!group.left && myRole === 'owner' && m.id !== me) {
      if (m.role === 'member') items.push({ label: 'Сделать админом', icon: <Star size={16} />, onClick: () => run(messenger.setGroupRole(contact.id, m.id, 'admin')) });
      if (m.role === 'admin') items.push({ label: 'Снять админа', icon: <Star size={16} />, onClick: () => run(messenger.setGroupRole(contact.id, m.id, 'member')) });
      items.push({
        label: 'Передать владение',
        icon: <Crown size={16} />,
        onClick: () =>
          setConfirm({
            title: 'Передать владение группой?',
            text: `${nameOf(m)} станет владельцем, а вы — админом. Вернуть владение сможет только новый владелец.`,
            button: 'Передать',
            action: () => messenger.setGroupRole(contact.id, m.id, 'owner'),
          }),
      });
    }
    if (canManage && m.id !== me && (myRole === 'owner' || m.role === 'member'))
      items.push({
        label: 'Удалить из группы',
        icon: <UserMinus size={16} />,
        danger: true,
        onClick: () =>
          setConfirm({
            title: `Удалить ${nameOf(m)} из группы?`,
            text: 'Все участники сменят ключи шифрования: новые сообщения этот человек не прочитает.',
            button: 'Удалить',
            action: () => messenger.removeGroupMember(contact.id, m.id),
          }),
      });
    return items;
  };

  return (
    <>
      <div className="profile-hero">
        <div className="group-avatar">
          <Avatar name={contact.displayName} seed={contact.id} size={96} />
          <span className="group-badge" aria-hidden="true">
            <Users size={16} />
          </span>
        </div>
        <h4>
          {contact.displayName}
          {canManage && (
            <button className="icon-btn sm" onClick={() => setRenaming(true)} aria-label="Переименовать группу" title="Переименовать">
              <Pencil size={15} />
            </button>
          )}
        </h4>
        <span className="handle">
          {group.left ? 'вы больше не в группе' : `${group.members.length} ${plural(group.members.length, ['участник', 'участника', 'участников'])}`}
        </span>
        {total > 0 && (
          <div style={{ marginTop: 8 }}>
            <span className={`chip${verified === total ? ' success' : ''}`}>
              {verified === total ? <ShieldCheck size={13} /> : <ShieldQuestion size={13} />} Ключи сверены у {verified} из {total}
            </span>
          </div>
        )}
      </div>

      <div className="section" id="shield-members" data-testid="group-members">
        <div className="section-title">
          <Users size={16} /> Участники
        </div>
        <ul className="member-list">
          {members.map((m) => {
            const items = itemsFor(m);
            const k = known(m.id);
            return (
              <li key={m.id}>
                <button
                  className="member-row"
                  disabled={!items.length}
                  onClick={(e) => setMenu({ x: e.clientX, y: e.clientY, member: m })}
                  aria-label={`${nameOf(m)}, ${ROLE_LABEL[m.role].toLowerCase()}${k?.verified ? ', ключ сверен' : ''}`}
                >
                  <Avatar name={m.id === me ? snapshot.me.displayName : nameOf(m)} seed={m.id} size={36} />
                  <span className="grow">
                    <b>{nameOf(m)}</b>
                    <span>@{m.username}</span>
                  </span>
                  {m.role !== 'member' && <span className={`role-chip ${m.role}`}>{ROLE_LABEL[m.role]}</span>}
                  {m.id !== me &&
                    (k?.verified && !k.keyWarning ? (
                      <ShieldCheck size={16} className="ok" aria-hidden="true" />
                    ) : (
                      <ShieldQuestion size={16} className="muted" aria-hidden="true" />
                    ))}
                </button>
              </li>
            );
          })}
        </ul>
        {canManage && group.members.length < MAX_GROUP_MEMBERS && (
          <button className="btn btn-sm btn-secondary" onClick={() => setAdding(true)}>
            <UserPlus size={15} /> Добавить участников
          </button>
        )}
        <p>
          Чтобы ключ участника стал сверенным, откройте с ним личный чат и сверьте код безопасности. Удалённый или вышедший участник не прочитает новые
          сообщения: все сменят ключи.
        </p>
      </div>

      {!group.left && (
        <div className="section action-list">
          <button
            className="action-item danger"
            onClick={() =>
              setConfirm({
                title: 'Выйти из группы?',
                text: 'Вы перестанете получать сообщения. Переписка останется на этом устройстве.',
                button: 'Выйти',
                action: () => messenger.leaveGroup(contact.id),
              })
            }
          >
            <LogOut size={18} />
            <span className="grow">Выйти из группы</span>
          </button>
        </div>
      )}

      {menu && <ContextMenu x={menu.x} y={menu.y} items={itemsFor(menu.member)} onClose={() => setMenu(null)} />}
      {adding && (
        <AddMembers
          messenger={messenger}
          snapshot={snapshot}
          contact={contact}
          onClose={() => setAdding(false)}
        />
      )}
      {renaming && <RenameGroup messenger={messenger} contact={contact} onClose={() => setRenaming(false)} />}
      {confirm && (
        <ConfirmDialog
          title={confirm.title}
          text={confirm.text}
          confirm={confirm.button}
          danger
          onClose={() => setConfirm(null)}
          onConfirm={() => confirm.action().catch((e: Error) => toast(e.message, 'error'))}
        />
      )}
    </>
  );
}

function AddMembers({ messenger, snapshot, contact, onClose }: { messenger: Messenger; snapshot: MessengerSnapshot; contact: Contact; onClose(): void }) {
  const group = contact.group!;
  const [chosen, setChosen] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const contacts = pickableContacts(snapshot, group.members.map((m) => m.id));
  const add = async () => {
    setBusy(true);
    try {
      await messenger.addGroupMembers(contact.id, chosen);
      onClose();
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };
  return (
    <Modal title="Добавить участников" onClose={onClose} width={440}>
      <div className="modal-body">
        <ContactPicker contacts={contacts} chosen={chosen} onChange={setChosen} max={MAX_GROUP_MEMBERS - group.members.length} />
        <span className="field-hint">Новые участники увидят сообщения, отправленные после того, как их добавили.</span>
        {error && <span className="field-error">{error}</span>}
        <button className="btn btn-primary btn-block" disabled={busy || !chosen.length} onClick={() => void add()}>
          {busy ? <span className="spinner" /> : <UserPlus size={16} />} Добавить
        </button>
      </div>
    </Modal>
  );
}

function RenameGroup({ messenger, contact, onClose }: { messenger: Messenger; contact: Contact; onClose(): void }) {
  const [name, setName] = useState(contact.displayName);
  const [error, setError] = useState('');
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    try {
      await messenger.renameGroup(contact.id, name);
      onClose();
    } catch (err) {
      setError((err as Error).message);
    }
  };
  return (
    <Modal title="Название группы" onClose={onClose} width={400}>
      <form className="modal-body" onSubmit={(e) => void submit(e)}>
        <input className="input" aria-label="Название группы" maxLength={64} autoFocus value={name} onChange={(e) => setName(e.target.value)} />
        {error && <span className="field-error">{error}</span>}
        <button className="btn btn-primary btn-block" disabled={!name.trim() || name.trim() === contact.displayName}>
          Сохранить
        </button>
      </form>
    </Modal>
  );
}
