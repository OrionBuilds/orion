import { assertEquals } from "jsr:@std/assert@1";
import { FakeSupabase, asClient } from "./testing/fake-supabase.ts";
import { encryptToken } from "./crypto.ts";
import { resolveRefreshToken, writeMasterToken } from "./google-oauth-helpers.ts";

Deno.env.set("GMAIL_ENCRYPTION_KEY", "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff");
const U = "u1";
const m = (id: string, primary: boolean, rt: string | null, created: string) => ({ id, user_id: U, org_id: "o", email: `${id}@x.com`, is_primary: primary, created_at: created, encrypted_refresh_token: rt });

Deno.test("resolveRefreshToken: default is the primary's token, a connection id picks that account, a foreign id yields nothing", async () => {
  const db = new FakeSupabase({ google_oauth_master: [m("a", false, "rtA", "1"), m("b", true, await encryptToken("rtB"), "2"), { ...m("z", true, "rtZ", "1"), user_id: "other" }] });
  assertEquals((await resolveRefreshToken(asClient(db), U, "o"))?.refreshToken, "rtB");
  assertEquals(await resolveRefreshToken(asClient(db), U, "o", "a"), { refreshToken: "rtA", source: "master", connectionId: "a" });
  assertEquals(await resolveRefreshToken(asClient(db), U, "o", "z"), null);
  assertEquals(await resolveRefreshToken(asClient(db), "nobody", "o"), null);
});

Deno.test("resolveRefreshToken: falls back to THIS connection's child rows only", async () => {
  const db = new FakeSupabase({
    google_oauth_master: [m("a", true, null, "1"), m("b", false, null, "2")],
    gmail_oauth_tokens: [{ id: "g1", user_id: U, connection_id: "b", refresh_token: "gmailB" }],
    google_calendar_connections: [{ id: "c1", user_id: U, connection_id: "a", refresh_token: "calA" }],
  });
  assertEquals((await resolveRefreshToken(asClient(db), U, "o", "a"))?.refreshToken, "calA");
  assertEquals((await resolveRefreshToken(asClient(db), U, "o", "b"))?.refreshToken, "gmailB");
  // legacy unlinked row belongs to the primary only
  db.rows("gmail_oauth_tokens").push({ id: "g0", user_id: U, connection_id: null, refresh_token: "legacy" });
  db.tables["google_calendar_connections"] = [];
  assertEquals((await resolveRefreshToken(asClient(db), U, "o", "a"))?.refreshToken, "legacy");
});

Deno.test("writeMasterToken: returns the connection id, never overwrites another account, merges scopes per account", async () => {
  const db = new FakeSupabase({}, { onWrite: (op, t, rows) => { if (op === "insert" && t === "google_oauth_master") for (const r of rows) r.is_primary = db.rows(t).length === 1; } });
  const a = await writeMasterToken(asClient(db), "o", U, "a@x.com", "at", "rt", new Date().toISOString(), ["s1"]);
  const b = await writeMasterToken(asClient(db), "o", U, "b@x.com", "at2", "rt2", new Date().toISOString(), ["s2"]);
  const a2 = await writeMasterToken(asClient(db), "o", U, "A@x.com", "at3", "rt3", new Date().toISOString(), ["s3"]);
  assertEquals(a2, a);
  assertEquals(db.rows("google_oauth_master").length, 2);
  assertEquals(db.rows("google_oauth_master").find((r) => r.id === a)!.granted_scopes, ["s1", "s3"]);
  assertEquals(db.rows("google_oauth_master").find((r) => r.id === b)!.granted_scopes, ["s2"]);
});
