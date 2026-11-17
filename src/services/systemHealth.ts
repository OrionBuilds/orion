import { supabase } from '../lib/supabase';
import type {
  CheckCatalogueEntry,
  CheckGroup,
  CheckResult,
  HealthRunReport,
  RunMode,
} from '../../supabase/functions/_shared/system-health/types';

export type { CheckCatalogueEntry, CheckGroup, CheckResult, HealthRunReport, RunMode };

export interface HealthRunRow {
  id: string;
  started_at: string;
  finished_at: string | null;
  duration_ms: number | null;
  mode: RunMode;
  groups: CheckGroup[];
  status: 'pass' | 'warn' | 'fail';
  pass_count: number;
  warn_count: number;
  fail_count: number;
  skip_count: number;
  triggered_by: string | null;
}

async function invoke<T>(body: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabase.functions.invoke('system-health', { body });
  if (error) {
    // FunctionsHttpError carries the response; surface the function's own message when present.
    const ctx = (error as { context?: Response }).context;
    if (ctx && typeof ctx.json === 'function') {
      const payload = await ctx.json().catch(() => null);
      if (payload?.error) throw new Error(String(payload.error));
    }
    throw new Error(error.message);
  }
  return data as T;
}

export function runHealthChecks(opts: { mode: RunMode; groups?: CheckGroup[]; checks?: string[] }): Promise<HealthRunReport> {
  return invoke<HealthRunReport>({ action: 'run', ...opts });
}

export async function pingAgents(): Promise<CheckResult[]> {
  const res = await invoke<{ results: CheckResult[] }>({ action: 'agent_ping' });
  return res.results ?? [];
}

/** Recent runs for the active org (RLS: SuperAdmins only). Empty when the table is not migrated yet. */
export async function listHealthRuns(limit = 25): Promise<{ rows: HealthRunRow[]; unavailable: boolean }> {
  const { data, error } = await supabase
    .from('system_health_runs')
    .select('id, started_at, finished_at, duration_ms, mode, groups, status, pass_count, warn_count, fail_count, skip_count, triggered_by')
    .order('started_at', { ascending: false })
    .limit(limit);
  if (error) return { rows: [], unavailable: true };
  return { rows: (data ?? []) as HealthRunRow[], unavailable: false };
}

export async function getHealthRunResults(id: string): Promise<CheckResult[]> {
  const { data, error } = await supabase.from('system_health_runs').select('results').eq('id', id).maybeSingle();
  if (error) throw error;
  return ((data?.results as CheckResult[] | undefined) ?? []);
}

/** Download the current view as JSON (results already contain no secrets). */
export function downloadJson(filename: string, payload: unknown): void {
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
