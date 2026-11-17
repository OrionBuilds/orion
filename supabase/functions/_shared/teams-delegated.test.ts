import { assertEquals } from "jsr:@std/assert@1";
import { discoverDelegated, sessionToken } from "./teams-delegated.ts";
import { FakeSupabase, asClient } from "./testing/fake-supabase.ts";

const now = Date.parse("2026-11-05T12:00:00Z");
const meeting = (graphId: string, connection: string | null, organizer: string) => ({
  user_id: "u", connection_id: connection, graph_event_id: graphId, ical_uid: graphId, title: `m-${graphId}`,
  start_time: "2026-11-05T09:00:00.000Z", end_time: "2026-11-05T10:00:00.000Z", organizer_email: organizer,
  attendees: [], online_meeting_url: `https://teams/${graphId}`, is_online_meeting: true,
});
const seed = (events: Record<string, unknown>[]) => new FakeSupabase({
  microsoft_oauth_master: [
    { id: "c1", user_id: "u", organization_id: "o", email: "a@x.com", is_primary: true, connection_status: "active" },
    { id: "c2", user_id: "u", organization_id: "o", email: "b@x.com", is_primary: false, connection_status: "active" },
  ],
  microsoft_calendar_events: events,
});

Deno.test("delegated discovery: sessions record the connection and only the organiser's own account files them", async () => {
  const f = seed([
    meeting("E1", "c1", "A@x.com"),   // organised by account 1, on account 1's calendar: filed under c1
    meeting("E2", "c2", "b@x.com"),   // organised by account 2: filed under c2
    meeting("E3", "c1", "b@x.com"),   // account 1 was only invited (organiser is account 2's address): not filed by c1
    meeting("E4", null, "a@x.com"),   // legacy row, no connection: belongs to the primary
    meeting("E5", "c2", "a@x.com"),   // on c2's calendar but organised by someone else's address: skipped
  ]);
  await discoverDelegated(asClient(f), now);
  const s = f.rows("meeting_sessions").map((r) => `${r.external_event_id}:${r.connection_id}`).sort();
  assertEquals(s, ["E1:c1", "E2:c2", "E4:c1"]);
});

Deno.test("delegated discovery: a single-account user behaves as before (primary connection recorded)", async () => {
  const f = new FakeSupabase({
    microsoft_oauth_master: [{ id: "c1", user_id: "u", organization_id: "o", email: "a@x.com", is_primary: true, connection_status: "active" }],
    microsoft_calendar_events: [meeting("E1", "c1", "a@x.com")],
  });
  await discoverDelegated(asClient(f), now);
  assertEquals(f.rows("meeting_sessions").length, 1);
  assertEquals(f.rows("meeting_sessions")[0].user_id, "u");
});

Deno.test("sessionToken: uses the session's own connection; legacy sessions default to the primary", async () => {
  const seen: unknown[] = [];
  const getToken = ((_db: unknown, userId: string, opts: unknown) => { seen.push([userId, opts]); return Promise.resolve("tok"); }) as never;
  await sessionToken(asClient(seed([])), { user_id: "u", connection_id: "c2" }, getToken);
  await sessionToken(asClient(seed([])), { user_id: "u", connection_id: null }, getToken);
  assertEquals(seen, [["u", { connectionId: "c2" }], ["u", { connectionId: undefined }]]);
});

Deno.test("delegated discovery skips external and personal connections", async () => {
  const f = new FakeSupabase({
    microsoft_oauth_master: [
      { id: "c1", user_id: "u", organization_id: "o", email: "a@x.com", is_primary: true, connection_status: "active" },
      { id: "c2", user_id: "u", organization_id: "o", email: "b@other.org", is_primary: false, connection_status: "active", account_type: "external" },
      { id: "c3", user_id: "u", organization_id: "o", email: "c@outlook.com", is_primary: false, connection_status: "active", account_type: "personal" },
    ],
    microsoft_calendar_events: [meeting("E1", "c1", "a@x.com"), meeting("E2", "c2", "b@other.org"), meeting("E3", "c3", "c@outlook.com")],
  });
  await discoverDelegated(asClient(f), now);
  assertEquals(f.rows("meeting_sessions").map((r) => r.connection_id), ["c1"]);
});

Deno.test("sessionToken refuses a session tied to a non-work connection", async () => {
  const f = new FakeSupabase({ microsoft_oauth_master: [{ id: "p", user_id: "u", email: "c@outlook.com", account_type: "personal" }] });
  const getToken = (() => Promise.resolve("tok")) as never;
  let err = "";
  try { await sessionToken(asClient(f), { user_id: "u", connection_id: "p" }, getToken); } catch (e) { err = (e as Error).message; }
  assertEquals(err.includes("not available"), true);
});
