import { supabase } from '../lib/supabase';

export interface ApprovalQueueItem {
  id: string;
  org_id: string;
  enrollment_id: string | null;
  workflow_id: string | null;
  node_id: string | null;
  action_type: string;
  contact_id: string | null;
  /** Short label shown in the queue. */
  title: string | null;
  /** The requester's own explanation of what will happen if this is approved. */
  description: string | null;
  draft_content: unknown;
  requested_at: string;
  resolved_at: string | null;
  resolved_by_user_id: string | null;
  /**
   * Must match workflow_approval_queue_status_check exactly. The unresolved state is
   * 'pending_approval', NOT 'pending' — the DB has never been able to hold 'pending', so
   * every filter that used it silently matched zero rows and the queue always looked empty.
   */
  status: 'pending_approval' | 'approved' | 'rejected' | 'expired' | 'escalated' | 'superseded';
  resolution_note: string | null;
  ai_run_id: string | null;
  pending_next_node_id: string | null;
  /** 'workflow' = legacy workflow-builder approval step (engine retired; historic rows only);
   *  'agent_run' = spawned by a scheduled agent run; 'agent_approval' = an agent's own ask
   *  (CLARA/FRIDAY). */
  source: 'workflow' | 'agent_run' | 'agent_approval';
  /** source=agent_approval only: which agent (friday|clara) mirrored this row. */
  agent_slug: string | null;
  agent_run_id: string | null;
  contact?: { id: string; first_name: string; last_name: string; email: string } | null;
  resolved_by?: { id: string; name: string } | null;
  agent_run?: { id: string; agent: { id: string; name: string } | null } | null;
}

export interface ApprovalFilters {
  status?: string[];
  search?: string;
}

export async function getApprovalQueue(
  orgId: string,
  filters: ApprovalFilters = {},
  page = 1,
  perPage = 25
): Promise<{ data: ApprovalQueueItem[]; count: number }> {
  let query = supabase
    .from('workflow_approval_queue')
    .select(`
      *,
      contact:contacts!contact_id(id, first_name, last_name, email),
      resolved_by:users!resolved_by_user_id(id, name),
      agent_run:agent_task_runs!agent_run_id(id, agent:users!agent_user_id(id, name))
    `, { count: 'exact' })
    .eq('org_id', orgId);

  if (filters.status && filters.status.length > 0) {
    query = query.in('status', filters.status);
  }

  const from = (page - 1) * perPage;
  const to = from + perPage - 1;

  const { data, error, count } = await query
    .order('requested_at', { ascending: false })
    .range(from, to);

  if (error) throw error;
  return { data: (data ?? []) as ApprovalQueueItem[], count: count ?? 0 };
}

/** The send-ready draft a Clara approval carries (draft_content.draft). */
export interface ClaraDraft {
  kind: 'email' | 'sms';
  to: string[] | string;
  subject?: string;
  body: string;
  contact_id?: string | null;
  send_after?: string | null;
  respect_quiet_hours?: boolean;
  log?: Record<string, unknown> | null;
}

/** Pure: the editable Clara draft inside an approval's draft_content, or null for any other payload. */
export function claraDraftOf(item: Pick<ApprovalQueueItem, 'source' | 'agent_slug' | 'draft_content'>): ClaraDraft | null {
  if (item.source !== 'agent_approval' || item.agent_slug !== 'clara' && item.agent_slug !== 'harvey') return null;
  const dc = item.draft_content;
  if (!dc || typeof dc !== 'object') return null;
  const d = (dc as { draft?: unknown }).draft;
  if (!d || typeof d !== 'object') return null;
  const draft = d as ClaraDraft;
  return (draft.kind === 'email' || draft.kind === 'sms') && typeof draft.body === 'string' ? draft : null;
}

/**
 * Edit a still-pending Clara draft before deciding it (what the meeting follow-ups panel used to
 * offer). Only the draft's text and its send delay change; the row stays pending.
 */
export async function updateClaraDraft(
  item: Pick<ApprovalQueueItem, 'id' | 'draft_content'>,
  patch: { subject?: string; body: string; sendNow?: boolean }
): Promise<unknown> {
  const dc = (item.draft_content ?? {}) as Record<string, unknown>;
  const draft: Record<string, unknown> = { ...((dc.draft ?? {}) as Record<string, unknown>), body: patch.body };
  if (patch.subject !== undefined) draft.subject = patch.subject;
  if (patch.sendNow) draft.send_after = null;
  const next = { ...dc, draft, edited_by_owner: true };
  const { error } = await supabase
    .from('workflow_approval_queue')
    .update({ draft_content: next })
    .eq('id', item.id)
    .eq('status', 'pending_approval');
  if (error) throw error;
  return next;
}

/**
 * Clara's post-meeting recap drafts for one meeting. They live in the approvals queue under the
 * external ref `meeting-followup:<meeting_transcription_id>:<contact_id>:<channel>`.
 */
export async function getMeetingFollowUpApprovalCounts(
  meetingTranscriptionId: string
): Promise<{ total: number; pending: number }> {
  const { data, error } = await supabase
    .from('workflow_approval_queue')
    .select('status')
    .eq('source', 'agent_approval')
    .eq('agent_slug', 'clara')
    .like('external_ref', `meeting-followup:${meetingTranscriptionId}:%`);

  if (error) throw error;
  const rows = (data ?? []) as { status: string }[];
  return { total: rows.length, pending: rows.filter((r) => r.status === 'pending_approval').length };
}

export async function getPendingApprovalCount(orgId: string): Promise<number> {
  const { count, error } = await supabase
    .from('workflow_approval_queue')
    .select('id', { count: 'exact', head: true })
    .eq('org_id', orgId)
    .eq('status', 'pending_approval');

  if (error) throw error;
  return count ?? 0;
}

/**
 * Decide a pending approval. The row is the whole contract: agents (CLARA/FRIDAY) poll their
 * decided rows, clara-approved-sends delivers approved Clara drafts, and the
 * sync_agent_run_on_approval_change trigger mirrors agent_run decisions. (The workflow engine
 * that used to be resumed from here was retired.)
 */
async function resolveItem(
  id: string,
  status: 'approved' | 'rejected',
  userId: string,
  note?: string
): Promise<void> {
  const { error } = await supabase
    .from('workflow_approval_queue')
    .update({
      status,
      resolved_at: new Date().toISOString(),
      resolved_by_user_id: userId,
      resolution_note: note || null,
    })
    .eq('id', id);

  if (error) throw error;
}

export async function approveItem(id: string, userId: string, note?: string): Promise<void> {
  return resolveItem(id, 'approved', userId, note);
}

export async function rejectItem(id: string, userId: string, note?: string): Promise<void> {
  return resolveItem(id, 'rejected', userId, note);
}
