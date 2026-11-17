/**
 * GitHub REST reads for the FRIDAY ports (replaces the `gh` CLI). The token comes from the
 * FRIDAY_GITHUB_TOKEN (fallback GITHUB_TOKEN) secret via the injected Env and is only ever put in
 * the Authorization header: never logged, never in an error message.
 */
import type { Env } from "../clara/phones.ts";
import type { ChangedFile, UnitCommit, WorkUnit } from "./portal-copy.ts";

export interface Gh {
  json<T>(path: string): Promise<T>;
}

export function parseGithubRepo(url: string): { owner: string; repo: string } | null {
  const m = (url ?? "").trim().match(/github\.com[/:]([^/\s]+)\/([^/\s#?]+?)(?:\.git)?\/?$/i);
  return m ? { owner: m[1], repo: m[2] } : null;
}

export function ghToken(env: Env): string | null {
  return env.get("FRIDAY_GITHUB_TOKEN")?.trim() || env.get("GITHUB_TOKEN")?.trim() || null;
}

export function makeGh(env: Env, timeoutMs: () => number = () => 8_000, f: typeof fetch = (i, o) => fetch(i, o)): Gh {
  const token = ghToken(env);
  return {
    async json<T>(path: string): Promise<T> {
      if (!token) throw new Error("GitHub token not configured (FRIDAY_GITHUB_TOKEN)");
      const r = await f(`https://api.github.com/${path.replace(/^\//, "")}`, {
        headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28", "user-agent": "orion-friday" },
        signal: AbortSignal.timeout(timeoutMs()),
      });
      if (!r.ok) throw new Error(`github ${r.status} ${path.split("?")[0]}`);
      return await r.json() as T;
    },
  };
}

interface RawFile { filename: string; additions?: number; deletions?: number; status?: string }
const toFile = (f: RawFile): ChangedFile => ({ path: f.filename, additions: f.additions ?? 0, deletions: f.deletions ?? 0, status: f.status });
export function toUnitCommit(c: { sha: string; message: string }): UnitCommit {
  const [subject, ...rest] = (c.message ?? "").split("\n");
  return { sha: c.sha, subject: (subject ?? "").trim(), body: rest.join("\n").trim() };
}

export async function fetchDefaultBranch(gh: Gh, owner: string, repo: string): Promise<string> {
  const r = await gh.json<{ default_branch?: string }>(`repos/${owner}/${repo}`);
  return r.default_branch || "main";
}

export interface MergedPr { number: number; title: string; body: string; merged_at: string; merge_commit_sha: string | null; html_url: string }

export async function fetchMergedPrs(gh: Gh, owner: string, repo: string, base: string, sinceIso: string): Promise<MergedPr[]> {
  const rows = await gh.json<Array<MergedPr & { merged_at: string | null; body: string | null }>>(
    `repos/${owner}/${repo}/pulls?state=closed&base=${encodeURIComponent(base)}&sort=updated&direction=desc&per_page=50`,
  );
  return (rows ?? []).filter((p) => p.merged_at && p.merged_at > sinceIso)
    .map((p) => ({ number: p.number, title: p.title, body: p.body ?? "", merged_at: p.merged_at as string, merge_commit_sha: p.merge_commit_sha ?? null, html_url: p.html_url }))
    .sort((a, b) => a.merged_at.localeCompare(b.merged_at));
}

export interface CommitInfo { sha: string; date: string; message: string; parents: string[] }

export async function fetchCommits(gh: Gh, owner: string, repo: string, branch: string, sinceIso: string): Promise<CommitInfo[]> {
  const rows = await gh.json<Array<{ sha: string; commit: { message: string; committer?: { date?: string }; author?: { date?: string } }; parents: { sha: string }[] }>>(
    `repos/${owner}/${repo}/commits?sha=${encodeURIComponent(branch)}&since=${encodeURIComponent(sinceIso)}&per_page=100`,
  );
  return (rows ?? [])
    .map((c) => ({ sha: c.sha, date: c.commit.committer?.date ?? c.commit.author?.date ?? "", message: c.commit.message, parents: (c.parents ?? []).map((p) => p.sha) }))
    .filter((c) => c.date > sinceIso).sort((a, b) => a.date.localeCompare(b.date));
}

export async function fetchPrFiles(gh: Gh, owner: string, repo: string, n: number): Promise<ChangedFile[]> {
  return ((await gh.json<RawFile[]>(`repos/${owner}/${repo}/pulls/${n}/files?per_page=100`)) ?? []).map(toFile);
}
export async function fetchPrCommits(gh: Gh, owner: string, repo: string, n: number): Promise<UnitCommit[]> {
  const rows = await gh.json<Array<{ sha: string; commit: { message: string } }>>(`repos/${owner}/${repo}/pulls/${n}/commits?per_page=50`);
  return (rows ?? []).map((c) => toUnitCommit({ sha: c.sha, message: c.commit.message }));
}
export async function fetchCommitFiles(gh: Gh, owner: string, repo: string, sha: string): Promise<ChangedFile[]> {
  return ((await gh.json<{ files?: RawFile[] }>(`repos/${owner}/${repo}/commits/${sha}`)).files ?? []).map(toFile);
}
export async function fetchCompare(gh: Gh, owner: string, repo: string, base: string, head: string): Promise<{ commits: UnitCommit[]; files: ChangedFile[] }> {
  const r = await gh.json<{ commits?: Array<{ sha: string; commit: { message: string } }>; files?: RawFile[] }>(`repos/${owner}/${repo}/compare/${base}...${head}`);
  return { commits: (r.commits ?? []).map((c) => toUnitCommit({ sha: c.sha, message: c.commit.message })), files: (r.files ?? []).map(toFile) };
}

function mergeFiles(lists: ChangedFile[][]): ChangedFile[] {
  const agg = new Map<string, ChangedFile>();
  for (const list of lists) for (const f of list) {
    const cur = agg.get(f.path);
    if (cur) { cur.additions += f.additions || 0; cur.deletions += f.deletions || 0; } else agg.set(f.path, { ...f });
  }
  return [...agg.values()];
}

/**
 * Everything that landed on the default branch since `since`: merged PRs, true merge commits (expanded
 * via compare) and direct commits grouped by UTC day, oldest first. Stops fetching detail once `more()`
 * says the time budget is gone and reports `truncatedAt` (the occurredAt of the last complete unit) so
 * the caller can advance its cursor only that far.
 */
export async function collectUnits(
  gh: Gh, owner: string, repo: string, o: { since: string; defaultBranch: string; more?: () => boolean },
): Promise<WorkUnit[]> {
  const more = o.more ?? (() => true);
  const prs = await fetchMergedPrs(gh, owner, repo, o.defaultBranch, o.since);
  const prShas = new Set(prs.map((p) => p.merge_commit_sha).filter(Boolean) as string[]);
  const prNums = new Set(prs.map((p) => p.number));
  const commits = await fetchCommits(gh, owner, repo, o.defaultBranch, o.since);
  const notPr = commits.filter((c) => {
    if (prShas.has(c.sha)) return false;
    const m = c.message.split("\n")[0].match(/\(#(\d+)\)\s*$/);
    return !(m && prNums.has(Number(m[1])));
  });
  const merges = notPr.filter((c) => c.parents.length > 1);
  let direct = notPr.filter((c) => c.parents.length <= 1);
  const units: WorkUnit[] = [];

  for (const pr of prs) {
    if (!more()) break;
    const [files, prCommits] = await Promise.all([fetchPrFiles(gh, owner, repo, pr.number), fetchPrCommits(gh, owner, repo, pr.number)]);
    const shas = new Set(prCommits.map((c) => c.sha));
    direct = direct.filter((c) => !shas.has(c.sha));
    units.push({
      kind: "pr", ref: `pr#${pr.number}`, title: pr.title, body: pr.body, url: pr.html_url,
      commits: prCommits.length ? prCommits : [{ sha: pr.merge_commit_sha ?? "", subject: pr.title, body: "" }],
      files, occurredAt: pr.merged_at,
    });
  }
  for (const m of merges) {
    if (!more()) break;
    const { commits: brought, files } = await fetchCompare(gh, owner, repo, m.parents[0], m.sha);
    const b = new Set(brought.map((c) => c.sha));
    direct = direct.filter((c) => !b.has(c.sha));
    units.push({
      kind: "merge", ref: `merge-${m.sha.slice(0, 7)}`,
      title: brought.length === 1 ? brought[0].subject : m.message.split("\n")[0],
      body: brought.length === 1 ? brought[0].body : "",
      commits: brought.length ? brought : [toUnitCommit({ sha: m.sha, message: m.message })], files, occurredAt: m.date,
    });
  }
  const byDay = new Map<string, CommitInfo[]>();
  for (const c of direct) byDay.set(c.date.slice(0, 10), [...(byDay.get(c.date.slice(0, 10)) ?? []), c]);
  for (const [day, list] of byDay) {
    if (!more()) break;
    const sorted = list.sort((a, b) => a.date.localeCompare(b.date));
    const newest = sorted[sorted.length - 1];
    const fileLists: ChangedFile[][] = [];
    for (const c of sorted.slice(0, 15)) fileLists.push(await fetchCommitFiles(gh, owner, repo, c.sha));
    const uc = sorted.map((c) => toUnitCommit({ sha: c.sha, message: c.message }));
    units.push({
      kind: "commit-digest", ref: `commits-${day}-${newest.sha.slice(0, 7)}`,
      title: sorted.length === 1 ? uc[0].subject : `${sorted.length} changes on ${day}`,
      body: sorted.length === 1 ? uc[0].body : "", commits: uc, files: mergeFiles(fileLists), occurredAt: newest.date,
    });
  }
  return units.sort((a, b) => a.occurredAt.localeCompare(b.occurredAt));
}

// ── Open PRs (release approvals) ─────────────────────────────────────────────

export interface OpenPr {
  number: number; url: string; title: string; body: string; isDraft: boolean;
  /** MERGEABLE | CONFLICTING | UNKNOWN */ mergeable: string;
  /** SUCCESS | PENDING | FAILURE | "" (none) */ checks: string;
  headRefName?: string; createdAt?: string; headSha?: string;
}

export async function listOpenPrs(gh: Gh, owner: string, repo: string): Promise<OpenPr[]> {
  const rows = await gh.json<Array<{ number: number; html_url: string; title: string; body: string | null; draft?: boolean; head: { ref: string; sha: string }; created_at: string }>>(
    `repos/${owner}/${repo}/pulls?state=open&per_page=30&sort=created&direction=desc`,
  );
  return (rows ?? []).map((r) => ({
    number: r.number, url: r.html_url, title: r.title, body: r.body ?? "", isDraft: r.draft === true,
    mergeable: "UNKNOWN", checks: "", headRefName: r.head?.ref, createdAt: r.created_at, headSha: r.head?.sha,
  })).filter((p) => p.url);
}

/** Fill mergeable + rolled-up checks for ONE PR (two cheap calls; only done for the release candidate). */
export async function enrichPr(gh: Gh, owner: string, repo: string, pr: OpenPr): Promise<OpenPr> {
  const one = await gh.json<{ mergeable?: boolean | null; mergeable_state?: string }>(`repos/${owner}/${repo}/pulls/${pr.number}`);
  const mergeable = one.mergeable === false || one.mergeable_state === "dirty" ? "CONFLICTING" : one.mergeable === true ? "MERGEABLE" : "UNKNOWN";
  let checks = "";
  if (pr.headSha) {
    const runs = await gh.json<{ check_runs?: Array<{ status: string; conclusion: string | null }> }>(`repos/${owner}/${repo}/commits/${pr.headSha}/check-runs?per_page=50`);
    const cr = runs.check_runs ?? [];
    if (cr.length) {
      const bad = cr.some((c) => c.status === "completed" && ["failure", "timed_out", "cancelled", "action_required"].includes(c.conclusion ?? ""));
      const pending = cr.some((c) => c.status !== "completed");
      checks = bad ? "FAILURE" : pending ? "PENDING" : "SUCCESS";
    }
  }
  return { ...pr, mergeable, checks };
}
