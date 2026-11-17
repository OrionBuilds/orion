import { assert, assertEquals, assertNotEquals, assertRejects } from "jsr:@std/assert@1";
import { FakeSupabase, asClient } from "./testing/fake-supabase.ts";
import { decryptToken, signState } from "./crypto.ts";
import {
  buildGoogleAuthUrl,
  connectGoogleAccount,
  dedupeSelectedCalendars,
  disconnectGoogle,
  disconnectGoogleCalendar,
  enqueueCalendarInitialSync,
  getCalendarAccessToken,
  getGoogleConnectionStatus,
  parseStartRequest,
  pickTeamGoogleRow,
  readGoogleState,
  refreshStaleGoogleConnections,
  registerGmailMailbox,
  resolveCalendarRow,
  runGoogleAccountsAction,
  signGoogleState,
  type CalendarRow,
} from "./google-accounts.ts";
import { ALL_GOOGLE_SCOPES } from "./google-oauth-helpers.ts";
import { GoogleTokenError } from "./google-connections.ts";

const KEY = "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff";
Deno.env.set("GMAIL_ENCRYPTION_KEY", KEY);
Deno.env.set("GOOGLE_CLIENT_ID", "cid");
Deno.env.set("GOOGLE_CLIENT_SECRET", "sec");

const U = "u1", ORG = "o1";
const future = new Date(Date.now() + 3600_000).toISOString();
const past = new Date(Date.now() - 3600_000).toISOString();

/** FakeSupabase + the DB trigger that makes a user's first google_oauth_master row primary. */
function mk(seed: Record<string, Record<string, unknown>[]> = {}, rpc?: Record<string, (a: Record<string, unknown>) => unknown>) {
  const db = new FakeSupabase(seed, {
    rpc,
    onWrite: (op, table, rows) => {
      if (table === "google_oauth_master" && op === "insert") {
        for (const r of rows) {
          const others = db.rows("google_oauth_master").filter((o) => o !== r && o.user_id === r.user_id);
          r.is_primary = others.length === 0;
          r.created_at ??= new Date().toISOString();
        }
      }
    },
  });
  return db;
}

const conn = (tag: string, extra: Record<string, unknown> = {}) => ({
  id: tag, user_id: U, org_id: ORG, email: `${tag}@x.com`, label: null, is_primary: false, connection_status: "active",
  encrypted_access_token: `acc-${tag}`, encrypted_refresh_token: `ref-${tag}`, token_expiry: future, refresh_fail_count: 0,
  granted_scopes: [...ALL_GOOGLE_SCOPES], created_at: `2026-01-0${tag === "a" ? 1 : 2}`, ...extra,
});

/* ----------------------------------------------------------------- signed state */

Deno.test("state: signed state round-trips; unsigned btoa, tampered, expired and missing are refused", async () => {
  const s = { userId: U, orgId: ORG, redirectUri: "https://x/cb", appOrigin: "https://app", ts: Date.now() };
  const signed = await signGoogleState(s);
  const ok = await readGoogleState(signed);
  assert(ok.ok);
  if (ok.ok) assertEquals([ok.state.userId, ok.state.orgId, ok.state.appOrigin], [U, ORG, "https://app"]);

  // the old unsigned fallback: base64 of the JSON, no signature
  assertEquals(await readGoogleState(btoa(JSON.stringify(s))), { ok: false, reason: "invalid" });
  // forged identity with a bad signature
  const forged = `${btoa(JSON.stringify({ ...s, userId: "victim" }))}.${signed.split(".")[1]}`;
  assertEquals(await readGoogleState(forged), { ok: false, reason: "invalid" });
  assertEquals(await readGoogleState(`${btoa(JSON.stringify(s))}.zz`), { ok: false, reason: "invalid" });
  assertEquals(await readGoogleState(`${btoa(JSON.stringify(s))}.`), { ok: false, reason: "invalid" });
  assertEquals(await readGoogleState(null), { ok: false, reason: "missing" });
  assertEquals(await readGoogleState(""), { ok: false, reason: "missing" });
  // correctly signed but missing fields
  assertEquals(await readGoogleState(await signState(JSON.stringify({ userId: U }))), { ok: false, reason: "invalid" });
  // expired
  const old = await signGoogleState({ ...s, ts: Date.now() - 11 * 60_000 });
  assertEquals(await readGoogleState(old), { ok: false, reason: "expired" });
});

Deno.test("state: with no signing key start cannot sign and nothing verifies (fail closed)", async () => {
  const signed = await signGoogleState({ userId: U, orgId: ORG, redirectUri: "r", ts: Date.now() });
  Deno.env.delete("GMAIL_ENCRYPTION_KEY");
  try {
    await assertRejects(() => signGoogleState({ userId: U, orgId: ORG, redirectUri: "r", ts: Date.now() }));
    assertEquals(await readGoogleState(signed), { ok: false, reason: "invalid" });
  } finally {
    Deno.env.set("GMAIL_ENCRYPTION_KEY", KEY);
  }
});

Deno.test("auth url: add mode and login_hint force the account chooser; plain connect keeps prompt=consent", () => {
  const base = { clientId: "cid", callbackUri: "https://x/cb", scopes: ALL_GOOGLE_SCOPES, state: "S" };
  const plain = new URL(buildGoogleAuthUrl(base));
  assertEquals(plain.searchParams.get("prompt"), "consent");
  assertEquals(plain.searchParams.get("access_type"), "offline");
  assertEquals(plain.searchParams.get("include_granted_scopes"), "true");
  assertEquals(plain.searchParams.get("scope"), ALL_GOOGLE_SCOPES.join(" "));
  assertEquals(plain.searchParams.get("login_hint"), null);
  assertEquals(new URL(buildGoogleAuthUrl({ ...base, mode: "add" })).searchParams.get("prompt"), "select_account consent");
  const hinted = new URL(buildGoogleAuthUrl({ ...base, loginHint: "me@y.com" }));
  assertEquals([hinted.searchParams.get("prompt"), hinted.searchParams.get("login_hint")], ["select_account consent", "me@y.com"]);
});

Deno.test("parseStartRequest: mode add, login_hint, app origin from query or redirect_uri", () => {
  assertEquals(parseStartRequest(null, new URLSearchParams("app_origin=https://app")), { appOrigin: "https://app" });
  assertEquals(parseStartRequest({ mode: "add", login_hint: " a@b.com ", redirect_uri: "https://app.example/settings?x=1" }, new URLSearchParams()),
    { appOrigin: "https://app.example", mode: "add", loginHint: "a@b.com" });
  assertEquals(parseStartRequest({ mode: "nope", redirect_uri: "javascript:alert(1)" }, new URLSearchParams()), { appOrigin: "" });
});

/* ----------------------------------------------------------------- connecting accounts */

const tokens = (n: string) => ({ accessToken: `AT-${n}`, refreshToken: `RT-${n}`, tokenExpiry: future, scopes: [...ALL_GOOGLE_SCOPES] });

Deno.test("connect: first account is primary, writes every child with connection_id, encrypted, and the mirror", async () => {
  const db = mk();
  const r = await connectGoogleAccount(asClient(db), { orgId: ORG, userId: U, email: "jordan@a.com", ...tokens("1") });
  assert(r.created && r.isPrimary);
  const id = r.connectionId;
  for (const t of ["gmail_oauth_tokens", "google_calendar_connections", "drive_connections"]) {
    const rows = db.rows(t);
    assertEquals(rows.length, 1, t);
    assertEquals(rows[0].connection_id, id, t);
  }
  assertEquals(await decryptToken(db.rows("gmail_oauth_tokens")[0].refresh_token as string), "RT-1");
  assert(!JSON.stringify(db.rows("google_oauth_master")).includes("RT-1"));
  assertEquals(db.rows("user_connected_accounts").map((x) => [x.provider, x.provider_account_email]).sort(), [["google_gmail", "jordan@a.com"], ["google_workspace", "jordan@a.com"]]);
  assertEquals(db.rows("google_calendar_connections")[0].selected_calendar_ids, ["primary"]);
  assertEquals(r.cross.calendarConnectionId, db.rows("google_calendar_connections")[0].id);
});

Deno.test("connect: a second account adds its own rows and never overwrites the first account's tokens, rows or mirror", async () => {
  const db = mk();
  const a = await connectGoogleAccount(asClient(db), { orgId: ORG, userId: U, email: "jordan@a.com", ...tokens("1") });
  db.rows("google_calendar_connections")[0].selected_calendar_ids = ["work@a.com"];
  const snapshotA = JSON.stringify([
    db.rows("google_oauth_master")[0], db.rows("gmail_oauth_tokens")[0], db.rows("google_calendar_connections")[0], db.rows("drive_connections")[0], db.rows("user_connected_accounts"),
  ]);
  const b = await connectGoogleAccount(asClient(db), { orgId: ORG, userId: U, email: "me@gmail.com", ...tokens("2") });
  assert(b.created && !b.isPrimary);
  assertNotEquals(a.connectionId, b.connectionId);
  assertEquals(db.rows("google_oauth_master").length, 2);
  for (const t of ["gmail_oauth_tokens", "google_calendar_connections", "drive_connections"]) {
    assertEquals(db.rows(t).map((x) => x.connection_id).sort(), [a.connectionId, b.connectionId].sort(), t);
  }
  const snapshotAfter = JSON.stringify([
    db.rows("google_oauth_master").find((x) => x.id === a.connectionId),
    db.rows("gmail_oauth_tokens").find((x) => x.connection_id === a.connectionId),
    db.rows("google_calendar_connections").find((x) => x.connection_id === a.connectionId),
    db.rows("drive_connections").find((x) => x.connection_id === a.connectionId),
    db.rows("user_connected_accounts"),
  ]);
  assertEquals(snapshotAfter, snapshotA); // account A and the primary-only mirror are untouched
  assertEquals(await decryptToken(db.rows("google_oauth_master").find((x) => x.id === b.connectionId)!.encrypted_refresh_token as string), "RT-2");
});

Deno.test("connect: the same email (any case) re-authorizes its own connection and keeps the selected calendars", async () => {
  const db = mk();
  const a = await connectGoogleAccount(asClient(db), { orgId: ORG, userId: U, email: "Jordan@A.com", ...tokens("1") });
  db.rows("google_calendar_connections")[0].selected_calendar_ids = ["cal1"];
  const again = await connectGoogleAccount(asClient(db), { orgId: ORG, userId: U, email: "jordan@a.com", ...tokens("3") });
  assert(!again.created);
  assertEquals(again.connectionId, a.connectionId);
  assertEquals(db.rows("google_oauth_master").length, 1);
  assertEquals(db.rows("gmail_oauth_tokens").length, 1);
  assertEquals(db.rows("google_calendar_connections").length, 1);
  assertEquals(db.rows("google_calendar_connections")[0].selected_calendar_ids, ["cal1"]);
  assertEquals(await decryptToken(db.rows("gmail_oauth_tokens")[0].refresh_token as string), "RT-3");
});

Deno.test("connect: a legacy child row (connection_id NULL, same email) is adopted, not duplicated", async () => {
  const db = mk({ gmail_oauth_tokens: [{ id: "legacy", user_id: U, organization_id: ORG, email: "jordan@a.com", access_token: "x", connection_id: null }] });
  const r = await connectGoogleAccount(asClient(db), { orgId: ORG, userId: U, email: "jordan@a.com", ...tokens("1") });
  assertEquals(db.rows("gmail_oauth_tokens").length, 1);
  assertEquals(db.rows("gmail_oauth_tokens")[0].id, "legacy");
  assertEquals(db.rows("gmail_oauth_tokens")[0].connection_id, r.connectionId);
});

Deno.test("connect: fails closed without an encryption key and stores nothing", async () => {
  const db = mk();
  Deno.env.delete("GMAIL_ENCRYPTION_KEY");
  try {
    await assertRejects(() => connectGoogleAccount(asClient(db), { orgId: ORG, userId: U, email: "jordan@a.com", ...tokens("1") }));
  } finally {
    Deno.env.set("GMAIL_ENCRYPTION_KEY", KEY);
  }
  assertEquals(db.rows("google_oauth_master").length, 0);
  assertEquals(db.rows("gmail_oauth_tokens").length, 0);
});

Deno.test("connect: a Gmail-only legacy grant fans out to the Gmail row only", async () => {
  const db = mk();
  const gmailOnly = ["https://www.googleapis.com/auth/gmail.readonly", "https://www.googleapis.com/auth/gmail.send", "https://www.googleapis.com/auth/gmail.modify"];
  await connectGoogleAccount(asClient(db), { orgId: ORG, userId: U, email: "jordan@a.com", ...tokens("1"), scopes: gmailOnly });
  assertEquals(db.rows("gmail_oauth_tokens").length, 1);
  assertEquals(db.rows("google_calendar_connections").length, 0);
  assertEquals(db.rows("drive_connections").length, 0);
});

/* ----------------------------------------------------------------- gmail mailbox registration */

const watchFetch = (historyId: string) => ((url: string | URL | Request) => {
  const u = String(url);
  if (u.includes("/watch")) return Promise.resolve(new Response(JSON.stringify({ historyId, expiration: String(Date.now() + 86400_000) }), { status: 200 }));
  return Promise.resolve(new Response("{}", { status: 200 }));
}) as unknown as typeof fetch;

const reg = { orgId: ORG, userId: U, supabaseUrl: "https://s", serviceKey: "svc", pubsubTopic: "projects/p/topics/t" };

Deno.test("mailbox: sync state, watch and the initial job are per connection and a second mailbox leaves the first cursor alone", async () => {
  const db = mk();
  await registerGmailMailbox(asClient(db), { ...reg, connectionId: "A", email: "a@x.com", isPrimary: true, accessToken: "tA", fetchImpl: watchFetch("100"), awaitSyncTrigger: true });
  await registerGmailMailbox(asClient(db), { ...reg, connectionId: "B", email: "b@x.com", isPrimary: false, accessToken: "tB", fetchImpl: watchFetch("900"), awaitSyncTrigger: true });
  const st = db.rows("gmail_sync_state");
  assertEquals(st.length, 2);
  assertEquals(st.find((r) => r.connection_id === "A")!.history_id, "100");
  assertEquals(st.find((r) => r.connection_id === "B")!.history_id, "900");
  assertEquals(db.rows("gmail_sync_jobs").map((j) => [j.connection_id, j.job_type, j.status]).sort(), [["A", "initial", "queued"], ["B", "initial", "queued"]]);
  // re-auth of A moves A's cursor only
  await registerGmailMailbox(asClient(db), { ...reg, connectionId: "A", email: "a@x.com", isPrimary: true, accessToken: "tA2", fetchImpl: watchFetch("150"), awaitSyncTrigger: true });
  assertEquals(db.rows("gmail_sync_state").length, 2);
  assertEquals(db.rows("gmail_sync_state").find((r) => r.connection_id === "A")!.history_id, "150");
  assertEquals(db.rows("gmail_sync_state").find((r) => r.connection_id === "B")!.history_id, "900");
});

Deno.test("mailbox: without a watch the existing cursor survives a re-auth; the primary adopts its legacy sync row", async () => {
  const db = mk({ gmail_sync_state: [{ id: "old", user_id: U, organization_id: ORG, connection_id: null, history_id: "42" }] });
  const calls: string[] = [];
  const f = ((url: string | URL | Request) => { calls.push(String(url)); return Promise.resolve(new Response("{}", { status: 200 })); }) as unknown as typeof fetch;
  await registerGmailMailbox(asClient(db), { ...reg, pubsubTopic: null, connectionId: "A", email: "a@x.com", isPrimary: true, accessToken: "t", fetchImpl: f, awaitSyncTrigger: true });
  const st = db.rows("gmail_sync_state");
  assertEquals(st.length, 1);
  assertEquals([st[0].id, st[0].connection_id, st[0].history_id], ["old", "A", "42"]);
  assertEquals(calls, ["https://s/functions/v1/gmail-sync"]); // no watch call
  // a secondary never steals the legacy row of the primary
  const db2 = mk({ gmail_sync_state: [{ id: "old", user_id: U, organization_id: ORG, connection_id: null, history_id: "42" }] });
  await registerGmailMailbox(asClient(db2), { ...reg, pubsubTopic: null, connectionId: "B", email: "b@x.com", isPrimary: false, accessToken: "t", fetchImpl: f, awaitSyncTrigger: true });
  assertEquals(db2.rows("gmail_sync_state").length, 2);
  assertEquals(db2.rows("gmail_sync_state").find((r) => r.id === "old")!.connection_id, null);
});

Deno.test("calendar initial_sync is enqueued once per calendar connection", async () => {
  const db = mk();
  await enqueueCalendarInitialSync(asClient(db), ORG, "cal1");
  await enqueueCalendarInitialSync(asClient(db), ORG, "cal1");
  await enqueueCalendarInitialSync(asClient(db), ORG, "cal2");
  assertEquals(db.rows("google_calendar_sync_jobs").map((j) => [j.connection_id, j.job_type, j.status]), [["cal1", "initial_sync", "pending"], ["cal2", "initial_sync", "pending"]]);
});

/* ----------------------------------------------------------------- connection status */

Deno.test("status: one account keeps the legacy shape and adds accounts[]", async () => {
  const db = mk({ google_oauth_master: [conn("a", { is_primary: true, created_at: "2026-01-01" })] });
  const r = await getGoogleConnectionStatus(asClient(db), U);
  assertEquals(r, {
    connected: true, legacy: false, email: "a@x.com", gmail: true, calendar: true, drive: true, scopes: [...ALL_GOOGLE_SCOPES],
    connectedAt: "2026-01-01", tokenExpired: false,
    accounts: [{ id: "a", email: "a@x.com", label: null, is_primary: true, connection_status: "active" }],
  });
});

Deno.test("status: several accounts report the primary's shape plus every account; only the primary is refreshed", async () => {
  const db = mk({ google_oauth_master: [conn("a", { token_expiry: past }), conn("b", { is_primary: true, token_expiry: past, email: "b@y.com", created_at: "2026-01-02" })] });
  const asked: string[] = [];
  const r = await getGoogleConnectionStatus(asClient(db), U, { getToken: (id) => { asked.push(id); return Promise.resolve("t"); } });
  assertEquals(r.email, "b@y.com");
  assertEquals(r.tokenExpired, false);
  assertEquals(asked, ["b"]);
  assertEquals((r.accounts as { id: string }[]).map((x) => x.id), ["b", "a"]);
  const failing = await getGoogleConnectionStatus(asClient(db), U, { getToken: () => Promise.reject(new Error("x")) });
  assertEquals(failing.tokenExpired, true);
});

Deno.test("status: needs_reauth primary reports tokenExpired; no master falls back to the legacy rows", async () => {
  const db = mk({ google_oauth_master: [conn("a", { is_primary: true, connection_status: "needs_reauth" })] });
  assertEquals((await getGoogleConnectionStatus(asClient(db), U)).tokenExpired, true);
  const legacy = mk({ google_calendar_connections: [{ id: "c", user_id: U, email: "l@x.com", scopes: "calendar" }] });
  assertEquals(await getGoogleConnectionStatus(asClient(legacy), U), {
    connected: true, legacy: true, email: "l@x.com", gmail: false, calendar: true, drive: false, scopes: [], accounts: [],
  });
  const none = await getGoogleConnectionStatus(asClient(mk()), U);
  assertEquals([none.connected, none.legacy, none.accounts], [false, false, []]);
});

/* ----------------------------------------------------------------- disconnect */

function twoAccountDb() {
  return mk({
    google_oauth_master: [conn("a", { is_primary: true }), conn("b")],
    gmail_oauth_tokens: [{ id: "ga", user_id: U, connection_id: "a" }, { id: "gb", user_id: U, connection_id: "b" }],
    gmail_sync_state: [{ id: "sa", user_id: U, connection_id: "a" }, { id: "sb", user_id: U, connection_id: "b" }],
    gmail_sync_jobs: [{ id: "ja", user_id: U, connection_id: "a" }, { id: "jb", user_id: U, connection_id: "b" }],
    google_calendar_connections: [{ id: "ca", user_id: U, connection_id: "a" }, { id: "cb", user_id: U, connection_id: "b" }],
    google_calendar_events: [{ id: "ea", connection_id: "ca" }, { id: "eb", connection_id: "cb" }],
    google_calendar_sync_jobs: [{ id: "x1", connection_id: "ca" }, { id: "x2", connection_id: "cb" }],
    drive_connections: [{ id: "da", user_id: U, connection_id: "a" }, { id: "db", user_id: U, connection_id: "b" }],
    drive_files: [{ id: "fa", connection_id: "a" }, { id: "fb", connection_id: "b" }],
    users: [{ id: U, gmail_connected: true, google_drive_connected: true }],
    user_connected_accounts: [{ user_id: U, provider: "google_workspace" }],
  });
}

Deno.test("disconnect: an id that is not the caller's is 404 and nothing is deleted", async () => {
  const db = twoAccountDb();
  const r = await disconnectGoogle(asClient(db), U, "someone-elses");
  assertEquals(r.status, 404);
  assertEquals(db.rows("google_oauth_master").length, 2);
  const other = await disconnectGoogle(asClient(db), "other-user", "a");
  assertEquals(other.status, 404);
  assertEquals(db.rows("google_oauth_master").length, 2);
});

Deno.test("disconnect: several accounts and no id is 400", async () => {
  const db = twoAccountDb();
  const r = await disconnectGoogle(asClient(db), U);
  assertEquals(r.status, 400);
  assertEquals(db.rows("google_oauth_master").length, 2);
});

Deno.test("disconnect: removing one account removes only its rows, revokes its token and keeps the flags while another has the service", async () => {
  const db = twoAccountDb();
  const revoked: string[] = [];
  const r = await disconnectGoogle(asClient(db), U, "b", { revoke: (t) => { revoked.push(t); return Promise.resolve(); } });
  assertEquals(r, { status: 200, body: { success: true } });
  assertEquals(revoked, ["ref-b"]);
  assertEquals(db.rows("google_oauth_master").map((x) => x.id), ["a"]);
  for (const t of ["gmail_oauth_tokens", "gmail_sync_state", "gmail_sync_jobs", "drive_connections"]) {
    assertEquals(db.rows(t).map((x) => x.connection_id), ["a"], t);
  }
  assertEquals(db.rows("google_calendar_connections").map((x) => x.id), ["ca"]);
  assertEquals(db.rows("google_calendar_events").map((x) => x.id), ["ea"]);
  assertEquals(db.rows("google_calendar_sync_jobs").map((x) => x.id), ["x1"]);
  assertEquals(db.rows("drive_files").map((x) => x.id), ["fa"]);
  assertEquals([db.rows("users")[0].gmail_connected, db.rows("users")[0].google_drive_connected], [true, true]);
  assertEquals(db.rows("user_connected_accounts").length, 1); // the mirror is the DB trigger's business
  assertEquals(db.rows("audit_logs")[0].after_state, { disconnected_at: (db.rows("audit_logs")[0].after_state as { disconnected_at: string }).disconnected_at, connection_id: "b" });
});

Deno.test("disconnect: clears the users flags only for a service no remaining account has", async () => {
  const db = twoAccountDb();
  db.tables["drive_connections"] = db.rows("drive_connections").filter((r) => r.connection_id === "b"); // only b has Drive
  const r = await disconnectGoogle(asClient(db), U, "b", { revoke: () => Promise.resolve() });
  assertEquals(r.status, 200);
  assertEquals([db.rows("users")[0].gmail_connected, db.rows("users")[0].google_drive_connected], [true, false]);
});

Deno.test("disconnect: the only account, with or without an id, clears everything for the user as before", async () => {
  const db = mk({
    google_oauth_master: [conn("a", { is_primary: true })],
    gmail_oauth_tokens: [{ id: "ga", user_id: U, connection_id: null }, { id: "gz", user_id: "other", connection_id: "z" }],
    google_calendar_connections: [{ id: "ca", user_id: U, connection_id: "a" }],
    google_calendar_events: [{ id: "ea", connection_id: "ca" }],
    users: [{ id: U, gmail_connected: true, google_drive_connected: true }],
    user_connected_accounts: [{ user_id: U, provider: "google_workspace" }, { user_id: U, provider: "google_gmail" }, { user_id: U, provider: "microsoft_365" }],
  });
  const r = await disconnectGoogle(asClient(db), U, null, { revoke: () => Promise.resolve() });
  assertEquals(r.status, 200);
  assertEquals(db.rows("google_oauth_master").length, 0);
  assertEquals(db.rows("gmail_oauth_tokens").map((x) => x.id), ["gz"]); // another user's rows survive
  assertEquals(db.rows("google_calendar_events").length, 0);
  assertEquals([db.rows("users")[0].gmail_connected, db.rows("users")[0].google_drive_connected], [false, false]);
  assertEquals(db.rows("user_connected_accounts").map((x) => x.provider), ["microsoft_365"]);
});

Deno.test("disconnect: a legacy user with no master row is cleaned up as before", async () => {
  const db = mk({
    google_calendar_connections: [{ id: "ca", user_id: U, connection_id: null }],
    google_calendar_list: [{ id: "l", connection_id: "ca" }],
    users: [{ id: U, gmail_connected: true }],
  });
  const r = await disconnectGoogle(asClient(db), U, null, { revoke: () => Promise.resolve() });
  assertEquals(r.status, 200);
  assertEquals(db.rows("google_calendar_connections").length, 0);
  assertEquals(db.rows("google_calendar_list").length, 0);
});

/* ----------------------------------------------------------------- google-accounts actions */

Deno.test("google-accounts list: caller's accounts only, primary first, never a token column", async () => {
  const db = mk({ google_oauth_master: [conn("a", { last_refresh_error: "x" }), conn("b", { is_primary: true, label: "Work" }), { ...conn("z"), user_id: "other", id: "z" }] });
  const r = await runGoogleAccountsAction(asClient(db), U, { action: "list" });
  assertEquals(r.status, 200);
  const accounts = r.body.accounts as Record<string, unknown>[];
  assertEquals(accounts.map((x) => x.id), ["b", "a"]);
  assertEquals(Object.keys(accounts[0]).sort(), ["connection_status", "email", "granted_scopes", "id", "is_primary", "label", "last_refresh_error"]);
  assert(!JSON.stringify(r.body).includes("ref-"));
  assertEquals(accounts[1].last_refresh_error, "x");
});

Deno.test("google-accounts set-primary / set-label: ownership checked first, then the RPCs", async () => {
  const calls: Array<[string, Record<string, unknown>]> = [];
  const db = mk({ google_oauth_master: [conn("a", { is_primary: true }), conn("b"), { ...conn("z"), user_id: "other", id: "z" }] }, {
    google_set_primary: (a) => { calls.push(["primary", a]); return null; },
    google_set_label: (a) => { calls.push(["label", a]); return null; },
  });
  assertEquals((await runGoogleAccountsAction(asClient(db), U, { action: "set-primary", connection_id: "z" })).status, 404);
  assertEquals((await runGoogleAccountsAction(asClient(db), U, { action: "set-label", connection_id: "z", label: "x" })).status, 404);
  assertEquals((await runGoogleAccountsAction(asClient(db), U, { action: "set-primary" } as never)).status, 400);
  assertEquals((await runGoogleAccountsAction(asClient(db), U, { action: "nope" } as never)).status, 400);
  assertEquals(calls.length, 0);
  assertEquals((await runGoogleAccountsAction(asClient(db), U, { action: "set-primary", connection_id: "b" })).status, 200);
  assertEquals((await runGoogleAccountsAction(asClient(db), U, { action: "set-label", connection_id: "a", label: "Personal" })).status, 200);
  assertEquals(calls, [["primary", { p_connection: "b" }], ["label", { p_connection: "a", p_label: "Personal" }]]);
});

Deno.test("google-accounts: an RPC error is a 500 with no detail", async () => {
  const db = mk({ google_oauth_master: [conn("a", { is_primary: true })] }); // no rpc stub -> error
  const r = await runGoogleAccountsAction(asClient(db), U, { action: "set-primary", connection_id: "a" });
  assertEquals([r.status, r.body], [500, { error: "Update failed" }]);
});

/* ----------------------------------------------------------------- token cron */

/** Google token endpoint stub keyed by the refresh token in the form body. */
function tokenEndpoint(behaviour: Record<string, "ok" | "invalid_grant" | "server_error">) {
  const seen: string[] = [];
  const f = ((_url: string | URL | Request, init?: RequestInit) => {
    const rt = new URLSearchParams(String(init?.body)).get("refresh_token")!;
    seen.push(rt);
    const b = behaviour[rt] ?? "ok";
    if (b === "ok") return Promise.resolve(new Response(JSON.stringify({ access_token: `new-${rt}`, expires_in: 3600 }), { status: 200 }));
    if (b === "invalid_grant") return Promise.resolve(new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 }));
    return Promise.resolve(new Response("oops", { status: 500 }));
  }) as unknown as typeof fetch;
  return { f, seen };
}

function cronDb() {
  return mk({
    google_oauth_master: [
      conn("a", { is_primary: true, token_expiry: new Date(Date.now() + 120_000).toISOString() }),
      conn("b", { token_expiry: past }),
      conn("c", { token_expiry: new Date(Date.now() + 5 * 3600_000).toISOString() }), // not due
      conn("d", { token_expiry: past, connection_status: "needs_reauth" }),           // already flagged
      conn("e", { token_expiry: past, refresh_fail_count: 5 }),                        // at the cap
    ],
    gmail_oauth_tokens: [{ id: "ga", user_id: U, connection_id: "a", access_token: "oldA" }, { id: "gb", user_id: U, connection_id: "b", access_token: "oldB" }],
    google_calendar_connections: [{ id: "ca", user_id: U, connection_id: "a", access_token: "oldA" }, { id: "cb", user_id: U, connection_id: "b", access_token: "oldB" }],
  });
}

Deno.test("cron: each due connection is refreshed with its OWN token and only its rows are written", async () => {
  const db = cronDb();
  const { f, seen } = tokenEndpoint({});
  const r = await refreshStaleGoogleConnections(asClient(db), { fetchImpl: f });
  assertEquals([r.total, r.refreshed, r.failed], [2, 2, 0]);
  assertEquals(seen.sort(), ["ref-a", "ref-b"]); // never c, d or e; each row sends its own refresh token
  const m = (id: string) => db.rows("google_oauth_master").find((x) => x.id === id)!;
  assertEquals(await decryptToken(m("a").encrypted_access_token as string), "new-ref-a");
  assertEquals(await decryptToken(m("b").encrypted_access_token as string), "new-ref-b");
  assertEquals(m("c").encrypted_access_token, "acc-c");
  assertEquals(await decryptToken(db.rows("gmail_oauth_tokens").find((x) => x.connection_id === "b")!.access_token as string), "new-ref-b");
  assertEquals(await decryptToken(db.rows("gmail_oauth_tokens").find((x) => x.connection_id === "a")!.access_token as string), "new-ref-a");
});

Deno.test("cron: invalid_grant flips that connection to needs_reauth only; a transient error bumps only its counter; the others still refresh", async () => {
  const db = cronDb();
  db.rows("google_oauth_master").push(conn("f", { token_expiry: past, email: "f@x.com" }));
  const { f } = tokenEndpoint({ "ref-b": "invalid_grant", "ref-f": "server_error" });
  const r = await refreshStaleGoogleConnections(asClient(db), { fetchImpl: f });
  assertEquals([r.total, r.refreshed, r.failed], [3, 1, 2]);
  const m = (id: string) => db.rows("google_oauth_master").find((x) => x.id === id)!;
  assertEquals([m("b").connection_status, m("b").last_refresh_error], ["needs_reauth", "invalid_grant"]);
  assertEquals(m("a").connection_status, "active");
  assertNotEquals(m("a").encrypted_access_token, "acc-a");
  assertEquals([m("f").connection_status, m("f").refresh_fail_count], ["active", 1]);
  // the flagged connection leaves the queue; the transient one stays until the cap
  const again = await refreshStaleGoogleConnections(asClient(db), { fetchImpl: tokenEndpoint({}).f });
  assertEquals(again.total, 1); // only the transient failure is still due
});

Deno.test("cron: honours the per-run cap, soonest expiry first", async () => {
  const db = mk({ google_oauth_master: [1, 2, 3, 4].map((n) => conn(`k${n}`, { token_expiry: new Date(Date.now() - n * 60_000).toISOString() })) });
  const { f, seen } = tokenEndpoint({});
  const r = await refreshStaleGoogleConnections(asClient(db), { fetchImpl: f, maxBatch: 2 });
  assertEquals(r.total, 2);
  assertEquals(seen, ["ref-k4", "ref-k3"]);
});

/* ----------------------------------------------------------------- calendar handlers */

const calRow = (id: string, connection_id: string | null, extra: Record<string, unknown> = {}) => ({
  id, user_id: U, org_id: ORG, email: `${id}@x.com`, connection_id, access_token: "plain-acc", refresh_token: "plain-ref",
  token_expiry: future, selected_calendar_ids: ["primary"], created_at: id === "ca" ? "2026-01-01" : "2026-01-02", ...extra,
});

Deno.test("calendar row: default is the primary account's, an id may be the account or the row, foreign ids are not found", async () => {
  const db = mk({
    google_oauth_master: [conn("a"), conn("b", { is_primary: true })],
    google_calendar_connections: [calRow("ca", "a"), calRow("cb", "b"), { ...calRow("cz", "z"), user_id: "other" }],
  });
  const pick = async (id?: string) => await resolveCalendarRow(asClient(db), U, id);
  assertEquals((await pick() as { row: CalendarRow }).row.id, "cb");
  assertEquals((await pick("a") as { row: CalendarRow }).row.id, "ca");
  assertEquals((await pick("ca") as { row: CalendarRow }).row.id, "ca");
  assertEquals(await pick("cz"), { error: "not_found" });
  assertEquals(await pick("z"), { error: "not_found" });
  assertEquals(await resolveCalendarRow(asClient(mk()), U), { error: "not_connected" });
  // primary without a calendar row: the oldest calendar row
  const gmailPrimary = mk({ google_oauth_master: [conn("a", { is_primary: true }), conn("b")], google_calendar_connections: [calRow("cb", "b")] });
  assertEquals(((await resolveCalendarRow(asClient(gmailPrimary), U)) as { row: CalendarRow }).row.id, "cb");
});

Deno.test("calendar token: through the master connection (own account only); a legacy row refreshes itself only", async () => {
  const db = mk({
    google_oauth_master: [conn("a", { is_primary: true, token_expiry: past }), conn("b", { token_expiry: past })],
    google_calendar_connections: [calRow("ca", "a", { token_expiry: past }), calRow("cb", "b", { token_expiry: past }), calRow("cl", null, { token_expiry: past, refresh_token: "legacy-ref" })],
  });
  const { f, seen } = tokenEndpoint({});
  assertEquals(await getCalendarAccessToken(asClient(db), db.rows("google_calendar_connections")[1] as CalendarRow, { fetchImpl: f }), "new-ref-b");
  assertEquals(seen, ["ref-b"]);
  assertEquals(db.rows("google_oauth_master").find((x) => x.id === "a")!.encrypted_access_token, "acc-a");
  assertEquals(await getCalendarAccessToken(asClient(db), db.rows("google_calendar_connections")[2] as CalendarRow, { fetchImpl: f }), "new-legacy-ref");
  assertEquals(await decryptToken(db.rows("google_calendar_connections")[2].access_token as string), "new-legacy-ref");
  assertEquals(db.rows("google_calendar_connections")[0].access_token, "plain-acc"); // untouched
  // a revoked grant is surfaced, not swallowed
  await assertRejects(
    () => getCalendarAccessToken(asClient(db), { ...(db.rows("google_calendar_connections")[2] as CalendarRow), token_expiry: past }, { fetchImpl: tokenEndpoint({ "legacy-ref": "invalid_grant" }).f }),
    GoogleTokenError,
  );
});

Deno.test("calendar disconnect: one account's calendar only; several rows need an id; foreign ids 404", async () => {
  const db = mk({
    google_calendar_connections: [calRow("ca", "a"), calRow("cb", "b")],
    google_calendar_events: [{ id: "ea", connection_id: "ca" }, { id: "eb", connection_id: "cb" }],
    calendar_event_map: [{ id: "ma", connection_id: "ca" }, { id: "mb", connection_id: "cb" }],
  });
  const revoked: string[] = [];
  const revoke = (t: string) => { revoked.push(t); return Promise.resolve(); };
  assertEquals((await disconnectGoogleCalendar(asClient(db), U, null, { revoke })).status, 400);
  assertEquals((await disconnectGoogleCalendar(asClient(db), U, "nope", { revoke })).status, 404);
  assertEquals(db.rows("google_calendar_connections").length, 2);
  assertEquals((await disconnectGoogleCalendar(asClient(db), U, "b", { revoke })).status, 200);
  assertEquals(db.rows("google_calendar_connections").map((r) => r.id), ["ca"]);
  assertEquals(db.rows("google_calendar_events").map((r) => r.id), ["ea"]);
  assertEquals(db.rows("calendar_event_map").map((r) => r.id), ["ma"]);
  assertEquals(revoked, ["plain-acc"]);
  // the last row needs no id (as before)
  assertEquals((await disconnectGoogleCalendar(asClient(db), U, null, { revoke })).status, 200);
  assertEquals(db.rows("google_calendar_connections").length, 0);
  assertEquals((await disconnectGoogleCalendar(asClient(db), U, null, { revoke })).status, 200); // nothing to do is still success
});

Deno.test("dedupeSelectedCalendars and pickTeamGoogleRow", () => {
  assertEquals(dedupeSelectedCalendars(["primary", "Me@x.com", "other"], "me@x.com"), ["Me@x.com", "other"]);
  assertEquals(dedupeSelectedCalendars(["primary", "other"], "me@x.com"), ["primary", "other"]);
  assertEquals(dedupeSelectedCalendars(["primary"], null), ["primary"]);

  const rows = [{ email: "b", connection_id: "B", created_at: "2" }, { email: "a", connection_id: "A", created_at: "1" }];
  assertEquals(pickTeamGoogleRow(rows, new Set(["B"]))?.email, "b");
  assertEquals(pickTeamGoogleRow(rows, new Set())?.email, "a");           // oldest
  assertEquals(pickTeamGoogleRow(rows[0], new Set())?.email, "b");        // embed as an object
  assertEquals(pickTeamGoogleRow(null, new Set()), null);
  assertEquals(pickTeamGoogleRow([], new Set()), null);
});
