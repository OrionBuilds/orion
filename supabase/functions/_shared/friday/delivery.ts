/**
 * Applies the owner's decision on FRIDAY's portal approvals (agent_slug friday, ref os-triage:*).
 *
 * Nothing client-visible reaches a portal thread before the queue row says approved. FRIDAY's old
 * worker acks every friday agent_approval row it pulls (unknown refs included), so we never rely on
 * acked_at: delivery is tracked in friday_triage_deliveries and re-tried until it sticks.
 */
import type { SupabaseClient } from "npm:@supabase/supabase-js@2";
import type { Env } from "../clara/phones.ts";
import {
  AGENT, CLARIFY_PARKED, REF_PREFIX, SCOPE_REJECTED, authorName, crHopsToApproved, crMarker, draftClarifyQuestion, draftScopeApproved,
  notifyOwnerBell, postClientReply, postComment, saveState, setStatus, short, ticketMarker,
  type ActionType, type Budget, type Kind, type PortalAction,
} from "./portal.ts";

export const MAX_DELIVERY_ATTEMPTS = 5;

interface Row { id: string; org_id: string; status: string; action_type: ActionType; external_ref: string; draft_content: { draft?: { action?: PortalAction } } | null; resolved_at: string | null }

async function currentStatus(db: SupabaseClient, kind: Kind, id: string): Promise<string | null> {
  const { data } = await db.from(kind === "ticket" ? "project_support_tickets" : "project_change_requests").select("status").eq("id", id).maybeSingle();
  return (data as { status: string } | null)?.status ?? null;
}

/** Apply one decided action. Throws when something that must persist did not (the delivery then retries). */
export async function applyDecided(db: SupabaseClient, env: Env, type: ActionType, a: PortalAction, approved: boolean): Promise<string> {
  const kind = a.kind, id = a.item_id, orgId = a.org_id;
  const marker = kind === "ticket" ? ticketMarker(id) : crMarker(id);

  if (type === "friday_ticket_reply" || type === "friday_cr_reply" || type === "friday_portal_nudge") {
    if (!approved) return "rejected: nothing posted";
    const r = await postClientReply(db, env, kind, { orgId, id, body: String(a.body ?? "") });
    const next = String(a.next_status ?? "");
    if (next && kind === "ticket") {
      const cur = await currentStatus(db, kind, id);
      if (cur && cur !== next) await setStatus(db, kind, { orgId, id, status: next, fromStatus: cur }); // best effort: a missed advance re-sweeps, never duplicates
    }
    return r;
  }

  if (type === "friday_ticket_clarify" || type === "friday_cr_clarify") {
    if (!approved) {
      // "Don't ask" means proceed anyway with stated assumptions, never leave the item stuck.
      await saveState(db, kind, { orgId, itemId: id }, { stage: "resolve_pending", pending_action: { type: "force_resolve" } });
      return "rejected: will proceed without asking";
    }
    const question = String(a.question ?? "");
    const subject = String(a.subject ?? "");
    await postComment(db, kind, { orgId, id, body: draftClarifyQuestion(env, a.client_name as string | undefined, subject, question), internal: false, author: authorName(env) });
    const cur = await currentStatus(db, kind, id);
    const target = kind === "ticket" ? "waiting_on_client" : "needs_more_info";
    if (cur && cur !== target) await setStatus(db, kind, { orgId, id, status: target, fromStatus: cur });
    await postComment(db, kind, { orgId, id, body: `FRIDAY: clarifying question posted. ${marker} ${CLARIFY_PARKED}`, internal: true, author: "FRIDAY" }).catch(() => {});
    await saveState(db, kind, { orgId, itemId: id }, { stage: "clarify_awaiting", round: Number(a.round ?? 1), question, asked_at: new Date().toISOString(), nudged_at: null, escalated_at: null, pending_action: null });
    return "question posted";
  }

  if (type === "friday_cr_scope") {
    if (!approved) {
      await postComment(db, "cr", { orgId, id, body: `FRIDAY: owner rejected proceeding with this out-of-scope request; it stays under review, nothing was sent to the client. Schedule a scope call with the client. ${crMarker(id)} ${SCOPE_REJECTED}`, internal: true, author: "FRIDAY" }).catch(() => {});
      await notifyOwnerBell(db, env, orgId, { title: `Follow up with ${a.client_name || "the client"} on "${a.title}"`, body: "You declined the out-of-scope change request. FRIDAY sent nothing; a scope call with the client is the next step.", dedupe: `scope-rejected:${id}` });
      await saveState(db, "cr", { orgId, itemId: id }, { stage: "done" });
      return "rejected: owner notified";
    }
    await postClientReply(db, env, "cr", { orgId, id, body: draftScopeApproved(env, String(a.title ?? ""), a.client_name as string | undefined) });
    let status = await currentStatus(db, "cr", id);
    for (const next of crHopsToApproved(status)) {
      const ok = await setStatus(db, "cr", { orgId, id, status: next, fromStatus: status ?? undefined,
        extra: next === "quoted_awaiting_approval" ? { client_summary: "Approved by the team to proceed with the out-of-scope work." } : {} });
      if (!ok) throw new Error(`could not move CR ${short(id)} to ${next}`);
      status = next;
    }
    if (!status || !["approved", "scheduled", "in_progress", "completed"].includes(status)) throw new Error(`could not advance CR to approved (status=${status ?? "unknown"})`);
    await saveState(db, "cr", { orgId, itemId: id }, { stage: "triaged" });
    return "approved: CR moved to approved";
  }
  return "unknown action";
}

/** The delivery pass for a set of action types. Stops taking new rows when the time budget is spent. */
export async function deliverDecidedPortal(
  db: SupabaseClient, env: Env, o: { types: ActionType[]; budget: Budget; max?: number },
): Promise<{ delivered: number; failed: number; closed: number }> {
  const { data } = await db.from("workflow_approval_queue")
    .select("id, org_id, status, action_type, external_ref, draft_content, resolved_at")
    .eq("agent_slug", AGENT).eq("source", "agent_approval").in("action_type", o.types).in("status", ["approved", "rejected"])
    .like("external_ref", `${REF_PREFIX}%`).order("resolved_at", { ascending: true }).limit(100);
  const rows = (data ?? []) as Row[];
  if (!rows.length) return { delivered: 0, failed: 0, closed: 0 };
  const { data: dl } = await db.from("friday_triage_deliveries").select("approval_id, delivered_at, attempts").in("approval_id", rows.map((r) => r.id));
  const seen = new Map(((dl ?? []) as { approval_id: string; delivered_at: string | null; attempts: number }[]).map((d) => [d.approval_id, d]));
  let delivered = 0, failed = 0, closed = 0;
  for (const row of rows) {
    if (!o.budget.ok() || delivered + failed >= (o.max ?? 15)) break;
    const prior = seen.get(row.id);
    if (prior?.delivered_at || (prior?.attempts ?? 0) >= MAX_DELIVERY_ATTEMPTS) continue;
    const action = row.draft_content?.draft?.action;
    try {
      if (!action) throw new Error("approval carries no portal action");
      const outcome = await applyDecided(db, env, row.action_type, action, row.status === "approved");
      await db.from("friday_triage_deliveries").upsert({ approval_id: row.id, delivered_at: new Date().toISOString(), attempts: (prior?.attempts ?? 0) + 1, outcome, last_error: null }, { onConflict: "approval_id" });
      await db.from("workflow_approval_queue").update({ acked_at: new Date().toISOString() }).eq("id", row.id).is("acked_at", null);
      if (row.status === "approved") delivered++; else closed++;
    } catch (e) {
      failed++;
      await db.from("friday_triage_deliveries").upsert({ approval_id: row.id, delivered_at: null, attempts: (prior?.attempts ?? 0) + 1, last_error: (e as Error).message.slice(0, 300) }, { onConflict: "approval_id" });
    }
  }
  return { delivered, failed, closed };
}
