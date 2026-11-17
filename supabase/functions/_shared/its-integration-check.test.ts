import { assertEquals } from "jsr:@std/assert@1";
import { FakeSupabase, asClient } from "./testing/fake-supabase.ts";
import { anyGoogleAccountCanSend, anyGoogleCalendarEnabled, validateIntegrationState } from "./its-integration-check.ts";

const SEND = "https://www.googleapis.com/auth/gmail.send";
const READ = "https://www.googleapis.com/auth/gmail.readonly";

Deno.test("anyGoogleAccountCanSend: one sending account among several is enough", () => {
  assertEquals(anyGoogleAccountCanSend([]), false);
  assertEquals(anyGoogleAccountCanSend([{ granted_scopes: [READ] }, { granted_scopes: null }]), false);
  assertEquals(anyGoogleAccountCanSend([{ granted_scopes: [READ] }, { granted_scopes: [SEND] }]), true);
  assertEquals(anyGoogleAccountCanSend([{ granted_scopes: ["https://www.googleapis.com/auth/gmail.modify"] }]), true);
});

Deno.test("anyGoogleCalendarEnabled: a parked account does not hide a syncing one", () => {
  assertEquals(anyGoogleCalendarEnabled([]), false);
  assertEquals(anyGoogleCalendarEnabled([{ sync_enabled: false }]), false);
  assertEquals(anyGoogleCalendarEnabled([{ sync_enabled: false }, { sync_enabled: true }]), true);
  assertEquals(anyGoogleCalendarEnabled([{}]), true);
});

const actions = [
  { action_id: "1", type: "send_email", module: "m", payload: {}, depends_on: null },
  { action_id: "2", type: "create_event", module: "m", payload: {}, depends_on: null },
];

Deno.test("validateIntegrationState with two Google accounts (previously the lookup returned null for 2+ rows)", async () => {
  const f = new FakeSupabase({
    google_oauth_master: [
      { id: "a", user_id: "u", granted_scopes: [READ] },
      { id: "b", user_id: "u", granted_scopes: [SEND] },
    ],
    google_calendar_connections: [
      { id: "ca", user_id: "u", sync_enabled: false },
      { id: "cb", user_id: "u", sync_enabled: true },
    ],
  });
  const r = await validateIntegrationState(actions, { userId: "u", orgId: "o", supabase: asClient(f) });
  assertEquals(r.valid.map((a) => a.action_id), ["1", "2"]);
  assertEquals(r.invalid, []);
});

Deno.test("validateIntegrationState: no Google, no Microsoft -> both rejected; one account behaves as before", async () => {
  const none = await validateIntegrationState(actions, { userId: "u", orgId: "o", supabase: asClient(new FakeSupabase()) });
  assertEquals(none.invalid.map((i) => i.action_id), ["1", "2"]);
  const one = new FakeSupabase({
    google_oauth_master: [{ id: "a", user_id: "u", granted_scopes: [SEND] }],
    google_calendar_connections: [{ id: "ca", user_id: "u", sync_enabled: true }],
  });
  const r = await validateIntegrationState(actions, { userId: "u", orgId: "o", supabase: asClient(one) });
  assertEquals(r.valid.length, 2);
});
