/**
 * release-approvals (ported from FRIDAY's releaseApprovals.ts): for projects that opted in to client
 * sign-off, make sure the newest shippable FEATURE pull request has ONE pending project_release_approvals
 * row, which the client portal shows as "Ready for your review". Upkeep PRs (dependency sweeps and
 * their fix rounds) never reach a client. It only files a portal record: nothing is sent, nothing merges.
 *
 * Opt-in lives in project_agent_meta[agent=friday].meta.clientSignoff === true (the OS-side home of the
 * old local Project.clientSignoff flag); master switch is FRIDAY_RELEASE_APPROVALS=on (default off,
 * as in FRIDAY). Dedup: at most one pending card per project, and unique (project_id, pr_url).
 */
import type { SupabaseClient } from "npm:@supabase/supabase-js@2";
import { composeEntry, sectionsToText, type Ask } from "./portal-copy.ts";
import { enrichPr, fetchPrFiles, listOpenPrs, parseGithubRepo, type Gh, type OpenPr } from "./gh-api.ts";
import type { Budget } from "./run-budget.ts";

export const CARD_ESTIMATE_MS = 15_000;
const UPKEEP_HEAD = /^(?:friday\/)?deps[-\/]weekly[-\/]?\d{4}-\d{2}-\d{2}/i;
const UPKEEP_TITLE = /weekly patch bumps|\[deps\]/i;
const FIX_OF_UPKEEP = /^\s*\[(?:fix|review|rebase)(?:\s*r\d+)?\].*(?:weekly patch bumps|\[deps\])/i;

export function isUpkeepPr(pr: { headRefName?: string; title?: string }): boolean {
  const head = (pr.headRefName ?? "").trim();
  const title = (pr.title ?? "").trim();
  return UPKEEP_HEAD.test(head) || UPKEEP_TITLE.test(title) || FIX_OF_UPKEEP.test(title);
}

/** A PR fit to put in front of a client: not a draft, no conflicts, checks not failing. UNKNOWN mergeability is allowed. */
export function isShippable(pr: OpenPr): boolean {
  return !pr.isDraft && pr.mergeable !== "CONFLICTING" && pr.checks !== "FAILURE";
}

export interface ReleaseDeps { db: SupabaseClient; gh: Gh; ask: Ask | null; budget: Budget; enabled: boolean; now?: () => Date }
export interface ReleaseResult { filed: number; alreadyOpen: number; noCandidate: number; failed: number; optedIn: number; partial: boolean }

interface Proj { id: string; org_id: string; name: string; repo_urls: string[] | null }

export async function optedInProjects(db: SupabaseClient): Promise<Proj[]> {
  const { data: metas } = await db.from("project_agent_meta").select("project_id, meta").eq("agent", "friday");
  const ids = ((metas ?? []) as { project_id: string; meta: { clientSignoff?: unknown } | null }[]).filter((m) => m.meta?.clientSignoff === true).map((m) => m.project_id);
  if (!ids.length) return [];
  const { data } = await db.from("projects").select("id, org_id, name, repo_urls").eq("status", "active").in("id", ids);
  return ((data ?? []) as Proj[]).filter((p) => (p.repo_urls ?? []).length > 0);
}

async function hasPendingCard(db: SupabaseClient, projectId: string): Promise<boolean> {
  const { data, error } = await db.from("project_release_approvals").select("id").eq("project_id", projectId).eq("status", "pending").limit(1);
  if (error) return true; // on doubt, don't file: avoids duplicating when the check is flaky
  return ((data ?? []) as unknown[]).length > 0;
}

/** Client-facing "what ships" copy: the portal pipeline in "pending" mode ("ready and waiting for your go-ahead"). */
export async function composeReleaseCopy(gh: Gh, ask: Ask | null, projectName: string, owner: string, repo: string, pr: OpenPr): Promise<{ title: string; changelog: string }> {
  const files = await fetchPrFiles(gh, owner, repo, pr.number).catch(() => []);
  const entry = await composeEntry(
    { kind: "pr", ref: `pr#${pr.number}`, title: pr.title, body: pr.body, url: pr.url, commits: [], files, occurredAt: new Date().toISOString() },
    { projectName, mode: "pending" }, ask,
  );
  return { title: entry.title, changelog: sectionsToText(entry.sections) };
}

export async function runReleaseApprovals(d: ReleaseDeps): Promise<ReleaseResult> {
  const r: ReleaseResult = { filed: 0, alreadyOpen: 0, noCandidate: 0, failed: 0, optedIn: 0, partial: false };
  if (!d.enabled) return r;
  const projects = await optedInProjects(d.db);
  r.optedIn = projects.length;
  for (const p of projects) {
    if (!d.budget.canStart(CARD_ESTIMATE_MS)) { r.partial = true; break; }
    try {
      if (await hasPendingCard(d.db, p.id)) { r.alreadyOpen++; continue; }
      // Newest feature PR across the project's repos that is shippable (enrich newest-first, at most 3 lookups).
      let best: { owner: string; repo: string; pr: OpenPr } | null = null;
      for (const url of p.repo_urls ?? []) {
        const gh = parseGithubRepo(url);
        if (!gh) continue;
        const open = (await listOpenPrs(d.gh, gh.owner, gh.repo)).filter((pr) => !pr.isDraft && !isUpkeepPr(pr)).sort((a, b) => b.number - a.number);
        for (const pr of open.slice(0, 3)) {
          const e = await enrichPr(d.gh, gh.owner, gh.repo, pr);
          if (isShippable(e)) { if (!best || e.number > best.pr.number) best = { ...gh, pr: e }; break; }
        }
      }
      if (!best) { r.noCandidate++; continue; }
      const copy = await composeReleaseCopy(d.gh, d.ask, p.name, best.owner, best.repo, best.pr);
      const { error } = await d.db.from("project_release_approvals").insert({
        org_id: p.org_id, project_id: p.id, pr_url: best.pr.url, title: copy.title.slice(0, 200), changelog: copy.changelog,
        pr_repo: `${best.owner}/${best.repo}`, pr_number: best.pr.number,
      });
      if (error) {
        if (error.code === "23505") { r.alreadyOpen++; continue; } // this PR already has a row (any status)
        throw new Error(error.message);
      }
      r.filed++;
    } catch (e) {
      r.failed++;
      console.error(`[release-approvals] ${p.name}: ${String((e as Error).message ?? e).slice(0, 200)}`);
    }
  }
  return r;
}
