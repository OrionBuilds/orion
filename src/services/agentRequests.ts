/**
 * agent_requests: work handed to an agent (CLARA / FRIDAY / HARVEY / ...). A request in
 * `needs_input` is the agent waiting on a person. RLS shows a request to its two parties and to
 * the org owner / SuperAdmin.
 */
import { supabase } from '../lib/supabase';

export interface AgentQuestion {
  id: string;
  title: string;
  /** What the agent asked, in its words. */
  result_summary: string | null;
  /** The agent that is waiting (the request was addressed to it). */
  to_user_id: string;
  from_user_id: string;
  updated_at: string;
}

/** A question older than this can no longer be answered: only an agent's latest request in a thread takes a reply. */
const QUESTION_MAX_AGE_DAYS = 14;

/** Requests where an agent is waiting on an answer, most recent first, plus how many there are in all. */
export async function listAgentQuestions(orgId: string, limit = 5): Promise<{ data: AgentQuestion[]; count: number }> {
  const since = new Date(Date.now() - QUESTION_MAX_AGE_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const { data, error, count } = await supabase
    .from('agent_requests')
    .select('id, title, result_summary, to_user_id, from_user_id, updated_at', { count: 'exact' })
    .eq('org_id', orgId)
    .eq('status', 'needs_input')
    .gte('updated_at', since)
    .order('updated_at', { ascending: false })
    .limit(limit);
  if (error) throw error;
  const rows = (data ?? []) as AgentQuestion[];
  return { data: rows, count: count ?? rows.length };
}

// ── stopped work: requests an agent could not finish ─────────────────────────────────────────

/** A request that has stopped and will not move again on its own. */
export interface StoppedRequest {
  id: string;
  title: string;
  kind: string;
  status: 'failed' | 'needs_input';
  error: string | null;
  result_summary: string | null;
  to_user_id: string;
  source: Record<string, unknown> | null;
  created_at: string;
  updated_at: string;
}

/** Requests that stopped for the same reason (an outage fails a whole batch at once). */
export interface StoppedGroup {
  key: string;
  status: StoppedRequest['status'];
  title: string;
  /** Why it stopped: what failed (without the per-request detail), or the question nobody answered. */
  reason: string;
  /** The rest of the error, when the group is a single request (a batch differs in exactly this part). */
  detail: string | null;
  ids: string[];
  first: string;
  last: string;
  /** The factory playbook the work belongs to, when it is a playbook step. */
  playbook: string | null;
}

export interface OwnerActionResult { retried: number; dismissed: number; skipped: number }

const STOPPED_PAGE = 500;
const ACTION_BATCH = 200;

/**
 * Pure: the rows that have really stopped. A failure always has; a question only once it is too old to
 * answer (a fresh one is still live, and My day shows it).
 */
export function stoppedOnly(rows: StoppedRequest[], now = Date.now()): StoppedRequest[] {
  const cutoff = now - QUESTION_MAX_AGE_DAYS * 24 * 60 * 60 * 1000;
  return rows.filter((r) => r.status === 'failed' || (r.status === 'needs_input' && Date.parse(r.updated_at) < cutoff));
}

const oneLine = (s: string | null | undefined) => (s ?? '').split('\n')[0].replace(/\s+/g, ' ').trim().slice(0, 240);

/**
 * Pure: an error as "what failed" and "the detail". Agents report `Error: <what failed>: <output of whatever
 * broke>`, and that tail differs on every request of the same outage, so only the head identifies the failure.
 */
export function failureReason(error: string | null | undefined): { reason: string; detail: string | null } {
  const bare = oneLine(error).replace(/^error:\s*/i, '');
  if (!bare) return { reason: 'No reason was recorded', detail: null };
  const cut = bare.indexOf(': ');
  return cut > 0 ? { reason: bare.slice(0, cut), detail: bare.slice(cut + 2).trim() || null } : { reason: bare, detail: null };
}

/** Pure: group stopped requests by what they were and why they stopped, most recent first. */
export function groupStopped(rows: StoppedRequest[]): StoppedGroup[] {
  const groups = new Map<string, StoppedGroup>();
  for (const r of rows) {
    const { reason, detail } = r.status === 'failed'
      ? failureReason(r.error)
      : { reason: oneLine(r.result_summary) || 'Asked a question nobody answered', detail: null };
    const key = `${r.status}|${r.title}|${reason}`;
    const playbook = typeof r.source?.playbook === 'string' ? r.source.playbook : null;
    const g = groups.get(key);
    if (!g) {
      groups.set(key, { key, status: r.status, title: r.title || r.kind, reason, detail, ids: [r.id], first: r.created_at, last: r.created_at, playbook });
    } else {
      g.ids.push(r.id);
      g.detail = null;
      if (r.created_at < g.first) g.first = r.created_at;
      if (r.created_at > g.last) g.last = r.created_at;
    }
  }
  return [...groups.values()].sort((a, b) => b.last.localeCompare(a.last));
}

/** Pure: how many stopped requests each agent is holding. */
export function stoppedByAgent(rows: StoppedRequest[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const r of rows) m.set(r.to_user_id, (m.get(r.to_user_id) ?? 0) + 1);
  return m;
}

/** Stopped requests (failed, or a question too old to answer), newest first. One agent's, or the whole org's. */
export async function listStoppedRequests(orgId: string, agentUserId?: string): Promise<StoppedRequest[]> {
  let q = supabase
    .from('agent_requests')
    .select('id, title, kind, status, error, result_summary, to_user_id, source, created_at, updated_at')
    .eq('org_id', orgId)
    .in('status', ['failed', 'needs_input'])
    .order('created_at', { ascending: false })
    .limit(STOPPED_PAGE);
  if (agentUserId) q = q.eq('to_user_id', agentUserId);
  const { data, error } = await q;
  if (error) throw error;
  return stoppedOnly((data ?? []) as StoppedRequest[]);
}

/**
 * Owner only: hand stopped requests back to the agent (`retry`) or close them (`dismiss`). `skipped` counts
 * the ones that had already moved on (retried elsewhere, or their playbook run ended).
 */
export async function ownerRequestAction(ids: string[], action: 'retry' | 'dismiss'): Promise<OwnerActionResult> {
  const total: OwnerActionResult = { retried: 0, dismissed: 0, skipped: 0 };
  for (let i = 0; i < ids.length; i += ACTION_BATCH) {
    const { data, error } = await supabase.rpc('agent_requests_owner_action', { p_ids: ids.slice(i, i + ACTION_BATCH), p_action: action });
    if (error) throw error;
    const r = (data ?? {}) as Partial<OwnerActionResult>;
    total.retried += r.retried ?? 0;
    total.dismissed += r.dismissed ?? 0;
    total.skipped += r.skipped ?? 0;
  }
  return total;
}
