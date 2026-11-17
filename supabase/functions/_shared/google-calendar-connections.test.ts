import { assertEquals, assertRejects } from "jsr:@std/assert@1";
import { FakeSupabase, asClient } from "./testing/fake-supabase.ts";
import { decryptToken } from "./crypto.ts";
import {
  clearCalendarTokenFailure,
  connectionMatchesRequest,
  connectionOfGoogleEvent,
  getCalendarAccessToken,
  getCalendarConnection,
  getDriveAccessToken,
  getDriveConnection,
  googleCalendarAccessForAction,
  googleMailAccessForAction,
  isTokenFailure,
  listCalendarConnections,
  pickCalendarConnection,
  recordCalendarTokenFailure,
  requestedConnectionId,
  resolveConnectionForEvent,
  shouldDisableCalendarSync,
  uniqueConnectionId,
} from "./google-calendar-connections.ts";

Deno.env.set("GMAIL_ENCRYPTION_KEY", "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff");
Deno.env.set("GOOGLE_CLIENT_ID", "cid"); Deno.env.set("GOOGLE_CLIENT_SECRET", "sec");

const U = "u1", OTHER = "u2", ORG = "o1";
const NOW = new Date("2026-11-08T12:00:00Z");
const future = "2026-11-08T13:00:00Z", past = "2020-01-01T00:00:00Z";

// master A (primary) and B (second account); calendar rows ca / cb carry the master id in connection_id
function twoAccounts() {
  return new FakeSupabase({
    google_oauth_master: [
      { id: "mA", user_id: U, org_id: ORG, email: "a@x.com", is_primary: true, connection_status: "active", encrypted_access_token: "tokA", encrypted_refresh_token: "refA", token_expiry: past, refresh_fail_count: 0, created_at: "2026-01-01" },
      { id: "mB", user_id: U, org_id: ORG, email: "b@y.com", is_primary: false, connection_status: "active", encrypted_access_token: "tokB", encrypted_refresh_token: "refB", token_expiry: past, refresh_fail_count: 0, created_at: "2026-01-02" },
      { id: "mZ", user_id: OTHER, org_id: ORG, email: "z@z.com", is_primary: true, connection_status: "active", encrypted_access_token: "tokZ", encrypted_refresh_token: "refZ", token_expiry: past, refresh_fail_count: 0, created_at: "2026-01-01" },
    ],
    google_calendar_connections: [
      { id: "cA", user_id: U, org_id: ORG, email: "a@x.com", connection_id: "mA", access_token: "oldA", refresh_token: "refA", token_expiry: past, sync_enabled: true, created_at: "2026-01-01" },
      { id: "cB", user_id: U, org_id: ORG, email: "b@y.com", connection_id: "mB", access_token: "oldB", refresh_token: "refB", token_expiry: past, sync_enabled: true, created_at: "2026-01-02" },
      { id: "cZ", user_id: OTHER, org_id: ORG, email: "z@z.com", connection_id: "mZ", access_token: "oldZ", refresh_token: "refZ", token_expiry: past, sync_enabled: true, created_at: "2026-01-01" },
    ],
    drive_connections: [
      { id: "dA", user_id: U, organization_id: ORG, email: "a@x.com", connection_id: "mA", access_token_encrypted: "oldA", refresh_token_encrypted: "refA", token_expiry: past, is_active: true },
      { id: "dB", user_id: U, organization_id: ORG, email: "b@y.com", connection_id: "mB", access_token_encrypted: "oldB", refresh_token_encrypted: "refB", token_expiry: past, is_active: true },
    ],
    gmail_oauth_tokens: [
      { id: "gA", user_id: U, email: "a@x.com", connection_id: "mA", access_token: "oldA" },
      { id: "gB", user_id: U, email: "b@y.com", connection_id: "mB", access_token: "oldB" },
    ],
    calendar_event_map: [
      { id: "m1", user_id: U, connection_id: "cB", google_event_id: "evB", appointment_id: "apt1" },
      { id: "m2", user_id: U, connection_id: "cA", google_event_id: "evBoth", appointment_id: null },
      { id: "m3", user_id: U, connection_id: "cB", google_event_id: "evBoth", appointment_id: null },
    ],
    google_calendar_events: [
      { id: "e1", user_id: U, connection_id: "cB", google_event_id: "evB" },
      { id: "e2", user_id: U, connection_id: "cA", google_event_id: "evA" },
      { id: "e3", user_id: U, connection_id: "cGone", google_event_id: "evGone" },
    ],
  });
}
const okFetch = (access: string) => (() => Promise.resolve(new Response(JSON.stringify({ access_token: access, expires_in: 3600 }), { status: 200 }))) as unknown as typeof fetch;
const badFetch = (code: string, status = 400) => (() => Promise.resolve(new Response(JSON.stringify({ error: code }), { status }))) as unknown as typeof fetch;
const neverFetch = (() => { throw new Error("should not call Google"); }) as unknown as typeof fetch;

Deno.test("pickCalendarConnection: no selector = the primary account's calendar; id may be a calendar row id or an account id", () => {
  const masters = [{ id: "mA", email: "a@x.com", is_primary: false }, { id: "mB", email: "b@y.com", is_primary: true }];
  const rows = [{ id: "cA", email: "a@x.com", connection_id: "mA" }, { id: "cB", email: "b@y.com", connection_id: "mB" }];
  assertEquals(pickCalendarConnection(rows, masters)?.id, "cB");
  assertEquals(pickCalendarConnection(rows, masters, "cA")?.id, "cA");
  assertEquals(pickCalendarConnection(rows, masters, "mA")?.id, "cA");
  assertEquals(pickCalendarConnection(rows, masters, "nope"), null);
  assertEquals(pickCalendarConnection([], masters), null);
});

Deno.test("pickCalendarConnection: a legacy row without connection_id is matched by email, and is the fallback when no primary matches", () => {
  const masters = [{ id: "mA", email: "A@x.com", is_primary: true }];
  assertEquals(pickCalendarConnection([{ id: "c1", email: "a@x.com", connection_id: null }], masters)?.id, "c1");
  assertEquals(pickCalendarConnection([{ id: "c1", email: "a@x.com", connection_id: null }], masters, "mA")?.id, "c1");
  assertEquals(pickCalendarConnection([{ id: "c1", email: "orphan@x.com", connection_id: null, created_at: "2" }, { id: "c2", email: "o2@x.com", connection_id: null, created_at: "1" }], []).id, "c2");
});

Deno.test("getCalendarConnection defaults to the primary, honours a named account, and refuses another user's id", async () => {
  const db = asClient(twoAccounts());
  assertEquals((await getCalendarConnection(db, U, ORG))?.id, "cA");
  assertEquals((await getCalendarConnection(db, U, ORG, "cB"))?.id, "cB");
  assertEquals((await getCalendarConnection(db, U, ORG, "mB"))?.id, "cB");
  assertEquals(await getCalendarConnection(db, U, ORG, "cZ"), null);
  assertEquals(await getCalendarConnection(db, U, ORG, "mZ"), null);
  assertEquals(await getCalendarConnection(db, "nobody", ORG), null);
  assertEquals((await listCalendarConnections(db, U, ORG)).map((r) => r.id), ["cA", "cB"]);
});

Deno.test("a one-account user gets that single calendar connection without any selector", async () => {
  const db = asClient(twoAccounts());
  assertEquals((await getCalendarConnection(db, OTHER, ORG))?.id, "cZ");
});

Deno.test("uniqueConnectionId / connectionOfGoogleEvent: only an unambiguous holder is returned", async () => {
  assertEquals(uniqueConnectionId([{ connection_id: "x" }, { connection_id: "x" }, { connection_id: null }]), "x");
  assertEquals(uniqueConnectionId([{ connection_id: "x" }, { connection_id: "y" }]), undefined);
  const db = asClient(twoAccounts());
  assertEquals(await connectionOfGoogleEvent(db, U, { googleEventId: "evB" }), "cB");
  assertEquals(await connectionOfGoogleEvent(db, U, { googleEventId: "evA" }), "cA");
  assertEquals(await connectionOfGoogleEvent(db, U, { googleEventId: "evBoth" }), undefined);   // two accounts: do not guess
  assertEquals(await connectionOfGoogleEvent(db, U, { googleEventId: "missing" }), undefined);
  assertEquals(await connectionOfGoogleEvent(db, U, { appointmentId: "apt1" }), "cB");
  assertEquals(await connectionOfGoogleEvent(db, OTHER, { googleEventId: "evB" }), undefined);   // another user's lookup sees nothing
});

Deno.test("resolveConnectionForEvent: request > holder > primary; a removed holder falls back; a foreign request is refused", async () => {
  const db = asClient(twoAccounts());
  assertEquals((await resolveConnectionForEvent(db, U, ORG, { googleEventId: "evB" })).connection?.id, "cB");      // update/cancel -> holder
  assertEquals((await resolveConnectionForEvent(db, U, ORG, {})).connection?.id, "cA");                              // create -> primary
  assertEquals((await resolveConnectionForEvent(db, U, ORG, { requested: "cB" })).connection?.id, "cB");            // create on the named account
  assertEquals((await resolveConnectionForEvent(db, U, ORG, { requested: "cA", googleEventId: "evB" })).connection?.id, "cA");
  assertEquals((await resolveConnectionForEvent(db, U, ORG, { googleEventId: "evGone" })).connection?.id, "cA");     // holder deleted -> primary
  assertEquals((await resolveConnectionForEvent(db, U, ORG, { googleEventId: "evBoth" })).connection?.id, "cA");     // ambiguous -> primary
  assertEquals((await resolveConnectionForEvent(db, U, ORG, { requested: "cZ" })).connection, null);
  assertEquals((await resolveConnectionForEvent(db, U, null, { appointmentId: "apt1" })).connection?.id, "cB");      // booking path (no org filter)
});

Deno.test("requestedConnectionId trims and ignores non-strings", () => {
  assertEquals(requestedConnectionId(" x "), "x");
  assertEquals(requestedConnectionId(""), undefined);
  assertEquals(requestedConnectionId(null), undefined);
  assertEquals(requestedConnectionId(5), undefined);
});

Deno.test("calendar token: refreshing account B writes B's rows only, never A's", async () => {
  const f = twoAccounts();
  const conn = { ...f.rows("google_calendar_connections")[1] };            // cB
  const tok = await getCalendarAccessToken(asClient(f), conn, { fetchImpl: okFetch("newB"), now: () => NOW });
  assertEquals(tok, "newB");
  assertEquals(conn.access_token, "newB");
  const m = f.rows("google_oauth_master");
  assertEquals(await decryptToken(m[1].encrypted_access_token as string), "newB");
  assertEquals(m[0].encrypted_access_token, "tokA");                         // A's master untouched
  assertEquals(f.rows("google_calendar_connections")[0].access_token, "oldA");
  assertEquals(f.rows("gmail_oauth_tokens")[0].access_token, "oldA");
  assertEquals(f.rows("drive_connections")[0].access_token_encrypted, "oldA");
  assertEquals(await decryptToken(f.rows("google_calendar_connections")[1].access_token as string), "newB");
  assertEquals(f.rows("google_oauth_master")[2].encrypted_access_token, "tokZ");   // nor another user's
});

Deno.test("calendar token: a still-valid stored token is used without calling Google (plaintext and encrypted both read)", async () => {
  const f = twoAccounts();
  const conn = { ...f.rows("google_calendar_connections")[0], token_expiry: future };
  assertEquals(await getCalendarAccessToken(asClient(f), conn, { fetchImpl: neverFetch, now: () => NOW }), "oldA");
});

Deno.test("calendar token: invalid_grant marks only that account needs_reauth", async () => {
  const f = twoAccounts();
  const conn = { ...f.rows("google_calendar_connections")[1] };
  await assertRejects(() => getCalendarAccessToken(asClient(f), conn, { fetchImpl: badFetch("invalid_grant"), now: () => NOW }));
  assertEquals(f.rows("google_oauth_master").map((r) => r.connection_status), ["active", "needs_reauth", "active"]);
  assertEquals(isTokenFailure("Google token request failed: invalid_grant"), true);
  assertEquals(isTokenFailure("Google connection needs to be re-authorized"), true);
  assertEquals(isTokenFailure("Google API 500 internal"), false);
});

Deno.test("calendar token: a calendar row with no account row refreshes with its own token and writes only itself", async () => {
  const f = new FakeSupabase({
    google_calendar_connections: [{ id: "c1", user_id: U, email: "o@x.com", connection_id: null, access_token: "old", refresh_token: "ref", token_expiry: past }],
    google_oauth_master: [],
  });
  const conn = { ...f.rows("google_calendar_connections")[0] };
  assertEquals(await getCalendarAccessToken(asClient(f), conn, { fetchImpl: okFetch("fresh"), now: () => NOW }), "fresh");
  assertEquals(await decryptToken(f.rows("google_calendar_connections")[0].access_token as string), "fresh");
});

Deno.test("drive: default primary, named account, foreign id refused; refresh of B never touches A", async () => {
  const f = twoAccounts();
  const db = asClient(f);
  assertEquals((await getDriveConnection(db, U))?.id, "dA");
  assertEquals((await getDriveConnection(db, U, "dB"))?.id, "dB");
  assertEquals((await getDriveConnection(db, U, "mB"))?.id, "dB");
  assertEquals(await getDriveConnection(db, U, "mZ"), null);
  assertEquals(await getDriveConnection(db, U, "cB"), null);          // a calendar row id is not a drive connection
  assertEquals(await getDriveConnection(db, "nobody"), null);
  const conn = { ...f.rows("drive_connections")[1] };
  assertEquals(await getDriveAccessToken(db, conn, { fetchImpl: okFetch("dNewB"), now: () => NOW }), "dNewB");
  assertEquals(f.rows("drive_connections")[0].access_token_encrypted, "oldA");
  assertEquals(await decryptToken(f.rows("drive_connections")[1].access_token_encrypted as string), "dNewB");
  assertEquals(f.rows("google_oauth_master")[0].encrypted_access_token, "tokA");
});

Deno.test("drive: inactive connections are ignored", async () => {
  const f = twoAccounts();
  f.rows("drive_connections")[0].is_active = false;
  assertEquals((await getDriveConnection(asClient(f), U))?.id, "dB");
});

Deno.test("shouldDisableCalendarSync: needs_reauth, or enough counted failures", () => {
  assertEquals(shouldDisableCalendarSync(undefined), false);
  assertEquals(shouldDisableCalendarSync({ connection_status: "needs_reauth", refresh_fail_count: 0 }), true);
  assertEquals(shouldDisableCalendarSync({ connection_status: "active", refresh_fail_count: 4 }), false);
  assertEquals(shouldDisableCalendarSync({ connection_status: "active", refresh_fail_count: 25 }), true);
});

Deno.test("token failure parks ONLY the failing account's calendar connection, never the user's other account", async () => {
  const f = twoAccounts();
  f.rows("google_oauth_master")[1].connection_status = "needs_reauth";
  const r = await recordCalendarTokenFailure(asClient(f), "cB");
  assertEquals(r.disabled, true);
  assertEquals(f.rows("google_calendar_connections").map((c) => c.sync_enabled), [true, false, true]);
});

Deno.test("token failure on a healthy account (few failures) disables nothing; unknown connection is a no-op", async () => {
  const f = twoAccounts();
  f.rows("google_oauth_master")[1].refresh_fail_count = 3;
  assertEquals((await recordCalendarTokenFailure(asClient(f), "cB")).disabled, false);
  assertEquals(await recordCalendarTokenFailure(asClient(f), "nope"), { disabled: false, failCount: 0 });
  assertEquals(f.rows("google_calendar_connections").map((c) => c.sync_enabled), [true, true, true]);
});

Deno.test("clearing a failure resets only that connection's account counter", async () => {
  const f = twoAccounts();
  f.rows("google_oauth_master")[0].refresh_fail_count = 2;
  f.rows("google_oauth_master")[1].refresh_fail_count = 4;
  await clearCalendarTokenFailure(asClient(f), "cB");
  assertEquals(f.rows("google_oauth_master").map((m) => m.refresh_fail_count), [2, 0, 0]);
});

Deno.test("googleCalendarAccessForAction: create on the named/primary account, update on the holder, foreign refused", async () => {
  const f = twoAccounts();
  const db = asClient(f);
  const create = await googleCalendarAccessForAction(db, U, ORG, { fetchImpl: okFetch("t1") });
  assertEquals(create.ok && create.connection.id, "cA");
  const named = await googleCalendarAccessForAction(db, U, ORG, { requested: "mB", fetchImpl: okFetch("t2") });
  assertEquals(named.ok && named.token, "t2");
  assertEquals(named.ok && named.connection.id, "cB");
  const upd = await googleCalendarAccessForAction(db, U, ORG, { googleEventId: "evB", fetchImpl: okFetch("t3") });
  assertEquals(upd.ok && upd.connection.id, "cB");
  const foreign = await googleCalendarAccessForAction(db, U, ORG, { requested: "cZ", fetchImpl: neverFetch });
  assertEquals(foreign.ok, false);
  assertEquals(!foreign.ok && foreign.reason, "not_owned");
  const none = await googleCalendarAccessForAction(db, "nobody", ORG, {});
  assertEquals(!none.ok && none.reason, "not_connected");
  const dead = await googleCalendarAccessForAction(asClient(twoAccounts()), U, ORG, { requested: "cB", fetchImpl: badFetch("invalid_grant") });
  assertEquals(!dead.ok && dead.reason, "token");
});

Deno.test("googleMailAccessForAction: primary by default, named account, foreign refused", async () => {
  const db = asClient(twoAccounts());
  const def = await googleMailAccessForAction(db, U, { fetchImpl: okFetch("m1") });
  assertEquals(def.ok && def.email, "a@x.com");
  const named = await googleMailAccessForAction(db, U, { requested: "mB", fetchImpl: okFetch("m2") });
  assertEquals(named.ok && named.email, "b@y.com");
  const foreign = await googleMailAccessForAction(db, U, { requested: "mZ", fetchImpl: neverFetch });
  assertEquals(!foreign.ok && foreign.reason, "not_owned");
  assertEquals((await googleMailAccessForAction(db, "nobody", {})).ok, false);
});

Deno.test("connectionMatchesRequest: an event on account B rejects a request naming A; no id or either of B's ids passes", () => {
  const b = { id: "cB", connection_id: "mB" };
  assertEquals(connectionMatchesRequest(b, undefined), true);
  assertEquals(connectionMatchesRequest(b, "cB"), true);
  assertEquals(connectionMatchesRequest(b, "mB"), true);
  assertEquals(connectionMatchesRequest(b, "cA"), false);
  assertEquals(connectionMatchesRequest(b, "mA"), false);
});
