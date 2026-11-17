/**
 * Microsoft Graph mail operations for the user-facing mailbox UI (drafts, labels/folders, flags,
 * thread view, attachments) — the write/interactive side that mirrors gmail-api's actions. The
 * read sync and send/reply live in ms-mail.ts; this builds on graphFetch from ms-graph.ts.
 */
import { graphFetch } from "./ms-graph.ts";
import { type GraphMessage, parseGraphMessage } from "./ms-mail.ts";

type F = typeof fetch;
const enc = encodeURIComponent;
const MSG_SELECT = "id,conversationId,subject,from,toRecipients,ccRecipients,receivedDateTime,sentDateTime,bodyPreview,body,isRead,isDraft,hasAttachments,flag,parentFolderId";

export interface DraftInput {
  to: string[]; cc?: string[]; bcc?: string[]; subject: string; body: string; contentType?: "text" | "html";
}
const recips = (xs?: string[]) => (xs ?? []).map((address) => ({ emailAddress: { address } }));
const draftBody = (d: DraftInput) => ({
  subject: d.subject,
  body: { contentType: d.contentType === "html" ? "HTML" : "Text", content: d.body },
  toRecipients: recips(d.to), ccRecipients: recips(d.cc), bccRecipients: recips(d.bcc),
});

/** Create a draft in the mailbox; returns its id. */
export async function createDraft(token: string, d: DraftInput, f?: F): Promise<{ id: string }> {
  const r = await graphFetch(token, "/me/messages", { method: "POST", body: JSON.stringify(draftBody(d)) }, f);
  if (!r.ok) throw new Error(`Graph create draft failed: ${r.status}`);
  return { id: (await r.json() as { id: string }).id };
}

export async function updateDraft(token: string, id: string, d: DraftInput, f?: F): Promise<void> {
  const r = await graphFetch(token, `/me/messages/${enc(id)}`, { method: "PATCH", body: JSON.stringify(draftBody(d)) }, f);
  if (!r.ok) throw new Error(`Graph update draft failed: ${r.status}`);
}

export async function deleteDraft(token: string, id: string, f?: F): Promise<void> {
  const r = await graphFetch(token, `/me/messages/${enc(id)}`, { method: "DELETE" }, f);
  if (!r.ok && r.status !== 204) throw new Error(`Graph delete draft failed: ${r.status}`);
}

export async function sendDraft(token: string, id: string, f?: F): Promise<void> {
  const r = await graphFetch(token, `/me/messages/${enc(id)}/send`, { method: "POST" }, f);
  if (r.status !== 202 && !(r.ok)) throw new Error(`Graph send draft failed: ${r.status}`);
}

/** Move to Deleted Items (the Outlook "trash"). */
export async function trashMessage(token: string, id: string, f?: F): Promise<void> {
  const r = await graphFetch(token, `/me/messages/${enc(id)}/move`, {
    method: "POST", body: JSON.stringify({ destinationId: "deleteditems" }), headers: { Prefer: 'IdType="ImmutableId"' },
  }, f);
  if (!r.ok) throw new Error(`Graph trash failed: ${r.status}`);
}

/** Move to a well-known or explicit folder id (inbox, archive, junkemail, deleteditems, …). */
export async function moveMessage(token: string, id: string, destinationId: string, f?: F): Promise<void> {
  const r = await graphFetch(token, `/me/messages/${enc(id)}/move`, {
    method: "POST", body: JSON.stringify({ destinationId }), headers: { Prefer: 'IdType="ImmutableId"' },
  }, f);
  if (!r.ok) throw new Error(`Graph move failed: ${r.status}`);
}

export async function setRead(token: string, id: string, isRead: boolean, f?: F): Promise<void> {
  const r = await graphFetch(token, `/me/messages/${enc(id)}`, { method: "PATCH", body: JSON.stringify({ isRead }) }, f);
  if (!r.ok) throw new Error(`Graph mark read failed: ${r.status}`);
}

export async function setFlag(token: string, id: string, flagged: boolean, f?: F): Promise<void> {
  const r = await graphFetch(token, `/me/messages/${enc(id)}`, {
    method: "PATCH", body: JSON.stringify({ flag: { flagStatus: flagged ? "flagged" : "notFlagged" } }),
  }, f);
  if (!r.ok) throw new Error(`Graph flag failed: ${r.status}`);
}

/** Outlook categories ≈ Gmail labels: replace the message's category set. */
export async function setCategories(token: string, id: string, categories: string[], f?: F): Promise<void> {
  const r = await graphFetch(token, `/me/messages/${enc(id)}`, { method: "PATCH", body: JSON.stringify({ categories }) }, f);
  if (!r.ok) throw new Error(`Graph categories failed: ${r.status}`);
}

/** All messages in a conversation (thread), oldest first — mirrors Gmail get-thread. */
export async function listThread(token: string, conversationId: string, f?: F) {
  const r = await graphFetch(token,
    `/me/messages?$filter=conversationId eq '${conversationId.replace(/'/g, "''")}'&$select=${MSG_SELECT}&$orderby=receivedDateTime asc&$top=50`,
    { headers: { Prefer: 'IdType="ImmutableId"' } }, f);
  if (!r.ok) throw new Error(`Graph thread failed: ${r.status}`);
  const msgs = (await r.json() as { value: GraphMessage[] }).value ?? [];
  return { messages: msgs.map(parseGraphMessage) };
}

export async function getMessage(token: string, id: string, f?: F) {
  const r = await graphFetch(token, `/me/messages/${enc(id)}?$select=${MSG_SELECT}`, { headers: { Prefer: 'IdType="ImmutableId"' } }, f);
  if (!r.ok) throw new Error(`Graph get message failed: ${r.status}`);
  return parseGraphMessage(await r.json() as GraphMessage);
}

export interface AttachmentMeta { id: string; name: string; contentType: string; size: number }

export async function listAttachments(token: string, messageId: string, f?: F): Promise<AttachmentMeta[]> {
  const r = await graphFetch(token, `/me/messages/${enc(messageId)}/attachments?$select=id,name,contentType,size`, {}, f);
  if (!r.ok) throw new Error(`Graph attachments failed: ${r.status}`);
  return ((await r.json() as { value: AttachmentMeta[] }).value ?? []);
}

/** Returns a file attachment's bytes as base64 (Graph's contentBytes). */
export async function getAttachment(token: string, messageId: string, attachmentId: string, f?: F): Promise<{ name: string; contentType: string; contentBytes: string }> {
  const r = await graphFetch(token, `/me/messages/${enc(messageId)}/attachments/${enc(attachmentId)}`, {}, f);
  if (!r.ok) throw new Error(`Graph attachment fetch failed: ${r.status}`);
  const j = await r.json() as { name: string; contentType: string; contentBytes?: string };
  return { name: j.name, contentType: j.contentType, contentBytes: j.contentBytes ?? "" };
}

export async function listMailFolders(token: string, f?: F): Promise<{ id: string; displayName: string }[]> {
  const r = await graphFetch(token, "/me/mailFolders?$select=id,displayName&$top=100", {}, f);
  if (!r.ok) throw new Error(`Graph folders failed: ${r.status}`);
  return ((await r.json() as { value: { id: string; displayName: string }[] }).value ?? []);
}
