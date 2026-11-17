import { assertEquals, assert } from "jsr:@std/assert@1";
import { FakeSupabase, asClient } from "../testing/fake-supabase.ts";
import { makeBudget } from "./run-budget.ts";
import { isoWeek, isWeeklyWindow, runWeeklyUpdates, templateBody, weeklyUpdateIssues, clientSafeTitle } from "./weekly-update.ts";
import type { Say } from "./json-llm.ts";

const FRI = new Date("2026-10-23T19:00:00Z"); // Friday 15:00 ET
const ago = (d: number) => new Date(FRI.getTime() - d * 86_400_000).toISOString();
const BODY = "Hi Pat,\n\nThis week we wrapped up the checkout migration and the new contact form is now in motion, so the site is getting steadily quicker for your customers. Nothing needed anything from you.\n\nNext up is the gallery refresh. Reply here if you would like us to prioritize anything else.\n\nFRIDAY";
const say: Say = () => Promise.resolve(BODY);
const seed = (over: Record<string, Record<string, unknown>[]> = {}) => new FakeSupabase({
  contacts: [{ id: "c1", org_id: "o", first_name: "Pat", last_name: "Lee", email: "pat@acme.com", status: "active" }],
  projects: [{ id: "p1", org_id: "o", name: "Acme Site", status: "active", contact_id: "c1" }],
  project_tasks: [
    { project_id: "p1", title: "[QA] Migrate checkout", status: "completed", completed_at: ago(2), updated_at: ago(2) },
    { project_id: "p1", title: "Contact form", status: "in_progress", completed_at: null, updated_at: ago(1) },
    { project_id: "p1", title: "Gallery refresh", status: "todo", completed_at: null, updated_at: ago(9) },
  ],
  project_agent_meta: [], project_activity_log: [], friday_job_marks: [], workflow_approval_queue: [], notifications: [], ...over,
}, { unique: { workflow_approval_queue: [["agent_slug", "external_ref"]] } });
const deps = (f: FakeSupabase, o: Record<string, unknown> = {}) => ({ db: asClient(f), env: { get: () => undefined }, say, budget: makeBudget(), now: FRI, orgId: "o", ownerUserId: "owner", ...o });

Deno.test("the window is Friday from 14:00 org-local, and the week key is stable", () => {
  assertEquals(isWeeklyWindow(FRI, "America/New_York"), true);
  assertEquals(isWeeklyWindow(new Date("2026-10-23T16:00:00Z"), "America/New_York"), false); // 12:00
  assertEquals(isWeeklyWindow(new Date("2026-10-22T19:00:00Z"), "America/New_York"), false); // Thursday
  assertEquals(isoWeek(FRI), "2026-W43");
});

Deno.test("QA catches thin, jargon, placeholder and money; titles are scrubbed of task-board markers", () => {
  assertEquals(weeklyUpdateIssues(BODY), []);
  assert(weeklyUpdateIssues("short").length > 0);
  assert(weeklyUpdateIssues(BODY + " [QA] $500 TBD").length >= 3);
  assertEquals(clientSafeTitle("[Fix R2] Header"), "Header");
  assertEquals(weeklyUpdateIssues(templateBody("Pat Lee", { projects: [{ id: "p", name: "Acme" }], shipped: [], moving: [{ title: "Form", status: "in_progress", completed_at: null, updated_at: "" }], queued: [] })).length, 0);
});

Deno.test("a client with movement gets a portal post and an APPROVAL-QUEUE email draft, once per week", async () => {
  const f = seed();
  const r = await runWeeklyUpdates(deps(f));
  assertEquals([r.queued, r.skipped, r.partial], [1, 0, false]);
  const log = f.rows("project_activity_log")[0];
  assertEquals([log.event_type, (log.payload as { source_ref: string }).source_ref, (log.payload as { is_live: boolean }).is_live], ["milestone", "weekly:c1:2026-W43", false]);
  const q = f.rows("workflow_approval_queue");
  assertEquals(q.length, 1);
  assertEquals([q[0].status, q[0].external_ref, q[0].action_type], ["pending_approval", "weekly:c1:2026-W43", "clara_email"]);
  const d = (q[0].draft_content as { draft: { to: string[]; subject: string; body: string }; risk_tier: string });
  assertEquals([d.draft.to, d.risk_tier, d.draft.body.includes("[QA]")], [["pat@acme.com"], "client_visible", false]);
  assertEquals(f.rows("notifications").length, 0); // the owner is told by the approval queue's own trigger, once
  // Re-run the same week: nothing new anywhere.
  const again = await runWeeklyUpdates(deps(f));
  assertEquals([again.queued, again.skips["already done <6d"]], [0, 1]);
  assertEquals([f.rows("project_activity_log").length, f.rows("workflow_approval_queue").length], [1, 1]);
});

Deno.test("no activity, inactive contact or no active project means no update; a model outage uses the template", async () => {
  const quiet = seed({ project_tasks: [{ project_id: "p1", title: "old", status: "completed", completed_at: ago(20), updated_at: ago(20) }] });
  assertEquals((await runWeeklyUpdates(deps(quiet))).skips, { "no activity this week": 1 });
  const gone = seed({ contacts: [{ id: "c1", org_id: "o", first_name: "P", last_name: "L", email: "p@x.com", status: "archived" }] });
  assertEquals((await runWeeklyUpdates(deps(gone))).clients, 0);
  const f = seed();
  const down: Say = () => Promise.resolve(null);
  assertEquals((await runWeeklyUpdates(deps(f, { say: down }))).queued, 1);
  assert((f.rows("workflow_approval_queue")[0].draft_content as { draft: { body: string } }).draft.body.includes("Contact form"));
});

Deno.test("a contact without an email still gets the portal post; kill switch and budget stop the run", async () => {
  const f = seed({ contacts: [{ id: "c1", org_id: "o", first_name: "Pat", last_name: "Lee", email: null, status: "active" }] });
  assertEquals((await runWeeklyUpdates(deps(f))).queued, 1);
  assertEquals([f.rows("project_activity_log").length, f.rows("workflow_approval_queue").length], [1, 0]);
  assertEquals((await runWeeklyUpdates(deps(seed(), { enabled: false }))).clients, 0);
  let t = 0;
  const b = makeBudget(40_000, () => t); t = 39_500;
  assertEquals((await runWeeklyUpdates(deps(seed(), { budget: b }))).partial, true);
});
