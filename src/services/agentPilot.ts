import { supabase } from '../lib/supabase';

export interface PilotThresholds {
  min_decided?: number;
  min_approval_rate?: number;
  kill_below_rate?: number;
  kill_min_decided?: number;
}

export interface PilotRow {
  schedule_id: string;
  agent_slug: string;
  task_key: string;
  title: string;
  mode: 'shadow' | 'active';
  risk_tier: 'autonomous' | 'owner_review' | 'client_visible';
  approval_required: boolean;
  thresholds: PilotThresholds;
  runs: number;
  failed: number;
  approved: number;
  /** Approved only after a person changed it: counts as decided but not as approved untouched. */
  edited: number;
  rejected: number;
  expired: number;
  pending: number;
  last_run_at: string | null;
}

export type PilotVerdict = 'collecting' | 'ready_to_graduate' | 'kill_review' | 'permanent_checkpoint' | 'active_ok' | 'active_slipping';

export interface PilotAssessment {
  verdict: PilotVerdict;
  decided: number;
  approvalRate: number | null;
  minDecided: number;
  minRate: number;
  note: string;
}

/** Defaults follow the shadow-run rules: about 50 decided drafts at 95% approved to graduate; under 60% on 20+ is a kill review. */
export const PILOT_DEFAULTS = { min_decided: 50, min_approval_rate: 0.95, kill_below_rate: 0.6, kill_min_decided: 20 };

/**
 * Override a default only with a finite number inside its valid range. Thresholds arrive from JSON
 * (agent_task_schedules.config), so a null or garbage value must keep the default — otherwise
 * `rate >= null` is trivially true and a pilot could graduate without meeting the real bar.
 */
export function resolveThresholds(raw: PilotThresholds | null | undefined): typeof PILOT_DEFAULTS {
  const t = { ...PILOT_DEFAULTS };
  const num = (v: unknown, min: number, max: number): number | null =>
    typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max ? v : null;
  const decided = (v: unknown) => num(v, 0, Number.MAX_SAFE_INTEGER);
  const rate = (v: unknown) => num(v, 0, 1);
  const md = decided(raw?.min_decided); if (md !== null) t.min_decided = md;
  const mar = rate(raw?.min_approval_rate); if (mar !== null) t.min_approval_rate = mar;
  const kbr = rate(raw?.kill_below_rate); if (kbr !== null) t.kill_below_rate = kbr;
  const kmd = decided(raw?.kill_min_decided); if (kmd !== null) t.kill_min_decided = kmd;
  return t;
}

/**
 * Pure: what the counts say. Never changes anything. Client-visible work is a permanent checkpoint
 * (it can never run without a person), and every graduation is still a person's decision.
 * Expired drafts count against the rate: an unanswered draft is not an approval.
 */
export function assessPilot(row: PilotRow): PilotAssessment {
  const t = resolveThresholds(row.thresholds);
  const decided = row.approved + row.edited + row.rejected + row.expired;
  const rate = decided > 0 ? row.approved / decided : null;
  const base = { decided, approvalRate: rate, minDecided: t.min_decided, minRate: t.min_approval_rate };

  if (row.risk_tier === 'client_visible') {
    return { ...base, verdict: 'permanent_checkpoint', note: 'Client-visible output always needs a person. It never graduates.' };
  }
  if (row.mode === 'active') {
    if (rate !== null && decided >= t.kill_min_decided && rate < t.min_approval_rate) {
      return { ...base, verdict: 'active_slipping', note: `Approval rate ${(rate * 100).toFixed(0)}% is under ${(t.min_approval_rate * 100).toFixed(0)}%. Drop it back to shadow and review.` };
    }
    return { ...base, verdict: 'active_ok', note: 'Keep spot-checking; spot-checks never reach zero.' };
  }
  if (rate !== null && decided >= t.kill_min_decided && rate < t.kill_below_rate) {
    return { ...base, verdict: 'kill_review', note: `Only ${(rate * 100).toFixed(0)}% approved over ${decided} decided drafts. A pilot that fails its kill criteria is the method working: stop or fix it.` };
  }
  if (rate !== null && decided >= t.min_decided && rate >= t.min_approval_rate) {
    return { ...base, verdict: 'ready_to_graduate', note: `${(rate * 100).toFixed(0)}% approved over ${decided} decided drafts. Promotion to active is your call.` };
  }
  return { ...base, verdict: 'collecting', note: `${decided} of ${t.min_decided} decided drafts needed before judging.` };
}

export interface ShadowRunToReview {
  run_id: string;
  scheduled_for: string;
  summary: string;
  proposed: string | null;
}

export type ReviewVerdict = 'approved' | 'edited' | 'rejected';

function rpcError(error: { message?: string; code?: string }): Error {
  if (error.code === 'PGRST202' || /could not find the function/i.test(error.message ?? '')) {
    return new Error('Pilot status is not available yet: migration 20261102100000_agent_pilot_status.sql has not been applied.');
  }
  return new Error(error.message ?? 'Request failed');
}

export async function getShadowRunsToReview(orgId: string, scheduleId: string): Promise<ShadowRunToReview[]> {
  const { data, error } = await supabase.rpc('agent_pilot_review_queue', { p_org: orgId, p_schedule: scheduleId, p_limit: 20 });
  if (error) throw rpcError(error);
  return (data ?? []) as ShadowRunToReview[];
}

export async function reviewShadowRun(orgId: string, runId: string, verdict: ReviewVerdict, note?: string): Promise<void> {
  const { error } = await supabase.rpc('agent_pilot_review', { p_org: orgId, p_run: runId, p_verdict: verdict, p_note: note ?? null });
  if (error) throw rpcError(error);
}

export async function getPilotStatus(orgId: string, days = 30): Promise<PilotRow[]> {
  const { data, error } = await supabase.rpc('agent_pilot_status', { p_org: orgId, p_days: days });
  if (error) throw rpcError(error);
  return ((data as { pilots?: PilotRow[] } | null)?.pilots ?? []) as PilotRow[];
}
