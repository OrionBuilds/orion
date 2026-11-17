import { supabase } from '../lib/supabase';
import type { AIUsageLog, AIUsageMetrics, AIUsageLogFilters, ExportFormat } from '../types';

export interface PaginatedLogs {
  data: AIUsageLog[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}


/**
 * The Usage & Logs tab shows ai_call_usage: the table every metered model call (CLARA, FRIDAY, the OS, Jason)
 * is actually written to. It used to read ai_usage_logs, which nothing ever wrote to, so the tab was always empty.
 */
interface CallUsageRow {
  id: string;
  org_id: string;
  agent: string | null;
  agent_user_id: string | null;
  provider: string | null;
  model: string | null;
  source: string | null;
  purpose: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  cost_usd: number | null;
  task_ref: string | null;
  run_id: string | null;
  status: string | null;
  error_message?: string | null;
  duration_ms: number | null;
  created_at: string;
}

const titleCase = (s: string) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : 'Unknown');

export function mapCallUsage(r: CallUsageRow): AIUsageLog {
  const failed = r.status === 'error';
  const where = [r.provider, r.model].filter(Boolean).join(' ');
  return {
    id: r.id,
    org_id: r.org_id,
    agent_id: null,
    agent_name: titleCase(r.agent || ''),
    user_id: r.agent_user_id,
    user_name: null,
    model_key: r.model || 'unknown',
    action_summary: r.purpose || r.source || 'Model call',
    status: failed ? 'failed' : 'success',
    error_message: failed ? (r.error_message || `Model call failed${where ? ` (${where})` : ''}`) : null,
    duration_ms: r.duration_ms ?? 0,
    input_tokens: r.input_tokens,
    output_tokens: r.output_tokens,
    metadata: { provider: r.provider, source: r.source, cost_usd: r.cost_usd, task_ref: r.task_ref, run_id: r.run_id },
    created_at: r.created_at,
  };
}

const CALL_USAGE_COLUMNS =
  'id, org_id, agent, agent_user_id, provider, model, source, purpose, input_tokens, output_tokens, cost_usd, task_ref, run_id, status, error_message, duration_ms, created_at';

/** Maps the tab's filters onto ai_call_usage columns (agent slug, ok/error status). */
interface Filterable<Q> {
  gte(column: string, value: string): Q;
  lte(column: string, value: string): Q;
  in(column: string, values: string[]): Q;
  eq(column: string, value: string): Q;
  or(filters: string): Q;
}

/** The ai_call_usage agent slugs for the agents picked in the filter (null when none are picked). */
async function agentSlugsFor(filters: AIUsageLogFilters): Promise<string[] | null> {
  if (!filters.agentIds || filters.agentIds.length === 0) return null;
  const { data } = await supabase.from('ai_agents').select('name').in('id', filters.agentIds);
  const slugs = (data || []).map((a: { name: string }) => a.name.toLowerCase());
  return slugs.length ? slugs : ['__none__'];
}

function applyFilters<Q extends Filterable<Q>>(query: Q, filters: AIUsageLogFilters, agentSlugs: string[] | null): Q {
  let q = query;
  if (filters.startDate) q = q.gte('created_at', filters.startDate);
  if (filters.endDate) q = q.lte('created_at', filters.endDate);
  if (agentSlugs) q = q.in('agent', agentSlugs);
  if (filters.userIds && filters.userIds.length > 0) q = q.in('agent_user_id', filters.userIds);
  if (filters.status) q = q.eq('status', filters.status === 'failed' ? 'error' : 'ok');
  if (filters.search) {
    const t = filters.search.replace(/[,()%]/g, ' ').trim();
    if (t) q = q.or(`purpose.ilike.%${t}%,agent.ilike.%${t}%,source.ilike.%${t}%`);
  }
  return q;
}

export async function getUsageMetrics(
  orgId: string,
  startDate: string,
  endDate: string
): Promise<AIUsageMetrics> {
  const { data: logs, error } = await supabase
    .from('ai_call_usage')
    .select(CALL_USAGE_COLUMNS)
    .eq('org_id', orgId)
    .gte('created_at', startDate)
    .lte('created_at', endDate)
    .limit(5000);

  if (error) throw error;

  const allLogs = ((logs || []) as CallUsageRow[]).map(mapCallUsage);
  const successfulLogs = allLogs.filter(l => l.status === 'success');
  const failedLogs = allLogs.filter(l => l.status === 'failed');

  const agentCounts = new Map<string, number>();
  const modelCounts = new Map<string, number>();
  const dayCounts = new Map<string, number>();

  let totalDuration = 0;
  let totalInputTokens = 0;
  let totalOutputTokens = 0;

  allLogs.forEach(log => {
    agentCounts.set(log.agent_name, (agentCounts.get(log.agent_name) || 0) + 1);
    modelCounts.set(log.model_key, (modelCounts.get(log.model_key) || 0) + 1);

    const day = log.created_at.split('T')[0];
    dayCounts.set(day, (dayCounts.get(day) || 0) + 1);

    totalDuration += log.duration_ms || 0;
    totalInputTokens += log.input_tokens || 0;
    totalOutputTokens += log.output_tokens || 0;
  });

  return {
    total_runs: allLogs.length,
    successful_runs: successfulLogs.length,
    failed_runs: failedLogs.length,
    success_rate: allLogs.length > 0 ? (successfulLogs.length / allLogs.length) * 100 : 100,
    error_rate: allLogs.length > 0 ? (failedLogs.length / allLogs.length) * 100 : 0,
    avg_duration_ms: allLogs.length > 0 ? Math.round(totalDuration / allLogs.length) : 0,
    total_input_tokens: totalInputTokens,
    total_output_tokens: totalOutputTokens,
    runs_by_agent: Array.from(agentCounts.entries())
      .map(([agent_name, count]) => ({ agent_name, count }))
      .sort((a, b) => b.count - a.count),
    runs_by_model: Array.from(modelCounts.entries())
      .map(([model_key, count]) => ({ model_key, count }))
      .sort((a, b) => b.count - a.count),
    runs_by_day: Array.from(dayCounts.entries())
      .map(([date, count]) => ({ date, count }))
      .sort((a, b) => a.date.localeCompare(b.date)),
  };
}

export async function getUsageLogs(
  orgId: string,
  filters: AIUsageLogFilters,
  page: number = 1,
  pageSize: number = 50
): Promise<PaginatedLogs> {
  let query = supabase
    .from('ai_call_usage')
    .select(CALL_USAGE_COLUMNS, { count: 'exact' })
    .eq('org_id', orgId)
    .order('created_at', { ascending: false });
  query = applyFilters(query, filters, await agentSlugsFor(filters));

  const from = (page - 1) * pageSize;
  const to = from + pageSize - 1;
  query = query.range(from, to);

  const { data, error, count } = await query;

  if (error) throw error;

  const total = count || 0;
  const totalPages = Math.ceil(total / pageSize);

  return {
    data: ((data || []) as CallUsageRow[]).map(mapCallUsage),
    total,
    page,
    pageSize,
    totalPages,
  };
}

export async function exportLogsCSV(
  orgId: string,
  filters: AIUsageLogFilters
): Promise<string> {
  const logs = await getAllLogsForExport(orgId, filters);

  const headers = [
    'Timestamp',
    'Agent Name',
    'User',
    'Model',
    'Action',
    'Status',
    'Duration (ms)',
    'Input Tokens',
    'Output Tokens',
    'Error Message',
  ];

  const rows = logs.map(log => [
    log.created_at,
    escapeCSV(log.agent_name),
    escapeCSV(log.user_name || ''),
    escapeCSV(log.model_key),
    escapeCSV(log.action_summary),
    log.status,
    log.duration_ms.toString(),
    (log.input_tokens || '').toString(),
    (log.output_tokens || '').toString(),
    escapeCSV(log.error_message || ''),
  ]);

  return [headers.join(','), ...rows.map(row => row.join(','))].join('\n');
}

export async function exportLogsJSON(
  orgId: string,
  filters: AIUsageLogFilters
): Promise<string> {
  const logs = await getAllLogsForExport(orgId, filters);

  const exportData = logs.map(log => ({
    timestamp: log.created_at,
    agent_name: log.agent_name,
    agent_id: log.agent_id,
    user_name: log.user_name,
    user_id: log.user_id,
    model: log.model_key,
    action: log.action_summary,
    status: log.status,
    duration_ms: log.duration_ms,
    input_tokens: log.input_tokens,
    output_tokens: log.output_tokens,
    error_message: log.error_message,
    metadata: log.metadata,
  }));

  return JSON.stringify(exportData, null, 2);
}

async function getAllLogsForExport(
  orgId: string,
  filters: AIUsageLogFilters
): Promise<AIUsageLog[]> {
  let query = supabase
    .from('ai_call_usage')
    .select(CALL_USAGE_COLUMNS)
    .eq('org_id', orgId)
    .order('created_at', { ascending: false })
    .limit(10000);
  query = applyFilters(query, filters, await agentSlugsFor(filters));

  const { data, error } = await query;

  if (error) throw error;
  return ((data || []) as CallUsageRow[]).map(mapCallUsage);
}

function escapeCSV(value: string): string {
  if (value.includes(',') || value.includes('"') || value.includes('\n')) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

export async function createUsageLog(
  orgId: string,
  input: {
    agent_id: string | null;
    agent_name: string;
    user_id: string | null;
    user_name?: string;
    model_key: string;
    action_summary: string;
    status: 'success' | 'failed';
    error_message?: string;
    duration_ms: number;
    input_tokens?: number;
    output_tokens?: number;
    metadata?: Record<string, unknown>;
  }
): Promise<AIUsageLog> {
  const { data, error } = await supabase
    .from('ai_usage_logs')
    .insert({
      org_id: orgId,
      ...input,
    })
    .select('*')
    .single();

  if (error) throw error;
  return data;
}

export interface FailingSource {
  source: string;
  agent: string | null;
  calls: number;
  errors: number;
  error_rate: number;
  last_error_at: string | null;
  last_error_message: string | null;
}

/** Sources whose recent model calls mostly fail (48h, at least 3 calls, 80%+ failing), worst first. */
export async function getFailingSources(orgId: string): Promise<FailingSource[]> {
  const { data, error } = await supabase.rpc('ai_failing_sources', { p_org: orgId });
  if (error) throw error;
  return ((data || []) as Array<Omit<FailingSource, 'error_rate'> & { error_rate: number | string }>).map((r) => ({
    ...r,
    error_rate: Number(r.error_rate),
  }));
}
