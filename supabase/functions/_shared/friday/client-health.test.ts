import { assertEquals, assert } from "jsr:@std/assert@1";
import { FakeSupabase, asClient } from "../testing/fake-supabase.ts";
import { buildClientHealthReports, composeText, runClientHealthReport } from "./client-health.ts";

const NOW = new Date("2026-10-23T12:00:00Z");
const ago = (d: number) => new Date(NOW.getTime() - d * 86_400_000).toISOString();
const seed = () => new FakeSupabase({
  contacts: [{ id: "c1", first_name: "Pat", last_name: "Lee" }],
  projects: [
    { id: "p1", org_id: "o", name: "Acme Site", status: "active", contact_id: "c1", netlify_site_url: "https://acme.com", repo_urls: ["https://github.com/a/b"], target_end_date: "2026-12-01" },
    { id: "p2", org_id: "o", name: "Plain", status: "active", contact_id: "c1", netlify_site_url: null, repo_urls: [], target_end_date: null },
    { id: "p3", org_id: "o", name: "Done", status: "completed", contact_id: "c1", netlify_site_url: null, repo_urls: [], target_end_date: null },
  ],
  project_tasks: [
    { project_id: "p1", title: "Migrate checkout", status: "completed", completed_at: ago(2), updated_at: ago(2) },
    { project_id: "p1", title: "Ancient", status: "completed", completed_at: ago(40), updated_at: ago(40) },
    { project_id: "p1", title: "Form", status: "in_progress", completed_at: null, updated_at: ago(1) },
  ],
  project_activity_log: [{ project_id: "p1", event_type: "milestone", created_at: ago(3) }],
  project_release_approvals: [{ project_id: "p1", created_at: ago(1) }],
  friday_site_state: [{ project_id: "p1", status: "down", consecutive_fails: 4, last_down_alert_at: ago(0.1) }],
  clara_notifications: [],
}, { unique: { clara_notifications: [["organization_id", "dedupe_key"]] } });

Deno.test("reports cover active projects only, with weekly task, delivery and uptime facts", async () => {
  const rs = await buildClientHealthReports(asClient(seed()), "o", NOW);
  assertEquals(rs.map((r) => r.projectName), ["Acme Site", "Plain"]);
  const a = rs[0];
  assertEquals([a.sections.tasks.completed7d, a.sections.tasks.open, a.sections.tasks.inProgress, a.sections.delivered], [1, 1, 1, { portalUpdates7d: 1, signoffsFiled7d: 1 }]);
  assertEquals([a.sections.uptime.status, a.sections.engineering.repoCount, a.clientName], ["down", 1, "Pat Lee"]);
  assertEquals(rs[1].sections.uptime.monitored, false);
  assert(a.text.includes("site DOWN") && a.text.includes("target 2026-12-01"));
  assert(composeText("X", "Y", rs[1].sections).includes("board clear"));
});

Deno.test("the owner summary is one brief-bound notification per ISO week, never client-visible", async () => {
  const f = seed();
  const r = await runClientHealthReport({ db: asClient(f), orgId: "o", now: NOW });
  assertEquals([r.projects, r.wrapped7d, r.down, r.posted], [2, 1, 1, true]);
  const n = f.rows("clara_notifications");
  assertEquals([n.length, n[0].priority, n[0].origin, n[0].dedupe_key], [1, "normal", "agent", "friday.client_health_report:2026-W43"]);
  assert(String(n[0].text).includes("Down right now: Acme Site"));
  assertEquals((await runClientHealthReport({ db: asClient(f), orgId: "o", now: NOW })).posted, false);
  assertEquals(f.rows("clara_notifications").length, 1);
});
