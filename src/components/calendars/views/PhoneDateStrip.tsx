import { addDays, getStartOfWeek, isSameDay } from '../../../utils/calendarViewUtils';

/** Phone calendar: the seven days of the current week as tappable chips above the day view. */
export function PhoneDateStrip({ date, onSelect }: { date: Date; onSelect: (d: Date) => void }) {
  const start = getStartOfWeek(date);
  const today = new Date();
  const days = Array.from({ length: 7 }, (_, i) => addDays(start, i));
  const dow = new Intl.DateTimeFormat(undefined, { weekday: 'short' });
  return (
    <div className="flex border-b border-hud-bg-card px-1 py-1.5 gap-1" role="tablist" aria-label="Day of week">
      {days.map((d) => {
        const selected = isSameDay(d, date);
        const isToday = isSameDay(d, today);
        return (
          <button
            key={d.toISOString()}
            type="button"
            role="tab"
            aria-selected={selected}
            onClick={() => onSelect(d)}
            className={`flex-1 min-w-0 flex flex-col items-center py-1.5 rounded-lg touch-manipulation ${
              selected ? 'bg-hud-gold text-hud-bg-deep' : isToday ? 'text-hud-gold' : 'text-hud-cream-dim'
            }`}
          >
            <span className="text-[11px] font-medium">{dow.format(d)}</span>
            <span className="text-base font-semibold leading-tight">{d.getDate()}</span>
          </button>
        );
      })}
    </div>
  );
}
