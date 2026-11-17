/**
 * Logging Clara's calls and texts into the OS conversations module.
 *
 * One OPEN conversation per contact, shared across channels (sms, voice, email), matching what
 * twilio-sms-inbound and the email sync already do. A call becomes messages on that thread:
 *   - "Call started" / "Call ended ..." (channel voice, message_type call_event)
 *   - the transcript (message_type call_transcript) once available
 * plus one call_logs row per Twilio SID (duration, recording, transcript, summary).
 */
import type { SupabaseClient } from "npm:@supabase/supabase-js@2";

type Db = SupabaseClient;

export interface ContactRef { id: string; created: boolean }

/** Find a contact by phone (normalized match via RPC). Never creates one: contacts come from bookings, forms or manual entry. */
export async function resolveContactByPhone(db: Db, orgId: string, phone: string): Promise<ContactRef | null> {
  const { data: matched } = await db.rpc("find_contact_id_by_phone", { p_org: orgId, p_phone: phone });
  return matched ? { id: matched as string, created: false } : null;
}

export interface ConversationRef { id: string; created: boolean }

export async function findOrCreateConversation(
  db: Db,
  i: { orgId: string; contactId: string; channel: "sms" | "voice" | "email"; departmentId?: string | null; assignedUserId?: string | null },
): Promise<ConversationRef> {
  const { data: existing } = await db.from("conversations").select("id, assigned_user_id")
    .eq("organization_id", i.orgId).eq("contact_id", i.contactId).neq("status", "closed")
    .order("last_message_at", { ascending: false }).limit(1).maybeSingle();
  if (existing) {
    const e = existing as { id: string; assigned_user_id: string | null };
    // Hand an unassigned thread to the agent that is now handling it; never steal an assigned one.
    if (i.assignedUserId && !e.assigned_user_id) {
      await db.from("conversations").update({ assigned_user_id: i.assignedUserId }).eq("id", e.id).is("assigned_user_id", null);
    }
    return { id: e.id, created: false };
  }
  const { data, error } = await db.from("conversations").insert({
    organization_id: i.orgId,
    contact_id: i.contactId,
    department_id: i.departmentId ?? null,
    channel: i.channel,
    status: "open",
    unread_count: 0,
    assigned_user_id: i.assignedUserId ?? null,
  }).select("id").single();
  if (error || !data) throw new Error(`conversation create failed: ${error?.message}`);
  return { id: (data as { id: string }).id, created: true };
}

interface MsgInput {
  orgId: string; conversationId: string; contactId: string;
  channel: "sms" | "voice" | "email";
  direction: "inbound" | "outbound" | "system";
  body: string;
  subject?: string | null;
  messageType: string;
  externalId?: string | null;
  senderName?: string | null;
  senderIdentifier?: string | null;
  mediaUrls?: string[] | null;
  metadata?: Record<string, unknown>;
  at?: string;
}

export async function insertMessage(db: Db, m: MsgInput): Promise<string | null> {
  const at = m.at ?? new Date().toISOString();
  const { data, error } = await db.from("messages").insert({
    organization_id: m.orgId,
    conversation_id: m.conversationId,
    contact_id: m.contactId,
    channel: m.channel,
    direction: m.direction,
    body: m.body,
    ...(m.subject ? { subject: m.subject } : {}),
    message_type: m.messageType,
    sender_name: m.senderName ?? null,
    sender_identifier: m.senderIdentifier ?? null,
    media_urls: m.mediaUrls?.length ? m.mediaUrls : null,
    metadata: m.metadata ?? {},
    status: "delivered",
    delivery_status: "delivered",
    external_id: m.externalId ?? null,
    sent_at: at,
  }).select("id").maybeSingle();
  if (error) {
    // 23505 on idx_messages_sms_external_id_unique: Twilio redelivered the same MessageSid.
    if (error.code === "23505") return null;
    throw new Error(`message insert failed: ${error.message}`);
  }
  await db.from("conversations").update({ last_message_at: at, updated_at: at }).eq("id", m.conversationId);
  return (data as { id: string } | null)?.id ?? null;
}

export async function bumpUnread(db: Db, conversationId: string): Promise<void> {
  const { data } = await db.from("conversations").select("unread_count").eq("id", conversationId).single();
  await db.from("conversations").update({ unread_count: ((data as { unread_count: number } | null)?.unread_count ?? 0) + 1 }).eq("id", conversationId);
}

// ── call_logs ────────────────────────────────────────────────────────────────────────────────

export interface CallLogUpsert {
  orgId: string;
  callSid: string;
  direction: "inbound" | "outbound";
  from: string;
  to: string;
  conversationId?: string | null;
  contactId?: string | null;
  line?: "business" | "work" | "owner";
  agentUserId?: string | null;
  status?: string;
}

/**
 * One row per Twilio SID; voice-answer, status, finalize and recording callbacks all land on it.
 * Only the fields a caller actually passes are written to an existing row: the finalizer linking
 * a conversation must not reset the status the status callback already wrote, nor the line the
 * first hit decided.
 */
export async function upsertCallLog(db: Db, c: CallLogUpsert): Promise<void> {
  const patch: Record<string, unknown> = {};
  if (c.conversationId !== undefined) patch.conversation_id = c.conversationId;
  if (c.contactId !== undefined) patch.contact_id = c.contactId;
  if (c.line) patch.line = c.line;
  if (c.agentUserId !== undefined) patch.agent_user_id = c.agentUserId;
  if (c.status) patch.status = c.status;

  const { data: existing, error: readError } = await db.from("call_logs").select("id").eq("twilio_call_sid", c.callSid).maybeSingle();
  if (readError) throw new Error(`call_logs lookup failed: ${readError.message}`);
  if (existing) {
    if (Object.keys(patch).length === 0) return;
    const { error } = await db.from("call_logs").update(patch).eq("twilio_call_sid", c.callSid);
    if (error) throw new Error(`call_logs update failed: ${error.message}`);
    return;
  }
  const row: Record<string, unknown> = {
    organization_id: c.orgId,
    twilio_call_sid: c.callSid,
    direction: c.direction,
    from_number: c.from,
    to_number: c.to,
    status: c.status ?? "initiated",
    ...patch,
  };
  // Two callbacks can race to create the row; the loser simply applies its patch.
  const { error } = await db.from("call_logs").upsert(row, { onConflict: "twilio_call_sid" });
  if (error) throw new Error(`call_logs upsert failed: ${error.message}`);
}

const TERMINAL = new Set(["completed", "failed", "busy", "no-answer", "canceled"]);

/** Status callback: record status/duration/end time against the right columns (the old code wrote nonexistent ones). */
export async function applyCallStatus(
  db: Db, callSid: string, status: string, durationSec: number | null, answeredBy?: string,
): Promise<void> {
  const update: Record<string, unknown> = { status };
  if (durationSec !== null && Number.isFinite(durationSec)) update.duration = durationSec;
  if (TERMINAL.has(status)) update.ended_at = new Date().toISOString();
  if (answeredBy) update.answered_by = answeredBy;
  // Twilio's progress callbacks (initiated/ringing/answered) can arrive after "completed"; a
  // finished call must never be re-labelled as in flight.
  let q = db.from("call_logs").update(update).eq("twilio_call_sid", callSid);
  if (!TERMINAL.has(status)) q = q.is("ended_at", null);
  const { error } = await q;
  if (error) throw new Error(`call_logs status failed: ${error.message}`);
}

export const durationText = (sec: number) => (sec >= 60 ? `${Math.floor(sec / 60)}m ${sec % 60}s` : `${sec}s`);
