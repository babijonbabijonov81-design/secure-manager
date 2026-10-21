import { EyeOff, KeyRound } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import type { Messenger } from '../../../core/messenger.ts';
import type { MessengerSnapshot } from '../../../core/types.ts';
import { ConfirmDialog, Modal, useToast } from '../lib/ui.tsx';

const MAX_TRIES = 5;

/** The secret phrase matched in the search: now the PIN of hidden chats. */
export function HiddenPinDialog({ messenger, onClose, onOpen }: { messenger: Messenger; onClose(): void; onOpen(): void }) {
  const [pin, setPin] = useState('');
  const [tries, setTries] = useState(0);
  const [error, setError] = useState('');
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (await messenger.checkHiddenPin(pin)) return onOpen();
    const used = tries + 1;
    setTries(used);
    setPin('');
    if (used >= MAX_TRIES) return onClose();
    setError(`Неверный PIN. Осталось попыток: ${MAX_TRIES - used}`);
  };
  return (
    <Modal title="Скрытые чаты" onClose={onClose} width={380}>
      <form className="modal-body" onSubmit={(e) => void submit(e)}>
        <input
          className="input pin-input"
          type="password"
          inputMode="numeric"
          autoComplete="off"
          maxLength={8}
          placeholder="PIN скрытых чатов"
          aria-label="PIN скрытых чатов"
          autoFocus
          value={pin}
          onChange={(e) => setPin(e.target.value.replace(/\D/g, ''))}
        />
        {error && <span className="field-error">{error}</span>}
        <button className="btn btn-primary btn-block" disabled={pin.length < 4}>
          Открыть
        </button>
      </form>
    </Modal>
  );
}

/** Settings → Конфиденциальность: the secret phrase and PIN of hidden chats. */
export function HiddenChatsSettings({ messenger, snapshot }: { messenger: Messenger; snapshot: MessengerSnapshot }) {
  const [dialog, setDialog] = useState(false);
  const [confirmOff, setConfirmOff] = useState(false);
  const configured = snapshot.security.hiddenChats;
  const count = snapshot.contacts.filter((c) => c.hidden).length;
  return (
    <div className="section" data-testid="hidden-chats">
      <div className="section-title">
        <EyeOff size={16} /> Скрытые чаты
      </div>
      <p>
        Скрытого чата нет в списке. Чтобы открыть скрытые чаты, введите секретную фразу в поиске, нажмите Enter и введите PIN. В уведомлениях о них —
        только «Новое сообщение». Скрыть чат можно в его Щите.
      </p>
      <p className="field-hint" style={{ margin: 0 }}>
        Это защита от чужого взгляда, а не от того, кто знает пароль Veil: скрытые чаты лежат в том же зашифрованном хранилище.
      </p>
      {configured ? (
        <div className="form-actions" style={{ marginTop: 0 }}>
          <button className="btn btn-secondary btn-sm" onClick={() => setDialog(true)}>
            Сменить фразу и PIN
          </button>
          <button className="btn btn-ghost btn-sm" onClick={() => setConfirmOff(true)}>
            Выключить{count ? ` и вернуть ${count}` : ''}
          </button>
        </div>
      ) : (
        <button className="btn btn-primary btn-sm" onClick={() => setDialog(true)}>
          Настроить скрытые чаты
        </button>
      )}
      {dialog && <HiddenSetupDialog messenger={messenger} onClose={() => setDialog(false)} />}
      {confirmOff && (
        <ConfirmDialog
          title="Выключить скрытые чаты?"
          text="Все скрытые чаты вернутся в общий список."
          confirm="Выключить"
          onClose={() => setConfirmOff(false)}
          onConfirm={() => messenger.disableHiddenChats()}
        />
      )}
    </div>
  );
}

function HiddenSetupDialog({ messenger, onClose }: { messenger: Messenger; onClose(): void }) {
  const [phrase, setPhrase] = useState('');
  const [pin, setPin] = useState('');
  const [repeat, setRepeat] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    if (pin !== repeat) return setError('PIN не совпадает');
    setBusy(true);
    try {
      await messenger.setupHiddenChats(phrase, pin);
      toast('Скрытые чаты настроены', 'success');
      onClose();
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };
  return (
    <Modal title="Скрытые чаты" onClose={onClose} width={420}>
      <form className="modal-body" onSubmit={(e) => void submit(e)}>
        <span className="field-hint">Фраза — то, что вы введёте в поиске. Не используйте имена контактов: поиск по ним покажет обычные чаты.</span>
        <input className="input" placeholder="Секретная фраза" aria-label="Секретная фраза" autoFocus value={phrase} onChange={(e) => setPhrase(e.target.value)} />
        <input
          className="input pin-input"
          type="password"
          inputMode="numeric"
          maxLength={8}
          placeholder="PIN, 4–8 цифр"
          aria-label="PIN скрытых чатов"
          value={pin}
          onChange={(e) => setPin(e.target.value.replace(/\D/g, ''))}
        />
        <input
          className="input pin-input"
          type="password"
          inputMode="numeric"
          maxLength={8}
          placeholder="Повторите PIN"
          aria-label="Повторите PIN скрытых чатов"
          value={repeat}
          onChange={(e) => setRepeat(e.target.value.replace(/\D/g, ''))}
        />
        {error && <span className="field-error">{error}</span>}
        <button className="btn btn-primary btn-block" disabled={busy || !phrase || !pin}>
          {busy ? <span className="spinner" /> : <KeyRound size={16} />} Сохранить
        </button>
      </form>
    </Modal>
  );
}
