import { assertEquals } from "jsr:@std/assert@1";
import { collectUnits, ghToken, listOpenPrs, enrichPr, parseGithubRepo, type Gh } from "./gh-api.ts";

const fakeGh = (routes: Record<string, unknown>, seen: string[] = []): Gh => ({
  json<T>(path: string) {
    seen.push(path);
    const k = Object.keys(routes).find((r) => path.startsWith(r));
    if (!k) return Promise.reject(new Error(`unrouted ${path}`));
    return Promise.resolve(routes[k] as T);
  },
});

Deno.test("repo urls parse; the token comes from env and a missing one is null", () => {
  assertEquals(parseGithubRepo("https://github.com/acme/site.git"), { owner: "acme", repo: "site" });
  assertEquals(parseGithubRepo("not a url"), null);
  assertEquals(ghToken({ get: (k) => (k === "FRIDAY_GITHUB_TOKEN" ? " t " : undefined) }), "t");
  assertEquals(ghToken({ get: () => undefined }), null);
});

Deno.test("collectUnits groups PRs, merge commits and per-day direct commits, oldest first", async () => {
  const gh = fakeGh({
    "repos/a/r/pulls?state=closed": [
      { number: 7, title: "Add form", body: "b", merged_at: "2026-10-02T10:00:00Z", merge_commit_sha: "m7", html_url: "u7" },
      { number: 6, title: "old", body: "", merged_at: "2026-09-01T10:00:00Z", merge_commit_sha: "m6", html_url: "u6" },
      { number: 5, title: "unmerged", body: "", merged_at: null, merge_commit_sha: null, html_url: "u5" },
    ],
    "repos/a/r/commits?sha": [
      { sha: "m7", commit: { message: "Add form (#7)", committer: { date: "2026-10-02T10:00:00Z" } }, parents: [{ sha: "p" }] },
      { sha: "d1", commit: { message: "tweak hero", committer: { date: "2026-10-01T09:00:00Z" } }, parents: [{ sha: "p" }] },
      { sha: "d2", commit: { message: "tweak footer", committer: { date: "2026-10-01T11:00:00Z" } }, parents: [{ sha: "p" }] },
    ],
    "repos/a/r/pulls/7/files": [{ filename: "src/components/Form.tsx", additions: 5, deletions: 1 }],
    "repos/a/r/pulls/7/commits": [{ sha: "c7", commit: { message: "form\n\nbody" } }],
    "repos/a/r/commits/d": { files: [{ filename: "src/app/page.tsx", additions: 1, deletions: 1 }] },
  });
  const units = await collectUnits(gh, "a", "r", { since: "2026-09-30T00:00:00Z", defaultBranch: "main" });
  assertEquals(units.map((u) => [u.kind, u.ref]), [["commit-digest", "commits-2026-10-01-d2"], ["pr", "pr#7"]]);
  assertEquals(units[0].title, "2 changes on 2026-10-01");
  assertEquals(units[1].commits[0].subject, "form");
});

Deno.test("collectUnits stops fetching detail when the budget callback says so", async () => {
  const seen: string[] = [];
  const gh = fakeGh({
    "repos/a/r/pulls?state=closed": [{ number: 7, title: "x", body: "", merged_at: "2026-10-02T10:00:00Z", merge_commit_sha: "m7", html_url: "u" }],
    "repos/a/r/commits?sha": [],
  }, seen);
  const units = await collectUnits(gh, "a", "r", { since: "2026-09-30T00:00:00Z", defaultBranch: "main", more: () => false });
  assertEquals([units.length, seen.some((p) => p.includes("/files"))], [0, false]);
});

Deno.test("open PRs are listed cheaply and enriched with mergeability and checks on demand", async () => {
  const gh = fakeGh({
    "repos/a/r/pulls?state=open": [{ number: 9, html_url: "u9", title: "Feature", body: null, draft: false, head: { ref: "feat/x", sha: "s9" }, created_at: "2026-10-30T00:00:00Z" }],
    "repos/a/r/pulls/9": { mergeable: true, mergeable_state: "clean" },
    "repos/a/r/commits/s9/check-runs": { check_runs: [{ status: "completed", conclusion: "success" }, { status: "in_progress", conclusion: null }] },
  });
  const [pr] = await listOpenPrs(gh, "a", "r");
  assertEquals([pr.mergeable, pr.checks], ["UNKNOWN", ""]);
  const e = await enrichPr(gh, "a", "r", pr);
  assertEquals([e.mergeable, e.checks], ["MERGEABLE", "PENDING"]);
});
