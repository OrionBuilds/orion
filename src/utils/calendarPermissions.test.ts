import { describe, expect, it } from 'vitest';
import type { Calendar, CalendarMember, UserWithDetails } from '../types';
import {
  canDeleteCalendar,
  canManageAppointmentType,
  canManageAvailability,
  canManageCalendar,
  canToggleCalendarStatus,
  canViewCalendar,
  getManageableCalendars,
  getViewableCalendars,
  isCalendarOwner,
  isInSameDepartment,
} from './calendarPermissions';

function member(userId: string): CalendarMember {
  return { user_id: userId } as unknown as CalendarMember;
}

function user(permissions: string[], overrides: Partial<UserWithDetails> = {}): UserWithDetails {
  return {
    id: 'u-1',
    department_id: 'd-1',
    permissions,
    ...overrides,
  } as unknown as UserWithDetails;
}

function calendar(overrides: Partial<Calendar> = {}): Calendar {
  return {
    id: 'cal-1',
    type: 'user',
    owner_user_id: 'u-1',
    department_id: 'd-1',
    ...overrides,
  } as unknown as Calendar;
}

const appointmentType = { id: 'at-1' } as never;

describe('canManageCalendar', () => {
  it('denies anonymous users', () => {
    expect(canManageCalendar(null, calendar())).toBe(false);
  });

  it('allows global calendar managers', () => {
    expect(
      canManageCalendar(user(['calendars.manage_all']), calendar({ owner_user_id: 'other' }))
    ).toBe(true);
  });

  it('allows department managers only within their department', () => {
    const manager = user(['calendars.manage_department']);
    expect(canManageCalendar(manager, calendar({ owner_user_id: 'other' }))).toBe(true);
    expect(
      canManageCalendar(manager, calendar({ owner_user_id: 'other', department_id: 'd-2' }))
    ).toBe(false);
    expect(
      canManageCalendar(manager, calendar({ owner_user_id: 'other', department_id: undefined }))
    ).toBe(false);
  });

  it('allows owners of their own user calendar', () => {
    const owner = user(['calendars.manage_own']);
    expect(canManageCalendar(owner, calendar())).toBe(true);
    expect(canManageCalendar(owner, calendar({ owner_user_id: 'other' }))).toBe(false);
    expect(canManageCalendar(owner, calendar({ type: 'team' }))).toBe(false);
  });

  it('denies users without any calendar permission', () => {
    expect(canManageCalendar(user([]), calendar())).toBe(false);
  });
});

describe('canManageAppointmentType', () => {
  it('requires both a user and a calendar', () => {
    expect(canManageAppointmentType(null, appointmentType, calendar())).toBe(false);
    expect(
      canManageAppointmentType(user(['appointment_types.manage_all']), appointmentType, null)
    ).toBe(false);
  });

  it('honors global, department, and own scopes', () => {
    expect(
      canManageAppointmentType(
        user(['appointment_types.manage_all']),
        appointmentType,
        calendar({ owner_user_id: 'other', department_id: 'd-9' })
      )
    ).toBe(true);
    expect(
      canManageAppointmentType(
        user(['appointment_types.manage_department']),
        appointmentType,
        calendar({ owner_user_id: 'other' })
      )
    ).toBe(true);
    expect(
      canManageAppointmentType(
        user(['appointment_types.manage_own']),
        appointmentType,
        calendar()
      )
    ).toBe(true);
    expect(canManageAppointmentType(user([]), appointmentType, calendar())).toBe(false);
  });
});

describe('canManageAvailability', () => {
  it('denies anonymous users and users without permissions', () => {
    expect(canManageAvailability(null, calendar())).toBe(false);
    expect(canManageAvailability(user([]), calendar())).toBe(false);
  });

  it('allows department availability managers in their own department', () => {
    expect(
      canManageAvailability(
        user(['availability.manage_department']),
        calendar({ owner_user_id: 'other' })
      )
    ).toBe(true);
  });

  it('allows department managers outside their department only with manage_all', () => {
    const otherDept = calendar({ owner_user_id: 'other', department_id: 'd-2' });
    expect(canManageAvailability(user(['availability.manage_department']), otherDept)).toBe(false);
    expect(
      canManageAvailability(
        user(['availability.manage_department', 'calendars.manage_all']),
        otherDept
      )
    ).toBe(true);
  });

  it('allows owners of their own user calendar', () => {
    expect(canManageAvailability(user(['availability.manage_own']), calendar())).toBe(true);
    expect(
      canManageAvailability(user(['availability.manage_own']), calendar({ type: 'team' }))
    ).toBe(false);
  });
});

describe('ownership and department helpers', () => {
  it('detects ownership of user calendars only', () => {
    expect(isCalendarOwner(user([]), calendar())).toBe(true);
    expect(isCalendarOwner(user([]), calendar({ type: 'team' }))).toBe(false);
    expect(isCalendarOwner(null, calendar())).toBe(false);
  });

  it('detects shared departments, requiring both sides to be set', () => {
    expect(isInSameDepartment(user([]), calendar())).toBe(true);
    expect(isInSameDepartment(user([]), calendar({ department_id: 'd-2' }))).toBe(false);
    expect(isInSameDepartment(user([], { department_id: undefined }), calendar())).toBe(false);
    expect(isInSameDepartment(user([]), calendar({ department_id: undefined }))).toBe(false);
    expect(isInSameDepartment(null, calendar())).toBe(false);
  });
});

describe('canViewCalendar', () => {
  it('requires the base calendars.view permission', () => {
    expect(canViewCalendar(null, calendar())).toBe(false);
    expect(canViewCalendar(user(['calendars.manage_all']), calendar())).toBe(false);
  });

  it('allows viewing own, department, and team-member calendars', () => {
    expect(canViewCalendar(user(['calendars.view']), calendar())).toBe(true);
    expect(
      canViewCalendar(
        user(['calendars.view', 'calendars.manage_department']),
        calendar({ owner_user_id: 'other' })
      )
    ).toBe(true);
    expect(
      canViewCalendar(
        user(['calendars.view']),
        calendar({ type: 'team', owner_user_id: 'other', members: [member('u-1')] })
      )
    ).toBe(true);
  });

  it('denies unrelated calendars', () => {
    expect(
      canViewCalendar(
        user(['calendars.view']),
        calendar({ type: 'team', owner_user_id: 'other', department_id: 'd-2', members: [] })
      )
    ).toBe(false);
  });
});

describe('calendar list filters', () => {
  const calendars = [
    calendar({ id: 'own' }),
    calendar({ id: 'other-dept', owner_user_id: 'other', department_id: 'd-2' }),
  ];

  it('returns nothing for anonymous users', () => {
    expect(getManageableCalendars(null, calendars)).toEqual([]);
    expect(getViewableCalendars(null, calendars)).toEqual([]);
  });

  it('filters manageable calendars by permission', () => {
    expect(
      getManageableCalendars(user(['calendars.manage_own']), calendars).map((c) => c.id)
    ).toEqual(['own']);
  });

  it('short-circuits viewable calendars for global managers', () => {
    expect(getViewableCalendars(user(['calendars.manage_all']), calendars)).toEqual(calendars);
    expect(getViewableCalendars(user(['calendars.view']), calendars).map((c) => c.id)).toEqual([
      'own',
    ]);
  });
});

describe('delete and status toggles', () => {
  it('mirror manage permissions', () => {
    const owner = user(['calendars.manage_own']);
    expect(canDeleteCalendar(owner, calendar())).toBe(true);
    expect(canToggleCalendarStatus(owner, calendar())).toBe(true);
    expect(canDeleteCalendar(user([]), calendar())).toBe(false);
    expect(canToggleCalendarStatus(user([]), calendar())).toBe(false);
  });
});
