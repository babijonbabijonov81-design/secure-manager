import jsQR from 'jsqr';
import { Camera, Check, Copy, KeyRound, ShieldCheck, UserPlus } from 'lucide-react';
import QRCode from 'qrcode';
import { useEffect, useRef, useState } from 'react';
import { INVITE_DAYS, parseInvite } from '../../../core/invite.ts';
import { bridge } from '../../../core/platform.ts';
import type { Messenger } from '../../../core/messenger.ts';
import { Modal, useToast } from '../lib/ui.tsx';

/** «Пригласить лично»: a new link with my key and its QR code (body of «Новый чат»). */
export function InvitePanel({ messenger }: { messenger: Messenger }) {
  const [link] = useState(() => messenger.createInvite());
  const [qr, setQr] = useState('');
  const [copied, setCopied] = useState(false);
  const toast = useToast();
  useEffect(() => {
    void QRCode.toDataURL(link, { margin: 1, width: 220, errorCorrectionLevel: 'M', color: { dark: '#1a1411', light: '#ffffff' } }).then(setQr);
  }, [link]);
  return (
    <div className="modal-body invite-panel" data-testid="invite-panel">
      <div className="qr-box">{qr ? <img src={qr} alt="QR-код приглашения" width={220} height={220} /> : <span className="spinner" />}</div>
      <code className="invite-link selectable" data-testid="invite-link">
        {link}
      </code>
      <button
        type="button"
        className="btn btn-primary btn-block"
        onClick={() => {
          void navigator.clipboard.writeText(link);
          setCopied(true);
          toast('Ссылка-приглашение скопирована', 'success');
        }}
      >
        {copied ? <Check size={16} /> : <Copy size={16} />} Копировать ссылку
      </button>
      <ul className="invite-facts">
        <li>
          <KeyRound size={15} /> В ссылке — ваш ключ. Кто её откроет, сравнит его с ключом на сервере: подмену будет видно сразу.
        </li>
        <li>
          <ShieldCheck size={15} /> Вы оба сразу станете «сверенными» — передавайте ссылку лично или покажите QR-код.
        </li>
        <li>
          <UserPlus size={15} /> Действует {INVITE_DAYS} дней. Сверяет только первого, кто её откроет.
        </li>
      </ul>
    </div>
  );
}

/** «Сканировать QR-код»: the camera of this computer reads someone's invite. */
export function ScanPanel({ onFound }: { onFound(link: string): void }) {
  const video = useRef<HTMLVideoElement>(null);
  const [error, setError] = useState('');
  const found = useRef(onFound);
  found.current = onFound;
  useEffect(() => {
    let stream: MediaStream | null = null;
    let timer = 0;
    let stopped = false;
    const canvas = document.createElement('canvas');
    const scan = () => {
      const v = video.current;
      if (stopped || !v) return;
      if (v.videoWidth) {
        const scale = Math.min(1, 640 / v.videoWidth);
        canvas.width = Math.round(v.videoWidth * scale);
        canvas.height = Math.round(v.videoHeight * scale);
        const g = canvas.getContext('2d', { willReadFrequently: true })!;
        g.drawImage(v, 0, 0, canvas.width, canvas.height);
        const code = jsQR(g.getImageData(0, 0, canvas.width, canvas.height).data, canvas.width, canvas.height);
        if (code && parseInvite(code.data)) return found.current(code.data);
      }
      timer = window.setTimeout(scan, 180);
    };
    (bridge ? bridge.requestCamera() : Promise.resolve(true))
      .then((ok) => (ok ? navigator.mediaDevices.getUserMedia({ video: { width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false }) : Promise.reject(new Error('denied'))))
      .then((s) => {
        stream = s;
        if (stopped) return s.getTracks().forEach((t) => t.stop());
        if (video.current) {
          video.current.srcObject = s;
          void video.current.play();
        }
        scan();
      })
      .catch(() => setError('Камера недоступна. Попросите собеседника прислать ссылку и вставьте её в поле «Новый чат».'));
    return () => {
      stopped = true;
      clearTimeout(timer);
      stream?.getTracks().forEach((t) => t.stop());
    };
  }, []);
  return (
    <div className="modal-body">
      {error ? (
        <span className="field-error">{error}</span>
      ) : (
        <div className="scan-frame">
          <video ref={video} muted playsInline aria-label="Изображение с камеры" />
          <span className="scan-corners" aria-hidden="true" />
        </div>
      )}
      <span className="field-hint">
        <Camera size={14} /> Наведите камеру на QR-код приглашения на экране собеседника. Кадры никуда не отправляются.
      </span>
    </div>
  );
}

/** A veil:// link the system opened Veil with (or one found by the scanner). */
export function OpenInviteDialog({ messenger, link, onClose, onOpen }: { messenger: Messenger; link: string; onClose(): void; onOpen(id: string): void }) {
  const invite = parseInvite(link);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(invite ? '' : 'Это не приглашение Veil или ссылка повреждена');
  const toast = useToast();
  const accept = async () => {
    setBusy(true);
    setError('');
    try {
      const contact = await messenger.acceptInvite(link);
      toast('Ключ совпал — контакт проверен', 'success');
      onOpen(contact.id);
      onClose();
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };
  return (
    <Modal title="Приглашение в Veil" onClose={onClose} width={420}>
      <div className="modal-body" data-testid="open-invite">
        {invite && (
          <div className="option-card" style={{ cursor: 'default' }}>
            <UserPlus size={20} />
            <div className="grow">
              <b>@{invite.username}</b>
              <span>приглашает вас в Veil</span>
            </div>
          </div>
        )}
        <span className="field-hint">Veil сравнит ключ из ссылки с ключом на сервере. Если совпадёт — контакт сразу будет проверен.</span>
        {error && <span className="field-error">{error}</span>}
        {invite && (
          <button className="btn btn-primary btn-block" onClick={() => void accept()} disabled={busy} autoFocus>
            {busy ? <span className="spinner" /> : <ShieldCheck size={16} />} Добавить и открыть чат
          </button>
        )}
      </div>
    </Modal>
  );
}
