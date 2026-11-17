/**
 * friday-clarify-watch and friday-clarify-silence-sweep (ported from FRIDAY's ticketClarify.ts).
 *
 * After a clarifying question is posted (delivery.ts, once the owner approved it) the state row sits
 * in `clarify_awaiting`. The watch (every 5 min) looks for the client's portal reply, re-judges the
 * item with every round's Q&A, and either resolves, asks once more (bounded to 2 rounds) or proceeds
 * with stated assumptions. The sweep (hourly) nudges after 24 h and pages the owner after 72 h.
 *
 * FRIDAY also read a mirrored email thread; FRIDAY sends no client mail any more, so that channel
 * is gone. Every client-visible word (the second question, the nudge) goes through the approval rail.
 */
import type { SupabaseClient } from "npm:@supabase/supabase-js@2";
import type { Env } from "../clara/phones.ts";
import { applyPending } from "./triage.ts";
import {
  classifyClarity, clarifyRoundOutcome, clarifySilenceAction, draftNudge, firstClientReply, notifyOwnerBell, raiseApproval, readThread, saveState,
  ticketName, type Budget, type Kind, type Model, type OsChangeRequest, type OsTicket, type PendingAction, type TriageState,
} from "./portal.ts";

async function loadItem(db: SupabaseClient, kind: Kind, id: string): Promise<OsTicket | OsChangeRequest | null> {
  const cols = kind === "ticket"
    ? "id, org_id, project_id, title, subject, description, status, priority, request_type, client_name, client_email"
    : "id, org_id, project_id, title, description, status, priority, request_type, client_name, client_email";
  const { data } = await db.from(kind === "ticket" ? "project_support_tickets" : "project_change_requests").select(cols).eq("id", id).maybeSingle();
  return (data as OsTicket | OsChangeRequest | null) ?? null;
}

export interface WatchResult { checked: number; resolved: number; askedAgain: number; forced: number; waiting: number; retry: number }

/** One poll over the awaiting_reply states, least-recently-checked first (updated_at is the cursor). */
export async function runClarifyWatch(db: SupabaseClient, env: Env, d: { model: Model; budget: Budget; max?: number }): Promise<WatchResult> {
  const r: WatchResult = { checked: 0, resolved: 0, askedAgain: 0, forced: 0, waiting: 0, retry: 0 };
  const { data } = await db.from("friday_triage_state").select("*").eq("stage", "clarify_awaiting").order("updated_at", { ascending: true }).limit(d.max ?? 20);
  for (const st of (data ?? []) as TriageState[]) {
    if (!d.budget.ok()) break;
    r.checked++;
    const touch = () => db.from("friday_triage_state").update({ updated_at: new Date().toISOString() }).eq("id", st.id);
    try {
      const item = await loadItem(db, st.kind, st.item_id);
      if (!item) { await saveState(db, st.kind, { orgId: st.org_id, itemId: st.item_id }, { stage: "done" }); continue; }
      const reply = firstClientReply(await readThread(db, st.kind, st.item_id), Date.parse(st.asked_at ?? "") || 0);
      if (!reply) { r.waiting++; await touch(); continue; }

      const qa = [...st.qa, { question: st.question ?? "", answer: reply.text }];
      const subject = st.kind === "ticket" ? ticketName(item as OsTicket) : (item as OsChangeRequest).title;
      const clarity = await classifyClarity(d.model, { title: subject, description: item.description ?? "" }, qa);
      if (!clarity.determinable) { r.retry++; await touch(); continue; } // keep the reply unconsumed; retry next poll, never guess

      const outcome = clarifyRoundOutcome(st.round, clarity.needsClarify);
      const pending: PendingAction = outcome === "ask_again" ? { type: "ask_again", question: clarity.clarifyQuestion as string }
        : outcome === "force_resolve" ? { type: "force_resolve" } : { type: "resolve" };
      // Persist the decided outcome first, so a cut-off run finishes it in the next triage pass.
      await saveState(db, st.kind, { orgId: st.org_id, itemId: st.item_id }, { stage: "resolve_pending", qa, pending_action: pending });
      const fresh = { ...st, stage: "resolve_pending" as const, qa, pending_action: pending };
      if (await applyPending(db, env, st.kind, fresh, item, d.model) === "ok") {
        if (outcome === "resolved") r.resolved++; else if (outcome === "ask_again") r.askedAgain++; else r.forced++;
      } else r.retry++;
    } catch (e) {
      await db.from("friday_triage_state").update({ attempts: st.attempts + 1, last_error: (e as Error).message.slice(0, 300) }).eq("id", st.id);
    }
  }
  return r;
}

export interface SweepResult { nudged: number; escalated: number }

/** 24 h silence: draft a portal nudge for approval. 72 h: tell the owner. Each happens once per round. */
export async function runClarifySilenceSweep(db: SupabaseClient, env: Env, d: { budget: Budget; now?: Date; max?: number }): Promise<SweepResult> {
  const r: SweepResult = { nudged: 0, escalated: 0 };
  const now = (d.now ?? new Date()).getTime();
  const { data } = await db.from("friday_triage_state").select("*").eq("stage", "clarify_awaiting").order("asked_at", { ascending: true }).limit(d.max ?? 50);
  for (const st of (data ?? []) as TriageState[]) {
    if (!d.budget.ok()) break;
    const askedAt = Date.parse(st.asked_at ?? "") || 0;
    if (!askedAt) continue;
    const act = clarifySilenceAction(askedAt, now, st.nudged_at ? Date.parse(st.nudged_at) || 1 : null, st.escalated_at ? Date.parse(st.escalated_at) || 1 : null);
    if (act === "none") continue;
    try {
      const item = await loadItem(db, st.kind, st.item_id);
      if (!item) continue;
      const subject = st.kind === "ticket" ? ticketName(item as OsTicket) : (item as OsChangeRequest).title;
      if (act === "nudge") {
        const body = draftNudge(item.client_name, subject, st.question ?? "");
        await raiseApproval(db, {
          orgId: st.org_id, ref: `nudge:${st.id}:${st.round}`, actionType: "friday_portal_nudge", title: `Nudge ${item.client_name || "client"} on: ${subject}`,
          description: `No answer to the clarifying question after 24 h. Posts this reminder in the portal thread:\n\n${body}`,
          action: { op: "post", kind: st.kind, item_id: st.item_id, org_id: st.org_id, body },
        });
        await db.from("friday_triage_state").update({ nudged_at: new Date(now).toISOString(), updated_at: new Date().toISOString() }).eq("id", st.id);
        r.nudged++;
      } else {
        await notifyOwnerBell(db, env, st.org_id, {
          title: `No answer on "${subject}" from ${item.client_name || "the client"}`,
          body: "No reply to the clarifying question after 3 days; it may be worth a direct follow-up.", dedupe: `clarify-stale:${st.id}:${st.round}`,
        });
        await db.from("friday_triage_state").update({ escalated_at: new Date(now).toISOString(), updated_at: new Date().toISOString() }).eq("id", st.id);
        r.escalated++;
      }
    } catch (e) {
      await db.from("friday_triage_state").update({ attempts: st.attempts + 1, last_error: (e as Error).message.slice(0, 300) }).eq("id", st.id);
    }
  }
  return r;
}
