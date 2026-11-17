/**
 * One outbound-mail dispatcher: every OS/agent email goes through `dispatchMail`, which sends via
 * the organization's chosen provider (organization_mail_settings.outbound_provider).
 *
 *   microsoft (default)  Graph sendMail / reply from the sender's connected mailbox. Unchanged behaviour:
 *                        Sent Items holds the copy and the Outlook sync logs it to conversations.
 *   resend               Resend from a verified domain; Reply-To = the sender's real Microsoft mailbox so
 *                        replies arrive through the normal Graph sync. Resend leaves no Sent Items copy, so
 *                        the send is logged to conversations here (external_id = the Resend id, which the
 *                        resend-webhook matches to update delivery status).
 *
 * This sits BELOW the callers' own gates (client-comms switch, approvals queue, owner checks): it only
 * decides which pipe carries a send that was already allowed. The owner is CC'd on everything, on both
 * providers (standing rule), unless he is already a recipient.
 */
import type { SupabaseClient } from "npm:@supabase/supabase-js@2";
import { getValidAccessToken, resolveMsConnection } from "./ms-graph.ts";
import { replyToMessage, sendMail, type SendMailInput } from "./ms-mail.ts";
import { findContactByEmail } from "./contact-lookup.ts";
import { resolveResendApiKey, sendResendEmail, type SendResendEmailOptions, type SendResendEmailResult } from "./resend.ts";

export type OutboundProvider = "microsoft" | "resend";

export interface MailSettings {
  provider: OutboundProvider;
  fromEmail: string | null;
  fromName: string | null;
  agentSenders: Record<string, { email?: string; name?: string }>;
}

export interface DispatchInput {
  /** users.id of the sender (the agent or person whose mailbox this is). */
  userId: string;
  /** The Graph message id (bare or 'ms:'-prefixed) to answer in-thread; omit for a new message. */
  replyToMessageId?: string | null;
  mail: SendMailInput;
  /** Owner address to CC (OWNER_CC_EMAIL); null/undefined = no CC. */
  ownerEmail?: string | null;
  /**
   * Which of the sender's Microsoft accounts (microsoft_oauth_master.id) to send from. Must belong to `userId`
   * (else MailSelectorError). Default: a reply goes out from the mailbox the message arrived on, a new message from the primary.
   */
  fromConnectionId?: string | null;
}

/** The caller named a Microsoft account that is not theirs (map to HTTP 403). */
export class MailSelectorError extends Error {
  constructor(message = "That Microsoft account is not connected for this user") { super(message); this.name = "MailSelectorError"; }
}

export interface DispatchResult { provider: OutboundProvider; messageId: string | null; logged: boolean }

export interface DispatchDeps {
  env?: { get(k: string): string | undefined };
  getToken?: (db: SupabaseClient, userId: string, opts?: { connectionId?: string }) => Promise<string>;
  resend?: (o: SendResendEmailOptions) => Promise<SendResendEmailResult>;
}

const EMAIL_RE = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;
const clean = (xs: string[] | undefined) => [...new Set((xs ?? []).map((e) => e.trim().toLowerCase()).filter(Boolean))];

export function parseMailSettings(row: Record<string, unknown> | null | undefined): MailSettings {
  const provider: OutboundProvider = row?.outbound_provider === "resend" ? "resend" : "microsoft";
  const senders = row?.agent_senders && typeof row.agent_senders === "object" ? row.agent_senders as MailSettings["agentSenders"] : {};
  return {
    provider,
    fromEmail: (row?.resend_from_email as string | null)?.trim() || null,
    fromName: (row?.resend_from_name as string | null)?.trim() || null,
    agentSenders: senders,
  };
}

export async function loadMailSettings(db: SupabaseClient, orgId: string): Promise<MailSettings> {
  const { data } = await db.from("organization_mail_settings")
    .select("outbound_provider, resend_from_email, resend_from_name, agent_senders")
    .eq("organization_id", orgId).maybeSingle();
  return parseMailSettings(data as Record<string, unknown> | null);
}

/** Per-user override, else the org default. Null when neither is configured (the send is refused, not guessed). */
export function pickSender(s: MailSettings, userId: string, userName: string | null): { email: string; name: string | null } | null {
  const own = s.agentSenders[userId];
  const email = (own?.email || s.fromEmail || "").trim();
  if (!EMAIL_RE.test(email)) return null;
  return { email, name: (own?.name || (own?.email ? userName : s.fromName) || userName || null) };
}

/** To/Cc/Bcc with the owner CC rule applied: validated, de-duplicated, owner added unless already a recipient. */
export function resolveRecipients(mail: SendMailInput, ownerEmail?: string | null) {
  const to = clean(mail.to), cc = clean(mail.cc), bcc = clean(mail.bcc);
  if (to.length === 0) throw new Error("sendMail: at least one recipient is required");
  for (const a of [...to, ...cc, ...bcc]) if (!EMAIL_RE.test(a)) throw new Error(`sendMail: invalid address: ${a}`);
  const owner = ownerEmail?.trim().toLowerCase();
  if (owner && ![...to, ...cc, ...bcc].includes(owner)) cc.push(owner);
  return { to, cc, bcc };
}

const escapeHtml = (t: string) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export function buildResendOptions(
  input: { mail: SendMailInput; ownerEmail?: string | null; headers?: Record<string, string> },
  sender: { email: string; name: string | null },
  replyTo: string | null,
  apiKey: string,
  tags: Record<string, string>,
): SendResendEmailOptions {
  const { to, cc, bcc } = resolveRecipients(input.mail, input.ownerEmail);
  const html = input.mail.contentType === "html";
  return {
    apiKey,
    from: sender.email,
    fromName: sender.name ?? undefined,
    to,
    subject: input.mail.subject,
    ...(html ? { html: input.mail.body } : { text: input.mail.body, html: `<div style="white-space:pre-wrap">${escapeHtml(input.mail.body)}</div>` }),
    replyTo: replyTo ?? undefined,
    cc: cc.length ? cc : undefined,
    bcc: bcc.length ? bcc : undefined,
    customHeaders: input.headers,
    customArgs: tags,
  };
}

interface StoredMail { subject: string; counterpart: string; rfcId: string | null; references: string | null }

/** The message we are answering, from our own log (no Graph call: Graph is the thing that is blocked). */
async function loadReplyTarget(db: SupabaseClient, orgId: string, mailbox: string, id: string): Promise<StoredMail | null> {
  const bare = id.replace(/^ms:/, "");
  const { data } = await db.from("messages").select("subject, direction, metadata")
    .eq("organization_id", orgId).in("external_id", [`ms:${bare}`, bare]).limit(1).maybeSingle();
  const m = data as { subject: string | null; direction: string; metadata: Record<string, unknown> | null } | null;
  if (!m) return null;
  const md = m.metadata ?? {};
  const from = String(md.from_email ?? "").toLowerCase();
  const tos = ((md.to_emails as string[] | undefined) ?? []).map((e) => e.toLowerCase());
  const counterpart = m.direction === "inbound" ? from : tos.find((e) => e !== mailbox) ?? "";
  if (!counterpart) return null;
  const refs = [md.references, md.rfc_message_id].filter((x) => typeof x === "string" && x).join(" ").trim();
  return { subject: m.subject ?? "", counterpart, rfcId: (md.rfc_message_id as string | null) ?? null, references: refs || null };
}

/** The mailbox a stored message arrived on (messages.mailbox_connection_id), or null for legacy rows / unknown messages. */
async function messageMailbox(db: SupabaseClient, orgId: string | null, id: string): Promise<string | null> {
  const bare = id.replace(/^ms:/, "");
  let q = db.from("messages").select("mailbox_connection_id").in("external_id", [`ms:${bare}`, bare]);
  if (orgId) q = q.eq("organization_id", orgId);
  const { data } = await q.limit(1).maybeSingle();
  return (data as { mailbox_connection_id: string | null } | null)?.mailbox_connection_id ?? null;
}

/**
 * Which connection a mail action runs on. Explicit id: must be one of `userId`'s accounts (MailSelectorError otherwise).
 * No id: the mailbox of the message being answered/acted on when it is one of the user's accounts, else undefined = the primary.
 */
export async function resolveMailConnection(
  db: SupabaseClient, userId: string, o: { connectionId?: string | null; messageId?: string | null; orgId?: string | null },
): Promise<string | undefined> {
  if (o.connectionId) {
    const c = await resolveMsConnection(db, userId, { connectionId: o.connectionId });
    if (!c) throw new MailSelectorError();
    return c.id;
  }
  if (o.messageId) {
    const arrived = await messageMailbox(db, o.orgId ?? null, o.messageId).catch(() => null);
    if (arrived) return (await resolveMsConnection(db, userId, { connectionId: arrived }))?.id;
  }
  return undefined;
}

const rePrefix = (s: string) => (/^\s*re:/i.test(s) ? s : `Re: ${s}`.trim());

/** Log a Resend send into the contact's open conversation, exactly where the Graph sync would have put it. */
async function logSend(
  db: SupabaseClient,
  c: { orgId: string; userId: string; resendId: string; from: string; to: string[]; cc: string[]; bcc: string[]; subject: string; body: string; mailbox: string; connectionId?: string | null },
): Promise<boolean> {
  const counterpart = c.to.find((e) => e !== c.mailbox) ?? "";
  if (!counterpart) return false;
  const contact = await findContactByEmail(db, c.orgId, counterpart);
  if (!contact) return false; // same rule as the inbox sync: only people in the CRM are conversations
  let conversationId: string;
  const { data: existing } = await db.from("conversations").select("id")
    .eq("organization_id", c.orgId).eq("contact_id", contact.id).neq("status", "closed")
    .order("last_message_at", { ascending: false }).limit(1).maybeSingle();
  if (existing) conversationId = existing.id;
  else {
    const { data: created, error } = await db.from("conversations").insert({
      organization_id: c.orgId, contact_id: contact.id, department_id: contact.department_id,
      assigned_user_id: c.userId, status: "open", unread_count: 0,
    }).select("id").single();
    if (error || !created) return false;
    conversationId = created.id;
    await db.from("inbox_events").insert({
      organization_id: c.orgId, conversation_id: conversationId, event_type: "conversation_created",
      payload: { channel: "email", contact_name: `${contact.first_name} ${contact.last_name}` },
    });
  }
  const sentAt = new Date().toISOString();
  const { error } = await db.from("messages").insert({
    organization_id: c.orgId, conversation_id: conversationId, contact_id: contact.id,
    channel: "email", direction: "outbound", body: c.body.slice(0, 200_000), subject: c.subject,
    metadata: {
      provider: "resend", from_email: c.from, to_emails: c.to, cc_emails: c.cc, bcc_emails: c.bcc,
      sent_by_user_id: c.userId, synced_via: "mail-dispatch",
    },
    status: "sent", delivery_status: "queued", external_id: c.resendId, sent_at: sentAt,
    ...(c.connectionId ? { mailbox_connection_id: c.connectionId, mailbox_email: c.mailbox } : {}),
  });
  if (error) { console.error("[mail-dispatch] log failed:", error.message); return false; }
  await db.from("conversations").update({ last_message_at: sentAt, updated_at: sentAt }).eq("id", conversationId);
  return true;
}

export async function dispatchMail(db: SupabaseClient, input: DispatchInput, deps: DispatchDeps = {}): Promise<DispatchResult> {
  const env = deps.env ?? Deno.env;
  const getToken = deps.getToken ?? getValidAccessToken;
  const { data: u } = await db.from("users").select("organization_id, email, name").eq("id", input.userId).maybeSingle();
  const user = u as { organization_id: string | null; email: string | null; name: string | null } | null;
  const settings = user?.organization_id ? await loadMailSettings(db, user.organization_id) : parseMailSettings(null);

  const connectionId = await resolveMailConnection(db, input.userId, {
    connectionId: input.fromConnectionId, messageId: input.replyToMessageId, orgId: user?.organization_id ?? null,
  });

  if (settings.provider === "microsoft" || !user?.organization_id) {
    const token = connectionId ? await getToken(db, input.userId, { connectionId }) : await getToken(db, input.userId);
    if (input.replyToMessageId) {
      await replyToMessage(token, input.replyToMessageId, input.mail.body, input.ownerEmail);
    } else {
      await sendMail(token, input.mail, input.ownerEmail);
    }
    return { provider: "microsoft", messageId: null, logged: false };
  }

  // --- Resend ---
  if (!env.get("RESEND_API_KEY")?.trim() && !resolveResendApiKey(settings.fromEmail, env)) {
    throw new Error("Resend isn't configured (RESEND_API_KEY)");
  }
  const sender = pickSender(settings, input.userId, user.name);
  if (!sender) throw new Error("No Resend sender address is set for this organization (organization_mail_settings.resend_from_email)");
  // Key by the sender's domain (RESEND_API_KEY__<DOMAIN>), falling back to the default key.
  const key = resolveResendApiKey(sender.email, env);
  if (!key) throw new Error(`Resend isn't configured for ${sender.email} (RESEND_API_KEY)`);
  const apiKey = key.apiKey;

  // Replies land in the sender's real mailbox (the Graph sync records them there).
  // A user may have several accounts: the one this send is from (else the primary), never an arbitrary row.
  const ms = await resolveMsConnection(db, input.userId, { connectionId });
  const mailbox = (ms?.email ?? user.email ?? "").trim().toLowerCase() || null;

  let mail = input.mail;
  let headers: Record<string, string> | undefined;
  if (input.replyToMessageId) {
    const t = await loadReplyTarget(db, user.organization_id, mailbox ?? "", input.replyToMessageId);
    if (!t) throw new Error("sendMail: the message to reply to isn't in the log, so it can't be answered in-thread");
    mail = { ...input.mail, to: [t.counterpart], subject: rePrefix(t.subject) };
    if (t.rfcId) headers = { "In-Reply-To": t.rfcId, References: t.references ?? t.rfcId };
  }

  const opts = buildResendOptions({ mail, ownerEmail: input.ownerEmail, headers }, sender, mailbox, apiKey,
    { orion_user: input.userId, orion_org: user.organization_id });
  const res = await (deps.resend ?? sendResendEmail)(opts);
  if (!res.ok || !res.messageId) throw new Error(`Resend send failed: ${res.error ?? res.status}`);

  const to = clean(opts.to as string[]);
  const logged = await logSend(db, {
    orgId: user.organization_id, userId: input.userId, resendId: res.messageId, from: sender.email,
    to, cc: opts.cc ?? [], bcc: opts.bcc ?? [], subject: mail.subject, body: mail.body, mailbox: mailbox ?? "", connectionId: ms?.id ?? null,
  }).catch((e) => { console.error("[mail-dispatch] log error:", (e as Error).message); return false; });
  return { provider: "resend", messageId: res.messageId, logged };
}
