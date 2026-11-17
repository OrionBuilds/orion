import { assertEquals } from "jsr:@std/assert@1";
import { FakeSupabase, asClient } from "../testing/fake-supabase.ts";
import { makeBudget } from "./run-budget.ts";
import { isShippable, isUpkeepPr, runReleaseApprovals } from "./release-approvals.ts";
import type { Gh } from "./gh-api.ts";

const PRS = [
  { number: 12, html_url: "u12", title: "Add quote form", body: "", draft: false, head: { ref: "feat/form", sha: "s12" }, created_at: "2026-10-30T00:00:00Z" },
  { number: 13, html_url: "u13", title: "Weekly patch bumps", body: "", draft: false, head: { ref: "friday/deps-weekly-2026-10-30", sha: "s13" }, created_at: "2026-10-31T00:00:00Z" },
  { number: 14, html_url: "u14", title: "WIP", body: "", draft: true, head: { ref: "wip", sha: "s14" }, created_at: "2026-10-31T00:00:00Z" },
];
const gh = (checks = "success", mergeable: boolean | null = true): Gh => ({
  json<T>(path: string) {
    if (path.startsWith("repos/acme/site/pulls?state=open")) return Promise.resolve(PRS as T);
    if (path === "repos/acme/site/pulls/12") return Promise.resolve({ mergeable, mergeable_state: mergeable === false ? "dirty" : "clean" } as T);
    if (path.startsWith("repos/acme/site/commits/s12/check-runs")) return Promise.resolve({ check_runs: [{ status: "completed", conclusion: checks }] } as T);
    if (path.startsWith("repos/acme/site/pulls/12/files")) return Promise.resolve([{ filename: "src/components/QuoteForm.tsx", additions: 5, deletions: 0 }] as T);
    return Promise.reject(new Error(`unrouted ${path}`));
  },
});
const seed = (over: Record<string, Record<string, unknown>[]> = {}) => new FakeSupabase({
  projects: [{ id: "p1", org_id: "o", name: "Acme Site", status: "active", repo_urls: ["https://github.com/acme/site"] }],
  project_agent_meta: [{ project_id: "p1", agent: "friday", meta: { clientSignoff: true } }],
  project_release_approvals: [], ...over,
}, { unique: { project_release_approvals: [["project_id", "pr_url"]] } });
const run = (f: FakeSupabase, g = gh(), enabled = true) => runReleaseApprovals({ db: asClient(f), gh: g, ask: null, budget: makeBudget(), enabled });

Deno.test("upkeep and unshippable PRs are recognised", () => {
  assertEquals(isUpkeepPr({ title: "Weekly patch bumps" }), true);
  assertEquals(isUpkeepPr({ headRefName: "friday/deps-weekly-2026-10-30" }), true);
  assertEquals(isUpkeepPr({ title: "Add quote form", headRefName: "feat/form" }), false);
  const base = { number: 1, url: "u", title: "t", body: "", isDraft: false, mergeable: "MERGEABLE", checks: "SUCCESS" };
  assertEquals([isShippable(base), isShippable({ ...base, mergeable: "CONFLICTING" }), isShippable({ ...base, checks: "FAILURE" }), isShippable({ ...base, isDraft: true }), isShippable({ ...base, mergeable: "UNKNOWN" })], [true, false, false, false, true]);
});

Deno.test("an opted-in project gets ONE pending pending-mode card for its newest feature PR; re-runs add nothing", async () => {
  const f = seed();
  const r = await run(f);
  assertEquals([r.filed, r.failed], [1, 0]);
  const row = f.rows("project_release_approvals")[0];
  assertEquals([row.pr_url, row.pr_number, row.pr_repo, row.org_id], ["u12", 12, "acme/site", "o"]);
  assertEquals(String(row.changelog).includes("waiting for your go-ahead"), true);
  assertEquals(String(row.changelog).includes("is live"), false);
  const again = await run(f);
  assertEquals([again.filed, again.alreadyOpen], [0, 1]);
  assertEquals(f.rows("project_release_approvals").length, 1);
});

Deno.test("off by default, not filed without opt-in, and failing checks or conflicts are not put in front of a client", async () => {
  assertEquals((await run(seed(), gh(), false)).filed, 0);
  assertEquals((await run(seed({ project_agent_meta: [] }))).optedIn, 0);
  assertEquals((await run(seed(), gh("failure"))).noCandidate, 1);
  assertEquals((await run(seed(), gh("success", false))).noCandidate, 1);
});

Deno.test("a GitHub failure is counted, not thrown", async () => {
  const bad: Gh = { json: () => Promise.reject(new Error("github 500")) };
  const r = await run(seed(), bad);
  assertEquals([r.failed, r.filed], [1, 0]);
});
