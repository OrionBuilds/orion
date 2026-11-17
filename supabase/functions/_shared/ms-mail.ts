/**
 * Microsoft Graph mail -> OS `conversations`/`messages`.
 *
 * Mirrors `processGmailMessage` (_shared/gmail-helpers.ts): a message is only recorded when
 * its counterpart is an active CRM contact, it joins that contact's open conversation (or opens
 * one), and an inbox_event is raised for new conversations. Dedupe is by `external_id`
 * ('ms:<immutable id>', backed by idx_messages_ms_email_external_unique).
 */
import type { SupabaseClient } from "npm:@supabase/supabase-js@2";
import { getValidAccessToken, graphFetch, type MsConfig } from "./ms-graph.ts";
import { ndrNotification, parseNdr } from "./ms-ndr.ts";
import { findContactByEmail } from "./contact-lookup.ts";
import { suggestSenderAlias } from "./sender-suggestions.ts";
import { replyClearsUnread } from "./unread.ts";

/** `syncSource` of the live Inbox / Sent Items delta feed (as opposed to a contact history backfill). */
export const INBOX_SYNC_SOURCE = "microsoft-mail-sync";

const MAX_BODY_SIZE = 200_000;

export interface GraphRecipient {
  emailAddress?: { address?: string; name?: string };
}
export interface GraphMessage {
  id: string;
  internetMessageId?: string;
  conversationId?: string;
  subject?: string;
  bodyPreview?: string;
  body?: { contentType?: string; content?: string };
  from?: GraphRecipient;
  toRecipients?: GraphRecipient[];
  ccRecipients?: GraphRecipient[];
  bccRecipients?: GraphRecipient[];
  receivedDateTime?: string;
  sentDateTime?: string;
  hasAttachments?: boolean;
  isDraft?: boolean;
  parentFolderId?: string;
  "@removed"?: unknown;
}

export interface ParsedGraphMessage {
  externalId: string;
  rfcMessageId: string | null;
  threadId: string | null;
  subject: string;
  body: string;
  bodyTruncated: boolean;
  fromEmail: string;
  fromName: string;
  toEmails: string[];
  ccEmails: string[];
  bccEmails: string[];
  sentAt: string;
  hasAttachments: boolean;
}

const addr = (r?: GraphRecipient) => (r?.emailAddress?.address ?? "").trim().toLowerCase();
const addrs = (rs?: GraphRecipient[]) => (rs ?? []).map(addr).filter(Boolean);

export function parseGraphMessage(m: GraphMessage): ParsedGraphMessage {
  const raw = m.body?.content ?? m.bodyPreview ?? "";
  // We request text bodies via Prefer; if Graph still hands back HTML, strip it down.
  const text = m.body?.contentType?.toLowerCase() === "html"
    ? raw.replace(/<style[\s\S]*?<\/style>|<script[\s\S]*?<\/script>/gi, "")
      .replace(/<br\s*\/?>|<\/p>|<\/div>/gi, "\n").replace(/<[^>]+>/g, "")
      .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    : raw;
  return {
    externalId: `ms:${m.id}`,
    rfcMessageId: m.internetMessageId ?? null,
    threadId: m.conversationId ?? null,
    subject: m.subject ?? "",
    body: text.substring(0, MAX_BODY_SIZE),
    bodyTruncated: text.length > MAX_BODY_SIZE,
    fromEmail: addr(m.from),
    fromName: m.from?.emailAddress?.name ?? "",
    toEmails: addrs(m.toRecipients),
    ccEmails: addrs(m.ccRecipients),
    bccEmails: addrs(m.bccRecipients),
    sentAt: new Date(m.sentDateTime ?? m.receivedDateTime ?? Date.now()).toISOString(),
    hasAttachments: !!m.hasAttachments,
  };
}

export async function processGraphMessage(
  supabase: SupabaseClient,
  m: GraphMessage,
  ctx: { orgId: string; userId: string; mailboxEmail: string; syncSource: string; connectionId?: string | null },
): Promise<{ processed: boolean; reason?: string; messageId?: string }> {
  if (m.isDraft) return { processed: false, reason: "draft" };
  const p = parseGraphMessage(m);
  const mailbox = ctx.mailboxEmail.toLowerCase();
  const isOutbound = p.fromEmail === mailbox;

  // A bounce for something we sent: tell the mailbox owner once, instead of dropping it as "not a contact".
  const ndr = isOutbound ? null : parseNdr(p, mailbox);
  if (ndr) {
    const { data: seen } = await supabase.from("notifications").select("id")
      .eq("user_id", ctx.userId).eq("type", "email_delivery_failed").eq("metadata->>external_id", p.externalId).limit(1).maybeSingle();
    if (!seen) await supabase.from("notifications").insert(ndrNotification(ndr, ctx.userId, p.externalId));
    return { processed: false, reason: "ndr" };
  }
  const contactEmail = isOutbound ? p.toEmails.find((e) => e !== mailbox) ?? "" : p.fromEmail;
  if (!contactEmail) return { processed: false, reason: "no counterpart" };

  const { data: dup } = await supabase.from("messages").select("id")
    .eq("organization_id", ctx.orgId).eq("external_id", p.externalId).limit(1).maybeSingle();
  if (dup) return { processed: false, reason: "duplicate", messageId: dup.id };

  // One mail CC'd to two of the user's mailboxes is ONE row: the first mailbox to sync it wins. Only when the caller
  // names its connection (a single legacy caller keeps today's behaviour exactly).
  if (ctx.connectionId && p.rfcMessageId) {
    const { data: other } = await supabase.from("messages").select("id, mailbox_connection_id")
      .eq("organization_id", ctx.orgId).eq("metadata->>internet_message_id", p.rfcMessageId).limit(1).maybeSingle();
    const o = other as { id: string; mailbox_connection_id: string | null } | null;
    if (o && o.mailbox_connection_id !== ctx.connectionId) return { processed: false, reason: "duplicate", messageId: o.id };
  }

  const contact = await findContactByEmail(supabase, ctx.orgId, contactEmail);
  if (!contact) {
    // New inbox mail from an address we don't know: if the sender's name is one of our contacts, ask the owner
    // whether it is them (a history backfill or our own sent mail never asks).
    if (!isOutbound && ctx.syncSource === INBOX_SYNC_SOURCE) {
      await suggestSenderAlias(supabase, { orgId: ctx.orgId, email: p.fromEmail, name: p.fromName, subject: p.subject, mailboxEmail: mailbox, sentAt: p.sentAt });
    }
    return { processed: false, reason: "not a known contact" };
  }

  let conversationId: string;
  const { data: existing } = await supabase.from("conversations").select("id")
    .eq("organization_id", ctx.orgId).eq("contact_id", contact.id).neq("status", "closed")
    .order("last_message_at", { ascending: false }).limit(1).maybeSingle();
  if (existing) {
    conversationId = existing.id;
  } else {
    const { data: created, error } = await supabase.from("conversations").insert({
      organization_id: ctx.orgId,
      contact_id: contact.id,
      department_id: contact.department_id,
      assigned_user_id: ctx.userId,
      status: "open",
      unread_count: 0,
    }).select("id").single();
    if (error || !created) return { processed: false, reason: `conversation insert failed: ${error?.message}` };
    conversationId = created.id;
    await supabase.from("inbox_events").insert({
      organization_id: ctx.orgId,
      conversation_id: conversationId,
      event_type: "conversation_created",
      payload: { channel: "email", contact_name: `${contact.first_name} ${contact.last_name}` },
    });
  }

  const { data: inserted, error: msgErr } = await supabase.from("messages").insert({
    organization_id: ctx.orgId,
    conversation_id: conversationId,
    contact_id: contact.id,
    channel: "email",
    direction: isOutbound ? "outbound" : "inbound",
    body: p.body,
    subject: p.subject,
    metadata: {
      provider: "microsoft_365",
      from_email: p.fromEmail,
      from_name: p.fromName,
      to_emails: p.toEmails,
      cc_emails: p.ccEmails,
      bcc_emails: p.bccEmails,
      thread_id: p.threadId,
      graph_message_id: m.id,
      rfc_message_id: p.rfcMessageId,
      internet_message_id: p.rfcMessageId,
      has_attachments: p.hasAttachments,
      body_truncated: p.bodyTruncated,
      synced_via: ctx.syncSource,
    },
    status: "delivered",
    external_id: p.externalId,
    sent_at: p.sentAt,
    ...(ctx.connectionId ? { mailbox_connection_id: ctx.connectionId, mailbox_email: mailbox } : {}),
  }).select("id").maybeSingle();
  // 23505 = lost a race with a concurrent sync; the other writer has it.
  if (msgErr) {
    return { processed: false, reason: msgErr.code === "23505" ? "duplicate" : `insert failed: ${msgErr.message}` };
  }

  if (isOutbound) {
    const cleared = await replyClearsUnread(supabase, conversationId, ctx.userId, p.sentAt);
    await supabase.from("conversations").update({
      last_message_at: p.sentAt,
      updated_at: new Date().toISOString(),
      ...(cleared ? { unread_count: 0 } : {}),
    }).eq("id", conversationId);
  } else {
    const { data: c } = await supabase.from("conversations").select("unread_count").eq("id", conversationId).single();
    await supabase.from("conversations").update({
      unread_count: (c?.unread_count ?? 0) + 1,
      last_message_at: p.sentAt,
      updated_at: new Date().toISOString(),
    }).eq("id", conversationId);
  }
  return { processed: true, messageId: inserted?.id };
}

const SELECT = [
  "id", "internetMessageId", "conversationId", "subject", "bodyPreview", "body", "from",
  "toRecipients", "ccRecipients", "bccRecipients", "receivedDateTime", "sentDateTime",
  "hasAttachments", "isDraft",
].join(",");

export const MAIL_FOLDERS = ["inbox", "sentitems"] as const;
export type MailFolder = typeof MAIL_FOLDERS[number];

/**
 * Pages one folder's delta feed. Returns the link to persist (nextLink if we ran out of page
 * budget mid-feed, deltaLink once caught up) so the next run resumes exactly there.
 */
export async function syncFolder(
  supabase: SupabaseClient,
  accessToken: string,
  folder: MailFolder,
  savedLink: string | undefined,
  ctx: { orgId: string; userId: string; mailboxEmail: string; connectionId?: string | null },
  opts: { maxPages?: number; initialDays?: number; fetchImpl?: typeof fetch } = {},
): Promise<{ link: string | null; caughtUp: boolean; processed: number; skipped: number }> {
  const maxPages = opts.maxPages ?? 10;
  const since = new Date(Date.now() - (opts.initialDays ?? 30) * 86_400_000).toISOString();
  let url = savedLink ??
    `/me/mailFolders/${folder}/messages/delta?$select=${SELECT}&$filter=receivedDateTime ge ${since}`;
  const prefer = 'odata.maxpagesize=50, outlook.body-content-type="text", IdType="ImmutableId"';
  let processed = 0, skipped = 0, pages = 0;

  while (pages < maxPages) {
    const r = await graphFetch(accessToken, url, { headers: { Prefer: prefer } }, opts.fetchImpl);
    if (r.status === 410) return { link: null, caughtUp: false, processed, skipped }; // delta expired: restart
    if (!r.ok) throw new Error(`Graph ${folder} delta failed: ${r.status}`);
    const page = await r.json() as { value: GraphMessage[]; "@odata.nextLink"?: string; "@odata.deltaLink"?: string };
    for (const m of page.value) {
      if (m["@removed"]) { skipped++; continue; }
      const res = await processGraphMessage(supabase, m, { ...ctx, syncSource: INBOX_SYNC_SOURCE });
      if (res.processed) processed++; else skipped++;
    }
    pages++;
    if (page["@odata.deltaLink"]) return { link: page["@odata.deltaLink"], caughtUp: true, processed, skipped };
    if (!page["@odata.nextLink"]) return { link: url, caughtUp: false, processed, skipped };
    url = page["@odata.nextLink"];
  }
  return { link: url, caughtUp: false, processed, skipped };
}

interface SyncConn { id: string; user_id: string; organization_id: string; email: string; is_primary: boolean }
interface SyncStateRow { id: string; user_id: string; organization_id: string; connection_id: string | null; mail_delta_links: Record<string, string> | null; last_sync_at: string | null }

/**
 * Pulls Inbox + Sent Items for every active Microsoft connection (a user may have several), oldest-synced
 * first so no mailbox starves, up to `max` connections per run. Delta links live per connection in
 * outlook_sync_state (by connection_id; a legacy row with no connection_id is adopted by the user's primary).
 * Every stored message is stamped with the mailbox it arrived on.
 */
export async function syncMailConnections(
  supabase: SupabaseClient,
  o: {
    cfg: MsConfig | null; onlyUser?: string; max?: number; maxPages?: number; fetchImpl?: typeof fetch;
    getToken?: (userId: string, connectionId: string) => Promise<string>;
  },
): Promise<{ results: Array<Record<string, unknown>>; error?: string }> {
  let q = supabase.from("microsoft_oauth_master")
    .select("id, user_id, organization_id, email, is_primary").eq("connection_status", "active");
  if (o.onlyUser) q = q.eq("user_id", o.onlyUser);
  const { data: connRows, error } = await q;
  if (error) return { results: [], error: error.message };
  const conns = (connRows ?? []) as SyncConn[];
  if (!conns.length) return { results: [] };

  const { data: stRows } = await supabase.from("outlook_sync_state")
    .select("id, user_id, organization_id, connection_id, mail_delta_links, last_sync_at")
    .in("user_id", [...new Set(conns.map((c) => c.user_id))]);
  const states = (stRows ?? []) as SyncStateRow[];
  const stateFor = (c: SyncConn) =>
    states.find((s) => s.connection_id === c.id) ??
    (c.is_primary ? states.find((s) => !s.connection_id && s.user_id === c.user_id && s.organization_id === c.organization_id) : undefined);

  const ordered = conns
    .map((c) => ({ c, st: stateFor(c) }))
    .sort((a, b) => String(a.st?.last_sync_at ?? "").localeCompare(String(b.st?.last_sync_at ?? "")))
    .slice(0, o.max ?? 10);
  const getToken = o.getToken ?? ((u: string, id: string) => getValidAccessToken(supabase, u, { cfg: o.cfg, connectionId: id, fetchImpl: o.fetchImpl }));
  const now = () => new Date().toISOString();

  const results: Array<Record<string, unknown>> = [];
  for (const { c, st } of ordered) {
    try {
      // claim (or create) this connection's own state row before touching Graph
      if (st) {
        await supabase.from("outlook_sync_state").update({ connection_id: c.id, sync_status: "syncing", updated_at: now() }).eq("id", st.id);
      } else {
        const { error: insErr } = await supabase.from("outlook_sync_state").insert({
          user_id: c.user_id, organization_id: c.organization_id, connection_id: c.id, mail_delta_links: {}, sync_status: "syncing", updated_at: now(),
        });
        if (insErr) throw new Error(`sync state: ${insErr.message}`);
      }
      const token = await getToken(c.user_id, c.id);
      const links: Record<string, string> = { ...(st?.mail_delta_links ?? {}) };
      let processed = 0;
      for (const folder of MAIL_FOLDERS) {
        const r = await syncFolder(supabase, token, folder, links[folder],
          { orgId: c.organization_id, userId: c.user_id, mailboxEmail: c.email, connectionId: c.id },
          { maxPages: o.maxPages, fetchImpl: o.fetchImpl });
        if (r.link) links[folder] = r.link; else delete links[folder];
        processed += r.processed;
      }
      await supabase.from("outlook_sync_state").update({
        mail_delta_links: links, sync_status: "idle", error_message: null, last_sync_at: now(), updated_at: now(),
      }).eq("connection_id", c.id);
      results.push({ user_id: c.user_id, connection_id: c.id, processed });
    } catch (e) {
      const msg = (e as Error).message;
      console.error(`[ms-mail-sync] ${c.user_id}/${c.id}: ${msg}`);
      await supabase.from("outlook_sync_state").update({
        sync_status: "error", error_message: msg.slice(0, 500), updated_at: now(),
      }).eq("connection_id", c.id);
      results.push({ user_id: c.user_id, connection_id: c.id, error: msg });
    }
  }
  return { results };
}

/** The connection after `currentId` in `ids` (a job that walks every mailbox); null at the end or when not found. */
export function nextConnectionId(ids: string[], currentId: string | null | undefined): string | null {
  if (!ids.length) return null;
  if (!currentId) return ids[0];
  const i = ids.indexOf(currentId);
  return i >= 0 && i + 1 < ids.length ? ids[i + 1] : null;
}

// ---------------------------------------------------------------------------------------
// Sending
// ---------------------------------------------------------------------------------------

export interface SendMailInput {
  to: string[];
  subject: string;
  body: string;
  /** "text" (default) or "html". */
  contentType?: "text" | "html";
  cc?: string[];
  bcc?: string[];
}

const dedupeEmails = (xs: string[]) => [...new Set(xs.map((e) => e.trim().toLowerCase()).filter(Boolean))];
const recipients = (xs: string[]) => xs.map((address) => ({ emailAddress: { address } }));

/**
 * Builds the Graph /me/sendMail payload. Owner-CC rule (2026-09-15): every outbound
 * email CCs the owner so he sees everything the agent sends; skipped when he is already a
 * recipient. Throws on an empty recipient list or a non-email-looking address.
 */
export function buildSendMailPayload(input: SendMailInput, ownerEmail?: string | null) {
  const to = dedupeEmails(input.to);
  if (to.length === 0) throw new Error("sendMail: at least one recipient is required");
  const cc = dedupeEmails(input.cc ?? []);
  const bcc = dedupeEmails(input.bcc ?? []);
  for (const a of [...to, ...cc, ...bcc]) {
    if (!/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(a)) throw new Error(`sendMail: invalid address: ${a}`);
  }
  const owner = ownerEmail?.trim().toLowerCase();
  if (owner && ![...to, ...cc, ...bcc].includes(owner)) cc.push(owner);
  return {
    message: {
      subject: input.subject,
      body: { contentType: input.contentType === "html" ? "HTML" : "Text", content: input.body },
      toRecipients: recipients(to),
      ccRecipients: recipients(cc),
      bccRecipients: recipients(bcc),
    },
    saveToSentItems: true,
  };
}

/** Sends via Graph. The sent copy lands in Sent Items and is logged to conversations by the sync. */
export async function sendMail(
  accessToken: string,
  input: SendMailInput,
  ownerEmail?: string | null,
  fetchImpl?: typeof fetch,
): Promise<void> {
  const payload = buildSendMailPayload(input, ownerEmail);
  const r = await graphFetch(accessToken, "/me/sendMail", { method: "POST", body: JSON.stringify(payload) }, fetchImpl);
  if (r.status !== 202) throw new Error(`Graph sendMail failed: ${r.status}`);
}

/** Reply in-thread to a message we hold (Graph keeps threading + quoting), CC'ing the owner. */
export async function replyToMessage(
  accessToken: string, graphMessageId: string, comment: string, ownerEmail?: string | null, fetchImpl?: typeof fetch,
): Promise<void> {
  const owner = ownerEmail?.trim().toLowerCase();
  const r = await graphFetch(accessToken, `/me/messages/${encodeURIComponent(graphMessageId)}/reply`, {
    method: "POST",
    body: JSON.stringify({
      comment,
      ...(owner ? { message: { ccRecipients: [{ emailAddress: { address: owner } }] } } : {}),
    }),
  }, fetchImpl);
  if (r.status !== 202) throw new Error(`Graph reply failed: ${r.status}`);
}

/** Fetch one message's internet headers (Authentication-Results, List-*, Auto-Submitted...). */
export async function fetchHeaders(accessToken: string, graphMessageId: string, fetchImpl?: typeof fetch): Promise<{ name?: string; value?: string }[]> {
  const r = await graphFetch(accessToken, `/me/messages/${encodeURIComponent(graphMessageId)}?$select=internetMessageHeaders`, { headers: { Prefer: 'IdType="ImmutableId"' } }, fetchImpl);
  if (!r.ok) throw new Error(`Graph headers failed: ${r.status}`);
  return ((await r.json()) as { internetMessageHeaders?: { name?: string; value?: string }[] }).internetMessageHeaders ?? [];
}

/**
 * File a message into the Archive folder (inbox zero for Clara's own mailbox). Graph immutable ids
 * survive a move within the mailbox, so the id we stored at sync time stays valid.
 */
export async function archiveMessage(accessToken: string, graphMessageId: string, fetchImpl?: typeof fetch): Promise<void> {
  const r = await graphFetch(accessToken, `/me/messages/${encodeURIComponent(graphMessageId)}/move`, {
    method: "POST", body: JSON.stringify({ destinationId: "archive" }), headers: { Prefer: 'IdType="ImmutableId"' },
  }, fetchImpl);
  if (!r.ok) throw new Error(`Graph archive failed: ${r.status}`);
}
