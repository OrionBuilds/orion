import type { SupabaseClient } from "npm:@supabase/supabase-js@2";
import { findContactByEmail } from "./contact-lookup.ts";
import { suggestSenderAlias } from "./sender-suggestions.ts";
import { replyClearsUnread } from "./unread.ts";

const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GMAIL_API_URL = "https://gmail.googleapis.com/gmail/v1";

const MAX_BODY_SIZE = 256_000;

export interface GmailTokenRecord {
  id: string;
  organization_id: string;
  user_id: string;
  access_token: string;
  refresh_token: string;
  token_expiry: string;
  email: string;
}

export interface ParsedGmailMessage {
  fromEmail: string;
  fromName: string;
  toEmails: string[];
  ccEmails: string[];
  bccEmails: string[];
  subject: string;
  date: string;
  rfcMessageId: string;
  inReplyTo: string;
  references: string;
  threadId: string;
  gmailMessageId: string;
  labelIds: string[];
  snippet: string;
  internalDate: string;
  body: string;
  bodyTruncated: boolean;
  bodySizeBytes: number;
  isHtml: boolean;
  hasAttachments: boolean;
  attachments: AttachmentMeta[];
}

export interface AttachmentMeta {
  attachmentId: string;
  filename: string;
  mimeType: string;
  size: number;
}

export function extractEmailAddress(emailString: string): string {
  const match = emailString.match(/<([^>]+)>/);
  if (match) return match[1].toLowerCase();
  return emailString.trim().toLowerCase();
}

export function extractEmailName(emailString: string): string {
  const match = emailString.match(/^"?([^"<]+)"?\s*</);
  if (match) return match[1].trim();
  return "";
}

function parseAddressList(header: string): string[] {
  if (!header) return [];
  return header
    .split(",")
    .map((s) => extractEmailAddress(s.trim()))
    .filter(Boolean);
}

export function decodeBase64Url(data: string): string {
  const base64 = data.replace(/-/g, "+").replace(/_/g, "/");
  try {
    return decodeURIComponent(
      atob(base64)
        .split("")
        .map((c) => "%" + ("00" + c.charCodeAt(0).toString(16)).slice(-2))
        .join("")
    );
  } catch {
    return atob(base64);
  }
}

function extractBodyFromParts(
  parts: Array<{
    mimeType: string;
    body?: { data?: string; size?: number };
    parts?: Array<unknown>;
  }>
): { body: string; isHtml: boolean; sizeBytes: number } {
  for (const part of parts) {
    if (part.mimeType === "text/plain" && part.body?.data) {
      const decoded = decodeBase64Url(part.body.data);
      return { body: decoded, isHtml: false, sizeBytes: decoded.length };
    }
  }
  for (const part of parts) {
    if (part.mimeType === "text/html" && part.body?.data) {
      const decoded = decodeBase64Url(part.body.data);
      return { body: decoded, isHtml: true, sizeBytes: decoded.length };
    }
  }
  for (const part of parts) {
    if (
      part.mimeType?.startsWith("multipart/") &&
      Array.isArray(part.parts)
    ) {
      const nested = extractBodyFromParts(
        part.parts as Array<{
          mimeType: string;
          body?: { data?: string; size?: number };
          parts?: Array<unknown>;
        }>
      );
      if (nested.body) return nested;
    }
  }
  return { body: "", isHtml: false, sizeBytes: 0 };
}

export function extractEmailBody(payload: {
  body?: { data?: string; size?: number };
  mimeType?: string;
  parts?: Array<{
    mimeType: string;
    body?: { data?: string; size?: number; attachmentId?: string };
    parts?: Array<unknown>;
    filename?: string;
  }>;
}): { body: string; isHtml: boolean; sizeBytes: number; truncated: boolean } {
  if (payload.body?.data) {
    const decoded = decodeBase64Url(payload.body.data);
    const isHtml = payload.mimeType === "text/html";
    const truncated = decoded.length > MAX_BODY_SIZE;
    return {
      body: truncated ? decoded.substring(0, MAX_BODY_SIZE) : decoded,
      isHtml,
      sizeBytes: decoded.length,
      truncated,
    };
  }

  if (payload.parts) {
    const result = extractBodyFromParts(
      payload.parts as Array<{
        mimeType: string;
        body?: { data?: string; size?: number };
        parts?: Array<unknown>;
      }>
    );
    const truncated = result.sizeBytes > MAX_BODY_SIZE;
    return {
      body: truncated
        ? result.body.substring(0, MAX_BODY_SIZE)
        : result.body,
      isHtml: result.isHtml,
      sizeBytes: result.sizeBytes,
      truncated,
    };
  }

  return { body: "", isHtml: false, sizeBytes: 0, truncated: false };
}

function extractAttachments(
  parts: Array<{
    mimeType: string;
    body?: { attachmentId?: string; size?: number };
    filename?: string;
    parts?: Array<unknown>;
  }>
): AttachmentMeta[] {
  const attachments: AttachmentMeta[] = [];

  for (const part of parts) {
    if (part.body?.attachmentId && part.filename) {
      attachments.push({
        attachmentId: part.body.attachmentId,
        filename: part.filename,
        mimeType: part.mimeType,
        size: part.body.size || 0,
      });
    }
    if (Array.isArray(part.parts)) {
      attachments.push(
        ...extractAttachments(
          part.parts as Array<{
            mimeType: string;
            body?: { attachmentId?: string; size?: number };
            filename?: string;
            parts?: Array<unknown>;
          }>
        )
      );
    }
  }

  return attachments;
}

export function parseGmailMessage(
  msgData: Record<string, unknown>
): ParsedGmailMessage {
  const payload = msgData.payload as {
    headers?: Array<{ name: string; value: string }>;
    body?: { data?: string; size?: number };
    mimeType?: string;
    parts?: Array<{
      mimeType: string;
      body?: { data?: string; size?: number; attachmentId?: string };
      filename?: string;
      parts?: Array<unknown>;
    }>;
  };

  const headers = payload?.headers || [];
  const getHeader = (name: string) =>
    headers.find(
      (h: { name: string }) => h.name.toLowerCase() === name.toLowerCase()
    )?.value || "";

  const from = getHeader("From");
  const to = getHeader("To");
  const cc = getHeader("Cc");
  const bcc = getHeader("Bcc");
  const subject = getHeader("Subject");
  const date = getHeader("Date");
  const rfcMessageId = getHeader("Message-ID") || getHeader("Message-Id");
  const inReplyTo = getHeader("In-Reply-To");
  const references = getHeader("References");

  const bodyResult = extractEmailBody(payload);
  const attachments = payload?.parts
    ? extractAttachments(
        payload.parts as Array<{
          mimeType: string;
          body?: { attachmentId?: string; size?: number };
          filename?: string;
          parts?: Array<unknown>;
        }>
      )
    : [];

  return {
    fromEmail: extractEmailAddress(from),
    fromName: extractEmailName(from),
    toEmails: parseAddressList(to),
    ccEmails: parseAddressList(cc),
    bccEmails: parseAddressList(bcc),
    subject,
    date,
    rfcMessageId,
    inReplyTo,
    references,
    threadId: msgData.threadId as string,
    gmailMessageId: msgData.id as string,
    labelIds: (msgData.labelIds as string[]) || [],
    snippet: (msgData.snippet as string) || "",
    internalDate: msgData.internalDate as string,
    body: bodyResult.body,
    bodyTruncated: bodyResult.truncated,
    bodySizeBytes: bodyResult.sizeBytes,
    isHtml: bodyResult.isHtml,
    hasAttachments: attachments.length > 0,
    attachments,
  };
}

// Access tokens: use getMailboxToken (_shared/gmail-mailbox.ts) / getGoogleAccessToken (_shared/google-connections.ts). The old
// getAccessToken refreshed from a gmail_oauth_tokens row and copied the result over the user's single master row, which with
// several Google accounts would overwrite another account's tokens.

/** Sync sources that carry mail as it arrives (a push, or the incremental poll), as opposed to a history import. */
const LIVE_SYNC_SOURCES = new Set(["push", "incremental_poll", "incremental_job"]);
const NOT_INBOX = ["SPAM", "TRASH", "DRAFT", "CATEGORY_PROMOTIONS", "CATEGORY_SOCIAL", "CATEGORY_UPDATES", "CATEGORY_FORUMS"];
/** Pure: mail Gmail filed in the inbox proper (not spam, trash, or a promotions/social/updates tab). */
export function isInboxMail(labelIds: string[] | null | undefined): boolean {
  const labels = labelIds ?? [];
  return labels.includes("INBOX") && !NOT_INBOX.some((l) => labels.includes(l));
}

/** The mailbox a message was read from: its connection (null for a legacy caller that only knows the address) and address. */
export interface GmailMessageMailbox { connectionId?: string | null; email: string }

export async function processGmailMessage(
  supabase: SupabaseClient,
  msgData: Record<string, unknown>,
  orgId: string,
  userId: string,
  mailbox: string | GmailMessageMailbox,
  syncSource: string
): Promise<{ processed: boolean; messageId?: string; duplicate?: boolean }> {
  const parsed = parseGmailMessage(msgData);
  const mailboxEmail = typeof mailbox === "string" ? mailbox : mailbox.email;
  const mailboxConnectionId = typeof mailbox === "string" ? null : mailbox.connectionId ?? null;

  // The same RFC message can reach several connected mailboxes (the owner and a teammate both on a thread): keep ONE row,
  // the first mailbox's, instead of one per mailbox.
  if (parsed.rfcMessageId) {
    const { data: dup } = await supabase
      .from("messages")
      .select("id")
      .eq("organization_id", orgId)
      .eq("metadata->>rfc_message_id", parsed.rfcMessageId)
      .limit(1)
      .maybeSingle();
    if (dup) return { processed: false, duplicate: true };
  }

  // Direction is judged against THIS mailbox's address.
  const isOutbound =
    parsed.fromEmail.toLowerCase() === mailboxEmail.toLowerCase() ||
    parsed.labelIds.includes("SENT");

  const isInbound = !isOutbound;

  const contactEmail = isInbound
    ? parsed.fromEmail
    : parsed.toEmails[0] || "";

  if (!contactEmail) return { processed: false };

  const contact = await findContactByEmail(supabase, orgId, contactEmail);

  if (!contact) {
    // New inbox mail from an address we don't know: if the sender's name is one of our contacts, ask the owner
    // whether it is them. Only for live mail (not a history sync) that Gmail itself put in the inbox.
    if (isInbound && LIVE_SYNC_SOURCES.has(syncSource) && isInboxMail(parsed.labelIds)) {
      await suggestSenderAlias(supabase, {
        orgId, email: parsed.fromEmail, name: parsed.fromName, subject: parsed.subject, mailboxEmail,
        sentAt: parsed.internalDate ? new Date(parseInt(parsed.internalDate)).toISOString() : null,
      });
    }
    return { processed: false };
  }

  let conversation = null;
  const { data: existingConv } = await supabase
    .from("conversations")
    .select("id")
    .eq("organization_id", orgId)
    .eq("contact_id", contact.id)
    .neq("status", "closed")
    .order("last_message_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (existingConv) {
    conversation = existingConv;
  } else {
    const { data: newConv } = await supabase
      .from("conversations")
      .insert({
        organization_id: orgId,
        contact_id: contact.id,
        department_id: contact.department_id,
        status: "open",
        unread_count: 0,
      })
      .select()
      .single();

    conversation = newConv;

    await supabase.from("inbox_events").insert({
      organization_id: orgId,
      conversation_id: conversation.id,
      event_type: "conversation_created",
      payload: {
        channel: "email",
        contact_name: `${contact.first_name} ${contact.last_name}`,
      },
    });
  }

  const sentAt = parsed.date
    ? new Date(parsed.date).toISOString()
    : new Date(parseInt(parsed.internalDate)).toISOString();

  const { data: insertedMsg } = await supabase
    .from("messages")
    .insert({
      organization_id: orgId,
      conversation_id: conversation.id,
      contact_id: contact.id,
      channel: "email",
      direction: isInbound ? "inbound" : "outbound",
      body: parsed.body.substring(0, MAX_BODY_SIZE),
      subject: parsed.subject,
      metadata: {
        from_email: parsed.fromEmail,
        from_name: parsed.fromName,
        to_emails: parsed.toEmails,
        cc_emails: parsed.ccEmails,
        bcc_emails: parsed.bccEmails,
        thread_id: parsed.threadId,
        gmail_message_id: parsed.gmailMessageId,
        rfc_message_id: parsed.rfcMessageId,
        in_reply_to: parsed.inReplyTo,
        references: parsed.references,
        label_ids: parsed.labelIds,
        has_attachments: parsed.hasAttachments,
        body_truncated: parsed.bodyTruncated,
        body_size_bytes: parsed.bodySizeBytes,
        synced_via: syncSource,
      },
      status: "delivered",
      external_id: parsed.gmailMessageId,
      mailbox_email: mailboxEmail,
      mailbox_google_connection_id: mailboxConnectionId,
      sent_at: sentAt,
    })
    .select("id")
    .maybeSingle();

  if (parsed.hasAttachments && parsed.attachments.length > 0) {
    const attachmentRows = parsed.attachments.map((att) => ({
      organization_id: orgId,
      user_id: userId,
      gmail_message_id: parsed.gmailMessageId,
      attachment_id: att.attachmentId,
      filename: att.filename,
      mime_type: att.mimeType,
      size_bytes: att.size,
    }));

    await supabase.from("gmail_attachments").upsert(attachmentRows, {
      onConflict: "gmail_message_id,attachment_id",
      ignoreDuplicates: true,
    });
  }

  if (isInbound) {
    const { data: convData } = await supabase
      .from("conversations")
      .select("unread_count")
      .eq("id", conversation.id)
      .single();

    await supabase
      .from("conversations")
      .update({
        unread_count: (convData?.unread_count || 0) + 1,
        last_message_at: sentAt,
        updated_at: new Date().toISOString(),
      })
      .eq("id", conversation.id);
  } else {
    const cleared = await replyClearsUnread(supabase, conversation.id, userId, sentAt);
    await supabase
      .from("conversations")
      .update({
        last_message_at: sentAt,
        updated_at: new Date().toISOString(),
        ...(cleared ? { unread_count: 0 } : {}),
      })
      .eq("id", conversation.id);
  }

  if (insertedMsg) {
    await supabase.from("crm_email_links").upsert(
      {
        organization_id: orgId,
        user_id: userId,
        message_id: insertedMsg.id,
        record_type: "contact",
        record_id: contact.id,
      },
      { onConflict: "organization_id,message_id,record_type,record_id", ignoreDuplicates: true }
    );
  }

  return { processed: true, messageId: insertedMsg?.id };
}

export function encodeBase64Url(str: string): string {
  const encoder = new TextEncoder();
  const data = encoder.encode(str);
  const bytes = new Uint8Array(data);
  let binary = "";
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/**
 * RFC 2047 'B' encoding for header values containing non-ASCII bytes
 * (emoji, accented characters, etc.). Without this wrapper, Gmail's
 * downstream falls back to Latin-1 and renders mojibake like
 * `Ã°ÂŸÂ‘‹` instead of 👋 for UTF-8 subjects. ASCII-only values pass
 * through untouched so log/filter tools that grep subjects keep working.
 */
function encodeHeader(value: string): string {
  // eslint-disable-next-line no-control-regex
  if (/^[\x00-\x7F]*$/.test(value)) return value;
  const utf8 = new TextEncoder().encode(value);
  let binary = "";
  for (const b of utf8) binary += String.fromCharCode(b);
  return `=?UTF-8?B?${btoa(binary)}?=`;
}

/** Standard base64 (not url-safe) for binary attachment payloads, chunked to
 *  avoid call-stack limits on large files. */
export function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function wrapBase64(b64: string): string {
  return (b64.match(/.{1,76}/g) || []).join("\r\n");
}

export interface RawEmailAttachment {
  filename: string;
  mimeType: string;
  base64: string;
}

export function buildRawEmail(params: {
  to: string;
  cc?: string;
  bcc?: string;
  subject: string;
  body: string;
  inReplyTo?: string;
  references?: string;
  fromEmail?: string;
  attachments?: RawEmailAttachment[];
}): string {
  const lines: string[] = [];
  if (params.fromEmail) lines.push(`From: ${params.fromEmail}`);
  lines.push(`To: ${params.to}`);
  if (params.cc) lines.push(`Cc: ${params.cc}`);
  if (params.bcc) lines.push(`Bcc: ${params.bcc}`);
  lines.push(`Subject: ${encodeHeader(params.subject)}`);
  if (params.inReplyTo) lines.push(`In-Reply-To: ${params.inReplyTo}`);
  if (params.references) lines.push(`References: ${params.references}`);
  lines.push("MIME-Version: 1.0");

  const attachments = params.attachments ?? [];

  if (attachments.length === 0) {
    lines.push("Content-Type: text/html; charset=utf-8");
    lines.push("");
    lines.push(params.body);
    return encodeBase64Url(lines.join("\r\n"));
  }

  // multipart/mixed: HTML body part + one base64 part per attachment.
  const boundary = `b_${crypto.randomUUID().replace(/-/g, "")}`;
  lines.push(`Content-Type: multipart/mixed; boundary="${boundary}"`);
  lines.push("");
  lines.push(`--${boundary}`);
  lines.push("Content-Type: text/html; charset=utf-8");
  lines.push("");
  lines.push(params.body);
  for (const att of attachments) {
    const safeName = att.filename.replace(/["\r\n]/g, "");
    lines.push(`--${boundary}`);
    lines.push(`Content-Type: ${att.mimeType || "application/octet-stream"}; name="${safeName}"`);
    lines.push("Content-Transfer-Encoding: base64");
    lines.push(`Content-Disposition: attachment; filename="${safeName}"`);
    lines.push("");
    lines.push(wrapBase64(att.base64));
  }
  lines.push(`--${boundary}--`);
  return encodeBase64Url(lines.join("\r\n"));
}

export { GMAIL_API_URL, GOOGLE_TOKEN_URL };
