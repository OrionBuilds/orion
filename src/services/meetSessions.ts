import { supabase } from '../lib/supabase';
import { callEdgeFunction, parseEdgeFunctionError } from '../lib/edgeFunction';
import type { GoogleMeetSession, GoogleMeetSessionStatus } from '../types';

export interface MeetSessionFilters {
  status?: GoogleMeetSessionStatus[];
  search?: string;
  hasRecording?: boolean;
}

export async function getMeetSessionsByOrg(
  orgId: string,
  filters?: MeetSessionFilters,
  page = 1,
  pageSize = 20
): Promise<{ sessions: GoogleMeetSession[]; total: number }> {
  let query = supabase
    .from('google_meet_sessions')
    .select('*', { count: 'exact' })
    .eq('org_id', orgId)
    .order('event_start_time', { ascending: false });

  if (filters?.status && filters.status.length > 0) {
    query = query.in('status', filters.status);
  }

  if (filters?.search) {
    query = query.ilike('calendar_event_summary', `%${filters.search}%`);
  }

  if (filters?.hasRecording) {
    query = query.not('recording_url', 'is', null);
  }

  const from = (page - 1) * pageSize;
  query = query.range(from, from + pageSize - 1);

  const { data, error, count } = await query;
  if (error) throw error;

  return { sessions: data || [], total: count || 0 };
}

export async function getMeetSessionById(id: string): Promise<GoogleMeetSession | null> {
  const { data, error } = await supabase
    .from('google_meet_sessions')
    .select('*')
    .eq('id', id)
    .maybeSingle();

  if (error) throw error;
  return data;
}

/**
 * Reset a session so the processor will pick it up again. Also backdates
 * `first_check_after` so it's immediately eligible for the force-invoke path
 * (which filters on `first_check_after <= now()`).
 */
export async function retriggerProcessing(sessionId: string): Promise<void> {
  const { error } = await supabase
    .from('google_meet_sessions')
    .update({
      status: 'queued',
      retry_count: 0,
      processed: false,
      processing_error: null,
      first_check_after: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq('id', sessionId);

  if (error) throw error;
}

/**
 * Reprocess a single Meet session on demand: reset it, then invoke
 * `meet-processing-job` with its id. The `session_id` path bypasses the
 * 90-day backfill window, so this also works for older meetings. Returns how
 * many sessions the job reported processing (0 if it produced no artifacts).
 */
export async function reprocessMeetSession(sessionId: string): Promise<{ processed: number }> {
  await retriggerProcessing(sessionId);

  const res = await callEdgeFunction('meet-processing-job', { session_id: sessionId });
  if (!res.ok) {
    let detail = `Reprocess failed (${res.status})`;
    try {
      detail = parseEdgeFunctionError(await res.json(), detail);
    } catch { /* non-JSON body */ }
    throw new Error(detail);
  }

  const json = await res.json().catch(() => ({}));
  return { processed: Number(json?.processed) || 0 };
}

export async function getMeetProcessingStats(orgId: string): Promise<{
  total: number;
  completed: number;
  failed: number;
  pending: number;
  noArtifacts: number;
}> {
  const { data, error } = await supabase
    .from('google_meet_sessions')
    .select('status')
    .eq('org_id', orgId);

  if (error) throw error;

  const sessions = data || [];
  return {
    total: sessions.length,
    completed: sessions.filter((s: { status: string }) => s.status === 'completed').length,
    failed: sessions.filter((s: { status: string }) => s.status === 'failed').length,
    pending: sessions.filter((s: { status: string }) =>
      ['detected', 'queued', 'processing'].includes(s.status)
    ).length,
    noArtifacts: sessions.filter((s: { status: string }) => s.status === 'no_artifacts').length,
  };
}
