import { useMemo } from 'react';
import { CalendarX, Info, MapPin, Users, Video } from 'lucide-react';
import type { CalendarDisplayItem } from '../../../types';
import { AGENDA_DAYS, agendaDetail, formatClock, groupAgendaByDay, isAllDayItem } from '../../../utils/agenda';
import { accentFor } from './AgendaDayView';

/**
 * Agenda: the next two weeks as one plain list grouped by day, so "what is coming up" is a glance
 * and a scroll rather than a grid to read. Rows open the same detail modals as the other views.
 * `syncNote` is shown when no synced (Google / Microsoft) events are listed, so an empty list is
 * never mistaken for a free calendar.
 */
export function AgendaListView({
  startDate, items, onItemClick, syncNote, selfEmail,
}: {
  startDate: Date;
  items: CalendarDisplayItem[];
  onItemClick: (item: CalendarDisplayItem) => void;
  syncNote?: string | null;
  selfEmail?: string | null;
}) {
  const days = useMemo(() => groupAgendaByDay(items, startDate, AGENDA_DAYS), [items, startDate]);
  const now = Date.now();

  const note = syncNote ? (
    <p className="flex items-start gap-2 rounded-lg border border-hud-bg-elev bg-hud-bg-card/60 px-3 py-2 text-xs text-hud-cream-dim" data-testid="agenda-sync-note">
      <Info className="w-3.5 h-3.5 mt-0.5 shrink-0 text-hud-gold-soft" />
      <span>{syncNote}</span>
    </p>
  ) : null;

  if (days.length === 0) {
    return (
      <div className="h-full overflow-y-auto px-3 py-3" data-testid="agenda-list-empty">
        <div className="mx-auto max-w-3xl space-y-4">
          <div className="flex flex-col items-center justify-center gap-2 py-12 text-hud-cream-dim">
            <CalendarX className="w-8 h-8" />
            <p className="text-sm">Nothing on the OS calendar for these {AGENDA_DAYS} days</p>
          </div>
          {note}
        </div>
      </div>
    );
  }

  return (
    <div className="h-full overflow-y-auto px-3 pb-4" data-testid="agenda-list">
      <div className="mx-auto max-w-3xl">
        {days.map((day) => (
          <section key={day.key} aria-label={day.label}>
            <h3 className="sticky top-0 z-10 -mx-3 px-3 py-2 bg-hud-bg-mid text-[11px] font-medium uppercase tracking-wide text-hud-cream-mute">
              <span className={day.label === 'Today' ? 'text-hud-gold-soft' : undefined}>{day.label}</span>
              <span className="ml-2 normal-case tracking-normal">{day.items.length}</span>
            </h3>
            <ul className="space-y-2">
              {day.items.map((item) => {
                const { who, where, video, kind } = agendaDetail(item, selfEmail);
                const allDay = isAllDayItem(item);
                const past = !allDay && new Date(item.endTime).getTime() < now;
                return (
                  <li key={`${item.source}-${item.id}`}>
                    <button
                      type="button"
                      onClick={() => onItemClick(item)}
                      className={`w-full min-h-[44px] flex items-start gap-3 text-left rounded-lg border border-hud-bg-card border-l-4 ${accentFor(item)} bg-hud-bg-card/60 px-3 py-2.5 touch-manipulation active:bg-hud-bg-elev hover:bg-hud-bg-card ${past ? 'opacity-60' : ''}`}
                    >
                      <span className="w-[4.25rem] shrink-0 text-xs leading-snug text-hud-cream-soft">
                        {allDay ? 'All day' : (
                          <>
                            <span className="block font-medium text-white">{formatClock(item.startTime)}</span>
                            <span className="block text-hud-cream-mute">{formatClock(item.endTime)}</span>
                          </>
                        )}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block text-sm font-medium text-white leading-snug break-words">{item.title}</span>
                        {(kind || who || where || video) && (
                          <span className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-hud-cream-dim">
                            {kind && <span>{kind}</span>}
                            {who && <span className="inline-flex items-center gap-1 min-w-0"><Users className="w-3 h-3 shrink-0" /><span className="truncate max-w-[11rem]">{who}</span></span>}
                            {where && <span className="inline-flex items-center gap-1 min-w-0"><MapPin className="w-3 h-3 shrink-0" /><span className="truncate max-w-[11rem]">{where}</span></span>}
                            {video && <span className="inline-flex items-center gap-1"><Video className="w-3 h-3" />Video</span>}
                          </span>
                        )}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </section>
        ))}
        {note && <div className="mt-4">{note}</div>}
      </div>
    </div>
  );
}
