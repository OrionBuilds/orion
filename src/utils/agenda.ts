/**
 * Pure helpers for the agenda list (calendar "Agenda" view) and the dashboard's "My day" block:
 * day labels, grouping display items by local day, who/where sublines and the honest
 * "nothing synced" note. Browser local time, like the rest of the calendar code.
 * Unit-tested in agenda.test.ts.
 */
import type { CalendarDisplayItem } from '../types';
import { AGENDA_VIEW_DAYS, addDays, getStartOfDay, isSameDay } from './calendarViewUtils';

/** How many days the Agenda view lists from its start day. */
export const AGENDA_DAYS = AGENDA_VIEW_DAYS;

/** YYYY-MM-DD in local time (formatDateString is UTC and shifts the day in the evening). */
export function localDayKey(date: Date): string {
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${date.getFullYear()}-${m}-${d}`;
}

/** Parse a YYYY-MM-DD (or any Date-parsable) string as a local day; null when it is not a date. */
export function parseLocalDay(value: string | null | undefined): Date | null {
  if (!value) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
  const date = m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

/**
 * The calendar day of a mirrored (Google / Microsoft) all-day event. The mirrors store those at
 * UTC midnight of the event's date, which read as local time is the evening before in the Americas.
 */
export function mirroredAllDayDate(iso: string): Date {
  const d = new Date(iso);
  return new Date(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

/** "Today", "Tomorrow", otherwise "Mon, Nov 16" (with the year when it is not this year). */
export function dayLabel(day: Date, now: Date = new Date()): string {
  if (isSameDay(day, now)) return 'Today';
  if (isSameDay(day, addDays(now, 1))) return 'Tomorrow';
  return day.toLocaleDateString('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    ...(day.getFullYear() !== now.getFullYear() ? { year: 'numeric' as const } : {}),
  });
}

/** "9:30 AM" */
export function formatClock(iso: string): string {
  return new Date(iso).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });
}

/**
 * True for a timed event that runs from one local midnight to a later one (Google "Out of office"
 * blocks are stored this way, not as all-day): it reads as "All day", not "12:00 AM - 12:00 AM".
 */
export function coversWholeDays(startIso: string, endIso: string | null | undefined): boolean {
  if (!endIso) return false;
  const s = new Date(startIso);
  const e = new Date(endIso);
  if (Number.isNaN(s.getTime()) || Number.isNaN(e.getTime()) || e <= s) return false;
  const midnight = (d: Date) => d.getHours() === 0 && d.getMinutes() === 0;
  return midnight(s) && midnight(e);
}

/** All day as the mirror flags it, or a timed event covering whole local days. */
export function isAllDayItem(item: Pick<CalendarDisplayItem, 'allDay' | 'startTime' | 'endTime'>): boolean {
  return item.allDay || coversWholeDays(item.startTime, item.endTime);
}

/** "Nov 12 - 25" / "Nov 28 - Dec 11": the span the Agenda view covers from `start`. */
export function agendaRangeLabel(start: Date, days: number = AGENDA_DAYS): string {
  const end = addDays(start, days - 1);
  const month = (d: Date) => d.toLocaleDateString('en-US', { month: 'short' });
  return month(start) === month(end)
    ? `${month(start)} ${start.getDate()} - ${end.getDate()}`
    : `${month(start)} ${start.getDate()} - ${month(end)} ${end.getDate()}`;
}

export interface AgendaDay {
  /** Local YYYY-MM-DD. */
  key: string;
  date: Date;
  label: string;
  items: CalendarDisplayItem[];
}

/**
 * Items from `rangeStart`'s day through the next `days` days, grouped by the local day they start
 * on (mirrored all-day events: the date they are for). Days with nothing are left out. Something
 * that started before the range but is still running is listed on the first day. Within a day:
 * all-day first, then by start time, then title.
 */
export function groupAgendaByDay(
  items: CalendarDisplayItem[],
  rangeStart: Date,
  days: number = AGENDA_DAYS,
  now: Date = new Date()
): AgendaDay[] {
  const start = getStartOfDay(rangeStart);
  const end = addDays(start, days);
  const byDay = new Map<string, AgendaDay>();

  for (const item of items) {
    const floating = item.allDay && item.source === 'google';
    const s = floating ? mirroredAllDayDate(item.startTime) : new Date(item.startTime);
    if (Number.isNaN(s.getTime()) || s >= end) continue;
    let day: Date;
    if (s < start) {
      const e = floating ? mirroredAllDayDate(item.endTime) : new Date(item.endTime);
      if (Number.isNaN(e.getTime()) || e <= start) continue;
      day = start;
    } else {
      day = getStartOfDay(s);
    }
    const key = localDayKey(day);
    let group = byDay.get(key);
    if (!group) {
      group = { key, date: day, label: dayLabel(day, now), items: [] };
      byDay.set(key, group);
    }
    group.items.push(item);
  }

  const order = (a: CalendarDisplayItem, b: CalendarDisplayItem) =>
    Number(isAllDayItem(b)) - Number(isAllDayItem(a)) ||
    new Date(a.startTime).getTime() - new Date(b.startTime).getTime() ||
    a.title.localeCompare(b.title);

  return [...byDay.values()]
    .sort((a, b) => a.date.getTime() - b.date.getTime())
    .map((g) => ({ ...g, items: [...g.items].sort(order) }));
}

/** "Ana, Bo +3" */
export function formatWho(names: string[], max = 2): string | undefined {
  const clean = names.map((n) => n.trim()).filter(Boolean);
  if (clean.length === 0) return undefined;
  const shown = clean.slice(0, max).join(', ');
  return clean.length > max ? `${shown} +${clean.length - max}` : shown;
}

export interface AgendaDetail {
  /** Other people on it, when the record says. */
  who?: string;
  where?: string;
  video: boolean;
  /** Appointment type / "Task" / "Blocked": what kind of row this is, when that is not obvious from the title. */
  kind?: string;
}

type Attendee = { email?: string; displayName?: string; name?: string };

function attendeeNames(attendees: Attendee[] | null | undefined, exclude: Array<string | null | undefined>): string[] {
  const skip = new Set(exclude.filter(Boolean).map((e) => e!.toLowerCase()));
  return (attendees ?? [])
    .filter((a) => !a.email || !skip.has(a.email.toLowerCase()))
    .map((a) => a.displayName || a.name || (a.email ? a.email.split('@')[0] : ''))
    .filter(Boolean);
}

/** With whom / where for one agenda row, from whatever the underlying record carries. */
export function agendaDetail(item: CalendarDisplayItem, selfEmail?: string | null): AgendaDetail {
  if (item.source === 'crm' && item.originalAppointment) {
    const apt = item.originalAppointment as typeof item.originalAppointment & { location?: string | null };
    return { where: apt.location || undefined, video: !!apt.google_meet_link, kind: apt.appointment_type?.name || undefined };
  }
  if (item.source === 'google' && item.originalGoogleEvent) {
    const g = item.originalGoogleEvent;
    return {
      who: formatWho(attendeeNames(g.attendees, [selfEmail])),
      where: g.location || undefined,
      video: !!g.hangout_link,
    };
  }
  if (item.source === 'event' && item.originalCalendarEvent) {
    const ev = item.originalCalendarEvent;
    return {
      who: formatWho(attendeeNames(ev.attendees, [selfEmail])),
      where: ev.location || undefined,
      video: !!ev.google_meet_link,
    };
  }
  if (item.source === 'task') return { video: false, kind: 'Task' };
  if (item.source === 'blocked') return { video: false, kind: 'Blocked' };
  return { video: false };
}

/**
 * What to say about mirrored Google / Microsoft events when none are listed, so an empty list never
 * reads as "you are free". Null when synced events are showing.
 *  - `externalShown`: mirrored events in the listed range
 *  - `mirrorUpcoming`: mirrored events from today onward at any distance (null = could not tell)
 */
export function syncedEventsNote(o: { connected: boolean; externalShown: number; mirrorUpcoming: number | null }): string | null {
  if (!o.connected) return 'No synced calendar events: no Google or Microsoft calendar is connected, so only OS appointments show here.';
  if (o.externalShown > 0) return null;
  if (o.mirrorUpcoming === 0) {
    return 'No synced calendar events: your connected calendar has nothing from today onward in the OS, so meetings may be missing here. Try Sync.';
  }
  return 'No synced calendar events in this range.';
}
