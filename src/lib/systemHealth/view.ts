import type {
  CheckCatalogueEntry,
  CheckGroup,
  CheckResult,
  CheckStatus,
} from '../../../supabase/functions/_shared/system-health/types';

export type RowStatus = CheckStatus | 'not_run';

export interface CheckRowView {
  id: string;
  name: string;
  description?: string;
  status: RowStatus;
  result?: CheckResult;
  /** Dynamic child of a catalogue entry (e.g. one cron job under "Cron jobs"). */
  child: boolean;
}

/**
 * Merge a new run's results into what the page already shows.
 *
 * A group that ran in full replaces every previous result in that group (so a check that
 * disappeared — a deleted cron job, a disconnected account — does not linger). A partial run
 * (single CRUD entity) replaces only the ids it returned.
 */
export function mergeResults(
  previous: CheckResult[],
  next: CheckResult[],
  fullGroups: CheckGroup[],
): CheckResult[] {
  const nextIds = new Set(next.map((r) => r.id));
  const kept = previous.filter((r) => !fullGroups.includes(r.group) && !nextIds.has(r.id));
  return [...kept, ...next];
}

/** Catalogue rows for a group, each with its latest result, dynamic children after their parent. */
export function buildGroupView(
  catalogue: CheckCatalogueEntry[],
  results: CheckResult[],
  group: CheckGroup,
): CheckRowView[] {
  const entries = catalogue.filter((c) => c.group === group);
  const groupResults = results.filter((r) => r.group === group);
  const byId = new Map(groupResults.map((r) => [r.id, r]));
  const used = new Set<string>();
  const rows: CheckRowView[] = [];

  for (const e of entries) {
    const r = byId.get(e.id);
    if (r) used.add(r.id);
    const children = groupResults
      .filter((x) => x.id.startsWith(`${e.id}.`) && !entries.some((o) => o.id === x.id))
      .sort((a, b) => a.name.localeCompare(b.name));
    // A parent with children but no own result (e.g. per-connection Google rows) shows the worst child.
    const status: RowStatus = r ? r.status : children.length ? worst(children.map((c) => c.status)) : 'not_run';
    rows.push({ id: e.id, name: e.name, description: e.description, status, result: r, child: false });
    for (const c of children) {
      used.add(c.id);
      rows.push({ id: c.id, name: c.name, status: c.status, result: c, child: true });
    }
  }
  for (const r of groupResults) {
    if (!used.has(r.id)) rows.push({ id: r.id, name: r.name, status: r.status, result: r, child: false });
  }
  return rows;
}

const RANK: Record<CheckStatus, number> = { skip: 0, pass: 1, warn: 2, fail: 3 };

export function worst(statuses: CheckStatus[]): CheckStatus {
  return statuses.reduce<CheckStatus>((w, s) => (RANK[s] > RANK[w] ? s : w), 'skip');
}

export function countStatuses(rows: Pick<CheckRowView, 'status'>[]): Record<RowStatus, number> {
  const c: Record<RowStatus, number> = { pass: 0, warn: 0, fail: 0, skip: 0, not_run: 0 };
  for (const r of rows) c[r.status]++;
  return c;
}

/** True while any agent ping result says it is still waiting for pickup. */
export function hasPendingPing(results: CheckResult[]): boolean {
  return results.some((r) => /^agents\.[^.]+\.ping$/.test(r.id) && (r.details as { pending?: boolean } | undefined)?.pending === true);
}
