import { describe, it, expect } from 'vitest';
import { sortAgenda, accentFor } from './AgendaDayView';
import type { CalendarDisplayItem } from '../../../types';

const item = (id: string, title: string, start: string, end: string, extra: Partial<CalendarDisplayItem> = {}): CalendarDisplayItem =>
  ({ id, title, startTime: start, endTime: end, allDay: false, source: 'google', ...extra }) as CalendarDisplayItem;

describe('sortAgenda', () => {
  const day = new Date('2026-11-12T12:00:00');

  it('keeps only the chosen day, all-day first group, timed events in start order', () => {
    const r = sortAgenda([
      item('c', 'Late', '2026-11-12T15:00:00', '2026-11-12T16:00:00'),
      item('a', 'Early', '2026-11-12T09:00:00', '2026-11-12T09:30:00'),
      item('x', 'Other day', '2026-11-13T09:00:00', '2026-11-13T10:00:00'),
      item('d', 'Holiday', '2026-11-12T00:00:00', '2026-11-13T00:00:00', { allDay: true }),
    ], day);
    expect(r.allDay.map((i) => i.id)).toEqual(['d']);
    expect(r.timed.map((i) => i.id)).toEqual(['a', 'c']);
  });

  it('events that start together are ordered by title, so five identical invites stay stable', () => {
    const r = sortAgenda([
      item('2', 'Standup B', '2026-11-12T10:30:00', '2026-11-12T11:00:00'),
      item('1', 'Standup A', '2026-11-12T10:30:00', '2026-11-12T11:00:00'),
    ], day);
    expect(r.timed.map((i) => i.title)).toEqual(['Standup A', 'Standup B']);
  });
});

describe('accentFor', () => {
  it('colours CRM, Google, Outlook, task and blocked time differently', () => {
    expect(accentFor(item('1', 'x', 'a', 'b', { source: 'crm' }))).toContain('gold');
    expect(accentFor(item('2', 'x', 'a', 'b'))).toContain('teal');
    expect(accentFor(item('3', 'x', 'a', 'b', { originalGoogleEvent: { provider: 'microsoft' } as never }))).toContain('sky');
    expect(accentFor(item('4', 'x', 'a', 'b', { source: 'task' }))).toContain('rust');
    expect(accentFor(item('5', 'x', 'a', 'b', { source: 'blocked' }))).toContain('cream');
  });
});
