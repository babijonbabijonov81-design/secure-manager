import { ArchiveRestore, ArrowLeft, FileArchive, HardDriveDownload, Upload } from 'lucide-react';
import { useRef, useState, type FormEvent } from 'react';
import { readBackupHeader, type BackupHeader } from '../../../core/backup-file.ts';
import { restoreBackupFile, type Messenger, type MessengerEvents } from '../../../core/messenger.ts';
import { bridge } from '../../../core/platform.ts';
import type { StorageBackend } from '../../../core/storage.ts';
import type { MessengerSnapshot } from '../../../core/types.ts';
import { formatDay, formatTime } from '../lib/format.ts';
import { Modal, useToast } from '../lib/ui.tsx';

async function saveFile(name: string, data: Uint8Array): Promise<boolean> {
  if (bridge) return bridge.saveFile(name, data);
  const url = URL.createObjectURL(new Blob([data as BlobPart], { type: 'application/octet-stream' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
  return true;
}

/** Settings → Безопасность: save the account into one encrypted .veil file. */
export function BackupFileSection({ messenger, snapshot }: { messenger: Messenger; snapshot: MessengerSnapshot }) {
  const [dialog, setDialog] = useState(false);
  const at = snapshot.settings.backupFileAt;
  return (
    <div className="section" data-testid="backup-file">
      <div className="section-title">
        <FileArchive size={16} /> Резервная копия .veil
      </div>
      <p>
        Весь аккаунт — ключи, чаты, «Избранное», файлы — в одном файле, зашифрованном отдельным паролем копии. Восстанавливается на любом ПК, с Windows
        на Linux и обратно. Храните файл и пароль отдельно.
      </p>
      <span className="field-hint">{at ? `Последняя копия: ${formatDay(at).toLowerCase()} в ${formatTime(at)}` : 'Копий ещё не было.'}</span>
      <button className="btn btn-primary btn-sm" onClick={() => setDialog(true)}>
        <HardDriveDownload size={15} /> Сохранить копию
      </button>
      {dialog && <ExportDialog messenger={messenger} username={snapshot.me.username} onClose={() => setDialog(false)} />}
    </div>
  );
}

export function ExportDialog({ messenger, username, onClose }: { messenger: Messenger; username: string; onClose(): void }) {
  const [password, setPassword] = useState('');
  const [repeat, setRepeat] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const toast = useToast();
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    if (password.length < 8) return setError('Пароль копии — не короче 8 символов');
    if (password !== repeat) return setError('Пароли не совпадают');
    setBusy(true);
    try {
      const data = await messenger.exportBackupFile(password);
      const date = new Date().toISOString().slice(0, 10);
      if (await saveFile(`veil-${username}-${date}.veil`, data)) {
        toast('Резервная копия сохранена', 'success');
        onClose();
      } else setBusy(false);
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };
  return (
    <Modal title="Резервная копия .veil" onClose={onClose} width={440}>
      <form className="modal-body" onSubmit={(e) => void submit(e)}>
        <span className="field-hint">Отдельный пароль копии: без него файл не открыть, а Veil его не помнит.</span>
        <input className="input" type="password" placeholder="Пароль копии" aria-label="Пароль копии" autoFocus value={password} onChange={(e) => setPassword(e.target.value)} />
        <input className="input" type="password" placeholder="Повторите пароль копии" aria-label="Повторите пароль копии" value={repeat} onChange={(e) => setRepeat(e.target.value)} />
        {error && <span className="field-error">{error}</span>}
        <button className="btn btn-primary btn-block" disabled={busy || !password}>
          {busy ? <span className="spinner" /> : <HardDriveDownload size={16} />} Зашифровать и сохранить
        </button>
      </form>
    </Modal>
  );
}

/** Onboarding → «Восстановить из файла .veil». */
export function RestoreFileFlow({
  storage,
  events,
  onBack,
  onDone,
}: {
  storage: StorageBackend;
  events: MessengerEvents;
  onBack(): void;
  onDone(messenger: Messenger): void;
}) {
  const [file, setFile] = useState<{ data: Uint8Array; name: string; header: BackupHeader } | null>(null);
  const [backupPassword, setBackupPassword] = useState('');
  const [password, setPassword] = useState('');
  const [repeat, setRepeat] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const input = useRef<HTMLInputElement>(null);

  const pick = async (picked: File | undefined) => {
    setError('');
    if (!picked) return;
    const data = new Uint8Array(await picked.arrayBuffer());
    try {
      setFile({ data, name: picked.name, header: readBackupHeader(data).header });
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    if (password.length < 8) return setError('Пароль Veil — не короче 8 символов');
    if (password !== repeat) return setError('Пароли не совпадают');
    setBusy(true);
    try {
      onDone(await restoreBackupFile({ storage, file: file!.data, backupPassword, password }, events));
    } catch (err) {
      setError((err as Error).name === 'WrongPasswordError' ? 'Неверный пароль копии или файл повреждён' : (err as Error).message);
      setBusy(false);
    }
  };

  return (
    <div className="glass-card bridge-guest">
      <div className="step-head">
        <button className="icon-btn sm back" onClick={onBack} aria-label="Назад">
          <ArrowLeft size={18} />
        </button>
        <h2>Восстановление из файла</h2>
        <p>Откройте резервную копию .veil, сохранённую в Настройки → Безопасность.</p>
      </div>
      {!file ? (
        <div className="form">
          <button className="btn btn-secondary btn-lg btn-block" onClick={() => input.current?.click()}>
            <Upload size={18} /> Выбрать файл .veil
          </button>
          <input ref={input} type="file" accept=".veil" hidden aria-label="Файл резервной копии" onChange={(e) => void pick(e.target.files?.[0])} />
          {error && <span className="field-error">{error}</span>}
        </div>
      ) : (
        <form className="form" onSubmit={(e) => void submit(e)}>
          <div className="option-card" style={{ cursor: 'default' }}>
            <ArchiveRestore size={20} />
            <div className="grow">
              <b>{file.name}</b>
              <span>
                Создана {formatDay(file.header.createdAt).toLowerCase()} в {formatTime(file.header.createdAt)} · записей: {file.header.records}
              </span>
            </div>
          </div>
          <input className="input" type="password" placeholder="Пароль копии" aria-label="Пароль копии" autoFocus value={backupPassword} onChange={(e) => setBackupPassword(e.target.value)} />
          <span className="field-hint">Новый пароль Veil для этого компьютера:</span>
          <input className="input" type="password" placeholder="Пароль Veil" aria-label="Новый пароль Veil" value={password} onChange={(e) => setPassword(e.target.value)} />
          <input className="input" type="password" placeholder="Повторите пароль" aria-label="Повторите новый пароль Veil" value={repeat} onChange={(e) => setRepeat(e.target.value)} />
          <span className="field-hint">Если Veil с этим аккаунтом ещё открыт на другом ПК, он отключится, когда этот войдёт в сеть.</span>
          {error && <span className="field-error">{error}</span>}
          <button className="btn btn-primary btn-lg btn-block" disabled={busy || !backupPassword || !password}>
            {busy ? <span className="spinner" /> : 'Восстановить'}
          </button>
        </form>
      )}
    </div>
  );
}
