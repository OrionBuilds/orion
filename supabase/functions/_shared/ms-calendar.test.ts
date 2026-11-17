import { assertEquals, assertRejects } from "jsr:@std/assert@1";
import { syncCalendarWindow, toMirrorRow, type GraphEvent } from "./ms-calendar.ts";

const ev: GraphEvent = {
  id: "E1", subject: "Call", showAs: "busy",
  start: { dateTime: "2026-10-20T14:00:00.0000000" }, end: { dateTime: "2026-10-20T15:00:00.0000000" },
  organizer: { emailAddress: { address: "Boss@X.com" } },
};

Deno.test("maps showAs/cancel to status+transparency and treats Graph datetimes as UTC", () => {
  const r = toMirrorRow(ev, "o", "u")!;
  assertEquals(r.start_time, "2026-10-20T14:00:00.000Z");
  assertEquals([r.status, r.transparency, r.organizer_email], ["confirmed", "opaque", "boss@x.com"]);
  assertEquals(toMirrorRow({ ...ev, showAs: "free" }, "o", "u")!.transparency, "transparent");
  assertEquals(toMirrorRow({ ...ev, showAs: "tentative" }, "o", "u")!.status, "tentative");
  assertEquals(toMirrorRow({ ...ev, isCancelled: true }, "o", "u")!.status, "cancelled");
  assertEquals(toMirrorRow({ id: "x" }, "o", "u"), null);
});

import { FakeSupabase, asClient } from "./testing/fake-supabase.ts";

const iso = (d: number) => new Date(Date.now() + d * 86_400_000).toISOString();
const conn = (id: string, userId: string, email: string, primary: boolean) => ({
  id, user_id: userId, organization_id: "o", email, is_primary: primary, connection_status: "active", created_at: primary ? "2026-01-01" : "2026-02-01",
});
const mirror = (connection: string | null, graphId: string, userId = "u") => ({
  id: `row-${connection}-${graphId}`, organization_id: "o", user_id: userId, connection_id: connection, graph_event_id: graphId,
  title: "x", start_time: iso(2), end_time: iso(2.1),
});
const respond = (events: unknown[]) => (() => Promise.resolve(new Response(JSON.stringify({ value: events })))) as unknown as typeof fetch;
const gev = (id: string) => ({ ...ev, id, start: { dateTime: iso(2).replace("Z", "") }, end: { dateTime: iso(2.1).replace("Z", "") } });
const calRows = (f: FakeSupabase) => f.rows("microsoft_calendar_events");

function seed(extra: Record<string, unknown>[] = []) {
  return new FakeSupabase({
    microsoft_oauth_master: [conn("c1", "u", "a@x.com", true), conn("c2", "u", "b@x.com", false), conn("cz", "other", "z@x.com", true)],
    microsoft_calendar_events: extra as never[],
  });
}

Deno.test("reconcile deletes only rows Graph no longer returns", async () => {
  const f = seed([mirror("c1", "E1"), mirror("c1", "GONE")]);
  const res = await syncCalendarWindow(asClient(f), "tok", { orgId: "o", userId: "u" }, { fetchImpl: respond([gev("E1")]) });
  assertEquals(res, { upserted: 1, removed: 1 });
  assertEquals(calRows(f).map((r) => r.graph_event_id), ["E1"]);
  assertEquals(calRows(f)[0].connection_id, "c1"); // no selector = the primary
});

Deno.test("a failed fetch never deletes anything", async () => {
  const f = seed([mirror("c1", "GONE")]);
  const bad = (() => Promise.resolve(new Response("{}", { status: 500 }))) as unknown as typeof fetch;
  await assertRejects(() => syncCalendarWindow(asClient(f), "tok", { orgId: "o", userId: "u" }, { fetchImpl: bad }), Error, "500");
  assertEquals(calRows(f).length, 1);
});

Deno.test("a completed sync stamps its connection even when the calendar is empty; a failed one does not", async () => {
  const f = seed();
  const stamp = (id: string) => f.rows("microsoft_oauth_master").find((r) => r.id === id)!.calendar_synced_at as string | undefined;
  const bad = (() => Promise.resolve(new Response("{}", { status: 500 }))) as unknown as typeof fetch;
  await assertRejects(() => syncCalendarWindow(asClient(f), "tok", { orgId: "o", userId: "u" }, { fetchImpl: bad }), Error, "500");
  assertEquals(stamp("c1"), undefined);
  const before = Date.now();
  assertEquals(await syncCalendarWindow(asClient(f), "tok", { orgId: "o", userId: "u" }, { fetchImpl: respond([]) }), { upserted: 0, removed: 0 });
  assertEquals(Date.parse(stamp("c1")!) >= before, true);
  assertEquals([stamp("c2"), stamp("cz")], [undefined, undefined]); // only the synced account
});

Deno.test("two connections of one user with overlapping windows: syncing one never deletes the other's events", async () => {
  const f = seed([mirror("c1", "A1"), mirror("c1", "A-GONE"), mirror("c2", "B1"), mirror("c2", "B2")]);
  // c1 sync returns only A1: A-GONE is stale for c1, but B1/B2 (same user, same window) must survive.
  const r1 = await syncCalendarWindow(asClient(f), "tok", { orgId: "o", userId: "u", connectionId: "c1" }, { fetchImpl: respond([gev("A1")]) });
  assertEquals(r1.removed, 1);
  assertEquals(calRows(f).map((r) => `${r.connection_id}:${r.graph_event_id}`).sort(), ["c1:A1", "c2:B1", "c2:B2"]);
  // And the other way round: an EMPTY pull for c2 removes only c2's rows.
  const r2 = await syncCalendarWindow(asClient(f), "tok", { orgId: "o", userId: "u", connectionId: "c2" }, { fetchImpl: respond([]) });
  assertEquals(r2.removed, 2);
  assertEquals(calRows(f).map((r) => `${r.connection_id}:${r.graph_event_id}`), ["c1:A1"]);
});

Deno.test("the same Graph event id on two connections stores two rows (and a re-sync updates, not duplicates)", async () => {
  const f = seed();
  for (const c of ["c1", "c2", "c1"]) {
    await syncCalendarWindow(asClient(f), "tok", { orgId: "o", userId: "u", connectionId: c }, { fetchImpl: respond([gev("SAME")]) });
  }
  assertEquals(calRows(f).map((r) => `${r.connection_id}:${r.graph_event_id}`).sort(), ["c1:SAME", "c2:SAME"]);
});

Deno.test("sync refuses a connection owned by another user and writes nothing", async () => {
  const f = seed([mirror("cz", "Z1", "other")]);
  await assertRejects(() => syncCalendarWindow(asClient(f), "tok", { orgId: "o", userId: "u", connectionId: "cz" }, { fetchImpl: respond([gev("X")]) }), Error, "not connected");
  assertEquals(calRows(f).length, 1);
});

Deno.test("legacy rows without a connection are adopted by the primary, not duplicated", async () => {
  const f = seed([{ ...mirror(null, "E1"), connection_id: null }]);
  await syncCalendarWindow(asClient(f), "tok", { orgId: "o", userId: "u" }, { fetchImpl: respond([gev("E1")]) });
  assertEquals(calRows(f).map((r) => `${r.connection_id}:${r.graph_event_id}`), ["c1:E1"]);
  // syncing a SECONDARY never adopts legacy rows
  const g = seed([{ ...mirror(null, "E1"), connection_id: null }]);
  await syncCalendarWindow(asClient(g), "tok", { orgId: "o", userId: "u", connectionId: "c2" }, { fetchImpl: respond([]) });
  assertEquals(calRows(g)[0].connection_id, null);
});

Deno.test("allCalendars reads every calendar in the mailbox (not just the default), skips generated ones, dedupes", async () => {
  const f = seed([mirror("c1", "OLD")]);
  const urls: string[] = [];
  const fx = ((u: string) => {
    urls.push(decodeURIComponent(new URL(u).pathname));
    if (u.includes("/me/calendars?")) {
      return Promise.resolve(new Response(JSON.stringify({ value: [
        { id: "def", name: "Calendar", isDefaultCalendar: true },
        { id: "bday", name: "Birthdays" }, { id: "hol", name: "United States holidays" },
        { id: "gcal", name: "jordan@gmail.com (imported)" },
      ] })));
    }
    const val = u.includes("/calendars/gcal/") ? [gev("G1"), gev("E1")] : [gev("E1")];
    return Promise.resolve(new Response(JSON.stringify({ value: val })));
  }) as unknown as typeof fetch;
  const res = await syncCalendarWindow(asClient(f), "tok", { orgId: "o", userId: "u" }, { fetchImpl: fx, allCalendars: true });
  assertEquals(res, { upserted: 2, removed: 1, calendars: 2 });
  assertEquals(urls, ["/v1.0/me/calendars", "/v1.0/me/calendars/def/calendarView", "/v1.0/me/calendars/gcal/calendarView"]);
  assertEquals(calRows(f).map((r) => r.graph_event_id).sort(), ["E1", "G1"]);
  // The calendar list failing falls back to the default calendar view.
  const g = ((u: string) => Promise.resolve(u.includes("/me/calendars?") ? new Response("{}", { status: 403 }) : new Response(JSON.stringify({ value: [gev("E1")] })))) as unknown as typeof fetch;
  assertEquals((await syncCalendarWindow(asClient(seed()), "tok", { orgId: "o", userId: "u" }, { fetchImpl: g, allCalendars: true })).upserted, 1);
});

import { buildEventPayload, createEvent, deleteEvent, updateEvent } from "./ms-calendar.ts";

Deno.test("event payload is UTC, validates the window, invites attendees", () => {
  const p = buildEventPayload({ subject: "Call", startISO: "2026-10-21T14:00:00Z", endISO: "2026-10-21T14:30:00Z", attendees: ["a@x.com"] });
  assertEquals([p.start.dateTime, p.start.timeZone, p.attendees[0].emailAddress.address], ["2026-10-21T14:00:00.000", "UTC", "a@x.com"]);
  let msg = "";
  try { buildEventPayload({ subject: "x", startISO: "2026-10-21T14:00:00Z", endISO: "2026-10-21T14:00:00Z" }); } catch (e) { msg = (e as Error).message; }
  assertEquals(msg, "event end must be after start");
});

Deno.test("createEvent posts to the right calendar and mirrors own-calendar events with the connection_id", async () => {
  const urls: string[] = [];
  const f = ((u: string) => { urls.push(u); return Promise.resolve(new Response(JSON.stringify({ id: "EV1", subject: "Call" }), { status: 201 })); }) as unknown as typeof fetch;
  const db = seed();
  const e = { subject: "Call", startISO: "2026-10-21T14:00:00Z", endISO: "2026-10-21T14:30:00Z" };
  assertEquals((await createEvent(asClient(db), "t", { orgId: "o", userId: "u" }, e, f)).id, "EV1");
  assertEquals(urls[0].endsWith("/me/events"), true);
  assertEquals(calRows(db).map((r) => `${r.connection_id}:${r.graph_event_id}`), ["c1:EV1"]); // default = primary
  await createEvent(asClient(db), "t", { orgId: "o", userId: "u", connectionId: "c2" }, e, f);
  assertEquals(calRows(db).map((r) => `${r.connection_id}:${r.graph_event_id}`), ["c1:EV1", "c2:EV1"]);
  await createEvent(asClient(db), "t", { orgId: "o", userId: "u" }, { ...e, calendarOwner: "jordan@x.com" }, f);
  assertEquals(urls[2].includes("/users/jordan%40x.com/calendar/events"), true);
  assertEquals(calRows(db).length, 2); // other people's calendars are not mirrored under our user
});

Deno.test("create/update/delete refuse a connection owned by another user before calling Graph", async () => {
  let calls = 0;
  const f = (() => { calls++; return Promise.resolve(new Response("{}", { status: 200 })); }) as unknown as typeof fetch;
  const db = seed([mirror("cz", "Z1", "other")]);
  const ctx = { orgId: "o", userId: "u", connectionId: "cz" };
  const e = { subject: "Call", startISO: "2026-10-21T14:00:00Z", endISO: "2026-10-21T14:30:00Z" };
  await assertRejects(() => createEvent(asClient(db), "t", ctx, e, f), Error, "not connected");
  await assertRejects(() => updateEvent(asClient(db), "t", ctx, "Z1", { subject: "x" }, f), Error, "not connected");
  await assertRejects(() => deleteEvent(asClient(db), "t", ctx, "Z1", f), Error, "not connected");
  assertEquals(calls, 0);
  assertEquals(calRows(db).length, 1);
});

Deno.test("update uses the selected connection's row; delete removes only that connection's copy", async () => {
  const db = seed([mirror("c1", "SAME"), mirror("c2", "SAME")]);
  const urls: string[] = [];
  const f = ((u: string, init?: RequestInit) => {
    urls.push(`${init?.method} ${new URL(u).pathname}`);
    return Promise.resolve(init?.method === "DELETE" ? new Response(null, { status: 204 }) : new Response(JSON.stringify({ ...gev("SAME"), subject: "Renamed" })));
  }) as unknown as typeof fetch;
  await updateEvent(asClient(db), "t", { orgId: "o", userId: "u", connectionId: "c2" }, "SAME", { subject: "Renamed" }, f);
  assertEquals(calRows(db).map((r) => `${r.connection_id}:${r.title}`).sort(), ["c1:x", "c2:Renamed"]);
  await deleteEvent(asClient(db), "t", { userId: "u", connectionId: "c2" }, "SAME", f);
  assertEquals(calRows(db).map((r) => r.connection_id), ["c1"]);
  // default (no selector) = primary
  await deleteEvent(asClient(db), "t", { userId: "u" }, "SAME", f);
  assertEquals(calRows(db).length, 0);
});
