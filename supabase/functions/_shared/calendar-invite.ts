/**
 * Calendar invite helpers shared by the public booking page (src/pages/public/BookingPage.tsx) and
 * the booking-email edge function: an RFC 5545 .ics builder plus "add to calendar" deep links for
 * Google Calendar and Outlook (Outlook.com / Microsoft 365). Pure functions, no Deno or DOM APIs.
 */

export interface CalendarInviteEvent {
  /** Globally unique id, e.g. `<appointment id>@orion.invalid`. Same UID = same event on re-import. */
  uid: string;
  title: string;
  /** ISO timestamps (or Dates); always written in UTC. */
  start: string | Date;
  end: string | Date;
  description?: string | null;
  location?: string | null;
  /** Meeting link (Google Meet etc.); written as URL and used as LOCATION when none is given. */
  url?: string | null;
  organizer?: { name?: string | null; email: string } | null;
  attendee?: { name?: string | null; email: string } | null;
  /** PUBLISH for a downloadable file; REQUEST for an emailed invite (needs organizer + attendee). */
  method?: 'PUBLISH' | 'REQUEST';
  /** DTSTAMP override (tests); defaults to now. */
  now?: Date;
}

/** 2026-10-29T14:00:00.000Z -> 20261029T140000Z (iCalendar / Google "basic" UTC format). */
export function toIcsUtc(value: string | Date): string {
  return new Date(value).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}

/** Escape a TEXT value (RFC 5545 3.3.11): backslash, semicolon, comma and newlines. */
export function escapeIcsText(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r\n|\r|\n/g, '\\n');
}

function escapeParam(value: string): string {
  // Parameter values may not contain DQUOTE; quote them so ':' ';' ',' are allowed.
  return `"${value.replace(/"/g, "'")}"`;
}

const encoder = new TextEncoder();

/** Fold a content line to at most 75 octets per physical line (RFC 5545 3.1), never splitting a character. */
export function foldIcsLine(line: string): string {
  if (encoder.encode(line).length <= 75) return line;
  const parts: string[] = [];
  let current = '';
  let currentBytes = 0;
  for (const char of line) {
    const bytes = encoder.encode(char).length;
    // Continuation lines start with a space, which counts toward their 75 octets.
    const limit = parts.length === 0 ? 75 : 74;
    if (currentBytes + bytes > limit) {
      parts.push(current);
      current = '';
      currentBytes = 0;
    }
    current += char;
    currentBytes += bytes;
  }
  parts.push(current);
  return parts.join('\r\n ');
}

export function buildIcs(event: CalendarInviteEvent): string {
  const method = event.method ?? 'PUBLISH';
  const location = event.location || event.url || '';
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Orion//Booking//EN',
    'CALSCALE:GREGORIAN',
    `METHOD:${method}`,
    'BEGIN:VEVENT',
    `UID:${event.uid}`,
    `DTSTAMP:${toIcsUtc(event.now ?? new Date())}`,
    `DTSTART:${toIcsUtc(event.start)}`,
    `DTEND:${toIcsUtc(event.end)}`,
    `SUMMARY:${escapeIcsText(event.title)}`,
  ];
  if (event.description) lines.push(`DESCRIPTION:${escapeIcsText(event.description)}`);
  if (location) lines.push(`LOCATION:${escapeIcsText(location)}`);
  if (event.url) lines.push(`URL:${event.url}`);
  if (event.organizer?.email) {
    const cn = event.organizer.name ? `;CN=${escapeParam(event.organizer.name)}` : '';
    lines.push(`ORGANIZER${cn}:mailto:${event.organizer.email}`);
  }
  if (event.attendee?.email) {
    const cn = event.attendee.name ? `;CN=${escapeParam(event.attendee.name)}` : '';
    lines.push(`ATTENDEE${cn};ROLE=REQ-PARTICIPANT;PARTSTAT=ACCEPTED;RSVP=FALSE:mailto:${event.attendee.email}`);
  }
  lines.push('SEQUENCE:0', 'STATUS:CONFIRMED', 'TRANSP:OPAQUE', 'END:VEVENT', 'END:VCALENDAR');
  return lines.map(foldIcsLine).join('\r\n') + '\r\n';
}

/** Google Calendar "create event" template link. */
export function googleCalendarUrl(event: CalendarInviteEvent): string {
  const params = new URLSearchParams({
    action: 'TEMPLATE',
    text: event.title,
    dates: `${toIcsUtc(event.start)}/${toIcsUtc(event.end)}`,
  });
  if (event.description) params.set('details', event.description);
  const location = event.location || event.url;
  if (location) params.set('location', location);
  return `https://calendar.google.com/calendar/render?${params.toString()}`;
}

/** Outlook compose deep link: 'live' = Outlook.com (personal), 'office' = Microsoft 365 (work/school). */
export function outlookCalendarUrl(event: CalendarInviteEvent, host: 'live' | 'office'): string {
  const params = new URLSearchParams({
    path: '/calendar/action/compose',
    rru: 'addevent',
    subject: event.title,
    startdt: new Date(event.start).toISOString().replace(/\.\d{3}Z$/, 'Z'),
    enddt: new Date(event.end).toISOString().replace(/\.\d{3}Z$/, 'Z'),
  });
  if (event.description) params.set('body', event.description);
  const location = event.location || event.url;
  if (location) params.set('location', location);
  const origin = host === 'live' ? 'https://outlook.live.com' : 'https://outlook.office.com';
  return `${origin}/calendar/0/deeplink/compose?${params.toString()}`;
}
