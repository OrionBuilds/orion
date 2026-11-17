/**
 * Agent operations dashboard data (/agent-health).
 *
 * Every section is one round trip: SQL RPCs (migration 20261029030000_agent_ops_dashboard.sql) for
 * heartbeats, runs, schedules, channels and the AI cost ledger, and the ai-provider-usage edge function
 * for provider-side usage / subscription data (it holds the credentials; the browser never sees one).
 * The pure helpers below (status, alerts, formatting, pivots) are unit-tested in agentOps.test.ts.
 */
import { supabase } from '../lib/supabase';
import { getAgentThreadPulse, getPinnedAgentThreads, type AgentThreadPulse } from './agentThreads';
import { listStoppedRequests, stoppedByAgent } from './agentRequests';

// ── RPC shapes ───────────────────────────────────────────────────────────────────────────────

export interface Uptime { since: string; up_buckets: number; expected_buckets: number }

export interface RunCounts24h { total: number; ok: number; failed: number; expired: number; rejected: number; running: number; awaiting_approval: number }

export interface OverviewAgent {
  user_id: string;
  name: string;
  email: string;
  role: string;
  slug: string;
  heartbeat: { last_poll_at: string | null; poll_count: number; last_due: number | null; last_resolved: number | null } | null;
  liveness: {
    alerting: boolean; last_alert_at: string | null; last_stale_at: string | null; last_recovery_at: string | null;
    schedules_alerting: boolean; schedules_alert_at: string | null; tunnel_alerting: boolean; tunnel_alert_at: string | null;
  } | null;
  supervisor: {
    host: string | null; consecutive_fails: number; last_error: string | null;
    last_failure_at: string | null; last_success_at: string | null; updated_at: string | null;
  } | null;
  uptime_24h: Uptime | null;
  uptime_7d: Uptime | null;
  runs_24h: RunCounts24h;
  runs_7d: { total: number; ok: number; failed: number; avg_duration_s: number | null };
  current: Array<{ run_id: string; title: string; status: string; started_at: string | null }>;
  last_run: { title: string; status: string; at: string } | null;
  last_error: { title: string; status: string; error: string | null; at: string } | null;
  schedules: { active: number; shadow: number; off: number; overdue: number; next_run_at: string | null };
  backlog: { open_requests: number; needs_input: number; open_thread_turns: number; awaiting_approval: number };
  vault: { last_synced_at: string | null; note_count: number; link_count: number; last_error: string | null } | null;
  cost_mtd: { cost_usd: number; calls: number; unpriced_calls: number };
  /**
   * Not from the RPC: the agent's pinned thread, attached by getOverviewWithThreads for an agent that has never
   * polled. Such an agent answers from the cloud (Clara), so its thread is the only sign of life there is.
   */
  thread?: AgentThreadPulse | null;
  /** Not from the RPC: requests this agent could not finish (failed, or a question gone stale), also attached there. */
  stopped?: number;
}

export interface Overview {
  generated_at: string;
  agents: OverviewAgent[];
  services: Array<{ service: string; down_until: string | null; last_error: string | null; updated_at: string }>;
  /** Keyed by agent slug: state that survives an agent's user row being deleted and re-created. */
  supervisors?: Record<string, NonNullable<OverviewAgent['supervisor']>>;
  vaults?: Record<string, NonNullable<OverviewAgent['vault']>>;
  cost_mtd_by_agent?: Record<string, OverviewAgent['cost_mtd']>;
}

// ── roster ───────────────────────────────────────────────────────────────────────────────────

export interface KnownAgent { slug: string; label: string; role: string; purpose: string }

/**
 * The agents this OS expects to run, by slug and role — never by user id, because an agent's
 * account can be deleted and re-created. A retired agent is simply not listed. The live agent users
 * come from agent_ops_overview (every user holding an *Agent role); this list only decides which
 * expected agents get a "not provisioned" card when no such user exists.
 */
export const AGENT_ROSTER: KnownAgent[] = [
  { slug: 'clara', label: 'CLARA', role: 'ClaraAgent', purpose: 'Owner assistant — calls, texts, email, calendar and briefings' },
  { slug: 'friday', label: 'FRIDAY', role: 'FridayAgent', purpose: 'Engineering — tickets, change requests, monitoring and delivery' },
  { slug: 'harvey', label: 'HARVEY', role: 'HarveyAgent', purpose: 'Outbound — cold email and LinkedIn for the personal brand' },
];

export type RosterEntry =
  | { kind: 'agent'; agent: OverviewAgent }
  | {
    kind: 'unprovisioned';
    known: KnownAgent;
    supervisor: OverviewAgent['supervisor'];
    vault: OverviewAgent['vault'];
    cost_mtd: OverviewAgent['cost_mtd'] | null;
  };

/** Expected agents in roster order (a placeholder when no user holds the role), then any other agent users. */
export function buildRoster(o: Overview, roster: KnownAgent[] = AGENT_ROSTER): RosterEntry[] {
  const out: RosterEntry[] = [];
  const known = new Set(roster.map((k) => k.slug));
  for (const k of roster) {
    const users = o.agents.filter((a) => a.slug === k.slug);
    if (users.length) users.forEach((agent) => out.push({ kind: 'agent', agent }));
    else out.push({
      kind: 'unprovisioned', known: k,
      supervisor: o.supervisors?.[k.slug] ?? null,
      vault: o.vaults?.[k.slug] ?? null,
      cost_mtd: o.cost_mtd_by_agent?.[k.slug] ?? null,
    });
  }
  for (const a of o.agents) if (!known.has(a.slug)) out.push({ kind: 'agent', agent: a });
  return out;
}

export interface AgentDetail {
  agent: { user_id: string; slug: string; name: string };
  days: number;
  timezone: string;
  timeline_24h: Array<{ t: string; polls: number }>;
  timeline: Array<{ t: string; up_buckets: number; polls: number }>;
  history_since: string | null;
  runs_by_day: Array<{ day: string; ok: number; failed: number; expired: number; other: number; avg_duration_s: number | null }>;
  by_task: Array<{ task_key: string; title: string; runs: number; ok: number; failed: number; avg_duration_s: number | null; max_duration_s: number | null; last_status: string; last_at: string }>;
  schedules: Array<{ id: string; task_key: string; title: string; mode: string; cadence: string; time_of_day: string | null; timezone: string; next_run_at: string | null; last_run_at: string | null; risk_tier: string; overdue: boolean }>;
  recent_errors: Array<{ run_id: string; title: string; status: string; error: string; at: string }>;
  backlog: {
    requests: Array<{ id: string; title: string; kind: string; status: string; created_at: string; error: string | null }>;
    awaiting_approval: number; overdue_schedules: number; open_thread_turns: number;
  };
  channels: Record<string, unknown>;
  supervisor: OverviewAgent['supervisor'];
  liveness: Record<string, unknown> | null;
  vault: (NonNullable<OverviewAgent['vault']> & { updated_at: string | null }) | null;
  costs: {
    by_day: Array<{ day: string; cost_usd: number; calls: number; input_tokens: number; output_tokens: number }>;
    by_model: Array<{ provider: string; model: string; cost_usd: number; calls: number }>;
  };
}

export interface RunRow {
  id: string; agent_user_id: string; task_key: string | null; title: string; status: string; mode: string; attempt: number;
  scheduled_for: string | null; started_at: string | null; finished_at: string | null; duration_s: number | null;
  error: string | null; summary: string | null; created_at: string;
}

export interface CostTotals {
  cost_usd: number; calls: number; unpriced_calls: number; estimated_calls: number; error_calls: number;
  input_tokens: number; output_tokens: number; cache_read_tokens: number; cache_write_tokens: number;
  subscription_value_usd: number; metered_cost_usd: number;
}

export interface Costs {
  days: number;
  timezone: string;
  first_logged_at: string | null;
  totals: CostTotals;
  mtd: { cost_usd: number; calls: number; metered_cost_usd: number; since: string };
  prev_period: { cost_usd: number; calls: number; metered_cost_usd: number; from: string; to: string };
  by_agent: Array<{ agent: string; cost_usd: number; calls: number; input_tokens: number; output_tokens: number; runs: number; cost_per_run: number | null }>;
  by_provider: Array<{ provider: string; auth_type: string; cost_usd: number; calls: number; input_tokens: number; output_tokens: number; last_used_at: string }>;
  last_used: Record<string, string>;
  by_model: Array<{ provider: string; model: string; cost_usd: number; calls: number; input_tokens: number; output_tokens: number }>;
  by_source: Array<{ agent: string; source: string; cost_usd: number; calls: number }>;
  by_day: Array<{ day: string; agent: string; cost_usd: number; calls: number; input_tokens: number; output_tokens: number }>;
  top_tasks: Array<{ agent: string; ref: string; label: string; cost_usd: number; calls: number; last_at: string }>;
}

export interface ProviderUsageSummary {
  period_start: string; period_end: string; cost_usd: number | null;
  daily: Array<{ day: string; cost_usd: number }>;
  by_model: Array<{ model: string; input_tokens: number; output_tokens: number; cache_read_tokens: number; cache_write_tokens: number; requests?: number }>;
  input_tokens: number; output_tokens: number;
}

export interface ProviderCard {
  key: string;
  name: string;
  auth_type: 'api_key' | 'subscription';
  credentials: Array<{ label: string; location: string; present: boolean; enabled?: boolean; valid?: boolean | null; error?: string }>;
  usage_api: { available: boolean; configured: boolean; requires?: string; note: string };
  usage?: ProviderUsageSummary | null;
  subscription?: { tier: string | null; status: string | null; characters_used: number; character_limit: number; resets_at: string | null } | null;
  credits?: number | null;
  error?: string;
  fetched_at: string;
  cached?: boolean;
}

export interface ProviderUsage { generated_at: string; providers: ProviderCard[] }

// ── calls ────────────────────────────────────────────────────────────────────────────────────

const MIGRATION_HINT = 'Agent operations data is not available yet: migration 20261029030000_agent_ops_dashboard.sql has not been applied to this database.';

function rpcError(error: { message?: string; code?: string } | null): Error {
  const msg = error?.message ?? 'Request failed';
  if (error?.code === 'PGRST202' || /could not find the function/i.test(msg)) return new Error(MIGRATION_HINT);
  return new Error(msg);
}

async function rpc<T>(fn: string, args: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabase.rpc(fn, args);
  if (error) throw rpcError(error);
  return data as T;
}

export const getOverview = (orgId: string) => rpc<Overview>('agent_ops_overview', { p_org: orgId });

/**
 * The overview, with the pinned thread of every agent that has never polled and how many requests each agent
 * could not finish. A failed thread lookup leaves the agent without one (it then reads "never connected"), and a
 * failed request lookup leaves the count off, rather than failing the page.
 */
export async function getOverviewWithThreads(orgId: string): Promise<Overview> {
  const [base, stoppedRows] = await Promise.all([getOverview(orgId), listStoppedRequests(orgId).catch(() => [])]);
  const stopped = stoppedByAgent(stoppedRows);
  const overview = stopped.size ? { ...base, agents: base.agents.map((a) => (stopped.has(a.user_id) ? { ...a, stopped: stopped.get(a.user_id) } : a)) } : base;
  const silent = overview.agents.filter((a) => !a.heartbeat?.last_poll_at);
  if (!silent.length) return overview;
  const threads = await getPinnedAgentThreads().catch(() => []);
  const pulses = new Map<string, AgentThreadPulse>();
  await Promise.all(silent.map(async (a) => {
    const t = threads.find((x) => x.agent_user_id === a.user_id);
    if (!t) return;
    const pulse = await getAgentThreadPulse(t.channel_id, t.agent_user_id).catch(() => null);
    if (pulse) pulses.set(a.user_id, pulse);
  }));
  return { ...overview, agents: overview.agents.map((a) => (pulses.has(a.user_id) ? { ...a, thread: pulses.get(a.user_id) } : a)) };
}

export const getAgentDetail = (orgId: string, agentUserId: string, days: number) =>
  rpc<AgentDetail>('agent_ops_agent_detail', { p_org: orgId, p_agent: agentUserId, p_days: days, p_tz: browserTimeZone() });

export const getRuns = (orgId: string, o: { agentUserId?: string | null; status?: string | null; before?: string | null; limit?: number }) =>
  rpc<{ rows: RunRow[]; has_more: boolean }>('agent_ops_runs', {
    p_org: orgId, p_agent: o.agentUserId ?? null, p_status: o.status ?? null, p_before: o.before ?? null, p_limit: o.limit ?? 50,
  });

export const getCosts = (orgId: string, days: number) =>
  rpc<Costs>('agent_ops_costs', { p_org: orgId, p_days: days, p_tz: browserTimeZone() });

export async function getProviderUsage(refresh = false): Promise<ProviderUsage> {
  const { data, error } = await supabase.functions.invoke('ai-provider-usage', { body: { refresh } });
  if (error) {
    const status = (error as { context?: { status?: number } }).context?.status;
    if (status === 404) throw new Error('The ai-provider-usage edge function is not deployed yet.');
    if (status === 403) throw new Error('Provider usage is visible to SuperAdmins and members with the ai_agents.manage permission.');
    throw new Error(error.message);
  }
  return data as ProviderUsage;
}

export function browserTimeZone(): string {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'America/New_York'; } catch { return 'America/New_York'; }
}

// ── pure helpers ─────────────────────────────────────────────────────────────────────────────

/** Agents poll every 1-2 minutes; the OS alarm pages the owner after 20 minutes of silence. */
export const LIVE_MINUTES = 10;
export const OFFLINE_MINUTES = 60;

/** idle: not an outage. The agent has never connected, or answers from the cloud and has had nothing to answer. */
export type StatusLevel = 'live' | 'stale' | 'offline' | 'idle';

/** How long a message to a cloud agent may sit unanswered before it counts against it. */
export const UNANSWERED_MINUTES = 5;

export function minutesSince(iso: string | null | undefined, now = Date.now()): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? Math.max(0, Math.floor((now - t) / 60_000)) : null;
}

export function ago(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return 'never';
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return 'never';
  const s = Math.round((now - t) / 1000);
  if (s < 0) {
    const f = -s;
    if (f < 3600) return `in ${Math.max(1, Math.round(f / 60))}m`;
    if (f < 86400) return `in ${Math.round(f / 3600)}h`;
    return `in ${Math.round(f / 86400)}d`;
  }
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

/**
 * An agent that has never polled. If it has answered in its thread it runs in the cloud and is judged by that thread:
 * a failed or unanswered last message counts only while nothing has been said since. Otherwise a supervisor means a
 * workstation agent that is down, and neither means it has simply not been set up, which is not an outage.
 */
function unpolledStatus(a: Pick<OverviewAgent, 'supervisor' | 'thread'>, now: number): { level: StatusLevel; reason: string } {
  const pulse = a.thread;
  const replyAt = pulse?.lastReplyAt ? Date.parse(pulse.lastReplyAt) : NaN;
  if (!Number.isFinite(replyAt) && a.supervisor) return { level: 'offline', reason: 'Has never polled the OS for work' };
  if (!pulse) return { level: 'idle', reason: 'Not set up: has never connected to the OS' };
  const turn = pulse.lastTurn;
  const turnAt = turn ? Date.parse(turn.created_at) : NaN;
  if (turn && Number.isFinite(turnAt) && (!Number.isFinite(replyAt) || replyAt < turnAt)) {
    if (turn.status === 'failed') {
      return { level: 'stale', reason: `Couldn't answer your message from ${ago(turn.created_at, now)}${turn.error ? `: ${turn.error.replace(/\s+/g, ' ').trim().slice(0, 120)}` : ''}` };
    }
    if ((turn.status === 'sent' || turn.status === 'working') && (minutesSince(turn.created_at, now) ?? 0) > UNANSWERED_MINUTES) {
      return { level: 'stale', reason: `No answer yet to your message from ${ago(turn.created_at, now)}` };
    }
  }
  if (!Number.isFinite(replyAt)) return { level: 'idle', reason: 'Answers from the cloud (does not poll) — no conversation yet' };
  return { level: 'live', reason: `Answers from the cloud (does not poll) — last reply ${ago(pulse.lastReplyAt, now)}` };
}

/** Live / stale / offline from the last poll, with the most specific reason the data supports. */
export function agentStatus(a: Pick<OverviewAgent, 'heartbeat' | 'supervisor' | 'liveness' | 'thread'>, now = Date.now()): { level: StatusLevel; reason: string } {
  const mins = minutesSince(a.heartbeat?.last_poll_at, now);
  if (mins === null) return unpolledStatus(a, now);
  if (mins <= LIVE_MINUTES) return { level: 'live', reason: `Polled ${ago(a.heartbeat!.last_poll_at, now)}` };

  const sup = a.supervisor;
  const supFailing = sup && sup.consecutive_fails > 0 && sup.last_error;
  const silence = `No poll for ${ago(a.heartbeat!.last_poll_at, now).replace(' ago', '')}`;
  let why = '';
  if (supFailing) why = `supervisor on ${sup!.host ?? 'the workstation'} reports: ${sup!.last_error}`;
  else if (a.liveness?.tunnel_alerting) why = 'the OS tunnel is down';
  else if (mins > OFFLINE_MINUTES) why = 'process stopped or the workstation is off/unreachable (no supervisor error reported)';
  else why = 'agents poll every 1-2 minutes';
  return { level: mins > OFFLINE_MINUTES ? 'offline' : 'stale', reason: `${silence} — ${why}` };
}

export function uptimePct(u: Uptime | null | undefined): number | null {
  if (!u || !u.expected_buckets) return null;
  return Math.max(0, Math.min(100, Math.round((u.up_buckets / u.expected_buckets) * 1000) / 10));
}

export interface Alert { severity: 'critical' | 'warning' | 'info'; text: string }

export function agentAlerts(a: OverviewAgent, now = Date.now()): Alert[] {
  const out: Alert[] = [];
  const st = agentStatus(a, now);
  if (st.level === 'stale' || st.level === 'offline') out.push({ severity: st.level === 'offline' ? 'critical' : 'warning', text: st.reason });
  if (a.liveness?.alerting) out.push({ severity: 'critical', text: `Liveness alarm active (owner paged ${ago(a.liveness.last_alert_at, now)})` });
  if (a.liveness?.schedules_alerting) out.push({ severity: 'warning', text: 'Schedules alarm: due work is not being picked up' });
  if (a.liveness?.tunnel_alerting) out.push({ severity: 'critical', text: 'OS tunnel alarm active' });
  if (a.supervisor && a.supervisor.consecutive_fails > 0) {
    out.push({ severity: 'critical', text: `Supervisor failing (${a.supervisor.consecutive_fails}x): ${a.supervisor.last_error ?? 'no message'}` });
  }
  if (a.schedules.overdue > 0) out.push({ severity: 'warning', text: `${a.schedules.overdue} schedule${a.schedules.overdue === 1 ? '' : 's'} overdue` });
  const failed24 = a.runs_24h.failed + a.runs_24h.expired;
  if (failed24 > 0) out.push({ severity: 'warning', text: `${failed24} failed/expired run${failed24 === 1 ? '' : 's'} in 24h` });
  if (a.stopped) out.push({ severity: 'warning', text: `${a.stopped} request${a.stopped === 1 ? '' : 's'} it couldn't finish: retry or dismiss ${a.stopped === 1 ? 'it' : 'them'}` });
  if (a.backlog.needs_input > 0) out.push({ severity: 'info', text: `${a.backlog.needs_input} request${a.backlog.needs_input === 1 ? '' : 's'} waiting on your input` });
  if (a.backlog.awaiting_approval > 0) out.push({ severity: 'info', text: `${a.backlog.awaiting_approval} run${a.backlog.awaiting_approval === 1 ? '' : 's'} awaiting approval` });
  if (a.vault) {
    const vm = minutesSince(a.vault.last_synced_at, now);
    if (a.vault.last_error) out.push({ severity: 'warning', text: `Vault sync error: ${a.vault.last_error}` });
    else if (vm !== null && vm > 24 * 60) out.push({ severity: 'warning', text: `Memory vault last synced ${ago(a.vault.last_synced_at, now)}` });
  }
  return out;
}

export function formatUsd(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—';
  if (n === 0) return '$0.00';
  if (Math.abs(n) < 0.01) return '<$0.01';
  if (Math.abs(n) < 100) return `$${n.toFixed(2)}`;
  return `$${Math.round(n).toLocaleString('en-US')}`;
}

export function formatTokens(n: number | null | undefined): string {
  if (!n) return '0';
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}k`;
  return String(n);
}

/** Percent change; null when there is no previous value to compare with. */
export function pctChange(cur: number, prev: number): number | null {
  if (!prev) return null;
  return Math.round(((cur - prev) / prev) * 1000) / 10;
}

/** The last `days` calendar days (YYYY-MM-DD, local), oldest first, ending today. */
export function lastDays(days: number, now = new Date()): string[] {
  const out: string[] = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i);
    out.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`);
  }
  return out;
}

/** Rows of { day, agent, cost_usd } -> one row per day with a column per agent, zero-filled. */
export function pivotCostByDay(rows: Costs['by_day'], days: string[]): { data: Array<Record<string, number | string>>; agents: string[] } {
  const agents = Array.from(new Set(rows.map((r) => r.agent))).sort();
  const index = new Map<string, Record<string, number | string>>();
  for (const d of days) {
    const row: Record<string, number | string> = { day: d };
    for (const a of agents) row[a] = 0;
    index.set(d, row);
  }
  for (const r of rows) {
    const row = index.get(r.day);
    if (row) row[r.agent] = Math.round(((row[r.agent] as number) + Number(r.cost_usd)) * 1e6) / 1e6;
  }
  return { data: days.map((d) => index.get(d)!), agents };
}

/** Zero-fill a per-day series. */
export function fillDays<T extends { day: string }>(rows: T[], days: string[], empty: (day: string) => T): T[] {
  const m = new Map(rows.map((r) => [r.day, r]));
  return days.map((d) => m.get(d) ?? empty(d));
}

export function agentLabel(slug: string): string {
  return slug ? slug.toUpperCase() : 'AGENT';
}

export const RUN_STATUS_TONE: Record<string, 'ok' | 'bad' | 'warn' | 'muted'> = {
  completed: 'ok', approved: 'ok', failed: 'bad', expired_lease: 'bad', rejected: 'warn',
  claimed: 'muted', running: 'muted', awaiting_approval: 'warn',
};
