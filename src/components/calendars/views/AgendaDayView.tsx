import { useMemo } from 'react';
import { CalendarX, Clock, MapPin, Video } from 'lucide-react';
import type { CalendarDisplayItem } from '../../../types';
import { formatTimeRange, isSameDay } from '../../../utils/calendarViewUtils';

/** Accent per source so a glance tells CRM appointments from Google, Outlook, tasks and blocked time. */
export function accentFor(item: CalendarDisplayItem): string {
  if (item.source === 'crm') return 'border-l-hud-gold';
  if (item.source === 'google') return item.originalGoogleEvent?.provider === 'microsoft' ? 'border-l-sky-400' : 'border-l-hud-teal';
  if (item.source === 'task') return 'border-l-hud-rust';
  if (item.source === 'blocked') return 'border-l-hud-cream-mute';
  return 'border-l-hud-emerald';
}

export function sortAgenda(items: CalendarDisplayItem[], day: Date): { allDay: CalendarDisplayItem[]; timed: CalendarDisplayItem[] } {
  const mine = items.filter((i) => isSameDay(new Date(i.startTime), day));
  const byStart = (a: CalendarDisplayItem, b: CalendarDisplayItem) =>
    new Date(a.startTime).getTime() - new Date(b.startTime).getTime() || a.title.localeCompare(b.title);
  return { allDay: mine.filter((i) => i.allDay).sort(byStart), timed: mine.filter((i) => !i.allDay).sort(byStart) };
}

function subline(item: CalendarDisplayItem): { place?: string; video: boolean } {
  const g = item.originalGoogleEvent as { location?: string | null; hangout_link?: string | null; google_meet_link?: string | null; meet_link?: string | null } | undefined;
  const ev = item.originalCalendarEvent as { location?: string | null } | undefined;
  return { place: g?.location || ev?.location || undefined, video: !!(g?.hangout_link || g?.google_meet_link || g?.meet_link) };
}

/**
 * Phone day view: an agenda list instead of a time grid. Four or five invites that start together cannot share a
 * 360px grid (each ends up ~70px wide and unreadable), but they read fine as a list.
 */
export function AgendaDayView({
  date, items, onItemClick,
}: {
  date: Date;
  items: CalendarDisplayItem[];
  onItemClick: (item: CalendarDisplayItem) => void;
}) {
  const { allDay, timed } = useMemo(() => sortAgenda(items, date), [items, date]);
  const now = Date.now();

  if (allDay.length === 0 && timed.length === 0) {
    return (
      <div className="h-full flex flex-col items-center justify-center gap-2 py-16 text-hud-cream-dim" data-testid="agenda-empty">
        <CalendarX className="w-8 h-8" />
        <p className="text-sm">Nothing scheduled</p>
      </div>
    );
  }

  const row = (item: CalendarDisplayItem, showTime: boolean) => {
    const { place, video } = subline(item);
    const past = !item.allDay && new Date(item.endTime).getTime() < now;
    return (
      <li key={item.id}>
        <button
          type="button"
          onClick={() => onItemClick(item)}
          className={`w-full text-left rounded-lg border border-hud-bg-card border-l-4 ${accentFor(item)} bg-hud-bg-card/60 px-3 py-2.5 touch-manipulation active:bg-hud-bg-elev ${past ? 'opacity-60' : ''}`}
        >
          <p className="text-sm font-medium text-white leading-snug break-words">{item.title}</p>
          <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-hud-cream-dim">
            {showTime && (
              <span className="inline-flex items-center gap-1"><Clock className="w-3 h-3" />{formatTimeRange(item.startTime, item.endTime)}</span>
            )}
            {place && <span className="inline-flex items-center gap-1 min-w-0"><MapPin className="w-3 h-3 shrink-0" /><span className="truncate max-w-[10rem]">{place}</span></span>}
            {video && <span className="inline-flex items-center gap-1"><Video className="w-3 h-3" />Video</span>}
          </div>
        </button>
      </li>
    );
  };

  return (
    <div className="h-full overflow-y-auto px-3 py-3 space-y-4" data-testid="agenda-day">
      {allDay.length > 0 && (
        <section>
          <h3 className="text-[11px] font-medium uppercase tracking-wide text-hud-cream-mute mb-1.5">All day</h3>
          <ul className="space-y-2">{allDay.map((i) => row(i, false))}</ul>
        </section>
      )}
      {timed.length > 0 && (
        <section>
          {allDay.length > 0 && <h3 className="text-[11px] font-medium uppercase tracking-wide text-hud-cream-mute mb-1.5">Schedule</h3>}
          <ul className="space-y-2">{timed.map((i) => row(i, true))}</ul>
        </section>
      )}
    </div>
  );
}
