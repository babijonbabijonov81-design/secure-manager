import { AlertCircle, Bookmark, CheckCircle2, Info, X } from 'lucide-react';
import { createContext, useCallback, useContext, useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { SAVED_ID } from '../../../core/types.ts';
import { avatarGradient, initials } from './format.ts';

const SHIELD = 'M32 9.5 49.5 15.6V30.2c0 11.1-7.3 19.9-17.5 24.8C21.8 50.1 14.5 41.3 14.5 30.2V15.6Z';

/** App mark: white tile with a four-colour shield and a check mark (same artwork as the app icon). */
export function Logo({ size = 44 }: { size?: number }) {
  const id = useId().replace(/:/g, '');
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" aria-hidden="true" className="logo">
      <defs>
        <linearGradient id={`${id}-tile`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#ffffff" />
          <stop offset="1" stopColor="#eef1f6" />
        </linearGradient>
        <linearGradient id={`${id}-gloss`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#fff" stopOpacity="0.22" />
          <stop offset="0.5" stopColor="#fff" stopOpacity="0" />
        </linearGradient>
        <clipPath id={`${id}-clip`}>
          <path d={SHIELD} />
        </clipPath>
      </defs>
      <rect x="0.5" y="0.5" width="63" height="63" rx="14.5" fill={`url(#${id}-tile)`} stroke="#d9dee8" />
      <g clipPath={`url(#${id}-clip)`}>
        <rect width="32" height="32" fill="#4285F4" />
        <rect x="32" width="32" height="32" fill="#EA4335" />
        <rect y="32" width="32" height="32" fill="#34A853" />
        <rect x="32" y="32" width="32" height="32" fill="#FBBC05" />
        <path d="M32 0V64M0 32H64" stroke="#fff" strokeWidth="1.6" />
        <path d={SHIELD} fill={`url(#${id}-gloss)`} />
      </g>
      <path d="M24.2 31.6 29.6 37 40.2 26.4" fill="none" stroke="#fff" strokeWidth="4.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function Avatar({ name, seed, size = 44 }: { name: string; seed: string; size?: number }) {
  if (seed === SAVED_ID)
    return (
      <div className="avatar saved" style={{ width: size, height: size }}>
        <Bookmark size={Math.round(size * 0.44)} fill="currentColor" strokeWidth={1.5} />
      </div>
    );
  return (
    <div
      className="avatar"
      style={{ width: size, height: size, background: avatarGradient(seed), fontSize: Math.round(size * 0.38) }}
    >
      {initials(name)}
    </div>
  );
}

export function Toggle({ on, onChange, label }: { on: boolean; onChange(value: boolean): void; label?: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      className={`toggle${on ? ' on' : ''}`}
      onClick={() => onChange(!on)}
    />
  );
}

export function Modal({
  title,
  onClose,
  children,
  className = '',
  width,
}: {
  title?: ReactNode;
  onClose(): void;
  children: ReactNode;
  className?: string;
  width?: number;
}) {
  useEscape(onClose);
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`modal ${className}`} style={width ? { maxWidth: width } : undefined} role="dialog" aria-modal="true">
        {title !== undefined && (
          <div className="modal-head">
            <h3>{title}</h3>
            <button className="icon-btn sm" onClick={onClose} aria-label="Закрыть">
              <X size={18} />
            </button>
          </div>
        )}
        {children}
      </div>
    </div>
  );
}

export function useEscape(handler: () => void) {
  const ref = useRef(handler);
  ref.current = handler;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && ref.current();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
}

// ---- confirm dialog ----

export function ConfirmDialog({
  title,
  text,
  confirm,
  danger,
  onConfirm,
  onClose,
}: {
  title: string;
  text: ReactNode;
  confirm: string;
  danger?: boolean;
  onConfirm(): void | Promise<void>;
  onClose(): void;
}) {
  const [busy, setBusy] = useState(false);
  return (
    <Modal title={title} onClose={onClose} width={420}>
      <div className="modal-body">
        <p>{text}</p>
        <div className="form-actions">
          <button className="btn btn-secondary" onClick={onClose}>
            Отмена
          </button>
          <button
            className={`btn ${danger ? 'btn-danger' : 'btn-primary'}`}
            style={{ flex: 1 }}
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              try {
                await onConfirm();
                onClose();
              } finally {
                setBusy(false);
              }
            }}
          >
            {busy ? <span className="spinner" /> : confirm}
          </button>
        </div>
      </div>
    </Modal>
  );
}

// ---- toasts ----

type ToastKind = 'info' | 'error' | 'success';
interface ToastItem {
  id: number;
  kind: ToastKind;
  text: string;
}

const ToastContext = createContext<(text: string, kind?: ToastKind) => void>(() => {});
export const useToast = () => useContext(ToastContext);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const counter = useRef(0);
  const push = useCallback((text: string, kind: ToastKind = 'info') => {
    const id = ++counter.current;
    setItems((list) => [...list.slice(-2), { id, kind, text }]);
    setTimeout(() => setItems((list) => list.filter((t) => t.id !== id)), kind === 'error' ? 5000 : 3200);
  }, []);
  return (
    <ToastContext.Provider value={push}>
      {children}
      <div className="toasts" aria-live="polite">
        {items.map((t) => (
          <div key={t.id} className={`toast ${t.kind}`}>
            {t.kind === 'error' ? <AlertCircle size={18} /> : t.kind === 'success' ? <CheckCircle2 size={18} /> : <Info size={18} />}
            {t.text}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

// ---- context menu ----

export interface MenuItem {
  label: string;
  icon: ReactNode;
  danger?: boolean;
  onClick(): void;
}

export function ContextMenu({ x, y, items, header, onClose }: { x: number; y: number; items: MenuItem[]; header?: ReactNode; onClose(): void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x, y });
  useEscape(onClose);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const { width, height } = el.getBoundingClientRect();
    setPos({ x: Math.min(x, window.innerWidth - width - 8), y: Math.min(y, window.innerHeight - height - 8) });
  }, [x, y]);
  useEffect(() => {
    const close = () => onClose();
    window.addEventListener('mousedown', close);
    window.addEventListener('blur', close);
    window.addEventListener('resize', close);
    return () => {
      window.removeEventListener('mousedown', close);
      window.removeEventListener('blur', close);
      window.removeEventListener('resize', close);
    };
  }, [onClose]);
  return (
    <div ref={ref} className="context-menu" style={{ left: pos.x, top: pos.y }} onMouseDown={(e) => e.stopPropagation()}>
      {header}
      {items.map((item) => (
        <button
          key={item.label}
          className={item.danger ? 'danger' : ''}
          onClick={() => {
            onClose();
            item.onClick();
          }}
        >
          {item.icon}
          {item.label}
        </button>
      ))}
    </div>
  );
}

export function Backdrop() {
  return (
    <div className="backdrop" aria-hidden="true">
      <div className="orb a" />
      <div className="orb b" />
      <div className="orb c" />
      <div className="grid" />
    </div>
  );
}
