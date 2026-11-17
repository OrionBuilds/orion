import { describe, expect, it } from 'vitest';
import {
  buildIcs,
  escapeIcsText,
  foldIcsLine,
  googleCalendarUrl,
  outlookCalendarUrl,
  toIcsUtc,
  type CalendarInviteEvent,
} from '../../supabase/functions/_shared/calendar-invite';

const event: CalendarInviteEvent = {
  uid: 'appt-123@app.example.com',
  title: 'Capability Briefing, with Jordan; 30 min',
  start: '2026-10-29T14:00:00.000Z',
  end: '2026-10-29T14:30:00.000Z',
  description: 'Join: https://meet.google.com/abc-defg-hij\nReschedule: https://app.example.com/r/x',
  url: 'https://meet.google.com/abc-defg-hij',
  organizer: { name: 'Jordan Example', email: 'jordan@example.com' },
  now: new Date('2026-10-28T12:00:00.000Z'),
};

const octets = (s: string) => new TextEncoder().encode(s).length;

describe('toIcsUtc / escapeIcsText', () => {
  it('formats UTC in basic format', () => {
    expect(toIcsUtc('2026-10-29T14:00:00.000Z')).toBe('20261029T140000Z');
    expect(toIcsUtc(new Date('2026-01-02T03:04:05Z'))).toBe('20260102T030405Z');
  });

  it('escapes backslashes, semicolons, commas and newlines', () => {
    expect(escapeIcsText('a\\b;c,d\ne\r\nf')).toBe('a\\\\b\\;c\\,d\\ne\\nf');
  });
});

describe('foldIcsLine', () => {
  it('leaves short lines alone', () => {
    expect(foldIcsLine('SUMMARY:short')).toBe('SUMMARY:short');
  });

  it('folds long lines to <= 75 octets with CRLF + space, without splitting multi-byte characters', () => {
    const line = `DESCRIPTION:${'é'.repeat(60)}${'x'.repeat(100)}`;
    const folded = foldIcsLine(line);
    const physical = folded.split('\r\n');
    expect(physical.length).toBeGreaterThan(1);
    for (const p of physical) expect(octets(p)).toBeLessThanOrEqual(75);
    physical.slice(1).forEach((p) => expect(p.startsWith(' ')).toBe(true));
    expect(physical.map((p, i) => (i === 0 ? p : p.slice(1))).join('')).toBe(line);
  });
});

describe('buildIcs', () => {
  const ics = buildIcs(event);
  const unfolded = ics.replace(/\r\n /g, '');

  it('is a CRLF-delimited VCALENDAR with one VEVENT', () => {
    expect(ics.startsWith('BEGIN:VCALENDAR\r\n')).toBe(true);
    expect(ics.endsWith('END:VCALENDAR\r\n')).toBe(true);
    expect(ics.replace(/\r\n/g, '')).not.toContain('\n');
    expect(unfolded).toContain('BEGIN:VEVENT\r\n');
    expect(unfolded).toContain('METHOD:PUBLISH');
  });

  it('writes UID, DTSTAMP, UTC times, escaped text, meeting link and organizer', () => {
    expect(unfolded).toContain('UID:appt-123@app.example.com');
    expect(unfolded).toContain('DTSTAMP:20261028T120000Z');
    expect(unfolded).toContain('DTSTART:20261029T140000Z');
    expect(unfolded).toContain('DTEND:20261029T143000Z');
    expect(unfolded).toContain('SUMMARY:Capability Briefing\\, with Jordan\\; 30 min');
    expect(unfolded).toContain('DESCRIPTION:Join: https://meet.google.com/abc-defg-hij\\nReschedule:');
    expect(unfolded).toContain('LOCATION:https://meet.google.com/abc-defg-hij');
    expect(unfolded).toContain('URL:https://meet.google.com/abc-defg-hij');
    expect(unfolded).toContain('ORGANIZER;CN="Jordan Example":mailto:jordan@example.com');
  });

  it('keeps every physical line within 75 octets', () => {
    for (const line of ics.split('\r\n')) expect(octets(line)).toBeLessThanOrEqual(75);
  });

  it('adds METHOD:REQUEST and the attendee for emailed invites', () => {
    const req = buildIcs({ ...event, method: 'REQUEST', attendee: { name: 'Pat', email: 'pat@example.com' } }).replace(/\r\n /g, '');
    expect(req).toContain('METHOD:REQUEST');
    expect(req).toContain('ATTENDEE;CN="Pat";ROLE=REQ-PARTICIPANT;PARTSTAT=ACCEPTED;RSVP=FALSE:mailto:pat@example.com');
  });
});

describe('add-to-calendar links', () => {
  it('builds a Google Calendar template link', () => {
    const url = new URL(googleCalendarUrl(event));
    expect(url.origin + url.pathname).toBe('https://calendar.google.com/calendar/render');
    expect(url.searchParams.get('action')).toBe('TEMPLATE');
    expect(url.searchParams.get('text')).toBe(event.title);
    expect(url.searchParams.get('dates')).toBe('20261029T140000Z/20261029T143000Z');
    expect(url.searchParams.get('details')).toBe(event.description);
    expect(url.searchParams.get('location')).toBe('https://meet.google.com/abc-defg-hij');
  });

  it('builds Outlook.com and Microsoft 365 compose links', () => {
    const live = new URL(outlookCalendarUrl(event, 'live'));
    const office = new URL(outlookCalendarUrl(event, 'office'));
    expect(live.origin + live.pathname).toBe('https://outlook.live.com/calendar/0/deeplink/compose');
    expect(office.origin + office.pathname).toBe('https://outlook.office.com/calendar/0/deeplink/compose');
    for (const u of [live, office]) {
      expect(u.searchParams.get('subject')).toBe(event.title);
      expect(u.searchParams.get('startdt')).toBe('2026-10-29T14:00:00Z');
      expect(u.searchParams.get('enddt')).toBe('2026-10-29T14:30:00Z');
      expect(u.searchParams.get('body')).toBe(event.description);
      expect(u.searchParams.get('location')).toBe('https://meet.google.com/abc-defg-hij');
    }
  });

  it('prefers an explicit location over the meeting link', () => {
    const url = new URL(googleCalendarUrl({ ...event, location: '123 Main St, Austin' }));
    expect(url.searchParams.get('location')).toBe('123 Main St, Austin');
  });
});
