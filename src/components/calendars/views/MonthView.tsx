import { useMemo } from 'react';
import { useDevice } from '../../../contexts/DeviceContext';
import type { CalendarDisplayItem } from '../../../types';
import { getMonthGrid, formatDateString } from '../../../utils/calendarViewUtils';
import { AppointmentBlock } from './AppointmentBlock';
import { GoogleEventBlock } from './GoogleEventBlock';
import { EventBlock } from './EventBlock';
import { TaskBlock } from './TaskBlock';

interface MonthViewProps {
  date: Date;
  items: CalendarDisplayItem[];
  onItemClick: (item: CalendarDisplayItem) => void;
  onDayClick: (date: Date) => void;
}

const MAX_VISIBLE_ITEMS = 4;
const MAX_DOTS = 4;

// Phone month cells show coloured dots (one per item) instead of unreadable chips; tapping the day opens it.
function dotClass(item: CalendarDisplayItem): string {
  if (item.source === 'crm') return 'bg-hud-gold';
  if (item.source === 'google') return item.originalGoogleEvent?.provider === 'microsoft' ? 'bg-sky-400' : 'bg-hud-teal';
  if (item.source === 'task') return 'bg-hud-rust';
  return 'bg-hud-emerald';
}

// A crowded day shows its Outlook events first (they are the sparse ones and were getting buried
// under Google's), then fills the rest in time order. Shown items stay in time order.
function pickVisible(dayItems: CalendarDisplayItem[]): CalendarDisplayItem[] {
  if (dayItems.length <= MAX_VISIBLE_ITEMS) return dayItems;
  const isOutlook = (i: CalendarDisplayItem) => i.originalGoogleEvent?.provider === 'microsoft';
  const chosen = new Set<CalendarDisplayItem>([
    ...dayItems.filter(isOutlook),
    ...dayItems.filter((i) => !isOutlook(i)),
  ].slice(0, MAX_VISIBLE_ITEMS));
  return dayItems.filter((i) => chosen.has(i));
}

export function MonthView({ date, items, onItemClick, onDayClick }: MonthViewProps) {
  const isPhone = useDevice().device === 'phone';
  const monthGrid = useMemo(() => getMonthGrid(date), [date]);
  const dayNames = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

  const itemsByDay = useMemo(() => {
    const grouped: Record<string, CalendarDisplayItem[]> = {};

    items.forEach((item) => {
      const itemDate = new Date(item.startTime);
      const dateKey = formatDateString(itemDate);
      if (!grouped[dateKey]) {
        grouped[dateKey] = [];
      }
      grouped[dateKey].push(item);
    });

    Object.keys(grouped).forEach((key) => {
      grouped[key].sort(
        (a, b) => new Date(a.startTime).getTime() - new Date(b.startTime).getTime()
      );
    });

    return grouped;
  }, [items]);

  return (
    <div className="flex flex-col h-full">
      <div className="flex-shrink-0 grid grid-cols-7 border-b border-hud-bg-elev">
        {dayNames.map((name) => (
          <div key={name} className="py-2 text-center text-xs font-medium text-hud-cream-dim">
            {name}
          </div>
        ))}
      </div>

      <div className={`flex-1 grid ${isPhone ? 'grid-rows-6' : 'grid-rows-5 md:grid-rows-6'} min-h-0`}>
        {monthGrid.slice(0, 6).map((week, weekIndex) => (
          <div key={weekIndex} className="grid grid-cols-7 border-b border-hud-bg-card min-h-0">
            {week.map((day) => {
              const dayItems = itemsByDay[day.dateString] || [];
              const visibleItems = pickVisible(dayItems);
              const hiddenCount = dayItems.length - MAX_VISIBLE_ITEMS;

              return (
                <button
                  key={day.dateString}
                  onClick={() => onDayClick(day.date)}
                  className={`relative p-1 border-r border-hud-bg-card text-left hover:bg-hud-bg-card/50 transition-colors overflow-hidden ${
                    !day.isCurrentMonth ? 'bg-hud-bg-mid/50' : ''
                  } ${day.isToday ? 'bg-hud-gold/10' : ''}`}
                >
                  <div className={`flex items-start mb-1 ${isPhone ? 'justify-center' : 'justify-between'}`}>
                    <span
                      className={`inline-flex items-center justify-center w-6 h-6 text-sm rounded-full ${
                        day.isToday
                          ? 'bg-hud-gold text-hud-bg-deep font-semibold'
                          : day.isCurrentMonth
                            ? 'text-white'
                            : 'text-hud-cream-mute'
                      }`}
                    >
                      {day.dayOfMonth}
                    </span>
                    {dayItems.length > 0 && !isPhone && (
                      <span className="text-xs text-hud-cream-mute">{dayItems.length}</span>
                    )}
                  </div>

                  {isPhone ? (
                    <div className="flex flex-wrap justify-center gap-0.5 px-0.5" aria-label={`${dayItems.length} items`}>
                      {dayItems.slice(0, MAX_DOTS).map((item) => (
                        <span key={item.id} className={`w-1.5 h-1.5 rounded-full ${dotClass(item)}`} />
                      ))}
                      {dayItems.length > MAX_DOTS && <span className="text-[9px] leading-none text-hud-cream-mute">+</span>}
                    </div>
                  ) : (
                    <div className="space-y-0.5 overflow-hidden">
                      {visibleItems.map((item) => (
                        <MonthItemBlock key={item.id} item={item} onItemClick={onItemClick} />
                      ))}
                      {hiddenCount > 0 && (
                        <p className="text-xs text-hud-cream-mute pl-2">+{hiddenCount} more</p>
                      )}
                    </div>
                  )}
                </button>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}

function MonthItemBlock({
  item,
  onItemClick,
}: {
  item: CalendarDisplayItem;
  onItemClick: (item: CalendarDisplayItem) => void;
}) {
  if (item.source === 'crm' && item.originalAppointment) {
    return (
      <AppointmentBlock
        appointment={item.originalAppointment}
        onClick={() => onItemClick(item)}
        compact
      />
    );
  }

  if (item.source === 'google' && item.originalGoogleEvent) {
    return (
      <GoogleEventBlock
        event={item.originalGoogleEvent}
        onClick={() => onItemClick(item)}
        compact
      />
    );
  }

  if (item.source === 'event' && item.originalCalendarEvent) {
    return (
      <EventBlock
        event={item.originalCalendarEvent}
        onClick={() => onItemClick(item)}
        compact
      />
    );
  }

  if (item.source === 'task' && item.originalCalendarTask) {
    return (
      <TaskBlock
        task={item.originalCalendarTask}
        onClick={() => onItemClick(item)}
        compact
      />
    );
  }

  if (item.source === 'blocked') {
    return (
      <button
        onClick={(e) => { e.stopPropagation(); onItemClick(item); }}
        className="w-full text-left px-2 py-1 rounded text-xs truncate bg-hud-cream-mute/20 text-hud-cream-dim border-l-2 border-l-hud-cream-mute hover:opacity-80 transition-opacity"
      >
        <span className="font-medium">{item.title}</span>
      </button>
    );
  }

  return null;
}
