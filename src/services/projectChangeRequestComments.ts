import { supabase } from '../lib/supabase';
import type { ProjectChangeRequestComment } from '../types';

export async function getComments(
  changeRequestId: string,
  includeInternal: boolean,
  portalToken?: string,
): Promise<ProjectChangeRequestComment[]> {
  // Token-link (public status page): read client-visible comments via the SECURITY DEFINER RPC
  // that verifies the change-request token (F-41). Staff callers (authenticated) keep the direct
  // query, gated by the table's own authenticated RLS.
  if (portalToken) {
    const { data, error } = await supabase.rpc('portal_token_cr_comments', {
      p_request_id: changeRequestId,
      p_token: portalToken,
    });
    if (error) throw error;
    return (data ?? []) as ProjectChangeRequestComment[];
  }

  let query = supabase
    .from('project_change_request_comments')
    .select('*, author_user:users!project_change_request_comments_author_user_id_fkey(id, name, avatar_url)')
    .eq('change_request_id', changeRequestId);

  if (!includeInternal) {
    query = query.eq('is_internal', false);
  }

  const { data, error } = await query.order('created_at', { ascending: true });
  if (error) throw error;
  return (data ?? []) as ProjectChangeRequestComment[];
}

export async function addComment(params: {
  changeRequestId: string;
  orgId: string;
  body: string;
  isInternal: boolean;
  clientVisible?: boolean;
  authorType: 'user' | 'client' | 'system';
  authorUserId?: string;
  authorName?: string;
  /** Token-link (public status page) path — see below. */
  portalToken?: string;
}): Promise<ProjectChangeRequestComment> {
  // Token-link path: the public status page has no auth session, and the
  // token-blind anon INSERT policy is gone (20260824222000). The SECURITY
  // DEFINER RPC verifies the change-request token server-side before inserting,
  // so a comment can only land on the request whose link the client actually
  // holds.
  if (params.portalToken) {
    const { data, error } = await supabase.rpc('portal_token_cr_add_comment', {
      p_request_id: params.changeRequestId,
      p_token: params.portalToken,
      p_body: params.body,
      p_author_name: params.authorName ?? 'Client',
    });
    if (error) throw error;
    if (!data) throw new Error('Comment rejected: invalid or expired link token');
    return data as ProjectChangeRequestComment;
  }

  const { data, error } = await supabase
    .from('project_change_request_comments')
    .insert({
      change_request_id: params.changeRequestId,
      org_id: params.orgId,
      body: params.body,
      is_internal: params.isInternal,
      client_visible: params.clientVisible ?? !params.isInternal,
      author_type: params.authorType,
      author_user_id: params.authorUserId ?? null,
      author_name: params.authorName ?? null,
    })
    .select('*, author_user:users!project_change_request_comments_author_user_id_fkey(id, name, avatar_url)')
    .single();

  if (error) throw error;
  return data as ProjectChangeRequestComment;
}

export async function updateComment(
  id: string,
  body: string
): Promise<ProjectChangeRequestComment> {
  const { data, error } = await supabase
    .from('project_change_request_comments')
    .update({ body, updated_at: new Date().toISOString() })
    .eq('id', id)
    .select('*, author_user:users!project_change_request_comments_author_user_id_fkey(id, name, avatar_url)')
    .single();

  if (error) throw error;
  return data as ProjectChangeRequestComment;
}
