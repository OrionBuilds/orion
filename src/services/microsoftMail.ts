import { callEdgeFunction, parseEdgeFunctionError } from '../lib/edgeFunction';

async function callMsMail(action: string, body?: Record<string, unknown>) {
  const response = await callEdgeFunction('microsoft-mail', { action, ...body });
  if (!response.ok) {
    const err = await response.json().catch(() => ({}));
    throw new Error(parseEdgeFunctionError(err, `Microsoft mail ${action} failed`));
  }
  return response.json();
}

const splitAddrs = (v?: string) =>
  (v ?? '').split(',').map((s) => s.trim()).filter(Boolean);

/** Send a new Outlook email (owner CC'd server-side). */
export async function sendOutlookEmail(params: {
  to: string; subject: string; htmlBody: string; cc?: string; bcc?: string;
  /** Send from this connected account (2+ accounts only); omitted = the primary. */
  fromConnectionId?: string;
}) {
  return callMsMail('send', {
    ...(params.fromConnectionId ? { from_connection_id: params.fromConnectionId } : {}),
    to: splitAddrs(params.to), cc: splitAddrs(params.cc), bcc: splitAddrs(params.bcc),
    subject: params.subject, body: params.htmlBody, contentType: 'html',
  });
}

/** Reply in-thread to a held Outlook message (id like "ms:<graphId>"). */
export async function replyToOutlookMessage(params: { messageId: string; htmlBody: string; fromConnectionId?: string }) {
  return callMsMail('reply', {
    messageId: params.messageId,
    body: params.htmlBody,
    ...(params.fromConnectionId ? { from_connection_id: params.fromConnectionId } : {}),
  });
}

export async function getOutlookThread(conversationId: string) {
  return callMsMail('get-thread', { threadId: conversationId });
}

export async function createOutlookDraft(params: { to: string; subject?: string; htmlBody: string; cc?: string; bcc?: string }) {
  return callMsMail('create-draft', {
    to: splitAddrs(params.to), cc: splitAddrs(params.cc), bcc: splitAddrs(params.bcc),
    subject: params.subject ?? '', body: params.htmlBody, contentType: 'html',
  });
}
export async function updateOutlookDraft(messageId: string, params: { to: string; subject?: string; htmlBody: string; cc?: string; bcc?: string }) {
  return callMsMail('update-draft', {
    messageId, to: splitAddrs(params.to), cc: splitAddrs(params.cc), bcc: splitAddrs(params.bcc),
    subject: params.subject ?? '', body: params.htmlBody, contentType: 'html',
  });
}
export async function deleteOutlookDraft(messageId: string) { return callMsMail('delete-draft', { messageId }); }
export async function sendOutlookDraft(messageId: string) { return callMsMail('send-draft', { messageId }); }

export async function trashOutlookMessage(messageId: string) { return callMsMail('trash', { messageId }); }
export async function archiveOutlookMessage(messageId: string) { return callMsMail('archive', { messageId }); }
export async function moveOutlookMessage(messageId: string, destinationId: string) { return callMsMail('move', { messageId, destinationId }); }
export async function markOutlookRead(messageId: string, isRead = true) { return callMsMail('mark-read', { messageId, isRead }); }
export async function flagOutlookMessage(messageId: string, flagged = true) { return callMsMail('set-flag', { messageId, flagged }); }
export async function setOutlookCategories(messageId: string, categories: string[]) { return callMsMail('set-categories', { messageId, categories }); }

export async function listOutlookAttachments(messageId: string) { return callMsMail('list-attachments', { messageId }); }
export async function getOutlookAttachment(messageId: string, attachmentId: string) { return callMsMail('get-attachment', { messageId, attachmentId }); }
export async function listOutlookFolders() { return callMsMail('list-folders'); }
