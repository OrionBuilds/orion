import { assertEquals } from "jsr:@std/assert@1";
import { FakeSupabase, asClient } from "../testing/fake-supabase.ts";
import { COOLDOWN_DAYS, STALL_DAYS, findCandidates, isNudgeHour, runStallNudges, templateDraft } from "./stall-nudges.ts";

const NOW = new Date("2026-10-20T13:00:00Z"); // 09:00 ET
const ago = (d: number) => new Date(NOW.getTime() - d * 86_400_000).toISOString();
const env = { get: (k: string) => ({ BUSINESS_NAME: "Acme Co" })[k] };
const base = () => ({
  projects: [{ id: "p1", org_id: "o", name: "Acme Site", contact_id: "c1", status: "active" }],
  contacts: [{ id: "c1", first_name: "Pat", last_name: "Lee", email: "pat@acme.com" as string | null, status: "active" }],
  project_tasks: [{ id: "t1", project_id: "p1", title: "Migrate checkout", status: "in_progress", created_at: ago(5) }],
  messages: [] as Record<string, unknown>[], workflow_approval_queue: [] as Record<string, unknown>[],
});
const mk = (over: Partial<ReturnType<typeof base>> = {}) => new FakeSupabase({ ...base(), ...over }, { unique: { workflow_approval_queue: [["agent_slug", "external_ref"]] } });

Deno.test("the nudge hour is 9am in the org's timezone", () => {
  assertEquals(isNudgeHour(NOW, "America/New_York"), true);
  assertEquals(isNudgeHour(new Date("2026-10-20T14:00:00Z"), "America/New_York"), false);
});

Deno.test("a quiet client with open work gets exactly one draft naming one open item", async () => {
  const f = mk(); const db = asClient(f);
  const r = await runStallNudges(db, env, { orgId: "o", now: NOW, ownerUserId: "owner" });
  assertEquals(r, { drafted: 1, candidates: 1 });
  const row = f.rows("workflow_approval_queue")[0];
  assertEquals([row.status, row.agent_slug, row.source], ["pending_approval", "clara", "agent_approval"]);
  const d = (row.draft_content as { draft: { to: string[]; body: string } }).draft;
  assertEquals([d.to, d.body.includes("Migrate checkout"), d.body.includes("Clara")], [["pat@acme.com"], true, true]);
  // Same month, same contact: re-running changes nothing.
  assertEquals((await runStallNudges(db, env, { orgId: "o", now: NOW, ownerUserId: "owner" })).drafted, 0);
  assertEquals(f.rows("workflow_approval_queue").length, 1);
});

Deno.test("recent contact, a recent nudge, no open work, no email or an inactive client all mean no nudge", async () => {
  const recent = mk({ messages: [{ contact_id: "c1", direction: "inbound", sent_at: ago(STALL_DAYS - 2) }] });
  assertEquals((await findCandidates(asClient(recent), "o", NOW)).length, 0);
  const old = mk({ messages: [{ contact_id: "c1", direction: "inbound", sent_at: ago(STALL_DAYS + 5) }] });
  assertEquals((await findCandidates(asClient(old), "o", NOW)).length, 1);
  const nudged = mk({ workflow_approval_queue: [{ agent_slug: "clara", external_ref: "stall:c1:2026-10", requested_at: ago(COOLDOWN_DAYS - 3) }] });
  assertEquals((await findCandidates(asClient(nudged), "o", NOW)).length, 0);
  assertEquals((await findCandidates(asClient(mk({ project_tasks: [{ id: "t", project_id: "p1", title: "x", status: "completed", created_at: ago(1) }] })), "o", NOW)).length, 0);
  assertEquals((await findCandidates(asClient(mk({ contacts: [{ id: "c1", first_name: "P", last_name: "L", email: null, status: "active" }] })), "o", NOW)).length, 0);
  assertEquals((await findCandidates(asClient(mk({ contacts: [{ id: "c1", first_name: "P", last_name: "L", email: "p@x.com", status: "archived" }] })), "o", NOW)).length, 0);
});

Deno.test("a model-written draft is used when available; an outage falls back to the template, never skips", async () => {
  const f1 = mk();
  await runStallNudges(asClient(f1), env, { orgId: "o", now: NOW, ownerUserId: null, draft: () => Promise.resolve({ subject: "Quick check-in", body: "Hello Pat — custom." }) });
  assertEquals((f1.rows("workflow_approval_queue")[0].draft_content as { draft: { subject: string } }).draft.subject, "Quick check-in");
  const f2 = mk();
  await runStallNudges(asClient(f2), env, { orgId: "o", now: NOW, ownerUserId: null, draft: () => Promise.reject(new Error("model down")) });
  assertEquals((f2.rows("workflow_approval_queue")[0].draft_content as { draft: { subject: string } }).draft.subject, templateDraft(env, { contactId: "c1", name: "Pat Lee", email: "p", projectName: "Acme Site", openItem: "x" }).subject);
});
