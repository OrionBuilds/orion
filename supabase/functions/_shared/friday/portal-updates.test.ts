import { assertEquals } from "jsr:@std/assert@1";
import { FakeSupabase, asClient } from "../testing/fake-supabase.ts";
import { makeBudget } from "./run-budget.ts";
import { runPortalUpdates, maxIso, rememberSkipped, SKIPPED_CAP } from "./portal-updates.ts";
import type { Gh } from "./gh-api.ts";
import type { Ask } from "./portal-copy.ts";

const NOW = new Date("2026-10-20T20:00:00Z");
const GOOD = {
  title: "A simpler way to request a quote", context: "You asked for an easier way for visitors to get in touch about pricing.",
  changes: "We added a short quote request form to the site. Visitors now fill in their name, phone and a few details, and it reaches your team straight away.",
  impact: "Visitors will see the new form on the Quote Form area of the site. Everything else works the way it did before.",
  live_now: "This change is live on your site now.", check: [],
};
const ask: Ask = () => Promise.resolve(GOOD);
const routes = (extra: Record<string, unknown> = {}): Gh => {
  const r: Record<string, unknown> = {
    "repos/acme/site?": undefined,
    "repos/acme/site/pulls?state=closed": [{ number: 7, title: "Add form", body: "", merged_at: "2026-10-19T10:00:00Z", merge_commit_sha: "m7", html_url: "u7" },
      { number: 8, title: "bump lock", body: "", merged_at: "2026-10-19T12:00:00Z", merge_commit_sha: "m8", html_url: "u8" }],
    "repos/acme/site/commits?sha": [],
    "repos/acme/site/pulls/7/files": [{ filename: "src/components/QuoteForm.tsx", additions: 5, deletions: 0 }],
    "repos/acme/site/pulls/7/commits": [{ sha: "c7", commit: { message: "form" } }],
    "repos/acme/site/pulls/8/files": [{ filename: "package-lock.json", additions: 5, deletions: 5 }],
    "repos/acme/site/pulls/8/commits": [{ sha: "c8", commit: { message: "bump" } }],
    ...extra,
  };
  return { json<T>(path: string) {
    if (path === "repos/acme/site") return Promise.resolve({ default_branch: "main" } as T);
    const k = Object.keys(r).find((x) => r[x] !== undefined && path.startsWith(x));
    return k ? Promise.resolve(r[k] as T) : Promise.reject(new Error(`unrouted ${path}`));
  } };
};
const seed = (over: Record<string, Record<string, unknown>[]> = {}) => new FakeSupabase({
  projects: [{ id: "p1", org_id: "o", name: "Acme Site", status: "active", repo_urls: ["https://github.com/acme/site"] }],
  project_agent_meta: [], project_activity_log: [], friday_portal_cursors: [], ...over,
});
const cursor = (o: Record<string, unknown> = {}) => ({ repo: "acme/site", org_id: "o", initialized_at: "2026-10-01T00:00:00Z", last_merged_at: "2026-10-18T00:00:00Z", last_commit_at: "2026-10-18T00:00:00Z", default_branch: "main", skipped_refs: [], ...o });

Deno.test("first sighting only initialises the cursor and posts nothing", async () => {
  const f = seed();
  const r = await runPortalUpdates({ db: asClient(f), gh: routes(), ask, budget: makeBudget(), now: () => NOW });
  assertEquals([r.initialized, r.posted], [1, 0]);
  assertEquals(f.rows("friday_portal_cursors")[0].last_merged_at, NOW.toISOString());
  assertEquals(f.rows("project_activity_log").length, 0);
});

Deno.test("a merged feature PR is posted to the portal feed, housekeeping is skipped and remembered, a re-run is a no-op", async () => {
  const f = seed({ friday_portal_cursors: [cursor()] });
  const deps = { db: asClient(f), gh: routes(), ask, budget: makeBudget(), now: () => NOW };
  const r = await runPortalUpdates(deps);
  assertEquals([r.posted, r.noise, r.errors, r.partial], [1, 1, 0, false]);
  const row = f.rows("project_activity_log")[0];
  const p = row.payload as { source_ref: string; format: string; is_live: boolean; shas: string[] };
  assertEquals([row.event_type, row.project_id, p.source_ref, p.format, p.is_live, p.shas], ["milestone", "p1", "pr#7", "sections.v1", true, ["c7"]]);
  const c = f.rows("friday_portal_cursors")[0];
  assertEquals([c.skipped_refs, c.last_merged_at], [["pr#8"], NOW.toISOString()]);
  // Cursor moved to now: the next tick finds nothing new.
  const again = await runPortalUpdates(deps);
  assertEquals([again.posted, again.noise], [0, 0]);
  assertEquals(f.rows("project_activity_log").length, 1);
});

Deno.test("an opted-out project and a kill switch post nothing", async () => {
  const f = seed({ friday_portal_cursors: [cursor()], project_agent_meta: [{ project_id: "p1", agent: "friday", meta: { portalUpdates: false } }] });
  assertEquals((await runPortalUpdates({ db: asClient(f), gh: routes(), ask, budget: makeBudget(), now: () => NOW })).posted, 0);
  const g = seed({ friday_portal_cursors: [cursor()] });
  assertEquals((await runPortalUpdates({ db: asClient(g), gh: routes(), ask, budget: makeBudget(), now: () => NOW, enabled: false })).posted, 0);
});

Deno.test("a GitHub error is counted and leaves the cursor where it was; the other repo still runs", async () => {
  const f = seed({
    projects: [
      { id: "p1", org_id: "o", name: "Acme Site", status: "active", repo_urls: ["https://github.com/acme/site"] },
      { id: "p2", org_id: "o", name: "Broken", status: "active", repo_urls: ["https://github.com/acme/broken"] },
    ],
    friday_portal_cursors: [cursor(), cursor({ repo: "acme/broken", default_branch: "main" })],
  });
  const gh: Gh = { json<T>(path: string) { return path.includes("acme/broken") ? Promise.reject(new Error("github 404")) : routes().json<T>(path); } };
  const r = await runPortalUpdates({ db: asClient(f), gh, ask, budget: makeBudget(), now: () => NOW });
  assertEquals([r.errors, r.posted], [1, 1]);
  assertEquals(f.rows("friday_portal_cursors").find((c) => c.repo === "acme/broken")!.last_merged_at, "2026-10-18T00:00:00Z");
});

Deno.test("an exhausted budget stops cleanly and is reported partial without moving the cursor to now", async () => {
  const f = seed({ friday_portal_cursors: [cursor()] });
  let t = 0;
  const budget = makeBudget(40_000, () => t);
  t = 39_000; // 1 s left: below a unit's estimate
  const r = await runPortalUpdates({ db: asClient(f), gh: routes(), ask, budget, now: () => NOW });
  assertEquals([r.partial, r.posted], [true, 0]);
  assertEquals(f.rows("friday_portal_cursors")[0].last_merged_at, "2026-10-18T00:00:00Z");
});

Deno.test("helpers: maxIso and the capped FIFO of skipped refs", () => {
  assertEquals(maxIso(null, "2026-01-01"), "2026-01-01");
  assertEquals(maxIso("2026-02-01", "2026-01-01"), "2026-02-01");
  let l: string[] = [];
  for (let i = 0; i < SKIPPED_CAP + 5; i++) l = rememberSkipped(l, `r${i}`);
  assertEquals([l.length, l[0], rememberSkipped(l, "r204").length], [SKIPPED_CAP, "r5", SKIPPED_CAP]);
});
