import { assertEquals } from "jsr:@std/assert@1";
import { FakeSupabase, asClient } from "./testing/fake-supabase.ts";
import { consumeLoginState, createLoginState, resolveLoginUser } from "./ms-login.ts";

const users = [
  { id: "jordan", organization_id: "o", email: "jordan@example.com", status: "active", disabled_at: null },
  { id: "clara", organization_id: "o", email: "clara@example.com", status: "active", disabled_at: null },
  { id: "gone", organization_id: "o", email: "gone@example.com", status: "active", disabled_at: "2026-01-01" },
];

Deno.test("login state is one-shot and expires", async () => {
  const f = new FakeSupabase({ ms_login_states: [] });
  const t = await createLoginState(asClient(f), "https://x/cb", "https://app/");
  assertEquals((await consumeLoginState(asClient(f), t))?.appUrl, "https://app/");
  assertEquals(await consumeLoginState(asClient(f), t), null); // replay
  const t2 = await createLoginState(asClient(f), "https://x/cb");
  f.rows("ms_login_states")[0].expires_at = "2020-01-01T00:00:00Z";
  assertEquals(await consumeLoginState(asClient(f), t2), null);
  assertEquals(f.rows("ms_login_states").length, 0);
});

Deno.test("a login-enabled connected identity signs in as its user, even if the addresses differ", async () => {
  const f = new FakeSupabase({ users, microsoft_oauth_master: [{ user_id: "jordan", organization_id: "o", email: "Jordan@example.org", login_enabled: true }] });
  const r = await resolveLoginUser(asClient(f), "jordan@example.org");
  assertEquals(r.ok && r.user.userId, "jordan");
});

Deno.test("an agent mailbox connected to a user (login_enabled=false) can NOT sign in", async () => {
  const f = new FakeSupabase({ users, microsoft_oauth_master: [{ user_id: "clara", organization_id: "o", email: "clara@example.org", login_enabled: false }] });
  assertEquals(await resolveLoginUser(asClient(f), "clara@example.org"), { ok: false, reason: "no_account" });
});

Deno.test("exact email match works with case and +alias; strangers, disabled users and duplicates are refused", async () => {
  const f = new FakeSupabase({ users: [...users, { id: "dup1", organization_id: "o", email: "d@x.com", status: "active" }, { id: "dup2", organization_id: "p", email: "d@x.com", status: "active" }], microsoft_oauth_master: [], ms_login_links: [] });
  const ok = await resolveLoginUser(asClient(f), "Jordan+test@example.com");
  assertEquals(ok.ok && ok.user.userId, "jordan");
  assertEquals(await resolveLoginUser(asClient(f), "stranger@evil.com"), { ok: false, reason: "no_account" });
  assertEquals(await resolveLoginUser(asClient(f), "gone@example.com"), { ok: false, reason: "disabled" });
  assertEquals(await resolveLoginUser(asClient(f), "d@x.com"), { ok: false, reason: "ambiguous" });
});

Deno.test("a login-enabled link to a disabled user is refused", async () => {
  const f = new FakeSupabase({ users, microsoft_oauth_master: [{ user_id: "gone", organization_id: "o", email: "g@m.com", login_enabled: true }] });
  assertEquals(await resolveLoginUser(asClient(f), "g@m.com"), { ok: false, reason: "disabled" });
});

Deno.test("an explicit link signs in as its user regardless of address; it never reaches a disabled user", async () => {
  const f = new FakeSupabase({ users, microsoft_oauth_master: [], ms_login_links: [{ microsoft_email: "Jordan@example.org", user_id: "jordan" }, { microsoft_email: "g@example.org", user_id: "gone" }] });
  const ok = await resolveLoginUser(asClient(f), "jordan@example.org");
  assertEquals(ok.ok && ok.user.email, "jordan@example.com");
  assertEquals(await resolveLoginUser(asClient(f), "g@example.org"), { ok: false, reason: "disabled" });
});
