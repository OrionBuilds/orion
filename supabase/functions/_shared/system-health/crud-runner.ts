/**
 * CRUD health-check runner.
 *
 * Talks to the database only through the small CrudDb interface, so the edge function plugs in
 * supabase-js clients (the caller's JWT for RLS mode, service role otherwise) and the tests plug
 * in an in-memory fake. Pure module — no runtime imports.
 *
 * Cleanup contract: every row this run inserts is recorded the moment the insert returns, and the
 * cleanup phase runs in a `finally` with the SERVICE-ROLE client (`admin`), so rows are removed even
 * when a step throws, RLS refuses the delete, or the read-back fails. A final tag sweep catches a
 * row whose insert succeeded but whose response was lost. Nothing outside this run's ids / tag is
 * ever updated or deleted.
 */

import type { CheckResult, CheckStatus, RunMode, StepName, StepResult } from './types.ts';
import {
  type BuildCtx,
  type CrudSpec,
  type EntitySpec,
  HEALTHCHECK_TAG_PREFIX,
  type Row,
  crudCheckId,
  makeTag,
  resolveOrder,
} from './crud-registry.ts';

export interface DbError {
  message: string;
  code?: string;
}
export interface DbResult<T> {
  data: T | null;
  error: DbError | null;
}

export interface CrudDb {
  /** Insert one row and return it. */
  insert(table: string, row: Row): Promise<DbResult<Row>>;
  /** Row by id, or data=null when not found / not visible. */
  selectById(table: string, id: string): Promise<DbResult<Row>>;
  /** Update by id and return the row, or data=null when 0 rows matched (e.g. RLS). */
  updateById(table: string, id: string, patch: Row): Promise<DbResult<Row>>;
  /** Delete by id; data = number of rows deleted. */
  deleteById(table: string, id: string): Promise<DbResult<number>>;
  /** Up to `limit` rows, scoped to the org when orgColumn is set. */
  list(table: string, columns: string, orgColumn: string | null, orgId: string, limit: number): Promise<DbResult<Row[]>>;
  /**
   * Delete rows whose tagColumn starts with `prefix` (org-scoped), optionally only rows created
   * before `createdBefore`. data = number of rows deleted.
   */
  deleteTagged(
    table: string,
    orgColumn: string | null,
    orgId: string,
    tagColumn: string,
    prefix: string,
    createdBefore?: string,
    createdColumn?: string,
  ): Promise<DbResult<number>>;
}

export interface CrudRunOptions {
  specs: EntitySpec[];
  /** Spec keys; dependencies are added automatically. Empty/undefined = all. */
  selected?: string[] | null;
  /** Client used for the checks themselves (caller JWT in RLS mode, service role otherwise). */
  db: CrudDb;
  /** Service-role client used for cleanup and sweeps. May be the same object as db. */
  admin: CrudDb;
  mode: RunMode;
  orgId: string;
  userId: string;
  runId: string;
  now?: () => number;
}

export interface CrudRunOutput {
  results: CheckResult[];
  cleanup: CheckResult;
}

interface Tracked {
  spec: CrudSpec;
  id: string;
  removed: boolean;
}

const RANK: Record<CheckStatus, number> = { skip: 0, pass: 1, warn: 2, fail: 3 };

export function worstStatus(statuses: CheckStatus[]): CheckStatus {
  if (statuses.length === 0) return 'skip';
  let worst: CheckStatus = 'skip';
  for (const s of statuses) if (RANK[s] > RANK[worst]) worst = s;
  return worst;
}

function errMsg(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (e && typeof e === 'object' && 'message' in e) return String((e as { message: unknown }).message);
  return String(e);
}

/** Never let a client throw past us: convert to a DbResult. */
async function safe<T>(fn: () => Promise<DbResult<T>>): Promise<DbResult<T>> {
  try {
    return await fn();
  } catch (e) {
    return { data: null, error: { message: errMsg(e) } };
  }
}

function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a === 'number' || typeof b === 'number') return Number(a) === Number(b);
  return JSON.stringify(a) === JSON.stringify(b);
}

function startsWithTag(value: unknown, tag: string): boolean {
  return typeof value === 'string' && value.startsWith(tag);
}

export async function runCrudSuite(opts: CrudRunOptions): Promise<CrudRunOutput> {
  const now = opts.now ?? (() => Date.now());
  const order = resolveOrder(opts.specs, opts.selected);
  const tag = makeTag(opts.runId);
  const ctx: BuildCtx = {
    orgId: opts.orgId,
    userId: opts.userId,
    runId: opts.runId,
    tag,
    slug: `healthcheck-${opts.runId}`,
    refs: {},
    nowIso: new Date(now()).toISOString(),
  };

  const steps = new Map<string, StepResult[]>();
  const errors = new Map<string, string>();
  const started = new Map<string, number>();
  const elapsed = new Map<string, number>();
  const skipped = new Map<string, string>();
  const tracked: Tracked[] = [];
  const auditRows: string[] = [];
  const cleanupErrors: string[] = [];
  const cleanupStart = { t: 0 };

  const add = (key: string, step: StepName, status: CheckStatus, t0: number, message?: string) => {
    const list = steps.get(key) ?? [];
    list.push({ step, status, durationMs: Math.max(0, now() - t0), message });
    steps.set(key, list);
    if ((status === 'fail' || status === 'warn') && message && !errors.has(key)) errors.set(key, `${step}: ${message}`);
  };
  const time = (key: string, t0: number) => elapsed.set(key, (elapsed.get(key) ?? 0) + Math.max(0, now() - t0));

  try {
    // ── Phase 1: create / read / update / audit, parents first ──────────────────────────────
    for (const spec of order) {
      const t0 = now();
      started.set(spec.key, t0);

      if (spec.kind === 'read') {
        const r = await safe(() => opts.db.list(spec.table, spec.columns, spec.orgColumn, opts.orgId, 5));
        if (r.error) add(spec.key, 'list', 'fail', t0, r.error.message);
        else if (!r.data || r.data.length === 0) add(spec.key, 'list', 'warn', t0, 'no rows visible');
        else add(spec.key, 'list', 'pass', t0, `${r.data.length} row(s) readable`);
        time(spec.key, t0);
        continue;
      }

      const missing = spec.dependsOn.filter((d) => !ctx.refs[d]);
      if (missing.length) {
        skipped.set(spec.key, `skipped: dependency ${missing.join(', ')} was not created`);
        continue;
      }

      // create
      let tc = now();
      const ins = await safe(() => opts.db.insert(spec.table, spec.build(ctx)));
      const id = ins.data && typeof ins.data.id === 'string' ? ins.data.id : null;
      if (ins.error || !id) {
        add(spec.key, 'create', 'fail', tc, ins.error?.message ?? 'insert returned no id');
        time(spec.key, t0);
        continue;
      }
      tracked.push({ spec, id, removed: false });
      ctx.refs[spec.key] = id;
      add(spec.key, 'create', 'pass', tc);

      // read
      tc = now();
      const rd = await safe(() => opts.db.selectById(spec.table, id));
      if (rd.error) add(spec.key, 'read', 'fail', tc, rd.error.message);
      else if (!rd.data) add(spec.key, 'read', 'fail', tc, 'row not visible after insert');
      else if (spec.tagColumn && !startsWithTag(rd.data[spec.tagColumn], tag)) {
        add(spec.key, 'read', 'fail', tc, `${spec.tagColumn} did not round-trip`);
      } else add(spec.key, 'read', 'pass', tc);

      // update
      if (spec.update) {
        tc = now();
        const want = spec.update.value(ctx);
        const up = await safe(() => opts.db.updateById(spec.table, id, { [spec.update!.column]: want }));
        const denyExpected = opts.mode === 'rls' && (spec.rlsDeny ?? []).includes('update');
        if (up.error) add(spec.key, 'update', denyExpected ? 'pass' : 'fail', tc, up.error.message);
        else if (!up.data) {
          if (denyExpected) add(spec.key, 'update', 'pass', tc, 'refused by RLS as expected');
          else add(spec.key, 'update', 'fail', tc, '0 rows updated (blocked by RLS or row missing)');
        } else if (denyExpected) {
          add(spec.key, 'update', 'fail', tc, 'update succeeded but RLS should refuse it');
        } else if (!sameValue(up.data[spec.update.column], want)) {
          add(spec.key, 'update', 'fail', tc, `${spec.update.column} not persisted`);
        } else add(spec.key, 'update', 'pass', tc);
      }

      // audit
      if (spec.audit === 'app') {
        tc = now();
        const a = await safe(() =>
          opts.db.insert('audit_logs', {
            organization_id: opts.orgId,
            user_id: opts.userId,
            action: `${tag} ${spec.key}.create`,
            entity_type: spec.table,
            entity_id: id,
            after_state: { healthcheck: true, run_id: opts.runId },
          }),
        );
        const auditId = a.data && typeof a.data.id === 'string' ? a.data.id : null;
        if (a.error || !auditId) add(spec.key, 'audit', 'fail', tc, a.error?.message ?? 'audit insert returned no id');
        else {
          auditRows.push(auditId);
          const back = await safe(() => opts.db.selectById('audit_logs', auditId));
          if (back.error || !back.data) add(spec.key, 'audit', 'fail', tc, back.error?.message ?? 'audit row not readable');
          else if (back.data.entity_id !== id) add(spec.key, 'audit', 'fail', tc, 'audit row entity_id mismatch');
          else add(spec.key, 'audit', 'pass', tc);
        }
      }
      time(spec.key, t0);
    }

    // ── Phase 2: delete / archive, children first ───────────────────────────────────────────
    for (const t of [...tracked].reverse()) {
      const spec = t.spec;
      const tc = now();
      if (spec.remove.mode === 'archive') {
        const patch = spec.remove.patch(ctx);
        const col = spec.remove.verifyColumn;
        const up = await safe(() => opts.db.updateById(spec.table, t.id, patch));
        if (up.error) add(spec.key, 'archive', 'fail', tc, up.error.message);
        else if (!up.data) add(spec.key, 'archive', 'fail', tc, '0 rows archived (blocked by RLS or row missing)');
        else if (!sameValue(up.data[col], patch[col])) add(spec.key, 'archive', 'fail', tc, `${col} not persisted`);
        else add(spec.key, 'archive', 'pass', tc);
      } else {
        const denyExpected = opts.mode === 'rls' && (spec.rlsDeny ?? []).includes('delete');
        const del = await safe(() => opts.db.deleteById(spec.table, t.id));
        if (del.error) {
          add(spec.key, 'delete', denyExpected ? 'pass' : 'fail', tc, del.error.message);
        } else if ((del.data ?? 0) === 0) {
          // 0 rows: either RLS refused it, or a cascade from an earlier delete already removed it.
          const still = await safe(() => opts.admin.selectById(spec.table, t.id));
          if (!still.error && !still.data) {
            t.removed = true;
            add(spec.key, 'delete', denyExpected ? 'warn' : 'pass', tc, 'already removed by cascade');
          } else if (denyExpected) add(spec.key, 'delete', 'pass', tc, 'refused by RLS as expected');
          else add(spec.key, 'delete', 'fail', tc, '0 rows deleted (blocked by RLS?)');
        } else if (denyExpected) {
          t.removed = true;
          add(spec.key, 'delete', 'fail', tc, 'delete succeeded but RLS should refuse it');
        } else {
          const gone = await safe(() => opts.db.selectById(spec.table, t.id));
          t.removed = true;
          if (gone.data) add(spec.key, 'delete', 'fail', tc, 'row still readable after delete');
          else add(spec.key, 'delete', 'pass', tc);
        }
      }
      time(spec.key, tc);
    }
  } catch (e) {
    // A bug in the runner itself; record it and fall through to cleanup.
    cleanupErrors.push(`runner aborted: ${errMsg(e)}`);
  } finally {
    // ── Phase 3: cleanup with the service-role client, always ───────────────────────────────
    cleanupStart.t = now();
    for (const t of [...tracked].reverse()) {
      if (t.removed) continue;
      const tc = now();
      const del = await safe(() => opts.admin.deleteById(t.spec.table, t.id));
      if (del.error) {
        cleanupErrors.push(`${t.spec.table} ${t.id}: ${del.error.message}`);
        add(t.spec.key, 'cleanup', 'fail', tc, del.error.message);
      } else {
        t.removed = true;
        add(t.spec.key, 'cleanup', 'pass', tc, (del.data ?? 0) === 0 ? 'already gone (cascade)' : 'removed by service role');
      }
    }
    for (const id of auditRows) {
      const del = await safe(() => opts.admin.deleteById('audit_logs', id));
      if (del.error) cleanupErrors.push(`audit_logs ${id}: ${del.error.message}`);
    }
    // Belt and braces: anything else carrying this run's tag (insert succeeded, response lost).
    const swept = await sweepTagged(opts.admin, opts.specs, opts.orgId, tag);
    cleanupErrors.push(...swept.errors);
  }

  const results: CheckResult[] = order.map((spec) => {
    const list = steps.get(spec.key) ?? [];
    const skip = skipped.get(spec.key);
    const status = skip ? 'skip' : worstStatus(list.map((s) => s.status));
    const okSteps = list.filter((s) => s.status === 'pass').map((s) => s.step);
    return {
      id: crudCheckId(spec.key),
      group: 'data',
      name: spec.label,
      status,
      durationMs: elapsed.get(spec.key) ?? 0,
      summary: skip ?? (status === 'pass' ? `${okSteps.join(' / ')} ok` : errors.get(spec.key) ?? status),
      error: status === 'fail' || status === 'warn' ? errors.get(spec.key) : undefined,
      details: { table: spec.table, module: spec.module, mode: opts.mode },
      steps: list,
    };
  });

  const leftovers = tracked.filter((t) => !t.removed).map((t) => `${t.spec.table}:${t.id}`);
  const cleanup: CheckResult = {
    id: 'crud.cleanup',
    group: 'data',
    name: 'Test data cleanup',
    status: cleanupErrors.length || leftovers.length ? 'fail' : 'pass',
    durationMs: Math.max(0, now() - cleanupStart.t),
    summary: cleanupErrors.length || leftovers.length
      ? `${leftovers.length} test row(s) could not be removed`
      : `${tracked.length} test row(s) and ${auditRows.length} audit row(s) removed`,
    error: cleanupErrors.length ? cleanupErrors.join('; ') : undefined,
    details: { tag, created: tracked.length, auditRows: auditRows.length, leftovers },
  };

  return { results, cleanup };
}

/**
 * Delete every row carrying `prefix` in its tag column, children before parents (reverse registry
 * order, which respects ON DELETE RESTRICT such as opportunities -> pipelines).
 */
export async function sweepTagged(
  admin: CrudDb,
  specs: EntitySpec[],
  orgId: string,
  prefix: string,
  createdBefore?: string,
): Promise<{ deleted: number; errors: string[] }> {
  if (!prefix.startsWith(HEALTHCHECK_TAG_PREFIX)) {
    // Refuse to sweep anything that is not a health-check tag, whatever the caller passed.
    return { deleted: 0, errors: [`refused to sweep non-healthcheck prefix "${prefix}"`] };
  }
  let deleted = 0;
  const errors: string[] = [];
  for (const spec of [...specs].reverse()) {
    if (spec.kind !== 'crud' || !spec.tagColumn) continue;
    // Tables without an org column are only swept via their (tagged, org-scoped) parent.
    if (!spec.orgColumn) continue;
    const r = await safe(() =>
      admin.deleteTagged(spec.table, spec.orgColumn, orgId, spec.tagColumn!, prefix, createdBefore, spec.createdColumn ?? 'created_at'),
    );
    if (r.error) errors.push(`sweep ${spec.table}: ${r.error.message}`);
    else deleted += r.data ?? 0;
  }
  return { deleted, errors };
}
