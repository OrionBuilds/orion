/**
 * Clara's drafts that need the owner's yes, through the OS approval hub (workflow_approval_queue,
 * source='agent_approval'), and the owner deciding them by text or voice.
 *
 * One queue, one decision spine: the owner approves in the OS approvals hub OR tells Clara, and both land in
 * resolve_approval_decision (audit trail included). Idempotent on (agent_slug, external_ref).
 * A draft is only ever SENT after the queue row says approved (clara-approved-sends); a rejected or
 * expired row is acknowledged and nothing goes out.
 */
import type { SupabaseClient } from "npm:@supabase/supabase-js@2";
import { inQuietHours } from "./notify.ts";

/**
 * Delivery gating every draft kind may carry. An approved draft is held (not failed, not acked)
 * until `send_after`, and outside the org's quiet hours when `respect_quiet_hours` is set.
 * `log` is merged into the `messages` row the send files, so the send shows in Conversations.
 */
interface DraftDelivery { send_after?: string | null; respect_quiet_hours?: boolean; log?: Record<string, unknown> | null }
export interface EmailDraft extends DraftDelivery { kind: "email"; to: string[]; subject: string; body: string; contact_id?: string | null }
export interface SmsDraft extends DraftDelivery { kind: "sms"; to: string; body: string; contact_id?: string | null }
export type ClaraDraft = EmailDraft | SmsDraft;

export interface NewApproval {
  orgId: string;
  externalRef: string;
  title: string;
  description?: string;
  risk?: "low" | "medium" | "high";
  /** The agent-schedule risk tier this draft belongs to (client_visible drafts always need approval). */
  riskTier?: "autonomous" | "owner_review" | "client_visible";
  draft: ClaraDraft;
  contactId?: string | null;
  expiresAt?: string | null;
}

export async function createApproval(db: SupabaseClient, a: NewApproval): Promise<{ id: string; created: boolean }> {
  const { data, error } = await db.from("workflow_approval_queue").insert({
    org_id: a.orgId, source: "agent_approval", agent_slug: "clara", external_ref: a.externalRef,
    action_type: a.draft.kind === "sms" ? "clara_sms" : "clara_email", contact_id: a.contactId ?? a.draft.contact_id ?? null,
    title: a.title.slice(0, 200), description: a.description?.slice(0, 1000) ?? null, status: "pending_approval",
    expires_at: a.expiresAt ?? null, requested_at: new Date().toISOString(),
    draft_content: {
      risk: a.risk ?? "low", ...(a.riskTier ? { risk_tier: a.riskTier, approval_required: true } : {}),
      facts: {}, draft: a.draft, mirrored_by: "clara",
    },
  }).select("id").maybeSingle();
  if (error) {
    if (error.code === "23505") {
      const { data: ex } = await db.from("workflow_approval_queue").select("id").eq("agent_slug", "clara").eq("external_ref", a.externalRef).eq("source", "agent_approval").maybeSingle();
      return { id: (ex as { id: string } | null)?.id ?? "", created: false };
    }
    throw new Error(`approval insert failed: ${error.message}`);
  }
  // The owner's notification (bell + push) comes from the queue's own trigger (fn_agent_approval_notify): writing one
  // here as well showed every Clara approval twice.
  return { id: (data as { id: string }).id, created: true };
}

export interface PendingApproval { id: string; title: string; description: string | null; agent_slug: string | null; source: string; requested_at: string }

export async function listPending(db: SupabaseClient, orgId: string, limit = 10): Promise<PendingApproval[]> {
  const { data } = await db.from("workflow_approval_queue").select("id, title, description, agent_slug, source, requested_at")
    .eq("org_id", orgId).eq("status", "pending_approval").in("source", ["agent_approval", "agent_run"]).order("requested_at").limit(limit);
  return (data ?? []) as PendingApproval[];
}

export type Decision = "approve" | "reject";

/** Decide an approval as the owner. Throws the RPC's message (already resolved, not an approver, ...). */
export async function decide(
  db: SupabaseClient, o: { approvalId: string; decision: Decision; ownerUserId: string; ownerEmail: string | null; comment?: string },
): Promise<{ status: string }> {
  const { data, error } = await db.rpc("resolve_approval_decision", {
    p_approval_id: o.approvalId, p_decision: o.decision, p_user_id: o.ownerUserId, p_email: o.ownerEmail,
    p_comment: o.comment ?? "Decided by phone/text via Clara", p_via_magic_link: false, p_ip: null, p_ua: "clara-owner-brain",
  });
  if (error) throw new Error(error.message);
  const row = (Array.isArray(data) ? data[0] : data) as { status: string } | null;
  return { status: row?.status ?? "unknown" };
}

/**
 * Approved-or-closed Clara drafts that haven't been acted on yet. The window is wider than one
 * pass's sends because approved drafts held for `send_after` / quiet hours stay unacked at the
 * front of the queue and must not starve the ones behind them.
 */
export async function undelivered(db: SupabaseClient, limit = 100) {
  const { data } = await db.from("workflow_approval_queue")
    .select("id, org_id, status, title, draft_content, external_ref")
    .eq("source", "agent_approval").eq("agent_slug", "clara").in("status", ["approved", "rejected", "expired"]).is("acked_at", null)
    .order("resolved_at").limit(limit);
  return (data ?? []) as { id: string; org_id: string; status: string; title: string; draft_content: { draft?: ClaraDraft } | null; external_ref: string }[];
}

export async function ack(db: SupabaseClient, id: string, note?: string) {
  await db.from("workflow_approval_queue").update({ acked_at: new Date().toISOString(), ...(note ? { resolution_note: note } : {}) }).eq("id", id).is("acked_at", null);
}

export interface OutgoingEmail { to: string[]; subject: string; body: string; contact_id?: string | null; log?: Record<string, unknown> | null }
export interface OutgoingSms { to: string; body: string; contact_id?: string | null; log?: Record<string, unknown> | null }

export interface DeliverDeps {
  sendEmail: (orgId: string, m: OutgoingEmail) => Promise<void>;
  /** Throws on failure (the row then retries). Absent: SMS drafts wait until a pass that can send them. */
  sendSms?: (orgId: string, m: OutgoingSms) => Promise<void>;
  /** The org's quiet window ("HH:MM-HH:MM" + IANA tz); absent or undefined spec = no quiet hours. */
  quietHours?: (orgId: string) => Promise<{ quiet?: string; tz: string }>;
  /** True when the number has opted out of texts: the draft is closed, never sent. */
  smsOptedOut?: (orgId: string, phone: string) => Promise<boolean>;
  now?: () => Date;
  onFailure?: (id: string, title: string, err: string) => Promise<void>;
  /** Most sends per pass (held rows don't count). */
  maxSends?: number;
}

/** Pure: why an approved draft must wait, or null when it may go now. */
export function holdReason(draft: ClaraDraft, now: Date, quiet?: { quiet?: string; tz: string }): string | null {
  if (draft.send_after && Date.parse(draft.send_after) > now.getTime()) return "scheduled";
  if (draft.respect_quiet_hours && quiet?.quiet && inQuietHours(quiet.quiet, quiet.tz, now)) return "quiet_hours";
  return null;
}

/**
 * Act on decided drafts: send approved emails (owner CC'd by the one send path) and texts (from
 * Clara's number), acknowledge the rest. A send that fails is NOT acked, so it retries next pass;
 * a draft that isn't due yet (send_after, quiet hours) is skipped without acking or failing; a
 * draft is never sent without an approval.
 */
export async function deliverDecided(
  db: SupabaseClient, d: DeliverDeps,
): Promise<{ sent: number; closed: number; failed: number; deferred: number }> {
  let sent = 0, closed = 0, failed = 0, deferred = 0;
  const now = (d.now ?? (() => new Date()))();
  const quietCache = new Map<string, { quiet?: string; tz: string } | undefined>();
  const quietFor = async (orgId: string) => {
    if (!d.quietHours) return undefined;
    if (!quietCache.has(orgId)) quietCache.set(orgId, await d.quietHours(orgId).catch(() => undefined));
    return quietCache.get(orgId);
  };
  for (const row of await undelivered(db)) {
    if (row.status !== "approved") { await ack(db, row.id); closed++; continue; }
    if (sent >= (d.maxSends ?? 20)) break;
    const draft = row.draft_content?.draft;
    const usable = draft && (draft.kind === "email" ? draft.to?.length > 0 && Boolean(draft.body) : draft.kind === "sms" ? Boolean(draft.to && draft.body) : false);
    if (!draft || !usable) { await ack(db, row.id, "approved but the draft was unusable; nothing sent"); failed++; continue; }
    if (holdReason(draft, now, draft.respect_quiet_hours ? await quietFor(row.org_id) : undefined)) { deferred++; continue; }
    try {
      if (draft.kind === "sms") {
        if (!d.sendSms) { deferred++; continue; }
        if (await d.smsOptedOut?.(row.org_id, draft.to)) { await ack(db, row.id, "not sent: the recipient has opted out of texts"); closed++; continue; }
        await d.sendSms(row.org_id, { to: draft.to, body: draft.body, contact_id: draft.contact_id ?? null, log: draft.log ?? null });
      } else {
        await d.sendEmail(row.org_id, { to: draft.to, subject: draft.subject, body: draft.body, contact_id: draft.contact_id ?? null, log: draft.log ?? null });
      }
      await ack(db, row.id, "sent");
      sent++;
    } catch (e) {
      failed++;
      await d.onFailure?.(row.id, row.title, (e as Error).message);
    }
  }
  return { sent, closed, failed, deferred };
}
