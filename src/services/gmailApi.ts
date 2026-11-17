import { supabase } from '../lib/supabase';
import { callEdgeFunction, parseEdgeFunctionError } from '../lib/edgeFunction';
import type { EmailAttachment } from './emailAttachments';

/** Adds `connection_id` (which Google mailbox) only when one is chosen; omitted = the primary. */
function forAccount(connectionId?: string | null): { connection_id?: string } {
  return connectionId ? { connection_id: connectionId } : {};
}

async function callGmailApi(action: string, body?: Record<string, unknown>) {
  const response = await callEdgeFunction('gmail-api', { action, ...body });

  if (!response.ok) {
    const err = await response.json().catch(() => ({}));
    throw new Error(parseEdgeFunctionError(err, `Gmail API ${action} failed`));
  }

  return response.json();
}

export async function initiateGmailOAuth(redirectUri?: string): Promise<string> {
  const response = await callEdgeFunction('gmail-oauth-start', {
    redirect_uri: redirectUri || `${window.location.origin}/settings/profile?tab=connected-accounts`,
  });

  if (!response.ok) {
    const err = await response.json().catch(() => ({}));
    throw new Error(parseEdgeFunctionError(err, 'Failed to start Gmail OAuth'));
  }

  const data = await response.json();
  return data.authUrl;
}

export async function getGmailProfile() {
  return callGmailApi('get-profile');
}

export async function listGmailMessages(query = '', maxResults = 20, pageToken?: string, connectionId?: string) {
  return callGmailApi('list-messages', { query, maxResults, pageToken, ...forAccount(connectionId) });
}

export async function getGmailMessage(messageId: string, format = 'full', connectionId?: string) {
  return callGmailApi('get-message', { messageId, format, ...forAccount(connectionId) });
}

export async function getGmailThread(threadId: string, connectionId?: string) {
  return callGmailApi('get-thread', { threadId, ...forAccount(connectionId) });
}

export async function sendGmailEmail(params: {
  to: string;
  attachments?: EmailAttachment[];
  cc?: string;
  bcc?: string;
  subject: string;
  htmlBody: string;
  threadId?: string;
  inReplyTo?: string;
  references?: string;
  conversationId?: string;
  contactId?: string;
  /** Which of the user's Google accounts sends it; omitted = the primary (the server decides). */
  fromConnectionId?: string;
}) {
  const { fromConnectionId, ...rest } = params;
  return callGmailApi('send', { ...rest, ...(fromConnectionId ? { from_connection_id: fromConnectionId } : {}) });
}

export async function replyToGmailThread(params: {
  to: string;
  attachments?: EmailAttachment[];
  cc?: string;
  bcc?: string;
  subject?: string;
  htmlBody: string;
  threadId: string;
  inReplyTo?: string;
  references?: string;
  conversationId?: string;
  contactId?: string;
  /** Which of the user's Google accounts replies; omitted = the mailbox the thread arrived on, else the primary. */
  fromConnectionId?: string;
}) {
  const { fromConnectionId, ...rest } = params;
  return callGmailApi('reply', { ...rest, ...(fromConnectionId ? { from_connection_id: fromConnectionId } : {}) });
}

export async function createGmailDraft(params: {
  to?: string;
  cc?: string;
  bcc?: string;
  subject?: string;
  htmlBody?: string;
  threadId?: string;
  connectionId?: string;
}) {
  const { connectionId, ...rest } = params;
  return callGmailApi('create-draft', { ...rest, ...forAccount(connectionId) });
}

export async function updateGmailDraft(params: {
  draftId: string;
  to?: string;
  cc?: string;
  bcc?: string;
  subject?: string;
  htmlBody?: string;
  threadId?: string;
  connectionId?: string;
}) {
  const { connectionId, ...rest } = params;
  return callGmailApi('update-draft', { ...rest, ...forAccount(connectionId) });
}

export async function deleteGmailDraft(draftId: string, connectionId?: string) {
  return callGmailApi('delete-draft', { draftId, ...forAccount(connectionId) });
}

export async function listGmailDrafts(maxResults = 20, pageToken?: string, connectionId?: string) {
  return callGmailApi('list-drafts', { maxResults, pageToken, ...forAccount(connectionId) });
}

export async function trashGmailMessage(messageId: string, connectionId?: string) {
  return callGmailApi('trash', { messageId, ...forAccount(connectionId) });
}

export async function archiveGmailMessage(messageId: string, connectionId?: string) {
  return callGmailApi('archive', { messageId, ...forAccount(connectionId) });
}

export async function modifyGmailLabels(
  messageId: string,
  addLabelIds?: string[],
  removeLabelIds?: string[],
  connectionId?: string
) {
  return callGmailApi('modify-labels', { messageId, addLabelIds, removeLabelIds, ...forAccount(connectionId) });
}

/**
 * Removes a user's Gmail rows. With `connectionId` only that Google account's rows go (the server
 * promotes the primary and fixes the mirror); without it, everything of the user's as before.
 */
export async function disconnectGmail(userId: string, connectionId?: string): Promise<void> {
  const { data: userData } = await supabase
    .from('users')
    .select('organization_id')
    .eq('id', userId)
    .maybeSingle();

  if (userData) {
    let tokens = supabase
      .from('gmail_oauth_tokens')
      .delete()
      .eq('organization_id', userData.organization_id)
      .eq('user_id', userId);
    if (connectionId) tokens = tokens.eq('connection_id', connectionId);
    await tokens;

    let state = supabase
      .from('gmail_sync_state')
      .delete()
      .eq('organization_id', userData.organization_id)
      .eq('user_id', userId);
    if (connectionId) state = state.eq('connection_id', connectionId);
    await state;
  }

  // A single removed account leaves the mirror row and the flag to the server.
  if (connectionId) return;

  await supabase
    .from('user_connected_accounts')
    .delete()
    .eq('user_id', userId)
    .eq('provider', 'google_gmail');

  await supabase
    .from('users')
    .update({ gmail_connected: false, updated_at: new Date().toISOString() })
    .eq('id', userId);
}

export async function listMessageAttachments(messageExternalId: string, connectionId?: string) {
  return callGmailApi('list-attachments', { messageId: messageExternalId, ...forAccount(connectionId) });
}

export async function getMessageAttachment(messageExternalId: string, attachmentId: string, connectionId?: string) {
  return callGmailApi('get-attachment', { messageId: messageExternalId, attachmentId, ...forAccount(connectionId) });
}

export async function downloadAttachment(messageExternalId: string, attachmentId: string, connectionId?: string): Promise<Blob> {
  const response = await callEdgeFunction('gmail-api', {
    action: 'get-attachment',
    messageId: messageExternalId,
    attachmentId,
    ...forAccount(connectionId),
  });

  if (!response.ok) {
    const err = await response.json().catch(() => ({}));
    throw new Error(parseEdgeFunctionError(err, 'Failed to download attachment'));
  }

  return response.blob();
}

export async function getAttachmentMetadata(orgId: string, gmailMessageId: string) {
  const { data, error } = await supabase
    .from('gmail_attachments')
    .select('*')
    .eq('organization_id', orgId)
    .eq('gmail_message_id', gmailMessageId);

  if (error) throw error;
  return data || [];
}

export async function getEmailLinks(orgId: string, messageId: string) {
  const { data, error } = await supabase
    .from('crm_email_links')
    .select('*')
    .eq('organization_id', orgId)
    .eq('message_id', messageId);

  if (error) throw error;
  return data || [];
}

export async function linkEmailToRecord(params: {
  orgId: string;
  userId: string;
  messageId: string;
  recordType: 'contact' | 'opportunity';
  recordId: string;
}) {
  const { data, error } = await supabase
    .from('crm_email_links')
    .upsert(
      {
        organization_id: params.orgId,
        user_id: params.userId,
        message_id: params.messageId,
        record_type: params.recordType,
        record_id: params.recordId,
      },
      { onConflict: 'organization_id,message_id,record_type,record_id' }
    )
    .select()
    .maybeSingle();

  if (error) throw error;
  return data;
}

export async function unlinkEmailFromRecord(linkId: string) {
  const { error } = await supabase
    .from('crm_email_links')
    .delete()
    .eq('id', linkId);

  if (error) throw error;
}

export async function triggerIncrementalSync(orgId: string, userId: string, connectionId?: string) {
  const response = await callEdgeFunction('gmail-sync-incremental', {
    org_id: orgId,
    user_id: userId,
    ...forAccount(connectionId),
  });

  if (!response.ok) {
    const err = await response.json().catch(() => ({}));
    throw new Error(parseEdgeFunctionError(err, 'Incremental sync failed'));
  }

  return response.json();
}

/**
 * The user's Gmail connection: the primary account by default, or the one given by `connectionId`.
 * Sync info comes from the token-free `google_connection_status` view; where that is not available
 * yet it reads the legacy per-user rows (single account).
 */
export async function getGmailConnectionStatus(userId: string, connectionId?: string): Promise<{
  connected: boolean;
  email: string | null;
  lastSyncAt: string | null;
  syncStatus: string | null;
}> {
  const { data: userData } = await supabase
    .from('users')
    .select('gmail_connected, organization_id')
    .eq('id', userId)
    .maybeSingle();

  if (!userData?.gmail_connected) {
    return { connected: false, email: null, lastSyncAt: null, syncStatus: null };
  }

  const { data: accounts, error: viewError } = await supabase
    .from('google_connection_status')
    .select('connection_id, email, is_primary, last_incremental_sync_at, sync_status');
  if (!viewError && accounts && accounts.length > 0) {
    const rows = accounts as { connection_id: string | null; email: string | null; is_primary: boolean | null; last_incremental_sync_at: string | null; sync_status: string | null }[];
    const pick = (connectionId ? rows.find((r) => r.connection_id === connectionId) : null)
      ?? rows.find((r) => r.is_primary === true)
      ?? rows[0];
    return {
      connected: true,
      email: pick.email || null,
      lastSyncAt: pick.last_incremental_sync_at || null,
      syncStatus: pick.sync_status || null,
    };
  }

  const { data: tokenData } = await supabase
    .from('gmail_oauth_tokens')
    .select('email')
    .eq('organization_id', userData.organization_id)
    .eq('user_id', userId)
    .maybeSingle();

  const { data: syncData } = await supabase
    .from('gmail_sync_state')
    .select('last_incremental_sync_at, last_full_sync_at, sync_status')
    .eq('organization_id', userData.organization_id)
    .eq('user_id', userId)
    .maybeSingle();

  return {
    connected: true,
    email: tokenData?.email || null,
    lastSyncAt: syncData?.last_incremental_sync_at || syncData?.last_full_sync_at || null,
    syncStatus: syncData?.sync_status || null,
  };
}
