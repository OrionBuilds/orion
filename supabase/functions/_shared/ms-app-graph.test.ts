import { assertEquals, assertRejects } from "jsr:@std/assert";
import { getAppToken, msAppConfig, resetAppTokenCache } from "./ms-app-graph.ts";
import { MsTokenError } from "./ms-graph.ts";

const env = (m: Record<string, string>) => ({ get: (k: string) => m[k] });

Deno.test("msAppConfig is off unless id, secret and a tenant are all set", () => {
  assertEquals(msAppConfig(env({})), null);
  assertEquals(msAppConfig(env({ MS_TRANSCRIPTS_CLIENT_ID: "a", MS_TRANSCRIPTS_CLIENT_SECRET: "b" })), null);
  assertEquals(
    msAppConfig(env({ MS_TRANSCRIPTS_CLIENT_ID: "a", MS_TRANSCRIPTS_CLIENT_SECRET: "b", MS_OAUTH_TENANT_ID: "t" })),
    { clientId: "a", clientSecret: "b", tenantId: "t" },
  );
  assertEquals(
    msAppConfig(env({ MS_TRANSCRIPTS_CLIENT_ID: "a", MS_TRANSCRIPTS_CLIENT_SECRET: "b", MS_OAUTH_TENANT_ID: "t", MS_TRANSCRIPTS_TENANT_ID: "t2" }))?.tenantId,
    "t2",
  );
});

Deno.test("getAppToken uses client credentials with the .default scope and caches until near expiry", async () => {
  resetAppTokenCache();
  const bodies: URLSearchParams[] = [];
  const f = ((_url: string, init?: RequestInit) => {
    bodies.push(new URLSearchParams(String(init?.body)));
    return Promise.resolve(new Response(JSON.stringify({ access_token: `tok${bodies.length}`, expires_in: 3600 })));
  }) as unknown as typeof fetch;
  const cfg = { clientId: "c", clientSecret: "s", tenantId: "t" };
  assertEquals(await getAppToken(cfg, f, 0), "tok1");
  assertEquals(await getAppToken(cfg, f, 60_000), "tok1");
  assertEquals(await getAppToken(cfg, f, 3_600_000 - 30_000), "tok2");
  assertEquals(bodies[0].get("grant_type"), "client_credentials");
  assertEquals(bodies[0].get("scope"), "https://graph.microsoft.com/.default");
});

Deno.test("getAppToken surfaces Entra's error code", async () => {
  resetAppTokenCache();
  const f = (() => Promise.resolve(new Response(JSON.stringify({ error: "invalid_client" }), { status: 401 }))) as unknown as typeof fetch;
  const e = await assertRejects(() => getAppToken({ clientId: "c", clientSecret: "bad", tenantId: "t" }, f), MsTokenError);
  assertEquals((e as MsTokenError).code, "invalid_client");
});
