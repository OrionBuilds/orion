import { assertEquals } from "jsr:@std/assert@1";
import { FakeSupabase } from "../testing/fake-supabase.ts";
import { loadSelfContext } from "./owner-self.ts";

function ctx(seed: Record<string, Record<string, unknown>[]>, selects: string[] = []) {
  const f = new FakeSupabase(seed);
  // Record every column list asked for, to prove no token column is ever selected.
  const db = { from: (t: string) => { const q = f.from(t); const sel = q.select.bind(q); q.select = ((cols?: string, o?: never) => { selects.push(`${t}:${cols}`); return sel(cols, o); }) as never; return q; } };
  return { db: db as never, env: { get: () => undefined }, orgId: "o", ownerUserId: "owner", claraUserId: "clara", claraNumber: "+18135550142" };
}

Deno.test("self context: whose mailbox is whose, where she sends from, her numbers, the org provider, integrations, memories", async () => {
  const selects: string[] = [];
  const block = await loadSelfContext(ctx({
    user_connected_accounts: [
      { user_id: "owner", provider: "microsoft_365", provider_account_email: "boss@corp.com", status: "connected", token_encrypted: "SECRET" },
      { user_id: "clara", provider: "microsoft_365", provider_account_email: "clara@corp.com", status: "connected" },
      { user_id: "someone-else", provider: "google_workspace", provider_account_email: "other@x.com", status: "connected" },
    ],
    organizations: [{ id: "o", name: "Acme Ops", display_name: null, default_workspace_provider: "microsoft" }],
    twilio_numbers: [
      { org_id: "o", phone_number: "+18135550142", friendly_name: "(813) 555-0142", agent_label: "Clara", sms_route: "clara", status: "active" },
      { org_id: "o", phone_number: "+19045550000", friendly_name: "Retired line", agent_label: "Retired line", sms_route: "user", status: "disabled" },
      { org_id: "other", phone_number: "+15550000000", agent_label: "Clara", sms_route: "clara", status: "active" },
    ],
    integration_connections: [{ org_id: "o", user_id: null, status: "connected", integrations: { name: "QuickBooks Online" } }],
    clara_memories: [{ organization_id: "o", user_id: "owner", content: "Prefers texts before 9am", memory_type: "preference", importance_score: 8 }],
  }, selects));
  for (const want of ["The owner's connected accounts: Microsoft 365 boss@corp.com.", "Your (Clara's) connected accounts: Microsoft 365 clara@corp.com.",
    "You send email from clara@corp.com", "default workspace provider: Microsoft 365", "Your phone numbers: +18135550142.", "QuickBooks Online", "- Prefers texts before 9am"]) {
    assertEquals(block.includes(want), true, want);
  }
  assertEquals(block.includes("other@x.com") || block.includes("+15550000000") || block.includes("+19045550000") || block.includes("SECRET"), false);
  assertEquals(selects.some((s) => /token|secret|credential/i.test(s)), false);
});

Deno.test("self context: nothing connected is stated, and a failing table never breaks the turn", async () => {
  const block = await loadSelfContext(ctx({}));
  assertEquals(block.includes("The owner's connected accounts: no Microsoft 365 or Google account connected."), true);
  assertEquals(block.includes("You have no mailbox connected to send email from."), true);
  const broken = { db: { from: () => { throw new Error("db down"); } } as never, env: { get: () => undefined }, orgId: "o", ownerUserId: "owner", claraUserId: null, claraNumber: "" };
  assertEquals(await loadSelfContext(broken), "");
});
