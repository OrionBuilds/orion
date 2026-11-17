import { assertEquals, assertRejects } from "jsr:@std/assert@1";
import { FakeSupabase, asClient } from "./testing/fake-supabase.ts";
import { decryptToken } from "./crypto.ts";
import {
  getGoogleAccessToken, GoogleTokenError, listGoogleConnections, pickGoogleConnection, refreshGoogleAccessToken, upsertGoogleConnection,
} from "./google-connections.ts";

Deno.env.set("GMAIL_ENCRYPTION_KEY", "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff");
Deno.env.set("GOOGLE_CLIENT_ID", "cid"); Deno.env.set("GOOGLE_CLIENT_SECRET", "sec");
const env = { get: (k: string) => ({ GOOGLE_CLIENT_ID: "cid", GOOGLE_CLIENT_SECRET: "sec" } as Record<string, string>)[k] };
const U = "u1", ORG = "o1";
const NOW = new Date("2026-11-08T12:00:00Z");
const future = "2026-11-08T13:00:00Z", past = "2026-11-08T11:00:00Z";

const rows = [
  { id: "a", email: "Jordan@acme.example", is_primary: false, created_at: "2026-01-02" },
  { id: "b", email: "second@gmail.com", is_primary: true, created_at: "2026-01-03" },
];

Deno.test("pickGoogleConnection: id, then email (any case), then primary, then oldest; unknown never falls back", () => {
  assertEquals(pickGoogleConnection(rows, { connectionId: "a" })?.id, "a");
  assertEquals(pickGoogleConnection(rows, { email: "JORDAN@ACME.EXAMPLE" })?.id, "a");
  assertEquals(pickGoogleConnection(rows)?.id, "b");
  assertEquals(pickGoogleConnection(rows.map((r) => ({ ...r, is_primary: false })))?.id, "a");
  assertEquals(pickGoogleConnection(rows, { connectionId: "zzz" }), null);
  assertEquals(pickGoogleConnection(rows, { email: "x@y.com" }), null);
  assertEquals(pickGoogleConnection([]), null);
});

function twoAccounts() {
  return new FakeSupabase({
    google_oauth_master: [
      { id: "a", user_id: U, org_id: ORG, email: "a@x.com", is_primary: true, connection_status: "active", encrypted_access_token: "tokA", encrypted_refresh_token: "refA", token_expiry: past, refresh_fail_count: 0, created_at: "2026-01-01" },
      { id: "b", user_id: U, org_id: ORG, email: "b@y.com", is_primary: false, connection_status: "active", encrypted_access_token: "tokB", encrypted_refresh_token: "refB", token_expiry: past, refresh_fail_count: 0, created_at: "2026-01-02" },
    ],
    gmail_oauth_tokens: [{ id: "ga", user_id: U, email: "a@x.com", connection_id: "a", access_token: "oldA" }, { id: "gb", user_id: U, email: "b@y.com", connection_id: "b", access_token: "oldB" }],
    google_calendar_connections: [{ id: "ca", user_id: U, email: "a@x.com", connection_id: "a", access_token: "oldA" }, { id: "cb", user_id: U, email: "b@y.com", connection_id: "b", access_token: "oldB" }],
    drive_connections: [{ id: "da", user_id: U, email: "a@x.com", connection_id: "a", access_token_encrypted: "oldA" }],
  });
}
const okFetch = (access: string, extra: Record<string, unknown> = {}) => (() => Promise.resolve(new Response(JSON.stringify({ access_token: access, expires_in: 3600, ...extra }), { status: 200 }))) as unknown as typeof fetch;

Deno.test("refreshing connection B writes B's rows only and never A's", async () => {
  const f = twoAccounts();
  const tok = await getGoogleAccessToken(asClient(f), U, { connectionId: "b", fetchImpl: okFetch("newB"), now: () => NOW });
  assertEquals(tok, "newB");
  const m = f.rows("google_oauth_master");
  assertEquals((await decryptToken(m[1].encrypted_access_token as string)), "newB");
  assertEquals(m[0].encrypted_access_token, "tokA");                       // A untouched
  assertEquals(f.rows("gmail_oauth_tokens").map((r) => (r.access_token as string).includes(":")), [false, true]);
  assertEquals(f.rows("gmail_oauth_tokens")[0].access_token, "oldA");
  assertEquals(f.rows("google_calendar_connections")[0].access_token, "oldA");
  assertEquals(typeof f.rows("google_calendar_connections")[1].access_token, "string");
  assertEquals(f.rows("drive_connections")[0].access_token_encrypted, "oldA");
});

Deno.test("default is the primary; a fresh stored token is returned without calling Google", async () => {
  const f = twoAccounts();
  f.rows("google_oauth_master")[0].token_expiry = future;
  const never = (() => { throw new Error("should not refresh"); }) as unknown as typeof fetch;
  assertEquals(await getGoogleAccessToken(asClient(f), U, { fetchImpl: never, now: () => NOW }), "tokA");
});

Deno.test("invalid_grant marks only that connection needs_reauth; other errors only count a failure", async () => {
  const f = twoAccounts();
  const bad = (() => Promise.resolve(new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 }))) as unknown as typeof fetch;
  await assertRejects(() => getGoogleAccessToken(asClient(f), U, { connectionId: "b", fetchImpl: bad, now: () => NOW }), GoogleTokenError);
  assertEquals(f.rows("google_oauth_master").map((r) => r.connection_status), ["active", "needs_reauth"]);
  await assertRejects(() => getGoogleAccessToken(asClient(f), U, { connectionId: "b", fetchImpl: okFetch("x"), now: () => NOW }), Error, "needs to be re-authorized");
  const boom = (() => Promise.resolve(new Response("{}", { status: 503 }))) as unknown as typeof fetch;
  await assertRejects(() => getGoogleAccessToken(asClient(f), U, { connectionId: "a", fetchImpl: boom, now: () => NOW }), GoogleTokenError);
  assertEquals([f.rows("google_oauth_master")[0].connection_status, f.rows("google_oauth_master")[0].refresh_fail_count], ["active", 1]);
});

Deno.test("a connection the user does not have is a clear error, not another account", async () => {
  const f = twoAccounts();
  await assertRejects(() => getGoogleAccessToken(asClient(f), U, { connectionId: "nope", now: () => NOW }), Error, "not connected");
  await assertRejects(() => getGoogleAccessToken(asClient(f), "other-user", { now: () => NOW }), Error, "not connected");
});

Deno.test("a legacy child row without connection_id is adopted only when user and email match", async () => {
  const f = twoAccounts();
  f.rows("gmail_oauth_tokens").push({ id: "legacy-match", user_id: U, email: "B@Y.com", connection_id: null, access_token: "old" });
  f.rows("gmail_oauth_tokens").push({ id: "legacy-other", user_id: U, email: "c@z.com", connection_id: null, access_token: "old" });
  await getGoogleAccessToken(asClient(f), U, { connectionId: "b", fetchImpl: okFetch("newB"), now: () => NOW });
  const g = f.rows("gmail_oauth_tokens");
  assertEquals(g.find((r) => r.id === "legacy-match")?.connection_id, "b");
  assertEquals(g.find((r) => r.id === "legacy-other")?.connection_id, null);
});

Deno.test("refreshGoogleAccessToken: typed errors", async () => {
  const bad = (() => Promise.resolve(new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 }))) as unknown as typeof fetch;
  const e = await refreshGoogleAccessToken("r", bad, env).catch((x) => x as GoogleTokenError);
  assertEquals([e.code, e.needsReauth], ["invalid_grant", true]);
  const none = await refreshGoogleAccessToken("r", okFetch("x"), { get: () => undefined }).catch((x) => x as GoogleTokenError);
  assertEquals(none.code, "not_configured");
});

const base = { orgId: ORG, userId: U, accessToken: "acc", refreshToken: "ref", tokenExpiry: future };

Deno.test("upsert: first account is primary, a new email is a second row, the same email re-authorizes its own row", async () => {
  const f = new FakeSupabase({ google_oauth_master: [] }, { unique: { google_oauth_master: [["user_id", "email"]] } });
  const first = await upsertGoogleConnection(asClient(f), { ...base, email: "a@x.com", scopes: ["gmail"] });
  assertEquals([first.created], [true]);
  const second = await upsertGoogleConnection(asClient(f), { ...base, email: "b@y.com", scopes: ["calendar"] });
  assertEquals([second.created, f.rows("google_oauth_master").length], [true, 2]);
  const again = await upsertGoogleConnection(asClient(f), { ...base, email: "B@Y.com", accessToken: "acc2", scopes: ["drive"] });
  assertEquals([again.created, again.connectionId === second.connectionId, f.rows("google_oauth_master").length], [false, true, 2]);
  assertEquals(again.scopes.sort(), ["calendar", "drive"]);              // merged for THAT account only
  assertEquals((await listGoogleConnections(asClient(f), U)).length, 2);
});

Deno.test("upsert fails closed when encryption is unavailable (never stores a plaintext token)", async () => {
  const key = Deno.env.get("GMAIL_ENCRYPTION_KEY")!;
  Deno.env.delete("GMAIL_ENCRYPTION_KEY");
  try {
    const f = new FakeSupabase({ google_oauth_master: [] });
    await assertRejects(() => upsertGoogleConnection(asClient(f), { ...base, email: "a@x.com", scopes: [] }), Error, "not configured");
    assertEquals(f.rows("google_oauth_master").length, 0);
  } finally { Deno.env.set("GMAIL_ENCRYPTION_KEY", key); }
});
