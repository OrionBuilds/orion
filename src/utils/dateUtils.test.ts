import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { formatDate, formatDistanceToNow, formatTime } from './dateUtils';

const NOW = new Date('2026-06-15T12:00:00Z');

function ago(ms: number): Date {
  return new Date(NOW.getTime() - ms);
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

describe('formatDistanceToNow', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('reports sub-minute distances as "just now"', () => {
    expect(formatDistanceToNow(NOW)).toBe('just now');
    expect(formatDistanceToNow(ago(59_000))).toBe('just now');
  });

  it('reports minutes, hours, and days', () => {
    expect(formatDistanceToNow(ago(MINUTE))).toBe('1m ago');
    expect(formatDistanceToNow(ago(59 * MINUTE))).toBe('59m ago');
    expect(formatDistanceToNow(ago(HOUR))).toBe('1h ago');
    expect(formatDistanceToNow(ago(23 * HOUR))).toBe('23h ago');
    expect(formatDistanceToNow(ago(DAY))).toBe('1d ago');
    expect(formatDistanceToNow(ago(6 * DAY))).toBe('6d ago');
  });

  it('reports weeks, months, and years', () => {
    expect(formatDistanceToNow(ago(7 * DAY))).toBe('1w ago');
    expect(formatDistanceToNow(ago(27 * DAY))).toBe('3w ago');
    expect(formatDistanceToNow(ago(60 * DAY))).toBe('2mo ago');
    expect(formatDistanceToNow(ago(400 * DAY))).toBe('1y ago');
  });
});

describe('formatTime', () => {
  it('formats as 12-hour time with minutes', () => {
    expect(formatTime(new Date(2026, 5, 15, 14, 5))).toBe('2:05 PM');
    expect(formatTime(new Date(2026, 5, 15, 0, 30))).toBe('12:30 AM');
  });
});

describe('formatDate', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 5, 15, 12, 0, 0));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('labels today and yesterday', () => {
    expect(formatDate(new Date(2026, 5, 15, 8, 0))).toBe('Today');
    expect(formatDate(new Date(2026, 5, 14, 23, 0))).toBe('Yesterday');
  });

  it('uses the weekday name within the last week', () => {
    expect(formatDate(new Date(2026, 5, 11))).toBe('Thursday');
  });

  it('uses a month/day label for older dates in the current year', () => {
    expect(formatDate(new Date(2026, 0, 3))).toBe('Jan 3');
  });

  it('includes the year for dates in other years', () => {
    expect(formatDate(new Date(2024, 0, 3))).toBe('Jan 3, 2024');
  });
});
