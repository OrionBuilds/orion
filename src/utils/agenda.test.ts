import { describe, it, expect } from 'vitest';
import type { CalendarDisplayItem, GoogleCalendarEvent, CalendarEvent, Appointment } from '../types';
import {
  AGENDA_DAYS, agendaDetail, agendaRangeLabel, coversWholeDays, dayLabel, formatWho, groupAgendaByDay, isAllDayItem,
  localDayKey, mirroredAllDayDate, parseLocalDay, syncedEventsNote,
} from './agenda';
import { getDateRangeForView, getDateRangeLabel } from './calendarViewUtils';

const now = new Date(2026, 10, 12, 9, 0); // Thu Nov 12 2026, 9:00 local

function item(id: string, start: Date, minutes = 30, extra: Partial<CalendarDisplayItem> = {}): CalendarDisplayItem {
  return {
    id, title: id, startTime: start.toISOString(), endTime: new Date(start.getTime() + minutes * 60_000).toISOString(),
    allDay: false, source: 'event', ...extra,
  };
}

describe('localDayKey / parseLocalDay', () => {
  it('round-trips a local day, late evening included', () => {
    const late = new Date(2026, 10, 12, 23, 30);
    expect(localDayKey(late)).toBe('2026-11-12');
    const parsed = parseLocalDay('2026-11-12')!;
    expect([parsed.getFullYear(), parsed.getMonth(), parsed.getDate(), parsed.getHours()]).toEqual([2026, 10, 12, 0]);
  });

  it('returns null for junk', () => {
    expect(parseLocalDay('not-a-date')).toBeNull();
    expect(parseLocalDay('')).toBeNull();
    expect(parseLocalDay(null)).toBeNull();
  });
});

describe('dayLabel', () => {
  it('names today and tomorrow, dates the rest', () => {
    expect(dayLabel(new Date(2026, 10, 12, 23, 59), now)).toBe('Today');
    expect(dayLabel(new Date(2026, 10, 13, 0, 0), now)).toBe('Tomorrow');
    expect(dayLabel(new Date(2026, 10, 16), now)).toBe('Mon, Nov 16');
    expect(dayLabel(new Date(2026, 10, 11), now)).toBe('Wed, Nov 11');
  });

  it('adds the year when it is not this year', () => {
    expect(dayLabel(new Date(2027, 0, 4), now)).toBe('Mon, Jan 4, 2027');
  });
});

describe('agendaRangeLabel', () => {
  it('covers 14 days from the start day', () => {
    expect(agendaRangeLabel(new Date(2026, 10, 12))).toBe('Nov 12 - 25');
    expect(agendaRangeLabel(new Date(2026, 10, 28))).toBe('Nov 28 - Dec 11');
  });
});

describe('groupAgendaByDay', () => {
  it('groups by local day in order, skips empty days, labels today and tomorrow', () => {
    const days = groupAgendaByDay([
      item('later', new Date(2026, 10, 16, 14, 0)),
      item('tomorrow', new Date(2026, 10, 13, 8, 0)),
      item('today-pm', new Date(2026, 10, 12, 15, 0)),
      item('today-am', new Date(2026, 10, 12, 7, 0)),
    ], now, AGENDA_DAYS, now);
    expect(days.map((d) => d.label)).toEqual(['Today', 'Tomorrow', 'Mon, Nov 16']);
    expect(days.map((d) => d.key)).toEqual(['2026-11-12', '2026-11-13', '2026-11-16']);
    expect(days[0].items.map((i) => i.id)).toEqual(['today-am', 'today-pm']);
  });

  it('puts all-day items first, then start time, then title', () => {
    const at = new Date(2026, 10, 12, 10, 0);
    const [day] = groupAgendaByDay([
      item('b', at), item('a', at),
      item('all-day', new Date(2026, 10, 12, 12, 0), 60, { allDay: true }),
      item('early', new Date(2026, 10, 12, 6, 0)),
    ], now, AGENDA_DAYS, now);
    expect(day.items.map((i) => i.id)).toEqual(['all-day', 'early', 'a', 'b']);
  });

  it('treats a midnight-to-midnight timed event (Google "Out of office") as all day', () => {
    const ooo = item('ooo', new Date(2026, 10, 12, 0, 0), 24 * 60);
    expect(coversWholeDays(ooo.startTime, ooo.endTime)).toBe(true);
    expect(isAllDayItem(ooo)).toBe(true);
    expect(isAllDayItem(item('two-days', new Date(2026, 10, 12, 0, 0), 48 * 60))).toBe(true);
    expect(isAllDayItem(item('from-midnight', new Date(2026, 10, 12, 0, 0), 90))).toBe(false);
    expect(isAllDayItem(item('meeting', new Date(2026, 10, 12, 10, 0), 60))).toBe(false);
    expect(coversWholeDays(ooo.startTime, null)).toBe(false);
    expect(coversWholeDays(ooo.startTime, ooo.startTime)).toBe(false);
    const [day] = groupAgendaByDay([item('early', new Date(2026, 10, 12, 6, 0)), ooo], now, AGENDA_DAYS, now);
    expect(day.items.map((i) => i.id)).toEqual(['ooo', 'early']);
  });

  it('drops what is outside the window and keeps what is still running on the first day', () => {
    const days = groupAgendaByDay([
      item('yesterday', new Date(2026, 10, 11, 10, 0)),
      item('running', new Date(2026, 10, 11, 22, 0), 6 * 60),
      item('last-day', new Date(2026, 10, 25, 23, 0)),
      item('day-15', new Date(2026, 10, 26, 0, 0)),
      item('bad-date', new Date(2026, 10, 12), 30, { startTime: 'nope' }),
    ], now, AGENDA_DAYS, now);
    expect(days.flatMap((d) => d.items.map((i) => i.id))).toEqual(['running', 'last-day']);
    expect(days[0].label).toBe('Today');
  });

  it('lists a mirrored all-day event on the date it is for, whatever the timezone', () => {
    // The mirrors store all-day events at UTC midnight of their date.
    const allDay = (id: string, from: string, to: string) =>
      item(id, now, 0, { source: 'google', allDay: true, startTime: `${from}T00:00:00.000Z`, endTime: `${to}T00:00:00.000Z` });
    expect(localDayKey(mirroredAllDayDate('2026-11-13T00:00:00.000Z'))).toBe('2026-11-13');
    const days = groupAgendaByDay([
      allDay('friday', '2026-11-13', '2026-11-14'),
      allDay('ended-yesterday', '2026-11-11', '2026-11-12'),
      allDay('conference', '2026-11-10', '2026-11-13'),
      allDay('too-far', '2026-11-26', '2026-11-27'),
    ], now, AGENDA_DAYS, now);
    expect(days.map((d) => [d.key, d.items.map((i) => i.id)])).toEqual([
      ['2026-11-12', ['conference']],
      ['2026-11-13', ['friday']],
    ]);
  });

  it('labels relative to now even when the window starts on another day', () => {
    const days = groupAgendaByDay([item('x', new Date(2026, 10, 27, 9, 0))], new Date(2026, 10, 26), AGENDA_DAYS, now);
    expect(days.map((d) => d.label)).toEqual(['Fri, Nov 27']);
  });
});

describe('formatWho', () => {
  it('lists two names and counts the rest', () => {
    expect(formatWho([])).toBeUndefined();
    expect(formatWho(['Ana'])).toBe('Ana');
    expect(formatWho(['Ana', 'Bo', ' ', 'Cy', 'Di'])).toBe('Ana, Bo +2');
  });
});

describe('agendaDetail', () => {
  it('reads attendees, place and video from a mirrored event, leaving the owner out', () => {
    const g = {
      location: 'HQ', hangout_link: 'https://teams.example/x',
      attendees: [{ email: 'me@x.com', displayName: 'Me' }, { email: 'ana@x.com', displayName: 'Ana' }, { email: 'bo@x.com' }],
    } as unknown as GoogleCalendarEvent;
    const d = agendaDetail(item('g', now, 30, { source: 'google', originalGoogleEvent: g }), 'ME@x.com');
    expect(d).toEqual({ who: 'Ana, bo', where: 'HQ', video: true });
  });

  it('reads an OS event and an appointment', () => {
    const ev = { location: null, google_meet_link: null, attendees: [{ name: 'Cy' }] } as unknown as CalendarEvent;
    expect(agendaDetail(item('e', now, 30, { originalCalendarEvent: ev }))).toEqual({ who: 'Cy', where: undefined, video: false });
    const apt = { google_meet_link: 'https://meet/x', appointment_type: { name: 'Discovery call' } } as unknown as Appointment;
    expect(agendaDetail(item('a', now, 30, { source: 'crm', originalAppointment: apt })))
      .toEqual({ where: undefined, video: true, kind: 'Discovery call' });
  });

  it('names tasks and blocked time', () => {
    expect(agendaDetail(item('t', now, 30, { source: 'task' })).kind).toBe('Task');
    expect(agendaDetail(item('b', now, 30, { source: 'blocked' })).kind).toBe('Blocked');
  });
});

describe('syncedEventsNote', () => {
  it('says nothing when synced events are listed', () => {
    expect(syncedEventsNote({ connected: true, externalShown: 3, mirrorUpcoming: 9 })).toBeNull();
  });

  it('never implies a free calendar when nothing is synced', () => {
    expect(syncedEventsNote({ connected: false, externalShown: 0, mirrorUpcoming: null })).toMatch(/^No synced calendar events: no Google or Microsoft calendar is connected/);
    expect(syncedEventsNote({ connected: true, externalShown: 0, mirrorUpcoming: 0 })).toMatch(/nothing from today onward/);
    expect(syncedEventsNote({ connected: true, externalShown: 0, mirrorUpcoming: 12 })).toBe('No synced calendar events in this range.');
    expect(syncedEventsNote({ connected: true, externalShown: 0, mirrorUpcoming: null })).toBe('No synced calendar events in this range.');
  });
});

describe('agenda view range', () => {
  it('spans 14 local days from the given day', () => {
    const range = getDateRangeForView(new Date(2026, 10, 12, 15, 30), 'agenda');
    expect(range.startDate).toBe(new Date(2026, 10, 12).toISOString());
    expect(range.endDate).toBe(new Date(2026, 10, 25, 23, 59, 59, 999).toISOString());
    expect(getDateRangeLabel(new Date(2026, 10, 12), 'agenda')).toBe('Nov 12 - 25, 2026');
  });
});
