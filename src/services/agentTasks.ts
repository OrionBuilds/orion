import { supabase } from '../lib/supabase';

/**
 * Agent Tasks control plane (OS is source of truth). CRUD over agent_task_schedules +
 * read access to agent_task_runs. Schedule cadence math is delegated to the
 * agent_task_next_run_at() SQL function so the app and the claim RPC never disagree.
 * See migration 20260730045337_agent_task_scheduling_backbone.sql.
 */

export type AgentSlug = 'clara' | 'friday';
export type Cadence = 'hourly' | 'daily' | 'weekly' | 'monthly' | 'custom_cron';
export type RiskTier = 'autonomous' | 'owner_review' | 'client_visible';
export type OutputKind = 'owner_briefing' | 'client_deliverable' | 'housekeeping_report' | 'none';
export type ScheduleMode = 'off' | 'shadow' | 'active';
export type RunStatus =
  | 'claimed' | 'running' | 'awaiting_approval' | 'approved' | 'rejected'
  | 'completed' | 'failed' | 'expired_lease';

export interface AgentTaskSchedule {
  id: string;
  org_id: string;
  agent_user_id: string;
  agent_slug: AgentSlug;
  task_key: string;
  subject_id: string | null;
  title: string;
  description: string | null;
  cadence: Cadence;
  time_of_day: string | null;
  days_of_week: number[] | null;
  day_of_month: number | null;
  custom_cron: string | null;
  timezone: string;
  next_run_at: string;
  last_run_at: string | null;
  risk_tier: RiskTier;
  output_kind: OutputKind;
  approval_required: boolean;
  mode: ScheduleMode;
  catch_up_policy: 'skip' | 'run_once';
  max_runtime_minutes: number;
  config: Record<string, unknown>;
  created_by_user_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface AgentTaskRun {
  id: string;
  org_id: string;
  schedule_id: string;
  agent_user_id: string;
  scheduled_for: string;
  status: RunStatus;
  mode_at_run: 'shadow' | 'active';
  attempt: number;
  claimed_at: string;
  lease_expires_at: string;
  started_at: string | null;
  finished_at: string | null;
  delivered_at: string | null;
  result_summary: string | null;
  result: Record<string, unknown>;
  error: string | null;
  approval_id: string | null;
  deliverable_file_id: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * An operational warning an agent raised during a run. Agents write these into
 * `agent_task_runs.result.alerts[]` — the run itself still completes, so run status alone
 * never reveals them. Before this was surfaced, the only place a broken agent showed up
 * was an SMS-style digest in Conversations, indistinguishable from a customer message.
 */
export interface AgentAlert {
  kind: string;
  text: string;
  priority?: string;
  dedupeKey?: string;
  clientId?: string;
  accountId?: string;
  /** Joined in from the parent run. */
  agentUserId: string;
  runFinishedAt: string | null;
}

/** Pull recent agent-raised alerts out of run results, newest first, de-duplicated. */
export async function getRecentAgentAlerts(orgId: string, limit = 200): Promise<AgentAlert[]> {
  const { data, error } = await supabase
    .from('agent_task_runs')
    .select('agent_user_id, finished_at, result')
    .eq('org_id', orgId)
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) throw error;

  const seen = new Set<string>();
  const alerts: AgentAlert[] = [];

  for (const run of data ?? []) {
    const raw = (run.result as Record<string, unknown> | null)?.alerts;
    if (!Array.isArray(raw)) continue;
    for (const a of raw) {
      if (!a || typeof a !== 'object') continue;
      const alert = a as Record<string, unknown>;
      const text = typeof alert.text === 'string' ? alert.text : null;
      if (!text) continue;
      // Agents already emit a dedupeKey for repeat conditions; fall back to the text.
      const key = typeof alert.dedupeKey === 'string' ? alert.dedupeKey : text;
      if (seen.has(key)) continue;
      seen.add(key);
      alerts.push({
        kind: typeof alert.kind === 'string' ? alert.kind : 'alert',
        text,
        priority: typeof alert.priority === 'string' ? alert.priority : undefined,
        dedupeKey: typeof alert.dedupeKey === 'string' ? alert.dedupeKey : undefined,
        clientId: typeof alert.clientId === 'string' ? alert.clientId : undefined,
        accountId: typeof alert.accountId === 'string' ? alert.accountId : undefined,
        agentUserId: run.agent_user_id,
        runFinishedAt: run.finished_at,
      });
    }
  }

  return alerts;
}

export interface ScheduleCadenceInput {
  cadence: Cadence;
  time_of_day?: string | null;
  days_of_week?: number[] | null;
  day_of_month?: number | null;
  timezone?: string;
}

export type CreateScheduleInput = ScheduleCadenceInput & {
  org_id: string;
  agent_user_id: string;
  agent_slug: AgentSlug;
  task_key: string;
  title: string;
  subject_id?: string | null;
  description?: string | null;
  risk_tier: RiskTier;
  output_kind?: OutputKind;
  approval_required?: boolean;
  mode?: ScheduleMode;
  config?: Record<string, unknown>;
  created_by_user_id?: string | null;
};

/** Compute the next fire instant for a cadence via the canonical SQL function. */
export async function computeNextRunAt(input: ScheduleCadenceInput, from?: string): Promise<string> {
  const { data, error } = await supabase.rpc('agent_task_next_run_at', {
    p_cadence: input.cadence,
    p_time_of_day: input.time_of_day ?? null,
    p_days_of_week: input.days_of_week ?? null,
    p_day_of_month: input.day_of_month ?? null,
    p_timezone: input.timezone ?? 'America/New_York',
    p_from: from ?? new Date().toISOString(),
  });
  if (error) throw error;
  return data as string;
}

export async function listSchedules(opts?: { agentSlug?: AgentSlug; includeOff?: boolean }): Promise<AgentTaskSchedule[]> {
  let q = supabase.from('agent_task_schedules').select('*').order('next_run_at', { ascending: true });
  if (opts?.agentSlug) q = q.eq('agent_slug', opts.agentSlug);
  if (!opts?.includeOff) q = q.neq('mode', 'off');
  const { data, error } = await q;
  if (error) throw error;
  return (data ?? []) as AgentTaskSchedule[];
}

export async function listAllSchedules(): Promise<AgentTaskSchedule[]> {
  return listSchedules({ includeOff: true });
}

export async function createSchedule(input: CreateScheduleInput): Promise<AgentTaskSchedule> {
  const next_run_at = await computeNextRunAt(input);
  const clientVisible = input.risk_tier === 'client_visible';
  const { data, error } = await supabase
    .from('agent_task_schedules')
    .insert({
      org_id: input.org_id,
      agent_user_id: input.agent_user_id,
      agent_slug: input.agent_slug,
      task_key: input.task_key,
      subject_id: input.subject_id ?? null,
      title: input.title,
      description: input.description ?? null,
      cadence: input.cadence,
      time_of_day: input.time_of_day ?? null,
      days_of_week: input.days_of_week ?? null,
      day_of_month: input.day_of_month ?? null,
      timezone: input.timezone ?? 'America/New_York',
      next_run_at,
      risk_tier: input.risk_tier,
      output_kind: input.output_kind ?? 'none',
      approval_required: clientVisible ? true : (input.approval_required ?? false),
      mode: input.mode ?? 'shadow',
      config: input.config ?? {},
      created_by_user_id: input.created_by_user_id ?? null,
    })
    .select('*')
    .single();
  if (error) throw error;
  return data as AgentTaskSchedule;
}

/** Update mutable fields; if any cadence field changes, next_run_at is recomputed. */
export async function updateSchedule(
  id: string,
  patch: Partial<CreateScheduleInput>,
): Promise<AgentTaskSchedule> {
  const body: Record<string, unknown> = { ...patch, updated_at: new Date().toISOString() };
  const cadenceTouched =
    patch.cadence !== undefined || patch.time_of_day !== undefined ||
    patch.days_of_week !== undefined || patch.day_of_month !== undefined ||
    patch.timezone !== undefined;
  if (cadenceTouched) {
    const current = (await supabase.from('agent_task_schedules').select('*').eq('id', id).single()).data as AgentTaskSchedule;
    body.next_run_at = await computeNextRunAt({
      cadence: (patch.cadence ?? current.cadence) as Cadence,
      time_of_day: patch.time_of_day ?? current.time_of_day,
      days_of_week: patch.days_of_week ?? current.days_of_week,
      day_of_month: patch.day_of_month ?? current.day_of_month,
      timezone: patch.timezone ?? current.timezone,
    });
  }
  if (patch.risk_tier === 'client_visible') body.approval_required = true;
  const { data, error } = await supabase
    .from('agent_task_schedules').update(body).eq('id', id).select('*').single();
  if (error) throw error;
  return data as AgentTaskSchedule;
}

export async function setScheduleMode(id: string, mode: ScheduleMode): Promise<void> {
  const { error } = await supabase
    .from('agent_task_schedules')
    .update({ mode, updated_at: new Date().toISOString() })
    .eq('id', id);
  if (error) throw error;
}

/**
 * Force a schedule due immediately by rewinding next_run_at to now() (org RLS permits the
 * update). The agent's next poll (≤60s) claims the run, and claim_due_agent_task_runs()
 * advances next_run_at back onto the normal cadence — no drift.
 */
export async function runNow(id: string): Promise<void> {
  const { error } = await supabase
    .from('agent_task_schedules')
    .update({ next_run_at: new Date().toISOString(), updated_at: new Date().toISOString() })
    .eq('id', id);
  if (error) throw error;
}

export async function deleteSchedule(id: string): Promise<void> {
  const { error } = await supabase.from('agent_task_schedules').delete().eq('id', id);
  if (error) throw error;
}

export async function listRuns(opts?: { scheduleId?: string; status?: RunStatus; limit?: number }): Promise<AgentTaskRun[]> {
  let q = supabase.from('agent_task_runs').select('*').order('created_at', { ascending: false }).limit(opts?.limit ?? 100);
  if (opts?.scheduleId) q = q.eq('schedule_id', opts.scheduleId);
  if (opts?.status) q = q.eq('status', opts.status);
  const { data, error } = await q;
  if (error) throw error;
  return (data ?? []) as AgentTaskRun[];
}

/**
 * Most recent activity timestamp per agent user, keyed by agent_user_id. Staff Management
 * shows agent-type users' `last_sign_in_at`, which is always null (agents connect via MCP,
 * never sign into the browser) — this backs an agent-aware "Last Active" instead.
 */
/**
 * When each agent was last known to be alive.
 *
 * Run history alone is the wrong signal: a run row only exists when work was DUE, so an agent
 * with a sparse schedule looks identical to one that died — and an agent whose OS auth expired
 * looks identical to one that is simply idle. agent_heartbeats is stamped on every poll whether
 * or not there was work, so it is the signal that actually distinguishes them. Runs remain as a
 * fallback for the window before heartbeats existed.
 */
export async function getAgentLastActiveMap(orgId: string): Promise<Record<string, string>> {
  const [runsRes, beatsRes] = await Promise.all([
    supabase
      .from('agent_task_runs')
      .select('agent_user_id, claimed_at, started_at, finished_at')
      .eq('org_id', orgId)
      .order('claimed_at', { ascending: false })
      .limit(500),
    supabase
      .from('agent_heartbeats')
      .select('agent_user_id, last_poll_at')
      .eq('org_id', orgId),
  ]);
  if (runsRes.error) throw runsRes.error;

  const map: Record<string, string> = {};
  for (const row of runsRes.data ?? []) {
    const ts = row.finished_at || row.started_at || row.claimed_at;
    if (!ts) continue;
    if (!map[row.agent_user_id] || ts > map[row.agent_user_id]) {
      map[row.agent_user_id] = ts;
    }
  }
  // Heartbeats win when newer. A missing table/permission is not fatal — fall back to runs.
  for (const row of beatsRes.data ?? []) {
    const ts = row.last_poll_at as string | null;
    if (!ts) continue;
    if (!map[row.agent_user_id] || ts > map[row.agent_user_id]) {
      map[row.agent_user_id] = ts;
    }
  }
  return map;
}

/** How long each agent has been silent, in minutes. Absent = never seen. */
export async function getAgentSilenceMinutes(orgId: string): Promise<Record<string, number>> {
  const seen = await getAgentLastActiveMap(orgId);
  const now = Date.now();
  const out: Record<string, number> = {};
  for (const [id, ts] of Object.entries(seen)) {
    out[id] = Math.floor((now - Date.parse(ts)) / 60_000);
  }
  return out;
}

export function subscribeToRuns(orgId: string, onChange: () => void) {
  return supabase
    .channel(`agent_task_runs:${orgId}`)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'agent_task_runs', filter: `org_id=eq.${orgId}` }, onChange)
    .subscribe();
}
