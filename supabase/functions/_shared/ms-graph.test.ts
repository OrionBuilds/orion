import { assertEquals, assertRejects, assertStringIncludes } from "jsr:@std/assert@1";
import {
  authorizeUrl,
  graphFetch,
  isExcludedIdentity,
  msConfig,
  normalizeEmail,
  refreshTokens,
  MsTokenError,
} from "./ms-graph.ts";

const env = (m: Record<string, string>) => ({ get: (k: string) => m[k] });
const cfg = { clientId: "cid", clientSecret: "sec", tenantId: "tid", excludedEmails: [] };

Deno.test("msConfig requires all three secrets", () => {
  assertEquals(msConfig(env({ MS_OAUTH_CLIENT_ID: "a", MS_OAUTH_CLIENT_SECRET: "b" })), null);
  const c = msConfig(env({
    MS_OAUTH_CLIENT_ID: "a",
    MS_OAUTH_CLIENT_SECRET: "b",
    MS_OAUTH_TENANT_ID: "c",
    MS_EXCLUDED_EMAILS: "Owner+x@Example.com, other@x.com",
  }))!;
  assertEquals(c.excludedEmails, ["owner@example.com", "other@x.com"]);
});

Deno.test("excluded identity matches despite case and +alias", () => {
  assertEquals(normalizeEmail(" Owner+tag@Example.com "), "owner@example.com");
  assertEquals(isExcludedIdentity("OWNER+zzz@example.com", ["owner@example.com"]), true);
  assertEquals(isExcludedIdentity("clara@example.org", ["owner@example.com"]), false);
});

Deno.test("authorizeUrl forces account chooser and carries state", () => {
  const u = new URL(authorizeUrl(cfg, { redirectUri: "https://x/cb", state: "st" }));
  assertEquals(u.searchParams.get("prompt"), "select_account");
  assertEquals(u.searchParams.get("state"), "st");
  assertStringIncludes(u.pathname, "/tid/oauth2/v2.0/authorize");
});

Deno.test("graphFetch refuses non-Microsoft hosts", async () => {
  await assertRejects(() => graphFetch("t", "https://evil.example.com/x"), Error, "host not permitted");
});

Deno.test("graphFetch prefixes relative paths and sets bearer", async () => {
  let seen: { url: string; auth: string | null } | null = null;
  const f = ((url: string, init: RequestInit) => {
    seen = { url, auth: new Headers(init.headers).get("Authorization") };
    return Promise.resolve(new Response("{}"));
  }) as unknown as typeof fetch;
  await graphFetch("tok", "/me", {}, f);
  assertEquals(seen, { url: "https://graph.microsoft.com/v1.0/me", auth: "Bearer tok" });
});

Deno.test("invalid_grant is flagged as needing reauth", async () => {
  const f = (() =>
    Promise.resolve(new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 }))) as unknown as typeof fetch;
  const err = await refreshTokens(cfg, "r", f).catch((e) => e);
  assertEquals(err instanceof MsTokenError && err.needsReauth, true);
});

Deno.test("response without refresh_token is rejected", async () => {
  const f = (() =>
    Promise.resolve(new Response(JSON.stringify({ access_token: "a", expires_in: 3600 })))) as unknown as typeof fetch;
  await assertRejects(() => refreshTokens(cfg, "r", f), MsTokenError, "no_refresh_token");
});

Deno.test("authorizeUrl carries login_hint for re-auth and keeps select_account", () => {
  const u = new URL(authorizeUrl(cfg, { redirectUri: "https://x/cb", state: "st", loginHint: "a@corp.com" }));
  assertEquals(u.searchParams.get("login_hint"), "a@corp.com");
  assertEquals(u.searchParams.get("prompt"), "select_account");
  assertEquals(new URL(authorizeUrl(cfg, { redirectUri: "https://x/cb", state: "st" })).searchParams.has("login_hint"), false);
});
