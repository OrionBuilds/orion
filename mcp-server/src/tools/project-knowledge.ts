import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { restGet, restRpc } from '../helpers/rest-client.js';
import { toolResult, toolError } from '../helpers/tool-utils.js';

/**
 * Project knowledge (contract: project-knowledge-contract.md, kept outside this repo). Per-project notes about
 * what the code is, written by FRIDAY from diffs and read before each run. Reads go through RLS
 * (agents + the org owner only); writes go through SECURITY DEFINER RPCs bound to the caller.
 */

const INDEX_COLUMNS =
  'slug,kind,title,summary,covers,depends_on,repo_url,stale,stale_reason,auto_update,source,last_synced_commit,last_synced_at,version,body';

/** Translate a repo-relative glob (`*` in a segment, `**` across segments, `?` one char) to a RegExp. Pure. */
export function globToRegExp(glob: string): RegExp {
  const g = glob.trim().replace(/^\.\//, '').replace(/^\/+/, '');
  let re = '';
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === '*') {
      if (g[i + 1] === '*') {
        i++;
        if (g[i + 1] === '/') { i++; re += '(?:.*/)?'; } else re += '.*';
      } else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}

export function normalizePath(p: string): string {
  return p.trim().replace(/^\.\//, '').replace(/^\/+/, '');
}

export function noteCoversFile(covers: string[] | null | undefined, file: string): boolean {
  const f = normalizePath(file);
  return (covers ?? []).some((g) => g.trim() && globToRegExp(g).test(f));
}

type Row = Record<string, unknown> & { body?: string; covers?: string[]; kind?: string; slug?: string };

/** Shape a table row into the contract's index row (no body, body_bytes instead). Pure. */
export function shapeIndexRow(r: Row): Record<string, unknown> {
  const { body, ...rest } = r;
  return { ...rest, body_bytes: Buffer.byteLength(String(body ?? ''), 'utf8') };
}

const KIND_ORDER: Record<string, number> = { overview: 0, module: 1, concern: 2 };
export function sortNotes<T extends Row>(rows: T[]): T[] {
  return [...rows].sort((a, b) =>
    (KIND_ORDER[a.kind ?? ''] ?? 9) - (KIND_ORDER[b.kind ?? ''] ?? 9) || String(a.slug).localeCompare(String(b.slug)));
}

/** Notes that a given set of slugs and/or files selects, once each; plus files nothing covers. Pure. */
export function selectNotes<T extends Row>(rows: T[], slugs: string[] | undefined, files: string[] | undefined) {
  const wanted = new Set(slugs ?? []);
  const picked = new Map<string, T>();
  const covered = new Set<string>();
  for (const r of rows) {
    if (wanted.has(String(r.slug))) picked.set(`${r.repo_url}|${r.slug}`, r);
    for (const f of files ?? []) {
      if (noteCoversFile(r.covers, f)) {
        picked.set(`${r.repo_url}|${r.slug}`, r);
        covered.add(f);
      }
    }
  }
  return { notes: sortNotes([...picked.values()]), unmatched_files: (files ?? []).filter((f) => !covered.has(f)) };
}

async function loadNotes(projectId: string, repoUrl?: string): Promise<Row[]> {
  const filters: Record<string, string> = { project_id: `eq.${projectId}` };
  if (repoUrl !== undefined) filters.repo_url = `eq.${repoUrl}`;
  return ((await restGet('project_knowledge', { select: INDEX_COLUMNS, filters, limit: 500 })) as Row[]) ?? [];
}

export function registerProjectKnowledgeTools(server: McpServer): void {
  server.tool(
    'project_knowledge_index',
    'List the knowledge notes of a project without their bodies (slug, kind, title, one-line summary, covers globs, stale flag, auto_update, source, last synced commit) plus the per-repo sync state (last commit, last run, uncovered files, lock). Overview note first. Agents and the org owner only.',
    { project_id: z.string().uuid(), repo_url: z.string().max(500).optional() },
    async (p) => {
      try {
        const [rows, sync] = await Promise.all([
          loadNotes(p.project_id, p.repo_url),
          restGet('project_knowledge_sync', {
            select: 'repo_url,last_synced_commit,last_run_at,last_status,last_error,lock_until,uncovered_files',
            filters: { project_id: `eq.${p.project_id}`, ...(p.repo_url !== undefined ? { repo_url: `eq.${p.repo_url}` } : {}) },
          }),
        ]);
        return toolResult({ project_id: p.project_id, notes: sortNotes(rows).map(shapeIndexRow), sync: sync ?? [] });
      } catch (e) {
        return toolError(e);
      }
    },
  );

  server.tool(
    'project_knowledge_get',
    'Get knowledge notes WITH bodies, by slugs and/or by files (reverse lookup: every note whose covers glob matches a file; unmatched_files lists files no note covers). At least one of slugs/files.',
    {
      project_id: z.string().uuid(),
      repo_url: z.string().max(500).optional(),
      slugs: z.array(z.string().max(120)).max(20).optional(),
      files: z.array(z.string().max(500)).max(200).optional(),
    },
    async (p) => {
      try {
        if (!p.slugs?.length && !p.files?.length) throw new Error('give slugs and/or files');
        const rows = await loadNotes(p.project_id, p.repo_url);
        const { notes, unmatched_files } = selectNotes(rows, p.slugs, p.files);
        return toolResult({ project_id: p.project_id, notes, unmatched_files });
      } catch (e) {
        return toolError(e);
      }
    },
  );

  server.tool(
    'project_knowledge_upsert',
    'Create or update one knowledge note (idempotent by project + repo + slug). Body max 12 KB, summary max 300 chars; credential-like content is rejected. A note a human edited (or with auto_update off) is frozen: returns { skipped: "frozen" } and changes nothing. Returns { id, created, version }.',
    {
      project_id: z.string().uuid(),
      repo_url: z.string().max(500).optional(),
      slug: z.string().regex(/^[a-z0-9][a-z0-9._/-]{0,119}$/),
      kind: z.enum(['overview', 'module', 'concern']),
      title: z.string().min(1).max(200),
      summary: z.string().max(300),
      body: z.string().max(12288),
      covers: z.array(z.string().max(300)).max(100).optional(),
      depends_on: z.array(z.string().max(120)).max(50).optional(),
      commit: z.string().max(80).optional(),
      clear_stale: z.boolean().optional(),
    },
    async (p) => {
      try {
        return toolResult(await restRpc('project_knowledge_upsert', {
          p_project_id: p.project_id,
          p_repo_url: p.repo_url ?? '',
          p_slug: p.slug,
          p_kind: p.kind,
          p_title: p.title,
          p_summary: p.summary,
          p_body: p.body,
          p_covers: p.covers ?? [],
          p_depends_on: p.depends_on ?? [],
          p_commit: p.commit ?? null,
          p_clear_stale: p.clear_stale ?? true,
        }));
      } catch (e) {
        return toolError(e);
      }
    },
  );

  server.tool(
    'project_knowledge_mark_stale',
    'Mark notes stale (the code they describe changed too much to patch). Returns { marked }.',
    {
      project_id: z.string().uuid(),
      repo_url: z.string().max(500).optional(),
      slugs: z.array(z.string().max(120)).min(1).max(100),
      reason: z.string().max(300),
    },
    async (p) => {
      try {
        return toolResult(await restRpc('project_knowledge_mark_stale', {
          p_project_id: p.project_id, p_repo_url: p.repo_url ?? '', p_slugs: p.slugs, p_reason: p.reason,
        }));
      } catch (e) {
        return toolError(e);
      }
    },
  );

  server.tool(
    'project_knowledge_sync_state',
    'Read or update the sync bookkeeping for a project repo: take/release the updater lock (acquire_lock_minutes returns lock_acquired false when another updater holds it), record the last synced commit/status/error, and the files no note covers. With no patch fields it just reads. Returns the state row.',
    {
      project_id: z.string().uuid(),
      repo_url: z.string().max(500).optional(),
      acquire_lock_minutes: z.number().int().min(1).max(120).optional(),
      release_lock: z.boolean().optional(),
      last_synced_commit: z.string().max(80).optional(),
      last_status: z.enum(['ok', 'partial', 'error', 'skipped']).optional(),
      last_error: z.string().max(1000).nullable().optional(),
      uncovered_files: z.array(z.string().max(500)).max(500).optional(),
    },
    async (p) => {
      try {
        return toolResult(await restRpc('project_knowledge_sync_state', {
          p_project_id: p.project_id,
          p_repo_url: p.repo_url ?? '',
          p_acquire_lock_minutes: p.acquire_lock_minutes ?? null,
          p_release_lock: p.release_lock ?? false,
          p_last_synced_commit: p.last_synced_commit ?? null,
          p_last_status: p.last_status ?? null,
          p_last_error: p.last_error ?? null,
          p_set_error: p.last_error !== undefined,
          p_uncovered_files: p.uncovered_files ?? null,
        }));
      } catch (e) {
        return toolError(e);
      }
    },
  );
}
