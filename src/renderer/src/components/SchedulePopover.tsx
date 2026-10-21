import { CalendarClock, Clock, Hourglass, Sun } from 'lucide-react';
import { useLayoutEffect, useRef, useState } from 'react';
import { useEscape } from '../lib/ui.tsx';

export type ScheduleChoice = { at: number } | { capsule: number };

const pad = (n: number) => String(n).padStart(2, '0');
const localInput = (ts: number) => {
  const d = new Date(ts);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

function tomorrowAt9(): number {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  d.setHours(9, 0, 0, 0);
  return d.getTime();
}

function nextNewYear(): number {
  const d = new Date();
  return new Date(d.getFullYear() + 1, 0, 1, 9, 0, 0, 0).getTime();
}

/** «Отправить позже» and «Капсула времени» next to the send button. */
export function SchedulePopover({ onPick, onClose }: { onPick(choice: ScheduleChoice): void; onClose(): void }) {
  const [custom, setCustom] = useState(() => localInput(Date.now() + 3 * 3600_000));
  const [capsule, setCapsule] = useState(() => localInput(nextNewYear()));
  const [error, setError] = useState('');
  const ref = useRef<HTMLDivElement>(null);
  useEscape(onClose);
  useLayoutEffect(() => ref.current?.querySelector<HTMLButtonElement>('button')?.focus(), []);

  const pickAt = (value: string, kind: 'at' | 'capsule') => {
    const ts = new Date(value).getTime();
    if (!Number.isFinite(ts) || ts < Date.now() + 60_000) return setError('Выберите время в будущем');
    onPick(kind === 'at' ? { at: ts } : { capsule: ts });
  };

  return (
    <>
      <div className="popover-scrim" onMouseDown={onClose} />
      <div className="schedule-pop" role="dialog" aria-label="Отправить позже" ref={ref}>
        <div className="schedule-title">
          <Clock size={15} /> Отправить позже
        </div>
        <button className="schedule-option" onClick={() => onPick({ at: Date.now() + 3600_000 })}>
          <Clock size={17} /> Через час
        </button>
        <button className="schedule-option" onClick={() => onPick({ at: tomorrowAt9() })}>
          <Sun size={17} /> Завтра в 9:00
        </button>
        <div className="schedule-custom">
          <input type="datetime-local" className="input" aria-label="Дата и время отправки" value={custom} onChange={(e) => setCustom(e.target.value)} />
          <button className="btn btn-sm btn-secondary" onClick={() => pickAt(custom, 'at')}>
            <CalendarClock size={15} /> Выбрать дату
          </button>
        </div>
        <div className="schedule-title capsule">
          <Hourglass size={15} /> Капсула времени
        </div>
        <span className="schedule-hint">Доставится сразу, а откроется только в выбранный день. До этого собеседник увидит карточку с датой.</span>
        <div className="schedule-custom">
          <input type="datetime-local" className="input" aria-label="Когда открыть капсулу" value={capsule} onChange={(e) => setCapsule(e.target.value)} />
          <button className="btn btn-sm btn-secondary" onClick={() => pickAt(capsule, 'capsule')}>
            <Hourglass size={15} /> Отправить капсулу
          </button>
        </div>
        {error && <span className="field-error">{error}</span>}
      </div>
    </>
  );
}
