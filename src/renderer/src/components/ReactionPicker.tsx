import { Plus } from 'lucide-react';
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import { QUICK_REACTIONS } from '../../../core/types.ts';
import { useEscape } from '../lib/ui.tsx';

const MORE_REACTIONS = ['👏', '🙏', '🎉', '😍', '🤔', '😡', '💯', '👌', '😎', '🤝', '💔', '🥰'];
const GAP = 8;
const MARGIN = 8;

interface Position {
  left: number;
  top: number;
  below: boolean;
  originX: number;
}

/**
 * Reaction bar that slides out of the message's reaction button. It lives in a portal, so the
 * message list cannot clip it, and closes only on a pick, Escape, a click elsewhere or when its
 * message scrolls out of view — never just because the mouse moved.
 */
export function ReactionPicker({
  anchor,
  current,
  onPick,
  onClose,
}: {
  anchor: HTMLElement;
  current?: string;
  onPick(emoji: string): void;
  onClose(): void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [expanded, setExpanded] = useState(false);
  const [pos, setPos] = useState<Position | null>(null);
  useEscape(onClose);

  useLayoutEffect(() => {
    const place = () => {
      const el = ref.current;
      if (!el || !anchor.isConnected) return onClose();
      const a = anchor.getBoundingClientRect();
      const bounds = anchor.closest('.messages')?.getBoundingClientRect() ?? new DOMRect(0, 0, window.innerWidth, window.innerHeight);
      if (a.bottom < bounds.top || a.top > bounds.bottom) return onClose();
      // Layout size: the opening animation scales the element, so its bounding box would be too small.
      const [width, height] = [el.offsetWidth, el.offsetHeight];
      const minTop = Math.max(MARGIN, bounds.top);
      const maxBottom = Math.min(window.innerHeight - MARGIN, bounds.bottom);
      // Like Telegram: above the bubble, aligned with its outer edge; below it if there is no room;
      // next to the button for messages taller than the visible area.
      const b = (anchor.closest('.bubble-line')?.querySelector('.bubble') ?? anchor).getBoundingClientRect();
      let top: number;
      let below: boolean;
      if (b.top - GAP - height >= minTop) [top, below] = [b.top - GAP - height, false];
      else if (b.bottom + GAP + height <= maxBottom) [top, below] = [b.bottom + GAP, true];
      else {
        below = a.top - GAP - height < minTop;
        top = below ? Math.min(a.bottom + GAP, maxBottom - height) : a.top - GAP - height;
      }
      const preferred = anchor.closest('.msg-row.out') ? b.right - width : b.left;
      const left = Math.max(MARGIN, Math.min(preferred, window.innerWidth - width - MARGIN));
      setPos({ left, top, below, originX: Math.max(0, Math.min(width, a.left + a.width / 2 - left)) });
    };
    place();
    window.addEventListener('scroll', place, true);
    window.addEventListener('resize', place);
    return () => {
      window.removeEventListener('scroll', place, true);
      window.removeEventListener('resize', place);
    };
  }, [anchor, expanded, onClose]);

  useEffect(() => {
    const close = () => onClose();
    window.addEventListener('mousedown', close);
    window.addEventListener('blur', close);
    return () => {
      window.removeEventListener('mousedown', close);
      window.removeEventListener('blur', close);
    };
  }, [onClose]);

  const emojis = expanded ? [...QUICK_REACTIONS, ...MORE_REACTIONS] : QUICK_REACTIONS;
  const style: CSSProperties = pos
    ? { left: pos.left, top: pos.top, transformOrigin: `${pos.originX}px ${pos.below ? 'top' : 'bottom'}` }
    : { left: 0, top: 0, visibility: 'hidden' };

  return createPortal(
    <div
      ref={ref}
      className={`reaction-picker${expanded ? ' expanded' : ''}${pos?.below ? ' below' : ''}`}
      role="group"
      aria-label="Реакции"
      style={style}
      onMouseDown={(e) => e.stopPropagation()}
    >
      {emojis.map((emoji, i) => (
        <button
          key={emoji}
          aria-label={`Реакция ${emoji}`}
          title={current === emoji ? 'Убрать реакцию' : undefined}
          className={current === emoji ? 'active' : ''}
          style={{ '--i': i } as CSSProperties}
          onClick={() => onPick(emoji)}
        >
          {emoji}
        </button>
      ))}
      {!expanded && (
        <button className="more" aria-label="Другие реакции" style={{ '--i': emojis.length } as CSSProperties} onClick={() => setExpanded(true)}>
          <Plus size={18} />
        </button>
      )}
    </div>,
    document.body,
  );
}
