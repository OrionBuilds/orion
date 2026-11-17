/**
 * Microsoft Graph calendar -> `microsoft_calendar_events`.
 *
 * Stateless window sync: every run fetches the calendarView for [now-1d, now+60d] (recurrences
 * already expanded by Graph), upserts it, then deletes mirror rows inside the same window that
 * Graph no longer returns. Deletion only happens after the fetch completed in full, so a
 * mid-run failure can never wipe availability.
 */
import type { SupabaseClient } from "npm:@supabase/supabase-js@2";
import { graphFetch, resolveMsConnection } from "./ms-graph.ts";

/** Who/what a calendar call acts for. `connectionId` picks one of the user's Microsoft accounts (default: the primary). */
export interface CalendarCtx { orgId: string; userId: string; connectionId?: string | null }

/**
 * The connection_id every mirror row, reconcile and delete is scoped to. A named connection must belong to
 * ctx.userId (else this throws; it never falls back to another account); no name = the user's primary.
 */
export async function calendarConnectionId(supabase: SupabaseClient, ctx: { userId: string; connectionId?: string | null }): Promise<string> {
  const conn = await resolveMsConnection(supabase, ctx.userId, { connectionId: ctx.connectionId || undefined });
  if (!conn) throw new Error(ctx.connectionId ? "That Microsoft account is not connected for this user" : "Microsoft is not connected for this user");
  return conn.id;
}

/**
 * Write mirror rows without ON CONFLICT: the unique key is (user_id, graph_event_id) before migration step 2 and
 * (connection_id, graph_event_id) after it, so this looks rows up by (connection_id, graph_event_id) and
 * inserts or updates explicitly. Unchanged rows are not rewritten.
 */
export async function writeMirrorRows(supabase: SupabaseClient, connectionId: string, rows: NonNullable<ReturnType<typeof toMirrorRow>>[]): Promise<void> {
  for (let i = 0; i < rows.length; i += 200) {
    const chunk = rows.slice(i, i + 200).map((r) => ({ ...r, connection_id: connectionId }));
    const { data: existing, error: selErr } = await supabase.from("microsoft_calendar_events").select("*")
      .eq("connection_id", connectionId).in("graph_event_id", chunk.map((r) => r.graph_event_id));
    if (selErr) throw new Error(`calendar upsert failed: ${selErr.message}`);
    const byId = new Map(((existing ?? []) as Record<string, unknown>[]).map((x) => [x.graph_event_id as string, x]));
    const inserts: typeof chunk = [];
    for (const r of chunk) {
      const old = byId.get(r.graph_event_id);
      if (!old) { inserts.push(r); continue; }
      const { updated_at: _u, ...fields } = r;
      const same = Object.entries(fields).every(([k, v]) => JSON.stringify(old[k] ?? null) === JSON.stringify(v ?? null) ||
        (k.endsWith("_time") && Date.parse(String(old[k])) === Date.parse(String(v))));
      if (same) continue;
      const { error } = await supabase.from("microsoft_calendar_events").update(r).eq("id", old.id as string);
      if (error) throw new Error(`calendar upsert failed: ${error.message}`);
    }
    if (inserts.length) {
      const { error } = await supabase.from("microsoft_calendar_events").insert(inserts);
      if (error) throw new Error(`calendar upsert failed: ${error.message}`);
    }
  }
}

export interface GraphEvent {
  id: string;
  iCalUId?: string;
  subject?: string;
  isCancelled?: boolean;
  isAllDay?: boolean;
  showAs?: "free" | "tentative" | "busy" | "oof" | "workingElsewhere" | "unknown";
  start?: { dateTime: string; timeZone?: string };
  end?: { dateTime: string; timeZone?: string };
  location?: { displayName?: string };
  organizer?: { emailAddress?: { address?: string } };
  attendees?: { emailAddress?: { address?: string; name?: string }; status?: { response?: string } }[];
  onlineMeeting?: { joinUrl?: string } | null;
  isOnlineMeeting?: boolean;
  onlineMeetingProvider?: string;
  webLink?: string;
}

/** Graph returns naive local datetimes plus a zone; we request UTC so they are UTC. */
const utc = (dt: string) => new Date(dt.endsWith("Z") ? dt : `${dt}Z`).toISOString();

export function toMirrorRow(e: GraphEvent, orgId: string, userId: string, connectionId?: string | null) {
  if (!e.start?.dateTime || !e.end?.dateTime) return null;
  return {
    organization_id: orgId,
    user_id: userId,
    connection_id: connectionId ?? null,
    graph_event_id: e.id,
    ical_uid: e.iCalUId ?? null,
    title: e.subject ?? null,
    location: e.location?.displayName || null,
    start_time: utc(e.start.dateTime),
    end_time: utc(e.end.dateTime),
    all_day: !!e.isAllDay,
    status: e.isCancelled ? "cancelled" : e.showAs === "tentative" ? "tentative" : "confirmed",
    // free = shown as available; everything else (busy/oof/workingElsewhere/tentative) blocks.
    transparency: e.showAs === "free" ? "transparent" : "opaque",
    organizer_email: e.organizer?.emailAddress?.address?.toLowerCase() ?? null,
    attendees: (e.attendees ?? []).map((a) => ({
      email: a.emailAddress?.address?.toLowerCase(),
      name: a.emailAddress?.name,
      response: a.status?.response,
    })),
    online_meeting_url: e.onlineMeeting?.joinUrl ?? null,
    is_online_meeting: !!e.isOnlineMeeting || !!e.onlineMeeting?.joinUrl,
    online_meeting_provider: e.onlineMeetingProvider && e.onlineMeetingProvider !== "unknown" ? e.onlineMeetingProvider : null,
    web_link: e.webLink ?? null,
    updated_at: new Date().toISOString(),
  };
}

/** Calendars that are noise for availability and agendas (Outlook's generated ones). */
export const SKIP_CALENDAR = /^(birthdays|.*\bholidays)$/i;

/**
 * The user's calendars to mirror: the default one plus any other calendar in the mailbox
 * (secondary calendars and subscribed/shared ones such as an imported Google or ICS feed), minus
 * generated noise. /me/calendarView only covers the DEFAULT calendar, so a user whose real events
 * live in another calendar used to mirror nothing. Null = the list couldn't be read.
 */
export async function listCalendarIds(accessToken: string, fetchImpl?: typeof fetch): Promise<string[] | null> {
  const r = await graphFetch(accessToken, "/me/calendars?$select=id,name,isDefaultCalendar&$top=50", {}, fetchImpl);
  if (!r.ok) return null;
  const j = await r.json() as { value?: { id: string; name?: string; isDefaultCalendar?: boolean }[] };
  const cals = (j.value ?? []).filter((c) => c.isDefaultCalendar || !SKIP_CALENDAR.test((c.name ?? "").trim()));
  return cals.sort((a, b) => Number(!!b.isDefaultCalendar) - Number(!!a.isDefaultCalendar)).map((c) => c.id);
}

export async function syncCalendarWindow(
  supabase: SupabaseClient,
  accessToken: string,
  ctx: CalendarCtx,
  opts: { pastDays?: number; futureDays?: number; maxPages?: number; fetchImpl?: typeof fetch; allCalendars?: boolean } = {},
): Promise<{ upserted: number; removed: number; calendars?: number }> {
  const connectionId = await calendarConnectionId(supabase, ctx);
  // Rows written by the pre-multi-account code (no connection yet) belong to the primary account: adopt them.
  if ((await resolveMsConnection(supabase, ctx.userId))?.id === connectionId) {
    await supabase.from("microsoft_calendar_events").update({ connection_id: connectionId }).eq("user_id", ctx.userId).is("connection_id", null);
  }
  const from = new Date(Date.now() - (opts.pastDays ?? 1) * 86_400_000);
  const to = new Date(Date.now() + (opts.futureDays ?? 60) * 86_400_000);
  const maxPages = opts.maxPages ?? 20;
  const view = `calendarView?startDateTime=${from.toISOString()}&endDateTime=${to.toISOString()}` +
    `&$top=100&$select=id,iCalUId,subject,isCancelled,isAllDay,showAs,start,end,location,organizer,attendees,onlineMeeting,isOnlineMeeting,onlineMeetingProvider,webLink`;
  // Every calendar in the mailbox when asked (falls back to the default calendar if the list fails).
  const calendarIds = opts.allCalendars ? await listCalendarIds(accessToken, opts.fetchImpl) : null;
  const starts = calendarIds?.length
    ? calendarIds.map((id) => `/me/calendars/${encodeURIComponent(id)}/${view}`)
    : [`/me/${view}`];

  const rows: NonNullable<ReturnType<typeof toMirrorRow>>[] = [];
  const ids = new Set<string>();
  let pages = 0;
  for (const start of starts) {
    let url: string | undefined = start;
    while (url) {
      if (++pages > maxPages) throw new Error("calendar window exceeds page budget; refusing partial reconcile");
      const r = await graphFetch(accessToken, url, { headers: { Prefer: 'outlook.timezone="UTC"' } }, opts.fetchImpl);
      if (!r.ok) throw new Error(`Graph calendarView failed: ${r.status}`);
      const page = await r.json() as { value: GraphEvent[]; "@odata.nextLink"?: string };
      for (const e of page.value) {
        const row = toMirrorRow(e, ctx.orgId, ctx.userId, connectionId);
        if (row && !ids.has(row.graph_event_id)) { ids.add(row.graph_event_id); rows.push(row); }
      }
      url = page["@odata.nextLink"];
    }
  }

  // Fetch is complete from here on, so reconciliation is safe.
  await writeMirrorRows(supabase, connectionId, rows);

  const seen = new Set(rows.map((r) => r.graph_event_id));
  const { data: existing, error: selErr } = await supabase.from("microsoft_calendar_events")
    .select("id, graph_event_id").eq("user_id", ctx.userId).eq("connection_id", connectionId)
    .gte("start_time", from.toISOString()).lte("start_time", to.toISOString());
  if (selErr) throw new Error(`calendar reconcile read failed: ${selErr.message}`);
  const stale = (existing ?? []).filter((x) => !seen.has(x.graph_event_id)).map((x) => x.id);
  if (stale.length) {
    const { error } = await supabase.from("microsoft_calendar_events").delete().in("id", stale);
    if (error) throw new Error(`calendar reconcile delete failed: ${error.message}`);
  }
  // Stamp the sync itself: an empty calendar writes no mirror rows, so "newest row" can't tell a fresh
  // sync that found nothing from a sync that stopped. Best-effort (the column arrives with its migration).
  await supabase.from("microsoft_oauth_master").update({ calendar_synced_at: new Date().toISOString() }).eq("id", connectionId);
  return { upserted: rows.length, removed: stale.length, ...(calendarIds ? { calendars: calendarIds.length } : {}) };
}

// ---------------------------------------------------------------------------------------
// Creating events (used by Clara's work-line booking and, later, VIP/meeting scheduling)
// ---------------------------------------------------------------------------------------

export interface NewEvent {
  subject: string;
  startISO: string;
  endISO: string;
  attendees?: string[];
  body?: string;
  /** Create on another user's calendar (needs delegate access); default is the connected user's own. */
  calendarOwner?: string;
}

/** Pure: the Graph payload. Times are UTC. External attendees are invited as required. */
export function buildEventPayload(e: NewEvent) {
  if (!(Date.parse(e.endISO) > Date.parse(e.startISO))) throw new Error("event end must be after start");
  return {
    subject: e.subject,
    body: { contentType: "Text", content: e.body ?? "" },
    start: { dateTime: new Date(e.startISO).toISOString().replace("Z", ""), timeZone: "UTC" },
    end: { dateTime: new Date(e.endISO).toISOString().replace("Z", ""), timeZone: "UTC" },
    attendees: (e.attendees ?? []).map((a) => ({ emailAddress: { address: a }, type: "required" })),
  };
}

/** Create the event; returns Graph's id. Mirrors it locally so availability reflects it immediately. */
export async function createEvent(
  supabase: SupabaseClient, accessToken: string, ctx: CalendarCtx, e: NewEvent, fetchImpl?: typeof fetch,
): Promise<{ id: string }> {
  // Resolve (and ownership-check) the account before touching Graph; delegated-calendar events are not mirrored.
  const connectionId = e.calendarOwner ? null : await calendarConnectionId(supabase, ctx);
  const path = e.calendarOwner ? `/users/${encodeURIComponent(e.calendarOwner)}/calendar/events` : "/me/events";
  const r = await graphFetch(accessToken, path, { method: "POST", body: JSON.stringify(buildEventPayload(e)) }, fetchImpl);
  if (!r.ok) throw new Error(`Graph create event failed: ${r.status}`);
  const created = await r.json() as GraphEvent;
  if (connectionId) {
    const row = toMirrorRow({ ...created, start: created.start ?? { dateTime: e.startISO }, end: created.end ?? { dateTime: e.endISO }, showAs: created.showAs ?? "busy" }, ctx.orgId, ctx.userId, connectionId);
    if (row) await writeMirrorRows(supabase, connectionId, [row]);
  }
  return { id: created.id };
}

export interface EventUpdate {
  subject?: string;
  startISO?: string;
  endISO?: string;
  location?: string;
  body?: string;
  attendees?: string[];
}

/** Patch an event by its Graph id and refresh the mirror row. */
export async function updateEvent(
  supabase: SupabaseClient, accessToken: string, ctx: CalendarCtx, graphEventId: string, u: EventUpdate, fetchImpl?: typeof fetch,
): Promise<void> {
  const connectionId = await calendarConnectionId(supabase, ctx);
  const patch: Record<string, unknown> = {};
  if (u.subject !== undefined) patch.subject = u.subject;
  if (u.location !== undefined) patch.location = { displayName: u.location };
  if (u.body !== undefined) patch.body = { contentType: "Text", content: u.body };
  if (u.startISO) patch.start = { dateTime: new Date(u.startISO).toISOString().replace("Z", ""), timeZone: "UTC" };
  if (u.endISO) patch.end = { dateTime: new Date(u.endISO).toISOString().replace("Z", ""), timeZone: "UTC" };
  if (u.attendees) patch.attendees = u.attendees.map((a) => ({ emailAddress: { address: a }, type: "required" }));
  const r = await graphFetch(accessToken, `/me/events/${encodeURIComponent(graphEventId)}`, { method: "PATCH", body: JSON.stringify(patch) }, fetchImpl);
  if (!r.ok) throw new Error(`Graph update event failed: ${r.status}`);
  const updated = await r.json() as GraphEvent;
  const row = toMirrorRow(updated, ctx.orgId, ctx.userId, connectionId);
  if (row) await writeMirrorRows(supabase, connectionId, [row]);
}

/** Delete (cancel) an event by its Graph id and drop the mirror row. */
export async function deleteEvent(
  supabase: SupabaseClient, accessToken: string, ctx: { userId: string; connectionId?: string | null }, graphEventId: string, fetchImpl?: typeof fetch,
): Promise<void> {
  const connectionId = await calendarConnectionId(supabase, ctx);
  const r = await graphFetch(accessToken, `/me/events/${encodeURIComponent(graphEventId)}`, { method: "DELETE" }, fetchImpl);
  if (!r.ok && r.status !== 204) throw new Error(`Graph delete event failed: ${r.status}`);
  await supabase.from("microsoft_calendar_events").delete().eq("user_id", ctx.userId).eq("connection_id", connectionId).eq("graph_event_id", graphEventId);
}

/** RSVP to an event invitation. */
export async function respondEvent(
  accessToken: string, graphEventId: string, response: "accept" | "decline" | "tentativelyAccept", fetchImpl?: typeof fetch,
): Promise<void> {
  const r = await graphFetch(accessToken, `/me/events/${encodeURIComponent(graphEventId)}/${response}`, {
    method: "POST", body: JSON.stringify({ sendResponse: true }),
  }, fetchImpl);
  if (r.status !== 202 && !r.ok) throw new Error(`Graph RSVP failed: ${r.status}`);
}
