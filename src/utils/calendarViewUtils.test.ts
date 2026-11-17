import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  addDays,
  addMonths,
  addWeeks,
  formatDateString,
  formatTimeRange,
  generateTimeSlots,
  laneStyle,
  layoutOverlapping,
  getAppointmentPosition,
  getCurrentTimePosition,
  getDateRangeForView,
  getDateRangeLabel,
  getEndOfDay,
  getEndOfMonth,
  getEndOfWeek,
  getMonthGrid,
  getStartOfDay,
  getStartOfMonth,
  getStartOfWeek,
  getStatusColor,
  getWeekDays,
  isSameDay,
  toLocalDatetimeString,
} from './calendarViewUtils';

// 2026-06-17 is a Wednesday.
const wednesday = new Date(2026, 5, 17, 15, 30, 45, 123);

describe('day/week/month boundaries', () => {
  it('clamps to the start and end of the day', () => {
    expect(getStartOfDay(wednesday).getHours()).toBe(0);
    expect(getStartOfDay(wednesday).getMilliseconds()).toBe(0);
    expect(getEndOfDay(wednesday).getHours()).toBe(23);
    expect(getEndOfDay(wednesday).getMilliseconds()).toBe(999);
  });

  it('uses Monday as the first day of the week', () => {
    expect(getStartOfWeek(wednesday)).toEqual(new Date(2026, 5, 15));
    expect(getEndOfWeek(wednesday)).toEqual(new Date(2026, 5, 21, 23, 59, 59, 999));
  });

  it('rolls a Sunday back to the previous Monday', () => {
    const sunday = new Date(2026, 5, 21, 9, 0);
    expect(getStartOfWeek(sunday)).toEqual(new Date(2026, 5, 15));
  });

  it('returns the first and last instant of the month', () => {
    expect(getStartOfMonth(wednesday)).toEqual(new Date(2026, 5, 1));
    expect(getEndOfMonth(wednesday)).toEqual(new Date(2026, 5, 30, 23, 59, 59, 999));
  });
});

describe('date arithmetic', () => {
  it('adds days, weeks, and months without mutating the input', () => {
    const original = new Date(wednesday);
    expect(addDays(wednesday, 5).getDate()).toBe(22);
    expect(addDays(wednesday, -20).getMonth()).toBe(4);
    expect(addWeeks(wednesday, 2).getDate()).toBe(1);
    expect(addMonths(wednesday, 2).getMonth()).toBe(7);
    expect(wednesday).toEqual(original);
  });

  it('compares calendar days ignoring the time of day', () => {
    expect(isSameDay(wednesday, new Date(2026, 5, 17, 1, 0))).toBe(true);
    expect(isSameDay(wednesday, new Date(2026, 5, 18))).toBe(false);
    expect(isSameDay(wednesday, new Date(2025, 5, 17))).toBe(false);
  });

  it('formats a date as an ISO calendar day', () => {
    expect(formatDateString(new Date(Date.UTC(2026, 5, 17, 12)))).toBe('2026-06-17');
  });
});

describe('generateTimeSlots', () => {
  it('covers the default 6AM-10PM range inclusively', () => {
    const slots = generateTimeSlots();
    expect(slots).toHaveLength(17);
    expect(slots[0]).toEqual({ hour: 6, label: '6AM' });
    expect(slots[slots.length - 1]).toEqual({ hour: 22, label: '10PM' });
  });

  it('labels noon and midnight correctly', () => {
    expect(generateTimeSlots(0, 13)).toEqual(
      expect.arrayContaining([
        { hour: 0, label: '12AM' },
        { hour: 12, label: '12PM' },
        { hour: 13, label: '1PM' },
      ])
    );
  });
});

describe('grid builders', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(wednesday);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('builds a Monday-first week and flags today', () => {
    const days = getWeekDays(wednesday);
    expect(days.map((d) => d.dayName)).toEqual(['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']);
    expect(days.map((d) => d.dayOfMonth)).toEqual([15, 16, 17, 18, 19, 20, 21]);
    expect(days.filter((d) => d.isToday).map((d) => d.dayOfMonth)).toEqual([17]);
  });

  it('builds a month grid padded to whole weeks', () => {
    const weeks = getMonthGrid(wednesday);
    expect(weeks.every((week) => week.length === 7)).toBe(true);
    expect(weeks[0][0].dayOfMonth).toBe(1);
    expect(weeks.flat().filter((d) => d.isCurrentMonth)).toHaveLength(30);
    const lastWeek = weeks[weeks.length - 1];
    expect(lastWeek.some((day) => !day.isCurrentMonth)).toBe(true);
  });

  it('pads leading days from the previous month', () => {
    const weeks = getMonthGrid(new Date(2026, 6, 15));
    expect(weeks[0][0].dayOfMonth).toBe(29);
    expect(weeks[0][0].isCurrentMonth).toBe(false);
  });

  it('positions the current time relative to the grid start', () => {
    expect(getCurrentTimePosition()).toBeCloseTo((15 * 60 + 30 - 6 * 60) * (64 / 60));
    expect(getCurrentTimePosition(15)).toBeCloseTo(30 * (64 / 60));
  });
});

describe('getDateRangeLabel', () => {
  it('spells out the full date in day view', () => {
    expect(getDateRangeLabel(wednesday, 'day')).toBe('Wednesday, June 17, 2026');
  });

  it('collapses the month when a week does not span months', () => {
    expect(getDateRangeLabel(wednesday, 'week')).toBe('Jun 15 - 21, 2026');
  });

  it('shows both months when a week spans two of them', () => {
    expect(getDateRangeLabel(new Date(2026, 5, 30), 'week')).toBe('Jun 29 - Jul 5, 2026');
  });

  it('shows month and year in month view', () => {
    expect(getDateRangeLabel(wednesday, 'month')).toBe('June 2026');
  });
});

describe('getAppointmentPosition', () => {
  it('converts a time range into pixel offsets', () => {
    const { top, height } = getAppointmentPosition(
      new Date(2026, 5, 17, 9, 0).toISOString(),
      new Date(2026, 5, 17, 10, 0).toISOString()
    );
    expect(top).toBeCloseTo(3 * 64);
    expect(height).toBeCloseTo(64);
  });

  it('clamps to a non-negative top and a minimum height', () => {
    const { top, height } = getAppointmentPosition(
      new Date(2026, 5, 17, 5, 0).toISOString(),
      new Date(2026, 5, 17, 5, 5).toISOString()
    );
    expect(top).toBe(0);
    expect(height).toBe(16);
  });

  it('honors a custom grid start hour', () => {
    expect(
      getAppointmentPosition(
        new Date(2026, 5, 17, 9, 0).toISOString(),
        new Date(2026, 5, 17, 9, 30).toISOString(),
        9
      ).top
    ).toBe(0);
  });
});

describe('formatting helpers', () => {
  it('renders a local datetime-input value', () => {
    expect(toLocalDatetimeString(new Date(2026, 0, 5, 8, 7))).toBe('2026-01-05T08:07');
  });

  it('renders a 12-hour time range', () => {
    expect(
      formatTimeRange(
        new Date(2026, 5, 17, 9, 5).toISOString(),
        new Date(2026, 5, 17, 13, 30).toISOString()
      )
    ).toBe('9:05 AM - 1:30 PM');
  });

  it('maps appointment statuses to themed classes and falls back for unknowns', () => {
    expect(getStatusColor('scheduled').border).toBe('border-l-hud-gold');
    expect(getStatusColor('completed').text).toBe('text-hud-emerald');
    expect(getStatusColor('no_show').bg).toBe('bg-hud-plum/20');
    expect(getStatusColor('canceled')).toEqual(getStatusColor('something-else'));
  });
});

describe('getDateRangeForView', () => {
  it('spans the day, the week, and the padded month grid', () => {
    const day = getDateRangeForView(wednesday, 'day');
    expect(day.startDate).toBe(new Date(2026, 5, 17).toISOString());
    expect(day.endDate).toBe(new Date(2026, 5, 17, 23, 59, 59, 999).toISOString());

    const week = getDateRangeForView(wednesday, 'week');
    expect(week.startDate).toBe(new Date(2026, 5, 15).toISOString());
    expect(week.endDate).toBe(new Date(2026, 5, 21, 23, 59, 59, 999).toISOString());

    const month = getDateRangeForView(wednesday, 'month');
    expect(month.startDate).toBe(new Date(2026, 5, 1).toISOString());
    expect(month.endDate).toBe(new Date(2026, 6, 5, 23, 59, 59, 999).toISOString());
  });

  it('falls back to the day range for an unknown view type', () => {
    expect(getDateRangeForView(wednesday, 'quarter' as 'day')).toEqual(
      getDateRangeForView(wednesday, 'day')
    );
  });
});

describe('layoutOverlapping', () => {
  const ev = (id: string, s: string, e: string) => ({ id, startTime: `2026-11-11T${s}:00`, endTime: `2026-11-11T${e}:00` });

  it('puts overlapping events in side-by-side columns', () => {
    const lanes = layoutOverlapping([ev('a', '10:30', '11:30'), ev('b', '10:30', '11:30'), ev('c', '10:45', '11:00')]);
    expect(lanes.get('a')).toEqual({ column: 0, columns: 3 });
    expect(lanes.get('b')).toEqual({ column: 1, columns: 3 });
    expect(lanes.get('c')).toEqual({ column: 2, columns: 3 });
  });

  it('leaves non-overlapping events full width and reuses a freed column', () => {
    const lanes = layoutOverlapping([ev('a', '09:00', '10:00'), ev('b', '09:30', '10:30'), ev('c', '10:00', '11:00'), ev('d', '13:00', '14:00')]);
    expect(lanes.get('d')).toEqual({ column: 0, columns: 1 });
    expect(lanes.get('c')).toEqual({ column: 0, columns: 2 }); // takes the column a freed
    expect(lanes.get('b')).toEqual({ column: 1, columns: 2 });
  });

  it('gives a very short event the room of its minimum height', () => {
    const lanes = layoutOverlapping([ev('a', '10:00', '10:05'), ev('b', '10:10', '11:00')]);
    expect(lanes.get('a')?.columns).toBe(2);
  });

  it('laneStyle is empty for a lone event and splits the width otherwise', () => {
    expect(laneStyle({ column: 0, columns: 1 })).toEqual({});
    expect(laneStyle({ column: 1, columns: 2 })).toEqual({ left: 'calc(50% + 2px)', width: 'calc(50% - 4px)', right: 'auto' });
  });
});
