import { Cpu, Download, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { Messenger } from '../../../core/messenger.ts';
import { bridge } from '../../../core/platform.ts';
import type { MessengerSnapshot, TranscribeModel } from '../../../core/types.ts';
import { ipcError, MODEL_INFO, stopTranscriber } from '../lib/transcribe.ts';
import { ConfirmDialog, Modal, useToast } from '../lib/ui.tsx';

type Status = Record<TranscribeModel, { installed: boolean; mb: number }>;
const MODELS = Object.keys(MODEL_INFO) as TranscribeModel[];

function useModelStatus(): [Status | null, () => void] {
  const [status, setStatus] = useState<Status | null>(null);
  const refresh = () => void bridge?.models.status().then(setStatus);
  useEffect(refresh, []);
  return [status, refresh];
}

/**
 * Consent first: what is downloaded, from where, and what never leaves the computer.
 * Then the download with progress; `onReady` gets the model to use.
 */
export function ModelDownloadDialog({ messenger, onClose, onReady }: { messenger: Messenger; onClose(): void; onReady(model: TranscribeModel): void }) {
  const [status] = useModelStatus();
  const [model, setModel] = useState<TranscribeModel>(messenger.getSnapshot().settings.transcribeModel);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [error, setError] = useState('');
  useEffect(() => bridge?.models.onProgress(setProgress), []);

  const start = async () => {
    setError('');
    setProgress({ done: 0, total: 1 });
    try {
      await bridge!.models.download(model);
      use();
    } catch (err) {
      setProgress(null);
      setError(ipcError(err));
    }
  };
  const use = () => {
    messenger.updateSettings({ transcribeModel: model });
    onReady(model);
  };
  const close = () => {
    if (progress) void bridge?.models.cancel();
    onClose();
  };

  const percent = progress ? Math.round((progress.done / Math.max(1, progress.total)) * 100) : 0;
  return (
    <Modal title="Голосовые в текст" onClose={close} width={460}>
      <div className="modal-body" data-testid="model-dialog">
        <p style={{ margin: 0 }}>
          Чтобы превращать голосовые в текст, Veil нужна модель распознавания речи Whisper. Она скачается один раз с huggingface.co и останется на
          этом компьютере.
        </p>
        <ul className="invite-facts">
          <li>
            <Cpu size={15} /> Голосовые никуда не отправляются: распознавание идёт на этом ПК, даже без интернета.
          </li>
          <li>
            <Download size={15} /> Hugging Face увидит только, что с вашего IP скачали общедоступную модель.
          </li>
        </ul>
        <div className="model-options" role="radiogroup" aria-label="Модель">
          {MODELS.map((id) => (
            <label key={id} className={`model-option${model === id ? ' active' : ''}`}>
              <input type="radio" name="model" checked={model === id} onChange={() => setModel(id)} disabled={!!progress} />
              <span className="grow">
                <b>
                  {MODEL_INFO[id].label} · ≈ {status?.[id].mb ?? '…'} МБ{status?.[id].installed ? ' · скачана' : ''}
                </b>
                <span>{MODEL_INFO[id].hint}</span>
              </span>
            </label>
          ))}
        </div>
        {progress && (
          <div className="field">
            <span className="field-hint">Скачивание модели: {percent}%</span>
            <div className="progress" role="progressbar" aria-valuenow={percent} aria-label="Скачивание модели">
              <div style={{ width: `${Math.max(3, percent)}%` }} />
            </div>
          </div>
        )}
        {error && <span className="field-error">{error}</span>}
        <div className="form-actions" style={{ marginTop: 0 }}>
          <button className="btn btn-ghost" onClick={close}>
            {progress ? 'Остановить' : 'Не сейчас'}
          </button>
          <button className="btn btn-primary" onClick={() => (status?.[model].installed ? use() : void start())} disabled={!!progress || !status}>
            {progress ? <span className="spinner" /> : <Download size={16} />}
            {status?.[model].installed ? 'Использовать' : `Скачать ≈ ${status?.[model].mb ?? '…'} МБ`}
          </button>
        </div>
      </div>
    </Modal>
  );
}

/** Settings → Аудио: which model, what is on disk, delete. */
export function TranscribeSettings({ messenger, snapshot }: { messenger: Messenger; snapshot: MessengerSnapshot }) {
  const [status, refresh] = useModelStatus();
  const [dialog, setDialog] = useState(false);
  const [remove, setRemove] = useState<TranscribeModel | null>(null);
  const toast = useToast();
  const chosen = snapshot.settings.transcribeModel;
  const installed = MODELS.filter((id) => status?.[id].installed);
  return (
    <div className="section" data-testid="transcribe-settings">
      <div className="section-title">
        <Cpu size={16} /> Голосовые в текст
      </div>
      <p>Под голосовым появится кнопка «Расшифровать». Распознавание идёт только на этом компьютере, модель скачивается с вашего согласия.</p>
      <span className="field-hint">
        Модель: {MODEL_INFO[chosen].label.toLowerCase()}
        {status ? (status[chosen].installed ? ` · скачана, ${status[chosen].mb} МБ` : ' · ещё не скачана') : ''}
      </span>
      <div className="form-actions" style={{ marginTop: 0 }}>
        <button className="btn btn-secondary btn-sm" onClick={() => setDialog(true)}>
          <Download size={15} /> {installed.length ? 'Выбрать модель' : 'Скачать модель'}
        </button>
        {installed.map((id) => (
          <button key={id} className="btn btn-ghost btn-sm" onClick={() => setRemove(id)}>
            <Trash2 size={15} /> Удалить «{MODEL_INFO[id].label.toLowerCase()}» ({status![id].mb} МБ)
          </button>
        ))}
      </div>
      {dialog && (
        <ModelDownloadDialog
          messenger={messenger}
          onClose={() => {
            setDialog(false);
            refresh();
          }}
          onReady={() => {
            setDialog(false);
            refresh();
            toast('Модель готова', 'success');
          }}
        />
      )}
      {remove && (
        <ConfirmDialog
          title="Удалить модель?"
          text="Уже расшифрованные голосовые останутся. Чтобы расшифровать новые, модель придётся скачать заново."
          confirm="Удалить"
          danger
          onClose={() => setRemove(null)}
          onConfirm={async () => {
            stopTranscriber();
            await bridge?.models.remove(remove);
            refresh();
          }}
        />
      )}
    </div>
  );
}
