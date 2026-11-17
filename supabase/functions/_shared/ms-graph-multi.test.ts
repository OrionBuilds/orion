import { assertEquals, assertRejects } from "jsr:@std/assert@1";
import { pickConnection, getValidAccessToken } from "./ms-graph.ts";
import { FakeSupabase, asClient } from "./testing/fake-supabase.ts";

const rows = [
  { id: "a", email: "Jordan@a8.example", is_primary: false, created_at: "2026-01-02" },
  { id: "b", email: "jordan2@a8.example", is_primary: true, created_at: "2026-01-03" },
];

Deno.test("pickConnection: id, then email (any case), then primary, then oldest", () => {
  assertEquals(pickConnection(rows, { connectionId: "a" })?.id, "a");
  assertEquals(pickConnection(rows, { email: "JORDAN@A8.EXAMPLE" })?.id, "a");
  assertEquals(pickConnection(rows)?.id, "b");
  assertEquals(pickConnection(rows.map((r) => ({ ...r, is_primary: false })))?.id, "a");
  assertEquals(pickConnection([rows[0]])?.id, "a");
  assertEquals(pickConnection([]), null);
});

Deno.test("pickConnection: a selector for an account the user does not have never falls back to another account", () => {
  assertEquals(pickConnection(rows, { connectionId: "zzz" }), null);
  assertEquals(pickConnection(rows, { email: "other@x.com" }), null);
});

Deno.test("getValidAccessToken: two accounts no longer fail the lookup; an unknown account is a clear error", async () => {
  const f = new FakeSupabase({ microsoft_oauth_master: [
    { id: "a", user_id: "u", email: "a@x.com", is_primary: true, connection_status: "needs_reauth", encrypted_access_token: "x", encrypted_refresh_token: "y", token_expires_at: "2099-01-01" },
    { id: "b", user_id: "u", email: "b@x.com", is_primary: false, connection_status: "active", encrypted_access_token: "x", encrypted_refresh_token: "y", token_expires_at: "2099-01-01" },
  ] });
  const cfg = { clientId: "c", clientSecret: "s", tenantId: "t", redirectUri: "r" } as never;
  // the default is the primary (here needs_reauth), proving the lookup did not throw on two rows
  await assertRejects(() => getValidAccessToken(asClient(f), "u", { cfg }), Error, "needs to be re-authorized");
  await assertRejects(() => getValidAccessToken(asClient(f), "u", { cfg, connectionId: "nope" }), Error, "not connected");
});

import { authorityFor, authorizeUrl, MS_SCOPES, MS_SCOPES_EXTERNAL, MS_SCOPES_PERSONAL, scopesFor, tenantFromIdToken } from "./ms-graph.ts";

const cfgT = { clientId: "cid", tenantId: "home-tenant" };
Deno.test("authority: home unchanged, external = organizations (real tenant on refresh), personal = consumers", () => {
  assertEquals(authorityFor(cfgT), "home-tenant");
  assertEquals(authorityFor(cfgT, "work"), "home-tenant");
  assertEquals(authorityFor(cfgT, "external"), "organizations");
  const tid = "11111111-2222-3333-4444-555555555555";
  assertEquals(authorityFor(cfgT, "external", tid, "token"), tid);
  assertEquals(authorityFor(cfgT, "external", tid, "authorize"), "organizations");
  assertEquals(authorityFor(cfgT, "external", "not-a-guid", "token"), "organizations");
  assertEquals(authorityFor(cfgT, "personal", "9188040d-6c67-4c5b-b112-36a304b66dad", "token"), "consumers");
});

Deno.test("scopes: home = full set; external drops Teams scopes; personal has no organisational-only scope", () => {
  assertEquals(scopesFor(), MS_SCOPES);
  assertEquals(scopesFor("work"), MS_SCOPES);
  assertEquals(MS_SCOPES_EXTERNAL.includes("OnlineMeetingTranscript.Read.All" as never), false);
  assertEquals(MS_SCOPES_EXTERNAL.includes("Mail.ReadWrite" as never), true);
  for (const bad of ["Sites.ReadWrite.All", "Files.ReadWrite.All", "OnlineMeetings.Read", "OnlineMeetingTranscript.Read.All"]) assertEquals(MS_SCOPES_PERSONAL.includes(bad as never), false);
  assertEquals(MS_SCOPES_PERSONAL.includes("Mail.Send" as never), true);
});

Deno.test("authorizeUrl: default URL is exactly the home-tenant one; personal/external use their authority and scopes", () => {
  const home = new URL(authorizeUrl(cfgT, { redirectUri: "https://x/cb", state: "s" }));
  assertEquals(home.pathname, "/home-tenant/oauth2/v2.0/authorize");
  assertEquals(home.searchParams.get("scope"), MS_SCOPES.join(" "));
  const pers = new URL(authorizeUrl(cfgT, { redirectUri: "https://x/cb", state: "s", accountType: "personal" }));
  assertEquals(pers.pathname, "/consumers/oauth2/v2.0/authorize");
  assertEquals(pers.searchParams.get("scope"), MS_SCOPES_PERSONAL.join(" "));
  assertEquals(pers.searchParams.get("prompt"), "select_account");
  const ext = new URL(authorizeUrl(cfgT, { redirectUri: "https://x/cb", state: "s", accountType: "external" }));
  assertEquals(ext.pathname, "/organizations/oauth2/v2.0/authorize");
});

Deno.test("tenantFromIdToken reads tid, rejects garbage", () => {
  const mk = (p: unknown) => `h.${btoa(JSON.stringify(p)).replace(/=+$/, "")}.s`;
  assertEquals(tenantFromIdToken(mk({ tid: "11111111-2222-3333-4444-555555555555" })), "11111111-2222-3333-4444-555555555555");
  assertEquals(tenantFromIdToken(mk({ tid: "nope" })), null);
  assertEquals(tenantFromIdToken("garbage"), null);
  assertEquals(tenantFromIdToken(undefined), null);
});
