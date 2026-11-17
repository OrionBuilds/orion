import { assert, assertEquals, assertNotEquals } from "jsr:@std/assert@1";
import { FakeSupabase, asClient } from "./testing/fake-supabase.ts";
import { encryptToken } from "./crypto.ts";
import { authorizeUrl, MS_SCOPES, MS_SCOPES_PERSONAL, MSA_TENANT_ID, type MsConfig } from "./ms-graph.ts";
import {
  accountCapabilities,
  accountTypeFromState,
  connectMicrosoftAccount,
  decideAccountType,
  otherAccountsEnabled,
  stateScopeRequested,
  tenantToStore,
  disconnectMicrosoft,
  listPublicAccounts,
  refreshActiveConnections,
  runAccountsAction,
} from "./ms-accounts.ts";

Deno.env.set("GMAIL_ENCRYPTION_KEY", "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff");

const cfg: MsConfig = { clientId: "c", clientSecret: "s", tenantId: "t", excludedEmails: ["owner@corp.com"] };
const tokens = (n = "a") => ({ accessToken: `acc-${n}`, refreshToken: `ref-${n}`, expiresAt: new Date(Date.now() + 3600_000), scopes: [...MS_SCOPES] });
const base = { userId: "u1", orgId: "o1", tenantId: "t" };

function newDb(seed: Record<string, Record<string, unknown>[]> = {}) {
  // Mirrors the DB: unique per (user, lower(email)) is enforced by the code path (select-then-insert); one primary per user.
  return new FakeSupabase(seed, { uniqueWhere: { microsoft_oauth_master: [] } });
}

Deno.test("first account becomes primary, writes the mirror and an empty sync state", async () => {
  const f = newDb();
  const r = await connectMicrosoftAccount(asClient(f), { ...base, email: "jordan@corp.com", tokens: tokens() });
  assert(r.ok && r.isPrimary && r.created);
  const m = f.rows("microsoft_oauth_master");
  assertEquals(m.length, 1);
  assertEquals([m[0].is_primary, m[0].login_enabled, m[0].connection_status], [true, false, "active"]);
  assertNotEquals(m[0].encrypted_refresh_token, "ref-a"); // encrypted at rest
  assertEquals(f.rows("user_connected_accounts").map((x) => x.provider_account_email), ["jordan@corp.com"]);
  const s = f.rows("outlook_sync_state");
  assertEquals(s.length, 1);
  assertEquals(s[0].connection_id, m[0].id);
});

Deno.test("a new email adds a second row: first untouched, no inherited cursors, not primary, login off, mirror unchanged", async () => {
  const f = newDb();
  await connectMicrosoftAccount(asClient(f), { ...base, email: "jordan@corp.com", tokens: tokens("1") });
  const first = f.rows("microsoft_oauth_master")[0];
  const firstId = first.id as string;
  const firstRefresh = first.encrypted_refresh_token;
  // the first mailbox has synced: it has cursors
  Object.assign(f.rows("outlook_sync_state")[0], { delta_link: "DELTA-1", last_sync_at: "2026-11-01T00:00:00Z" });
  const mirrorBefore = JSON.stringify(f.rows("user_connected_accounts"));

  const r = await connectMicrosoftAccount(asClient(f), { ...base, email: "jordan@other.com", tokens: tokens("2") });
  assert(r.ok && !r.isPrimary && r.created);
  const m = f.rows("microsoft_oauth_master");
  assertEquals(m.length, 2);
  const a = m.find((x) => x.id === firstId)!;
  const b = m.find((x) => x.id !== firstId)!;
  assertEquals(a.encrypted_refresh_token, firstRefresh);
  assertEquals(a.email, "jordan@corp.com");
  assertEquals([a.is_primary, b.is_primary, b.login_enabled, b.email], [true, false, false, "jordan@other.com"]);

  const s = f.rows("outlook_sync_state");
  assertEquals(s.length, 2);
  const s1 = s.find((x) => x.connection_id === firstId)!;
  const s2 = s.find((x) => x.connection_id === b.id)!;
  assertEquals(s1.delta_link, "DELTA-1");
  assertEquals(s2.delta_link, undefined);
  assertEquals(s2.last_sync_at, undefined);
  assertEquals(JSON.stringify(f.rows("user_connected_accounts")), mirrorBefore); // only the primary writes the mirror
});

Deno.test("re-auth with the same email (any case) updates in place: no duplicate, status cleared, cursors kept", async () => {
  const f = newDb();
  await connectMicrosoftAccount(asClient(f), { ...base, email: "Jordan@Corp.com", tokens: tokens("1") });
  const row = f.rows("microsoft_oauth_master")[0];
  Object.assign(row, { connection_status: "needs_reauth", last_refresh_error: "invalid_grant" });
  Object.assign(f.rows("outlook_sync_state")[0], { delta_link: "KEEP" });
  const before = row.encrypted_refresh_token;

  const r = await connectMicrosoftAccount(asClient(f), { ...base, email: "jordan@corp.com", tokens: tokens("2") });
  assert(r.ok && !r.created && r.isPrimary);
  assertEquals(f.rows("microsoft_oauth_master").length, 1);
  const m = f.rows("microsoft_oauth_master")[0];
  assertEquals([m.connection_status, m.last_refresh_error], ["active", null]);
  assertNotEquals(m.encrypted_refresh_token, before);
  assertEquals(f.rows("outlook_sync_state").length, 1);
  assertEquals(f.rows("outlook_sync_state")[0].delta_link, "KEEP");
});

Deno.test("re-auth of a secondary does not touch the mirror or primary flag", async () => {
  const f = newDb();
  await connectMicrosoftAccount(asClient(f), { ...base, email: "a@corp.com", tokens: tokens() });
  await connectMicrosoftAccount(asClient(f), { ...base, email: "b@corp.com", tokens: tokens() });
  const r = await connectMicrosoftAccount(asClient(f), { ...base, email: "b@corp.com", tokens: tokens("x") });
  assert(r.ok && !r.isPrimary && !r.created);
  assertEquals(f.rows("microsoft_oauth_master").map((x) => x.is_primary), [true, false]);
  assertEquals(f.rows("user_connected_accounts").map((x) => x.provider_account_email), ["a@corp.com"]);
});

Deno.test("MS_EXCLUDED_EMAILS still blocks (case and +alias), storing nothing", async () => {
  const f = newDb();
  const r = await connectMicrosoftAccount(asClient(f), { ...base, email: "Owner+x@Corp.com", tokens: tokens(), excludedEmails: cfg.excludedEmails });
  assertEquals(r, { ok: false, reason: "excluded" });
  assertEquals(f.rows("microsoft_oauth_master").length, 0);
  assertEquals(f.rows("outlook_sync_state").length, 0);
  assertEquals(f.rows("user_connected_accounts").length, 0);
});

Deno.test("sign-in flow enables login on the account; an adopted legacy sync row is reused, not duplicated", async () => {
  const f = newDb({ outlook_sync_state: [{ id: "legacy", user_id: "u1", organization_id: "o1", connection_id: null, delta_link: "OLD" }] });
  const r = await connectMicrosoftAccount(asClient(f), { ...base, email: "jordan@corp.com", tokens: tokens(), loginEnabled: true });
  assert(r.ok);
  assertEquals(f.rows("microsoft_oauth_master")[0].login_enabled, true);
  const s = f.rows("outlook_sync_state");
  assertEquals(s.length, 1);
  assertEquals([s[0].connection_id, s[0].delta_link], [r.connectionId, "OLD"]);
});

async function twoAccounts() {
  const f = newDb();
  await connectMicrosoftAccount(asClient(f), { ...base, email: "a@corp.com", tokens: tokens("a") });
  await connectMicrosoftAccount(asClient(f), { ...base, email: "b@corp.com", tokens: tokens("b") });
  const [a, b] = f.rows("microsoft_oauth_master").map((x) => x.id as string);
  f.rows("microsoft_calendar_events").push(
    { id: "e1", user_id: "u1", connection_id: a, graph_event_id: "g1" },
    { id: "e2", user_id: "u1", connection_id: b, graph_event_id: "g2" },
  );
  return { f, a, b };
}

Deno.test("disconnect one account leaves the other, its events and its sync state intact", async () => {
  const { f, a, b } = await twoAccounts();
  const r = await disconnectMicrosoft(asClient(f), "u1", b);
  assertEquals(r.status, 200);
  assertEquals(f.rows("microsoft_oauth_master").map((x) => x.id), [a]);
  assertEquals(f.rows("outlook_sync_state").map((x) => x.connection_id), [a]);
  assertEquals(f.rows("microsoft_calendar_events").map((x) => x.id), ["e1"]);
  assertEquals(f.rows("user_connected_accounts").length, 1); // mirror stays while an account remains
});

Deno.test("disconnect with no connection_id and 2 accounts is 400 and deletes nothing", async () => {
  const { f } = await twoAccounts();
  const r = await disconnectMicrosoft(asClient(f), "u1");
  assertEquals(r.status, 400);
  assertEquals(f.rows("microsoft_oauth_master").length, 2);
  assertEquals(f.rows("microsoft_calendar_events").length, 2);
});

Deno.test("disconnect of someone else's connection id is refused and deletes nothing", async () => {
  const { f, a } = await twoAccounts();
  const r = await disconnectMicrosoft(asClient(f), "intruder", a);
  assertEquals(r.status, 404);
  assertEquals(f.rows("microsoft_oauth_master").length, 2);
});

Deno.test("single account: no connection_id removes everything as before, including the mirror", async () => {
  const f = newDb();
  await connectMicrosoftAccount(asClient(f), { ...base, email: "a@corp.com", tokens: tokens() });
  f.rows("microsoft_calendar_events").push({ id: "e", user_id: "u1", connection_id: f.rows("microsoft_oauth_master")[0].id });
  const r = await disconnectMicrosoft(asClient(f), "u1");
  assertEquals(r, { status: 200, body: { success: true } });
  for (const t of ["microsoft_oauth_master", "outlook_sync_state", "microsoft_calendar_events", "user_connected_accounts"]) assertEquals(f.rows(t).length, 0, t);
});

Deno.test("removing the last account (by id) also clears the mirror", async () => {
  const f = newDb();
  const r0 = await connectMicrosoftAccount(asClient(f), { ...base, email: "a@corp.com", tokens: tokens() });
  assert(r0.ok);
  await disconnectMicrosoft(asClient(f), "u1", r0.connectionId);
  assertEquals(f.rows("user_connected_accounts").length, 0);
});

Deno.test("token cron refreshes every active account and flags needs_reauth per row", async () => {
  const soon = new Date(Date.now() + 10_000).toISOString();
  const mk = async (id: string, user: string, email: string, status = "active") => ({
    id, user_id: user, email, connection_status: status, is_primary: true, created_at: id,
    token_expires_at: soon, encrypted_access_token: await encryptToken("old"), encrypted_refresh_token: await encryptToken(`ref-${id}`),
  });
  const f = new FakeSupabase({
    microsoft_oauth_master: [
      await mk("c1", "u1", "a@corp.com"),
      { ...(await mk("c2", "u1", "b@corp.com")), is_primary: false },
      { ...(await mk("c3", "u2", "z@corp.com")) },
      { ...(await mk("c4", "u3", "dead@corp.com", "needs_reauth")) },
    ],
  });
  const fetchImpl = ((_u: string, init: RequestInit) => {
    const body = String(init.body);
    if (body.includes("ref-c2")) return Promise.resolve(new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 }));
    return Promise.resolve(new Response(JSON.stringify({ access_token: "new", refresh_token: "rot", expires_in: 3600, scope: "User.Read" })));
  }) as unknown as typeof fetch;

  const r = await refreshActiveConnections(asClient(f), cfg, { windowMs: 900_000, maxBatch: 20, fetchImpl });
  assertEquals(r, { checked: 3, refreshed: 2, failed: 1 });
  const by = (id: string) => f.rows("microsoft_oauth_master").find((x) => x.id === id)!;
  assertEquals(by("c1").connection_status, "active");
  assertEquals(by("c1").last_refresh_error, null);
  assertEquals(by("c2").connection_status, "needs_reauth"); // flagged on its own row, the same user's primary is fine
  assertEquals(by("c2").last_refresh_error, "invalid_grant");
  assertEquals(by("c3").connection_status, "active");
  assertNotEquals(by("c1").token_expires_at, soon);
  assertEquals(by("c4").token_expires_at, soon); // already needs_reauth: not retried
});

Deno.test("accounts list never returns token columns and is scoped to the caller", async () => {
  const { f, a } = await twoAccounts();
  f.rows("microsoft_oauth_master").push({ id: "other", user_id: "u9", email: "x@y.com", is_primary: true, encrypted_access_token: "SECRET", encrypted_refresh_token: "SECRET" });
  const list = await listPublicAccounts(asClient(f), "u1");
  assertEquals(list.map((x) => x.email), ["a@corp.com", "b@corp.com"]);
  for (const acc of list) {
    for (const k of Object.keys(acc)) assert(!/token|secret/i.test(k), k);
  }
  assertEquals(JSON.stringify(list).includes("SECRET"), false);
  const r = await runAccountsAction(asClient(f), "u1", { action: "list" });
  assertEquals((r.body.accounts as unknown[]).length, 2);
  assertEquals(((r.body.accounts as { id: string }[])[0]).id, a);
});

Deno.test("accounts set-primary / set-label refuse another user's connection id and never call the RPC", async () => {
  const { f, b } = await twoAccounts();
  const calls: string[] = [];
  f.opts.rpc = { ms_set_primary: (a) => { calls.push(`p:${a.p_connection}`); return null; }, ms_set_label: (a) => { calls.push(`l:${a.p_connection}:${a.p_label}`); return null; } };
  const denied = await runAccountsAction(asClient(f), "intruder", { action: "set-primary", connection_id: b });
  assertEquals(denied.status, 404);
  const deniedLabel = await runAccountsAction(asClient(f), "intruder", { action: "set-label", connection_id: b, label: "x" });
  assertEquals(deniedLabel.status, 404);
  assertEquals(calls, []);
  const ok = await runAccountsAction(asClient(f), "u1", { action: "set-label", connection_id: b, label: "Work" });
  assertEquals(ok.status, 200);
  assertEquals(calls, [`l:${b}:Work`]);
  assertEquals((await runAccountsAction(asClient(f), "u1", { action: "set-primary", connection_id: "" })).status, 400);
});

const envOf = (v?: string) => ({ get: (k: string) => (k === "MS_OAUTH_ALLOW_OTHER_ACCOUNTS" ? v : undefined) });

Deno.test("gate: external/personal refused unless the secret is 'on' (case-insensitive); work always allowed", () => {
  for (const off of [undefined, "", "off", "true", "1"]) {
    for (const t of ["external", "personal"]) {
      const d = decideAccountType(t, { env: envOf(off) });
      assert(!d.ok && d.status === 403 && d.body.error === "other_accounts_disabled", `${t}/${off}`);
    }
    assertEquals(decideAccountType(undefined, { env: envOf(off) }), { ok: true, accountType: "work" });
    assertEquals(decideAccountType("work", { env: envOf(off) }), { ok: true, accountType: "work" });
  }
  for (const on of ["on", "ON", " On "]) {
    assertEquals(decideAccountType("external", { env: envOf(on) }), { ok: true, accountType: "external" });
    assertEquals(decideAccountType("personal", { env: envOf(on) }), { ok: true, accountType: "personal" });
  }
  assertEquals(otherAccountsEnabled(envOf("on")), true);
  assertEquals(accountCapabilities(envOf("on")), { external: true, personal: true });
  assertEquals(accountCapabilities(envOf(undefined)), { external: false, personal: false });
  const bad = decideAccountType("martian", { env: envOf("on") });
  assert(!bad.ok && bad.status === 400);
});

Deno.test("re-auth uses the row's type; asking for another type is refused", () => {
  assertEquals(decideAccountType(undefined, { env: envOf("on"), existingType: "personal" }), { ok: true, accountType: "personal" });
  const m = decideAccountType("work", { env: envOf("on"), existingType: "personal" });
  assert(!m.ok && m.status === 409 && m.body.error === "account_type_mismatch");
});

Deno.test("authorize URL per type: authority and scopes; work unchanged", () => {
  const u = (t?: "work" | "external" | "personal") => new URL(authorizeUrl(cfg, { redirectUri: "https://x/cb", state: "s", accountType: t }));
  const scopes = (x: URL) => x.searchParams.get("scope")!.split(" ");
  assertEquals(u().pathname, "/t/oauth2/v2.0/authorize");
  assertEquals(u("work").toString(), u().toString());
  assertEquals(scopes(u("work")), [...MS_SCOPES]);
  assertEquals(u("external").pathname, "/organizations/oauth2/v2.0/authorize");
  assert(!scopes(u("external")).some((x) => x.startsWith("OnlineMeeting")));
  assertEquals(u("personal").pathname, "/consumers/oauth2/v2.0/authorize");
  assertEquals(scopes(u("personal")), [...MS_SCOPES_PERSONAL]);
  assert(!scopes(u("personal")).some((x) => x.startsWith("Sites.") || x.startsWith("OnlineMeeting") || x === "Files.ReadWrite.All"));
});

Deno.test("state carries the type; work state is byte-for-byte the old scope string", () => {
  assertEquals(stateScopeRequested("work", MS_SCOPES), MS_SCOPES.join(" "));
  assertEquals(accountTypeFromState(MS_SCOPES.join(" ")), "work");
  assertEquals(accountTypeFromState(null), "work");
  for (const t of ["external", "personal"] as const) assertEquals(accountTypeFromState(stateScopeRequested(t, MS_SCOPES_PERSONAL)), t);
});

Deno.test("callback storage: type and tenant stored; login never enabled for non-work; excluded still enforced", async () => {
  const f = newDb();
  const ext = await connectMicrosoftAccount(asClient(f), { ...base, email: "me@other.org", tokens: tokens("e"), tenantId: tenantToStore("external", "11111111-2222-3333-4444-555555555555", "t"), accountType: "external", loginEnabled: true });
  const per = await connectMicrosoftAccount(asClient(f), { ...base, email: "me@outlook.com", tokens: tokens("p"), tenantId: tenantToStore("personal", null, "t"), accountType: "personal" });
  assert(ext.ok && per.ok);
  const m = f.rows("microsoft_oauth_master");
  const e = m.find((x) => x.email === "me@other.org")!;
  const p = m.find((x) => x.email === "me@outlook.com")!;
  assertEquals([e.account_type, e.tenant_id, e.login_enabled], ["external", "11111111-2222-3333-4444-555555555555", false]);
  assertEquals([p.account_type, p.tenant_id, p.login_enabled], ["personal", MSA_TENANT_ID, false]);
  assertEquals(tenantToStore("work", null, "t"), "t");
  const x = await connectMicrosoftAccount(asClient(f), { ...base, email: "owner@corp.com", tokens: tokens(), accountType: "external", excludedEmails: cfg.excludedEmails });
  assert(!x.ok && x.reason === "excluded");
});

Deno.test("re-auth keeps the stored type; a different type for the same email is refused and changes nothing", async () => {
  const f = newDb();
  await connectMicrosoftAccount(asClient(f), { ...base, email: "me@outlook.com", tokens: tokens("1"), accountType: "personal" });
  const before = JSON.stringify(f.rows("microsoft_oauth_master"));
  const bad = await connectMicrosoftAccount(asClient(f), { ...base, email: "ME@outlook.com", tokens: tokens("2") });
  assert(!bad.ok && bad.reason === "type_mismatch" && bad.existingType === "personal");
  assertEquals(JSON.stringify(f.rows("microsoft_oauth_master")), before);
  const ok = await connectMicrosoftAccount(asClient(f), { ...base, email: "ME@outlook.com", tokens: tokens("3"), accountType: "personal" });
  assert(ok.ok && !ok.created);
  assertEquals(f.rows("microsoft_oauth_master")[0].account_type, "personal");
  // a legacy work row (no account_type column value) re-auths as work
  const g = newDb({ microsoft_oauth_master: [{ id: "w", user_id: "u1", email: "a@corp.com", is_primary: true }] });
  assert((await connectMicrosoftAccount(asClient(g), { ...base, email: "a@corp.com", tokens: tokens() })).ok);
});

Deno.test("refresh of a personal row uses the consumers authority and personal scopes; work row is unchanged", async () => {
  const soon = new Date(Date.now() + 10_000).toISOString();
  const mk = async (id: string, extra: Record<string, unknown>) => ({
    id, user_id: id, email: `${id}@x.com`, connection_status: "active", is_primary: true, created_at: id,
    token_expires_at: soon, encrypted_access_token: await encryptToken("old"), encrypted_refresh_token: await encryptToken(`ref-${id}`), ...extra,
  });
  const f = new FakeSupabase({ microsoft_oauth_master: [
    await mk("per", { account_type: "personal", tenant_id: MSA_TENANT_ID }),
    await mk("ext", { account_type: "external", tenant_id: "11111111-2222-3333-4444-555555555555" }),
    await mk("wrk", {}),
  ] });
  const seen: Record<string, { url: string; scope: string }> = {};
  const fetchImpl = ((u: string, init: RequestInit) => {
    const body = new URLSearchParams(String(init.body));
    seen[body.get("refresh_token")!.replace("ref-", "")] = { url: u, scope: body.get("scope")! };
    return Promise.resolve(new Response(JSON.stringify({ access_token: "n", refresh_token: "r", expires_in: 3600, scope: "User.Read" })));
  }) as unknown as typeof fetch;
  const r = await refreshActiveConnections(asClient(f), cfg, { windowMs: 900_000, maxBatch: 20, fetchImpl });
  assertEquals(r, { checked: 3, refreshed: 3, failed: 0 });
  assertEquals(seen.per.url, "https://login.microsoftonline.com/consumers/oauth2/v2.0/token");
  assertEquals(seen.per.scope, MS_SCOPES_PERSONAL.join(" "));
  assertEquals(seen.ext.url, "https://login.microsoftonline.com/11111111-2222-3333-4444-555555555555/oauth2/v2.0/token");
  assertEquals(seen.wrk.url, "https://login.microsoftonline.com/t/oauth2/v2.0/token");
  assertEquals(seen.wrk.scope, MS_SCOPES.join(" "));
});

Deno.test("accounts list returns account_type per account and capabilities from the secret", async () => {
  const f = newDb({ microsoft_oauth_master: [
    { id: "a", user_id: "u1", email: "a@corp.com", is_primary: true, created_at: "1" },
    { id: "b", user_id: "u1", email: "b@outlook.com", is_primary: false, created_at: "2", account_type: "personal", encrypted_access_token: "SECRET" },
  ] });
  const on = await runAccountsAction(asClient(f), "u1", { action: "list" }, envOf("on"));
  assertEquals((on.body.accounts as { account_type: string }[]).map((x) => x.account_type), ["work", "personal"]);
  assertEquals(on.body.capabilities, { external: true, personal: true });
  assertEquals(JSON.stringify(on.body).includes("SECRET"), false);
  const off = await runAccountsAction(asClient(f), "u1", { action: "list" }, envOf(undefined));
  assertEquals(off.body.capabilities, { external: false, personal: false });
});
