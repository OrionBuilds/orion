import { describe, expect, it } from 'vitest';
import type {
  Appointment,
  BlockedSlot,
  CalendarEvent,
  CalendarTask,
  GoogleCalendarEvent,
} from '../types';
import {
  appointmentToDisplayItem,
  blockedSlotToDisplayItem,
  calendarEventToDisplayItem,
  calendarTaskToDisplayItem,
  googleEventToDisplayItem,
  mergeDisplayItems,
} from './calendarDisplayItems';

function appointment(overrides: Partial<Appointment> = {}): Appointment {
  return {
    id: 'apt-1',
    start_at_utc: '2026-06-15T10:00:00Z',
    end_at_utc: '2026-06-15T11:00:00Z',
    ...overrides,
  } as unknown as Appointment;
}

describe('appointmentToDisplayItem', () => {
  it('titles the item with the contact name when present', () => {
    const item = appointmentToDisplayItem(
      appointment({ contact: { first_name: 'Ann', last_name: 'Lee' } } as Partial<Appointment>)
    );
    expect(item).toMatchObject({ id: 'apt-1', title: 'Ann Lee', source: 'crm', allDay: false });
  });

  it('falls back to the booking answer name, then notes, then Guest', () => {
    expect(appointmentToDisplayItem(appointment({ answers: { name: 'Walk-in', email: 'walkin@example.test' } })).title).toBe(
      'Walk-in'
    );
    expect(appointmentToDisplayItem(appointment({ notes: 'Follow-up call' })).title).toBe(
      'Follow-up call'
    );
    expect(appointmentToDisplayItem(appointment()).title).toBe('Guest');
  });
});

describe('single-source converters', () => {
  it('maps google events, defaulting an empty summary', () => {
    const evt = {
      id: 'g-1',
      summary: 'Standup',
      start_time: '2026-06-15T09:00:00Z',
      end_time: '2026-06-15T09:15:00Z',
      all_day: false,
    } as unknown as GoogleCalendarEvent;
    expect(googleEventToDisplayItem(evt)).toMatchObject({ title: 'Standup', source: 'google' });
    expect(googleEventToDisplayItem({ ...evt, summary: '' }).title).toBe('(No title)');
  });

  it('maps blocked slots, defaulting the title', () => {
    const slot = {
      id: 'b-1',
      start_at_utc: '2026-06-15T12:00:00Z',
      end_at_utc: '2026-06-15T13:00:00Z',
      all_day: false,
    } as unknown as BlockedSlot;
    expect(blockedSlotToDisplayItem(slot)).toMatchObject({ title: 'Blocked', source: 'blocked' });
    expect(blockedSlotToDisplayItem({ ...slot, title: 'PTO' }).title).toBe('PTO');
  });

  it('maps calendar events', () => {
    const evt = {
      id: 'e-1',
      title: 'Review',
      start_at_utc: '2026-06-15T14:00:00Z',
      end_at_utc: '2026-06-15T15:00:00Z',
      all_day: true,
    } as unknown as CalendarEvent;
    expect(calendarEventToDisplayItem(evt)).toMatchObject({
      title: 'Review',
      source: 'event',
      allDay: true,
    });
  });

  it('derives a task end time from its duration, defaulting to 30 minutes', () => {
    const task = {
      id: 't-1',
      title: 'Send quote',
      due_at_utc: '2026-06-15T16:00:00Z',
    } as unknown as CalendarTask;
    expect(calendarTaskToDisplayItem(task)).toMatchObject({
      source: 'task',
      endTime: '2026-06-15T16:30:00.000Z',
    });
    expect(calendarTaskToDisplayItem({ ...task, duration_minutes: 90 }).endTime).toBe(
      '2026-06-15T17:30:00.000Z'
    );
  });
});

describe('mergeDisplayItems', () => {
  it('merges every source sorted by start time', () => {
    const items = mergeDisplayItems(
      [appointment({ id: 'apt-late', start_at_utc: '2026-06-15T18:00:00Z' })],
      [
        {
          id: 'g-1',
          summary: 'Standup',
          start_time: '2026-06-15T09:00:00Z',
          end_time: '2026-06-15T09:15:00Z',
          all_day: false,
        } as unknown as GoogleCalendarEvent,
      ],
      [
        {
          id: 'b-1',
          start_at_utc: '2026-06-15T12:00:00Z',
          end_at_utc: '2026-06-15T13:00:00Z',
          all_day: false,
        } as unknown as BlockedSlot,
      ],
      [
        {
          id: 'e-1',
          title: 'Review',
          start_at_utc: '2026-06-15T14:00:00Z',
          end_at_utc: '2026-06-15T15:00:00Z',
          all_day: false,
        } as unknown as CalendarEvent,
      ],
      [
        {
          id: 't-1',
          title: 'Send quote',
          due_at_utc: '2026-06-15T10:00:00Z',
        } as unknown as CalendarTask,
      ]
    );

    expect(items.map((i) => i.id)).toEqual(['g-1', 't-1', 'b-1', 'e-1', 'apt-late']);
  });

  it('drops appointments already represented by a synced google event', () => {
    const synced = appointment({ id: 'apt-synced', google_event_id: 'g-1' });
    const unsynced = appointment({ id: 'apt-plain' });
    const googleEvent = {
      id: 'g-row-1',
      google_event_id: 'g-1',
      summary: 'Synced',
      start_time: '2026-06-15T08:00:00Z',
      end_time: '2026-06-15T08:30:00Z',
      all_day: false,
    } as unknown as GoogleCalendarEvent;

    expect(mergeDisplayItems([synced, unsynced], [googleEvent], []).map((i) => i.id)).toEqual([
      'g-row-1',
      'apt-plain',
    ]);
  });

  it('keeps all appointments when there are no google events', () => {
    expect(
      mergeDisplayItems([appointment({ google_event_id: 'g-1' })], [], []).map((i) => i.id)
    ).toEqual(['apt-1']);
  });
});
