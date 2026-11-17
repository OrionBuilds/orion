/**
 * Union of the two personal-calendar mirrors (google_calendar_events + microsoft_calendar_events)
 * in one provider-tagged shape, for readers that don't care which provider an event lives in
 * (assistant schedule queries, summaries). Pure — callers do the two selects.
 */
import type { WorkspaceProvider } from "./provider.ts";

export interface UnifiedCalendarEvent {
  id: string;
  provider: WorkspaceProvider;
  /** The provider-side event id (Google event id / Graph event id) — what update/cancel need. */
  event_id: string;
  summary: string | null;
  location: string | null;
  start_time: string;
  end_time: string;
  all_day: boolean;
  status: string | null;
  attendees: unknown;
  hangout_link: string | null;
}

export const GOOGLE_EVENT_COLUMNS =
  "id, google_event_id, summary, location, start_time, end_time, all_day, status, attendees, hangout_link";
export const MS_EVENT_COLUMNS =
  "id, graph_event_id, title, location, start_time, end_time, all_day, status, attendees, online_meeting_url";

// deno-lint-ignore no-explicit-any
type Row = Record<string, any>;

export function fromGoogleRow(r: Row): UnifiedCalendarEvent {
  return {
    id: r.id, provider: "google", event_id: r.google_event_id, summary: r.summary ?? null,
    location: r.location ?? null, start_time: r.start_time, end_time: r.end_time, all_day: !!r.all_day,
    status: r.status ?? null, attendees: r.attendees ?? [], hangout_link: r.hangout_link ?? null,
  };
}

export function fromMicrosoftRow(r: Row): UnifiedCalendarEvent {
  return {
    id: r.id, provider: "microsoft", event_id: r.graph_event_id, summary: r.title ?? null,
    location: r.location ?? null, start_time: r.start_time, end_time: r.end_time, all_day: !!r.all_day,
    status: r.status ?? null, attendees: r.attendees ?? [], hangout_link: r.online_meeting_url ?? null,
  };
}

/** Merge both mirrors, drop cancelled events, sort by start, cap at `limit`. */
export function unionCalendarEvents(googleRows: Row[], msRows: Row[], limit = 50): UnifiedCalendarEvent[] {
  return [...googleRows.map(fromGoogleRow), ...msRows.map(fromMicrosoftRow)]
    .filter((e) => e.status !== "cancelled" && e.start_time)
    .sort((a, b) => Date.parse(a.start_time) - Date.parse(b.start_time))
    .slice(0, limit);
}

/**
 * Which provider an event id belongs to, judged by the mirrors: returns the provider whose mirror
 * row (for this user) holds the id, else null (caller falls back to the user's provider).
 */
export function providerForEventId(
  eventId: string,
  googleIds: string[],
  msIds: string[],
): WorkspaceProvider | null {
  if (msIds.includes(eventId)) return "microsoft";
  if (googleIds.includes(eventId)) return "google";
  return null;
}
