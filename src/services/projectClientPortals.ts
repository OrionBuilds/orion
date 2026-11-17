import { supabase } from '../lib/supabase';
import {
  portalListChangeRequests, portalGetChangeRequest, portalListChangeRequestComments,
  portalListSupportTickets, portalGetSupportTicket, portalListTicketComments,
  portalApproveChangeRequest, portalRejectChangeRequest,
  portalAddChangeRequestComment, portalAddTicketComment,
} from './clientPortal';

export interface ClientPortal {
  id: string;
  org_id: string;
  project_id: string;
  contact_id: string | null;
  portal_token_hash: string;
  portal_token: string | null;
  status: 'active' | 'revoked' | 'expired';
  expires_at: string | null;
  last_accessed_at: string | null;
  created_by_user_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface ClientPortalWithProject extends ClientPortal {
  project?: {
    id: string;
    name: string;
    status: string;
    description: string | null;
    start_date: string | null;
    target_end_date: string | null;
    updated_at: string;
    org_id: string;
    contact_id: string | null;
  } | null;
  contact?: {
    id: string;
    first_name: string | null;
    last_name: string | null;
    email: string | null;
    phone: string | null;
  } | null;
  organization?: {
    id: string;
    name: string;
    email: string | null;
    phone: string | null;
    website: string | null;
  } | null;
  created_by_user?: { id: string; name: string; email: string } | null;
}

export interface PortalEvent {
  id: string;
  portal_id: string;
  project_id: string;
  contact_id: string | null;
  event_type: string;
  metadata: Record<string, unknown>;
  ip_address: string | null;
  user_agent: string | null;
  created_at: string;
}

async function computeHash(value: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(value);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');
}

function generateSecureToken(): { raw: string; hashPromise: Promise<string> } {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  const raw = Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('');
  return { raw, hashPromise: computeHash(raw) };
}

export function buildPortalUrl(rawToken: string): string {
  return `${window.location.origin}/portal/project/${rawToken}`;
}

export async function createPortal(params: {
  projectId: string;
  orgId: string;
  contactId?: string;
  createdByUserId: string;
  expiresAt?: string;
}): Promise<{ portal: ClientPortal; rawToken: string; portalUrl: string }> {
  const token = generateSecureToken();
  const tokenHash = await token.hashPromise;

  const { data, error } = await supabase
    .from('project_client_portals')
    .insert({
      org_id: params.orgId,
      project_id: params.projectId,
      contact_id: params.contactId ?? null,
      portal_token_hash: tokenHash,
      portal_token: token.raw,
      status: 'active',
      expires_at: params.expiresAt ?? null,
      created_by_user_id: params.createdByUserId,
    })
    .select()
    .single();

  if (error) throw error;

  return {
    portal: data as ClientPortal,
    rawToken: token.raw,
    portalUrl: buildPortalUrl(token.raw),
  };
}

export async function verifyPortalToken(rawToken: string): Promise<ClientPortalWithProject | null> {
  const tokenHash = await computeHash(rawToken);

  const { data, error } = await supabase
    .from('project_client_portals')
    .select(`
      *,
      project:projects(id, name, status, description, start_date, target_end_date, updated_at, org_id, contact_id),
      contact:contacts(id, first_name, last_name, email, phone),
      organization:organizations(id, name, email, phone, website),
      created_by_user:users!project_client_portals_created_by_user_id_fkey(id, name, email)
    `)
    .eq('portal_token_hash', tokenHash)
    .eq('status', 'active')
    .maybeSingle();

  if (error || !data) return null;

  const portal = data as ClientPortalWithProject;

  if (portal.expires_at && new Date(portal.expires_at) < new Date()) {
    await supabase
      .from('project_client_portals')
      .update({ status: 'expired', updated_at: new Date().toISOString() })
      .eq('id', portal.id);
    return null;
  }

  await supabase
    .from('project_client_portals')
    .update({ last_accessed_at: new Date().toISOString(), updated_at: new Date().toISOString() })
    .eq('id', portal.id);

  return portal;
}

export async function getPortalsByProject(projectId: string): Promise<ClientPortalWithProject[]> {
  const { data, error } = await supabase
    .from('project_client_portals')
    .select(`
      *,
      contact:contacts(id, first_name, last_name, email, phone),
      created_by_user:users!project_client_portals_created_by_user_id_fkey(id, name, email)
    `)
    .eq('project_id', projectId)
    .order('created_at', { ascending: false });

  if (error) throw error;
  return (data ?? []) as ClientPortalWithProject[];
}

export async function revokePortal(portalId: string): Promise<void> {
  const { error } = await supabase
    .from('project_client_portals')
    .update({ status: 'revoked', updated_at: new Date().toISOString() })
    .eq('id', portalId);

  if (error) throw error;
}

export async function extendPortalExpiration(portalId: string, expiresAt: string): Promise<void> {
  const { error } = await supabase
    .from('project_client_portals')
    .update({ expires_at: expiresAt, status: 'active', updated_at: new Date().toISOString() })
    .eq('id', portalId);

  if (error) throw error;
}

export async function regeneratePortalToken(portalId: string): Promise<{ rawToken: string; portalUrl: string }> {
  const token = generateSecureToken();
  const tokenHash = await token.hashPromise;

  const { error } = await supabase
    .from('project_client_portals')
    .update({ portal_token_hash: tokenHash, portal_token: token.raw, status: 'active', updated_at: new Date().toISOString() })
    .eq('id', portalId);

  if (error) throw error;

  return { rawToken: token.raw, portalUrl: buildPortalUrl(token.raw) };
}

export async function logPortalEvent(params: {
  portalId: string;
  projectId: string;
  contactId?: string | null;
  eventType: string;
  metadata?: Record<string, unknown>;
  ipAddress?: string;
  userAgent?: string;
}): Promise<boolean> {
  // Write to the new client_portal_events table (the old
  // project_client_portal_events table was dropped). portalId is now
  // the client_portal_accounts.id (set by the bridge component).
  //
  // Supabase reports failures in the returned {error}, not by throwing — the
  // old try/catch here almost never ran, so a blocked account lookup or a
  // refused insert silently dropped the audit event (an approval would succeed
  // with no security trail, and nothing anywhere said so). Check both results
  // explicitly; still never break the portal UI over bookkeeping, but say what
  // was lost and let callers see it. (Codex finding #17.)
  try {
    const { data: account, error: accountError } = await supabase
      .from('client_portal_accounts')
      .select('org_id')
      .eq('id', params.portalId)
      .maybeSingle();
    if (accountError || !account?.org_id) {
      console.warn(
        `[logPortalEvent] "${params.eventType}" NOT recorded — account ${params.portalId} lookup failed ` +
        `(${accountError?.message ?? 'no row / no org_id'}); the audit trail is missing this event.`
      );
      return false;
    }

    const { error: insertError } = await supabase.from('client_portal_events').insert({
      org_id: account.org_id,
      account_id: params.portalId,
      project_id: params.projectId,
      contact_id: params.contactId ?? null,
      event_type: params.eventType,
      metadata: params.metadata ?? {},
      ip_address: params.ipAddress ?? null,
      user_agent: params.userAgent ?? null,
    });
    if (insertError) {
      console.warn(
        `[logPortalEvent] "${params.eventType}" NOT recorded for account ${params.portalId}: ${insertError.message}; ` +
        `the audit trail is missing this event.`
      );
      return false;
    }
    return true;
  } catch (err) {
    console.warn(`[logPortalEvent] "${params.eventType}" NOT recorded (unexpected):`, err);
    return false;
  }
}

export async function getPortalEvents(portalId: string): Promise<PortalEvent[]> {
  const { data, error } = await supabase
    .from('client_portal_events')
    .select('*')
    .eq('account_id', portalId)
    .order('created_at', { ascending: false });

  if (error) throw error;
  return (data ?? []) as PortalEvent[];
}

export async function clientApproveChangeRequest(params: {
  requestId: string;
  portalId: string;
  projectId: string;
  contactId?: string | null;
  userAgent?: string;
}): Promise<void> {
  await portalApproveChangeRequest(params.requestId);
  await logPortalEvent({
    portalId: params.portalId,
    projectId: params.projectId,
    contactId: params.contactId,
    eventType: 'project_change_request.client_approved',
    metadata: { change_request_id: params.requestId },
    userAgent: params.userAgent ?? navigator.userAgent,
  });
}

export async function clientRejectChangeRequest(params: {
  requestId: string;
  portalId: string;
  projectId: string;
  contactId?: string | null;
  reason?: string;
  userAgent?: string;
}): Promise<void> {
  await portalRejectChangeRequest(params.requestId, params.reason);
  await logPortalEvent({
    portalId: params.portalId,
    projectId: params.projectId,
    contactId: params.contactId,
    eventType: 'project_change_request.client_rejected',
    metadata: { change_request_id: params.requestId, reason: params.reason },
    userAgent: params.userAgent ?? navigator.userAgent,
  });
}

export async function clientAddComment(params: {
  changeRequestId: string;
  orgId: string;
  body: string;
  authorName: string;
  portalId: string;
  projectId: string;
  contactId?: string | null;
}): Promise<void> {
  await portalAddChangeRequestComment(params.changeRequestId, params.body, params.authorName);
  await logPortalEvent({
    portalId: params.portalId,
    projectId: params.projectId,
    contactId: params.contactId,
    eventType: 'project_change_request.client_replied',
    metadata: { change_request_id: params.changeRequestId },
    userAgent: navigator.userAgent,
  });
}

// Reads now route through the session-validated client-portal-auth edge function (service role)
// instead of anon table access, so the token-blind anon RLS policies can be dropped. Signatures
// are unchanged so the V1 portal pages need no edits.
export async function getPortalChangeRequests(projectId: string, statusFilter?: string[]): Promise<import('../types').ProjectChangeRequest[]> {
  return (await portalListChangeRequests(projectId, statusFilter)) as import('../types').ProjectChangeRequest[];
}

export async function getPortalChangeRequestById(requestId: string): Promise<import('../types').ProjectChangeRequest | null> {
  return (await portalGetChangeRequest(requestId)) as import('../types').ProjectChangeRequest | null;
}

export async function getPortalComments(changeRequestId: string): Promise<import('../types').ProjectChangeRequestComment[]> {
  return (await portalListChangeRequestComments(changeRequestId)) as import('../types').ProjectChangeRequestComment[];
}

export async function getPortalSupportTickets(projectId: string): Promise<import('../types').ProjectSupportTicket[]> {
  return (await portalListSupportTickets(projectId)) as import('../types').ProjectSupportTicket[];
}

export async function getPortalSupportTicketById(ticketId: string): Promise<import('../types').ProjectSupportTicket | null> {
  return (await portalGetSupportTicket(ticketId)) as import('../types').ProjectSupportTicket | null;
}

export async function getPortalTicketComments(ticketId: string): Promise<import('../types').ProjectSupportTicketComment[]> {
  return (await portalListTicketComments(ticketId)) as import('../types').ProjectSupportTicketComment[];
}

export async function clientAddTicketComment(params: {
  supportTicketId: string;
  orgId: string;
  body: string;
  authorName: string;
  portalId: string;
  projectId: string;
  contactId?: string | null;
}): Promise<void> {
  await portalAddTicketComment(params.supportTicketId, params.body, params.authorName);
  await logPortalEvent({
    portalId: params.portalId,
    projectId: params.projectId,
    contactId: params.contactId,
    eventType: 'project_support_ticket.client_replied',
    metadata: { support_ticket_id: params.supportTicketId },
    userAgent: navigator.userAgent,
  });
}

export function getPortalTicketStats(tickets: import('../types').ProjectSupportTicket[]) {
  return {
    open: tickets.filter((t) => ['new', 'in_review', 'in_progress'].includes(t.status)).length,
    waitingOnClient: tickets.filter((t) => t.status === 'waiting_on_client').length,
    resolved: tickets.filter((t) => ['resolved', 'closed'].includes(t.status)).length,
  };
}

export function getPortalStats(requests: import('../types').ProjectChangeRequest[]) {
  const openStatuses = ['submitted', 'under_review', 'needs_more_info', 'scheduled', 'in_progress'];
  return {
    open: requests.filter((r) => openStatuses.includes(r.status)).length,
    awaitingApproval: requests.filter((r) => r.status === 'quoted_awaiting_approval').length,
    completed: requests.filter((r) => r.status === 'completed').length,
    totalApprovedValue: requests
      .filter((r) => ['approved', 'completed'].includes(r.status))
      .reduce((sum, r) => sum + (Number(r.cost_impact) || 0), 0),
  };
}
