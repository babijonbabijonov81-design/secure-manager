import { AlertCircle, CheckCircle2, Info, X } from 'lucide-react';
import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { avatarGradient, initials } from './format.ts';

export function Logo({ size = 44 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" aria-hidden="true">
      <defs>
        <linearGradient id="veil-logo-g" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" style={{ stopColor: 'var(--accent, #7c5cff)' }} />
          <stop offset="1" style={{ stopColor: 'var(--accent-2, #4f8cff)' }} />
        </linearGradient>
      </defs>
      <rect width="64" height="64" rx="19" fill="url(#veil-logo-g)" />
      <path
        d="M32 13.5c-10.8 0-19.5 7.6-19.5 17 0 5.3 2.8 10 7.2 13.1l-1.6 7.4 8.4-4.3c1.8.5 3.6.7 5.5.7 10.8 0 19.5-7.6 19.5-17s-8.7-16.9-19.5-16.9z"
        fill="#fff"
      />
      <circle cx="32" cy="27.6" r="4.4" fill="url(#veil-logo-g)" />
      <path d="M29.6 30.4h4.8l1.4 8.1h-7.6z" fill="url(#veil-logo-g)" />
    </svg>
  );
}

export function Avatar({ name, seed, size = 44 }: { name: string; seed: string; size?: number }) {
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

export function ContextMenu({ x, y, items, onClose }: { x: number; y: number; items: MenuItem[]; onClose(): void }) {
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
