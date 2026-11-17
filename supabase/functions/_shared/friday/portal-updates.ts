/**
 * portal-updates (ported from FRIDAY's portalUpdates.ts): post a plain-English, sectioned entry to the
 * OS client-portal feed (project_activity_log, event_type='milestone') for every unit of work that
 * landed on a repo-linked project's DEFAULT branch: one per merged PR, per merge commit, per day of
 * direct commits. Housekeeping is classified by changed files and skipped.
 *
 * The portal feed is an OS portal record (not a direct send). Dropped from FRIDAY: the local
 * task/run lookup that added "what was asked" context (no local store any more) and the backfill CLI.
 *
 * Resumable: per-repo cursor in friday_portal_cursors, saved after every unit; dedupe is layered
 * (cursor + skipped refs, source_ref on the feed, per-row commit shas). First sighting of a repo only
 * initialises its cursor (history is a one-off backfill, never the cron).
 */
import type { SupabaseClient } from "npm:@supabase/supabase-js@2";
import { classifyUnit, composeEntry, type Ask, type ComposeCtx, type UnitCommit, type UpdateEntry, type WorkUnit } from "./portal-copy.ts";
import { collectUnits, fetchDefaultBranch, parseGithubRepo, type Gh } from "./gh-api.ts";
import type { Budget } from "./run-budget.ts";

export const SKIPPED_CAP = 200;
/** A unit needs ~one compose (25 s) + one repair (15 s) at worst; below this we stop and resume next tick. */
export const UNIT_ESTIMATE_MS = 12_000;

export interface Cursor {
  repo: string; org_id: string; initialized_at: string; last_merged_at: string | null; last_commit_at: string | null;
  default_branch: string | null; skipped_refs: string[];
}
export interface Posted { refs: Set<string>; shas: Set<string> }

export interface ProjectRow { id: string; org_id: string; name: string; repo_urls: string[] | null }

export function maxIso(a: string | null | undefined, b: string): string { return a && a > b ? a : b; }

export function rememberSkipped(list: string[], ref: string): string[] {
  return list.includes(ref) ? list : [...list, ref].slice(-SKIPPED_CAP);
}

export type UnitDecision = { action: "post"; entry: UpdateEntry & { issues?: string[] } } | { action: "skip"; reason: string } | { action: "dedup" };

export async function decideUnit(unit: WorkUnit, posted: Posted, skippedRefs: string[], ctx: ComposeCtx, ask: Ask | null): Promise<UnitDecision> {
  if (posted.refs.has(unit.ref) || skippedRefs.includes(unit.ref)) return { action: "dedup" };
  const shas = unit.commits.map((c: UnitCommit) => c.sha).filter(Boolean);
  if (shas.length && shas.every((s) => posted.shas.has(s))) return { action: "skip", reason: "already-posted" };
  const cls = classifyUnit(unit);
  if (cls.noise) return { action: "skip", reason: cls.reason ?? "noise" };
  return { action: "post", entry: await composeEntry(unit, ctx, ask) };
}

/** What's already on the project's feed: source_refs and the commit shas each row covered. */
export async function existingPosted(db: SupabaseClient, projectId: string): Promise<Posted> {
  const out: Posted = { refs: new Set(), shas: new Set() };
  const { data } = await db.from("project_activity_log").select("payload").eq("project_id", projectId).eq("event_type", "milestone")
    .order("created_at", { ascending: false }).limit(200);
  for (const r of (data ?? []) as { payload: { source_ref?: string; shas?: string[] } | null }[]) {
    if (r.payload?.source_ref) out.refs.add(r.payload.source_ref);
    for (const s of r.payload?.shas ?? []) if (typeof s === "string") out.shas.add(s);
  }
  return out;
}

/** Insert one feed row. Idempotent on source_ref (checked first; the feed has no unique index). */
export async function postEntry(db: SupabaseClient, p: { orgId: string; projectId: string }, entry: UpdateEntry, unit: WorkUnit): Promise<{ deduped: boolean }> {
  const { data: ex } = await db.from("project_activity_log").select("id").eq("project_id", p.projectId).eq("event_type", "milestone").eq("payload->>source_ref", unit.ref).limit(1);
  if ((ex as unknown[] | null)?.length) return { deduped: true };
  const shas = unit.commits.map((c) => c.sha).filter(Boolean).slice(0, 100);
  const { error } = await db.from("project_activity_log").insert({
    org_id: p.orgId, project_id: p.projectId, event_type: "milestone", summary: entry.title.slice(0, 200),
    created_at: unit.occurredAt,
    payload: {
      source: "friday-cron", title: entry.title, detail: entry.detail, source_ref: unit.ref, format: "sections.v1",
      sections: entry.sections, is_live: entry.is_live, kind: entry.kind === "maintenance" ? "fix" : entry.kind,
      ...(shas.length ? { shas } : {}),
    },
  });
  if (error) throw new Error(`project_activity_log insert failed: ${error.message}`);
  return { deduped: false };
}

/** Active, repo-linked projects that did not opt out (project_agent_meta[friday].meta.portalUpdates === false). */
export async function portalProjects(db: SupabaseClient, orgId?: string): Promise<ProjectRow[]> {
  let q = db.from("projects").select("id, org_id, name, repo_urls").eq("status", "active");
  if (orgId) q = q.eq("org_id", orgId);
  const { data } = await q.limit(200);
  const rows = ((data ?? []) as ProjectRow[]).filter((p) => (p.repo_urls ?? []).length > 0);
  if (!rows.length) return [];
  const { data: metas } = await db.from("project_agent_meta").select("project_id, meta").eq("agent", "friday").in("project_id", rows.map((r) => r.id));
  const optOut = new Set(((metas ?? []) as { project_id: string; meta: { portalUpdates?: unknown } | null }[]).filter((m) => m.meta?.portalUpdates === false).map((m) => m.project_id));
  return rows.filter((r) => !optOut.has(r.id));
}

export interface PortalDeps { db: SupabaseClient; gh: Gh; ask: Ask | null; budget: Budget; now?: () => Date; enabled?: boolean }
export interface PortalResult { posted: number; noise: number; deduped: number; errors: number; fallbacks: number; initialized: number; reposDone: number; partial: boolean }

async function saveCursor(db: SupabaseClient, c: Cursor): Promise<void> {
  const { error } = await db.from("friday_portal_cursors").upsert({ ...c, updated_at: new Date().toISOString() }, { onConflict: "repo" });
  if (error) throw new Error(`cursor save failed: ${error.message}`);
}

export async function runPortalUpdates(d: PortalDeps): Promise<PortalResult> {
  const r: PortalResult = { posted: 0, noise: 0, deduped: 0, errors: 0, fallbacks: 0, initialized: 0, reposDone: 0, partial: false };
  if (d.enabled === false) return r;
  const nowIso = (d.now?.() ?? new Date()).toISOString();
  const projects = await portalProjects(d.db);
  // Fair order across ticks: repos whose cursor was saved least recently go first, so a slow repo can't starve the rest.
  const { data: curRows } = await d.db.from("friday_portal_cursors").select("*");
  const cursors = new Map(((curRows ?? []) as (Cursor & { updated_at?: string })[]).map((c) => [c.repo, c]));
  const work: { p: ProjectRow; owner: string; repo: string; key: string }[] = [];
  for (const p of projects) for (const url of p.repo_urls ?? []) {
    const gh = parseGithubRepo(url);
    if (gh) work.push({ p, owner: gh.owner, repo: gh.repo, key: `${gh.owner}/${gh.repo}`.toLowerCase() });
  }
  work.sort((a, b) => ((cursors.get(a.key) as { updated_at?: string } | undefined)?.updated_at ?? "").localeCompare((cursors.get(b.key) as { updated_at?: string } | undefined)?.updated_at ?? ""));

  const feeds = new Map<string, Posted>();
  for (const w of work) {
    if (!d.budget.canStart(UNIT_ESTIMATE_MS)) { r.partial = true; break; }
    let cursor = cursors.get(w.key);
    if (!cursor) {
      cursor = { repo: w.key, org_id: w.p.org_id, initialized_at: nowIso, last_merged_at: nowIso, last_commit_at: nowIso, default_branch: null, skipped_refs: [] };
      await saveCursor(d.db, cursor);
      r.initialized++;
      continue;
    }
    try {
      if (!cursor.default_branch) { cursor.default_branch = await fetchDefaultBranch(d.gh, w.owner, w.repo); await saveCursor(d.db, cursor); }
      const since = [cursor.last_merged_at, cursor.last_commit_at].filter(Boolean).sort()[0] ?? cursor.initialized_at;
      let truncated = false;
      const units = await collectUnits(d.gh, w.owner, w.repo, { since, defaultBranch: cursor.default_branch, more: () => (d.budget.canStart(2_000) ? true : (truncated = true, false)) });
      if (!units.length && !truncated) { cursor.last_merged_at = nowIso; cursor.last_commit_at = nowIso; await saveCursor(d.db, cursor); r.reposDone++; continue; }
      let already = feeds.get(w.p.id);
      if (!already) { already = await existingPosted(d.db, w.p.id); feeds.set(w.p.id, already); }
      const ctx: ComposeCtx = { projectName: w.p.name, mode: "live" };
      let finished = !truncated;
      for (const unit of units) {
        if (!d.budget.canStart(UNIT_ESTIMATE_MS)) { finished = false; break; }
        const decision = await decideUnit(unit, already, cursor.skipped_refs ?? [], ctx, d.ask);
        if (decision.action === "dedup") r.deduped++;
        else if (decision.action === "skip") {
          r.noise++;
          cursor.skipped_refs = rememberSkipped(cursor.skipped_refs ?? [], unit.ref);
          console.log(`[portal-updates] skipped_noise ${w.key} ${unit.ref} ${decision.reason}`);
        } else {
          const res = await postEntry(d.db, { orgId: w.p.org_id, projectId: w.p.id }, decision.entry, unit);
          if (res.deduped) r.deduped++;
          else {
            r.posted++;
            already.refs.add(unit.ref);
            for (const c of unit.commits) if (c.sha) already.shas.add(c.sha);
            if (decision.entry.via === "fallback") { r.fallbacks++; console.warn(`[portal-updates] copy_fallback ${w.key} ${unit.ref} ${(decision.entry.issues ?? []).join("; ").slice(0, 200)}`); }
          }
        }
        // Advance only the matching cursor, after every unit: a cut-off run resumes here.
        if (unit.kind === "pr") cursor.last_merged_at = maxIso(cursor.last_merged_at, unit.occurredAt);
        else cursor.last_commit_at = maxIso(cursor.last_commit_at, unit.occurredAt);
        await saveCursor(d.db, cursor);
      }
      if (finished) { cursor.last_merged_at = nowIso; cursor.last_commit_at = nowIso; await saveCursor(d.db, cursor); r.reposDone++; } else r.partial = true;
    } catch (e) {
      r.errors++;
      console.error(`[portal-updates] repo_error ${w.key}: ${String((e as Error).message ?? e).slice(0, 300)}`);
      // Touch updated_at so one failing repo goes to the back of the queue instead of starving the rest.
      await saveCursor(d.db, cursor).catch(() => {});
    }
  }
  return r;
}
