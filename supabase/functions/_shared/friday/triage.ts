/**
 * friday-ticket-triage / friday-cr-triage: the hourly OS portal sweeps (ported from FRIDAY's
 * ticketTriage / changeRequestTriage).
 *
 * Per run: (1) apply decided approvals, (2) finish clarify outcomes that were waiting, (3) triage
 * NEW items oldest-first, (4) re-raise an acknowledgement that never got out. Work is capped by a
 * time budget and every step is keyed by friday_triage_state / the approval ref, so a cut-off run
 * resumes where it stopped and a re-run adds nothing.
 *
 * Dropped vs FRIDAY (they need the local git/task pipeline or local files, which stay on the worker):
 * routing into the delivery pipeline (recorded as a `pipeline` handoff on the state row instead),
 * PR-merge-aware completion notes, in-scope auto-start, retainer rules, stuck-CR escalation.
 */
import type { SupabaseClient } from "npm:@supabase/supabase-js@2";
import type { Env } from "../clara/phones.ts";
import { deliverDecidedPortal } from "./delivery.ts";
import {
  MAX_ACK_PARKS, SCOPE_PARKED, approvalsFor, classifyClarity, classifyScope, crMarker, draftCrAck, draftScopeHolding,
  draftTicketAck, fetchScopeText, hasClientVisibleReply, nextAckAttempt, notifyOwnerBell, postComment, raiseApproval, readThread,
  saveState, setStatus, ticketKind, ticketMarker, ticketName,
  type Budget, type Kind, type Model, type OsChangeRequest, type OsTicket, type PortalAction, type TriageState,
} from "./portal.ts";

const TICKET_COLS = "id, org_id, project_id, title, subject, description, status, priority, request_type, client_name, client_email, created_at";
const CR_COLS = "id, org_id, project_id, title, description, status, priority, request_type, client_name, client_email, created_at";

export interface TriageDeps { model: Model; budget: Budget; env: Env; max?: number }
export interface TriageResult { delivered: number; resolved: number; triaged: number; clarifyAsked: number; acked: number; handedOff: number; retry: number }
const empty = (): TriageResult => ({ delivered: 0, resolved: 0, triaged: 0, clarifyAsked: 0, acked: 0, handedOff: 0, retry: 0 });

const action = (kind: Kind, orgId: string, itemId: string, extra: Record<string, unknown>): PortalAction => ({ op: "post", kind, item_id: itemId, org_id: orgId, ...extra });

/** Raise a clarify ask for round `round` and park the state until the owner decides. */
export async function queueClarifyAsk(
  db: SupabaseClient, kind: Kind, item: { id: string; org_id: string; project_id: string; subject: string; client_name?: string | null; request_type?: string | null },
  question: string, round: number, qa: TriageState["qa"] = [],
): Promise<void> {
  const prefix = kind === "ticket" ? "ticket-clarify" : "cr-clarify";
  await raiseApproval(db, {
    orgId: item.org_id, ref: `${prefix}:${item.id}:${round}`, actionType: kind === "ticket" ? "friday_ticket_clarify" : "friday_cr_clarify",
    title: `${kind === "ticket" ? "Ticket" : "Change request"} clarifying question: ${item.subject}`,
    description: `Posts this question into the portal thread and waits for the client's answer (round ${round} of 2): ${question}`,
    action: action(kind, item.org_id, item.id, { subject: item.subject, client_name: item.client_name ?? null, question, round }),
  });
  await saveState(db, kind, { orgId: item.org_id, itemId: item.id, projectId: item.project_id }, { stage: "clarify_queued", round, question, qa, pending_action: null });
}

// ── tickets ──

/** Raise the client acknowledgement (attempt n, or a re-raise after the earlier one expired). */
async function proposeTicketAck(db: SupabaseClient, env: Env, t: OsTicket, willWork: boolean): Promise<boolean> {
  const n = nextAckAttempt(await approvalsFor(db, `ticket-ack:${t.id}:`));
  if (n === null) return false;
  const body = draftTicketAck(env, t, willWork);
  const r = await raiseApproval(db, {
    orgId: t.org_id, ref: `ticket-ack:${t.id}:${n}`, actionType: "friday_ticket_reply", title: `Reply to ${t.client_name || "client"}: ${ticketName(t)}`,
    description: `Acknowledgement to post in the ticket thread (then the ticket moves to ${willWork ? "in_progress" : "waiting_on_client"}):\n\n${body}`,
    action: action("ticket", t.org_id, t.id, { body, next_status: willWork ? "in_progress" : "waiting_on_client", subject: ticketName(t) }),
  });
  return r.created;
}

/** Triage one ticket whose description is settled (own text, or text plus the client's clarify answers). */
export async function triageTicket(db: SupabaseClient, env: Env, t: OsTicket, effective: string): Promise<void> {
  const kind = ticketKind(t.request_type);
  await postComment(db, "ticket", { orgId: t.org_id, id: t.id, internal: true, author: "FRIDAY",
    body: `FRIDAY triage: classified as ${kind}, queued for the delivery pipeline. ${ticketMarker(t.id)}` });
  await setStatus(db, "ticket", { orgId: t.org_id, id: t.id, status: "in_review", fromStatus: t.status });
  // The pipeline handoff the headless worker picks up (its own git/CLI work is not done here).
  const pipeline = { title: ticketName(t).slice(0, 60), details: `${effective}\n\n${ticketMarker(t.id)}`, kind, scope: kind === "bug" ? "in_scope" : "new", client_email: t.client_email ?? null, status: "pending" };
  await saveState(db, "ticket", { orgId: t.org_id, itemId: t.id, projectId: t.project_id }, { stage: "triaged", pipeline, pending_action: null });
  await proposeTicketAck(db, env, t, kind !== "other");
}

export async function applyPending(db: SupabaseClient, env: Env, kind: Kind, st: TriageState, item: OsTicket | OsChangeRequest, model: Model): Promise<"ok" | "retry"> {
  const pa = st.pending_action;
  if (!pa) return "ok";
  const subject = kind === "ticket" ? ticketName(item as OsTicket) : (item as OsChangeRequest).title;
  if (pa.type === "ask_again") {
    await queueClarifyAsk(db, kind, { id: item.id, org_id: item.org_id, project_id: item.project_id, subject, client_name: item.client_name }, pa.question, 2, st.qa);
    return "ok";
  }
  const effective = [item.description ?? "", ...st.qa.map((x) => `Q: ${x.question}\nA: ${x.answer}`)].join("\n\n");
  if (kind === "ticket") await triageTicket(db, env, item as OsTicket, effective);
  else if (await triageCr(db, env, item as OsChangeRequest, effective, model) === "retry") return "retry";
  return "ok";
}

/** Finish clarify outcomes (answer received / ask rejected) that are waiting on a triage pass. */
async function drainResolvePending(db: SupabaseClient, env: Env, kind: Kind, d: TriageDeps, out: TriageResult): Promise<void> {
  const { data } = await db.from("friday_triage_state").select("*").eq("kind", kind).eq("stage", "resolve_pending").order("updated_at", { ascending: true }).limit(10);
  for (const st of (data ?? []) as TriageState[]) {
    if (!d.budget.ok()) return;
    const { data: item } = await db.from(kind === "ticket" ? "project_support_tickets" : "project_change_requests").select(kind === "ticket" ? TICKET_COLS : CR_COLS).eq("id", st.item_id).maybeSingle();
    if (!item) { await saveState(db, kind, { orgId: st.org_id, itemId: st.item_id }, { stage: "done" }); continue; }
    try {
      if (await applyPending(db, env, kind, st, item as unknown as OsTicket, d.model) === "retry") out.retry++; else out.resolved++;
    } catch (e) {
      await db.from("friday_triage_state").update({ attempts: st.attempts + 1, last_error: (e as Error).message.slice(0, 300) }).eq("id", st.id);
    }
  }
}

export async function runTicketTriage(db: SupabaseClient, env: Env, d: TriageDeps): Promise<TriageResult> {
  const out = empty();
  out.delivered = (await deliverDecidedPortal(db, env, { types: ["friday_ticket_reply", "friday_ticket_clarify"], budget: d.budget })).delivered;
  await drainResolvePending(db, env, "ticket", d, out);

  // New tickets, oldest first. A ticket we already hold state for (clarifying / triaged) is never re-classified.
  const max = d.max ?? 10;
  const { data: news } = await db.from("project_support_tickets").select(TICKET_COLS).eq("status", "new").order("created_at", { ascending: true }).limit(max * 3);
  const tickets = (news ?? []) as OsTicket[];
  const states = await statesFor(db, "ticket", tickets.map((t) => t.id));
  let handled = 0;
  for (const t of tickets) {
    if (!d.budget.ok() || handled >= max) break;
    const st = states.get(t.id);
    if (st && ["clarify_queued", "clarify_awaiting", "resolve_pending"].includes(st.stage)) continue;
    handled++;
    try {
      const clarity = await classifyClarity(d.model, { title: ticketName(t), description: t.description ?? "" });
      if (!clarity.determinable) { out.retry++; continue; }
      if (clarity.needsClarify) {
        await queueClarifyAsk(db, "ticket", { id: t.id, org_id: t.org_id, project_id: t.project_id, subject: ticketName(t), client_name: t.client_name }, clarity.clarifyQuestion as string, 1);
        out.clarifyAsked++;
        continue;
      }
      await triageTicket(db, d.env, t, t.description ?? "");
      out.triaged++;
    } catch (e) {
      await saveState(db, "ticket", { orgId: t.org_id, itemId: t.id, projectId: t.project_id }, { stage: st?.stage ?? "triaged", attempts: (st?.attempts ?? 0) + 1, last_error: (e as Error).message.slice(0, 300) });
    }
  }

  // Acknowledgement self-heal: in_review with no client-visible FRIDAY comment and no live approval -> raise it again.
  const { data: reviews } = await db.from("project_support_tickets").select(TICKET_COLS).eq("status", "in_review").order("created_at", { ascending: true }).limit(15);
  for (const t of (reviews ?? []) as OsTicket[]) {
    if (!d.budget.ok()) break;
    const existing = await approvalsFor(db, `ticket-ack:${t.id}:`);
    const n = nextAckAttempt(existing);
    if (n === null) {
      // Expired twice: ask the owner once instead of re-parking forever.
      if (existing.length >= MAX_ACK_PARKS && existing.every((e) => e.status === "expired")) {
        await notifyOwnerBell(db, d.env, t.org_id, { title: `${t.client_name || "A client"}'s ticket "${ticketName(t)}" is waiting on a reply`, body: "The acknowledgement was drafted twice and never approved, so the client has not heard from us.", dedupe: `ticket-reply-stuck:${t.id}` });
      }
      continue;
    }
    if (hasClientVisibleReply(await readThread(db, "ticket", t.id))) continue;
    if (await proposeTicketAck(db, d.env, t, ticketKind(t.request_type) !== "other")) out.acked++;
  }
  return out;
}

// ── change requests ──

async function statesFor(db: SupabaseClient, kind: Kind, ids: string[]): Promise<Map<string, TriageState>> {
  if (!ids.length) return new Map();
  const { data } = await db.from("friday_triage_state").select("*").eq("kind", kind).in("item_id", ids);
  return new Map(((data ?? []) as TriageState[]).map((s) => [s.item_id, s]));
}

async function proposeCrAck(db: SupabaseClient, env: Env, cr: OsChangeRequest): Promise<boolean> {
  const n = nextAckAttempt(await approvalsFor(db, `cr-ack:${cr.id}:`));
  if (n === null) return false;
  const body = draftCrAck(env, cr);
  const r = await raiseApproval(db, {
    orgId: cr.org_id, ref: `cr-ack:${cr.id}:${n}`, actionType: "friday_cr_reply", title: `Reply to ${cr.client_name || "client"}: ${cr.title}`,
    description: `Acknowledgement to post in the change-request thread:\n\n${body}`,
    action: action("cr", cr.org_id, cr.id, { body, subject: cr.title }),
  });
  return r.created;
}

/** Scope-gate one CR whose description is settled. "retry" = the model was unreachable (never guess on scope). */
export async function triageCr(db: SupabaseClient, env: Env, cr: OsChangeRequest, effective: string, model: Model): Promise<"ok" | "retry"> {
  const scopeCheck = (env.get("FRIDAY_CR_SCOPE_CHECK") ?? "on").trim().toLowerCase() !== "off";
  const strict = (env.get("FRIDAY_CR_STRICT_SCOPE") ?? "off").trim().toLowerCase() === "on";
  const base = { orgId: cr.org_id, itemId: cr.id, projectId: cr.project_id };
  let verdict = { in_scope: true, determinable: true, reason: "" };
  if (scopeCheck) {
    verdict = await classifyScope(model, { title: cr.title, description: effective, request_type: cr.request_type }, await fetchScopeText(db, cr.project_id), strict);
    if (!verdict.determinable) return "retry";
  }

  if (scopeCheck && !verdict.in_scope) {
    await postComment(db, "cr", { orgId: cr.org_id, id: cr.id, internal: true, author: "FRIDAY",
      body: `FRIDAY scope review: "${cr.title}" appears OUT OF SCOPE vs the signed proposal: ${verdict.reason} Parked for owner approval. ${crMarker(cr.id)} ${SCOPE_PARKED}` });
    await setStatus(db, "cr", { orgId: cr.org_id, id: cr.id, status: "under_review", fromStatus: cr.status, extra: { internal_summary: `Out of scope: ${verdict.reason}`.slice(0, 500) } });
    const holding = draftScopeHolding(env, cr);
    await raiseApproval(db, {
      orgId: cr.org_id, ref: `cr-hold:${cr.id}`, actionType: "friday_cr_reply", title: `Holding reply to ${cr.client_name || "client"}: ${cr.title}`,
      description: `Tells the client we flagged this for review before proceeding:\n\n${holding}`,
      action: action("cr", cr.org_id, cr.id, { body: holding, subject: cr.title }),
    });
    await raiseApproval(db, {
      orgId: cr.org_id, ref: `cr-scope:${cr.id}:1`, actionType: "friday_cr_scope", title: `Out-of-scope change request: ${cr.title}. Your approval needed`,
      description: `${verdict.reason}\n\nAPPROVE to proceed (the client is told we're moving forward and the request is approved). REJECT to hold it; nothing is sent and you are reminded to schedule a scope call.`,
      action: action("cr", cr.org_id, cr.id, { title: cr.title, client_name: cr.client_name ?? null, reason: verdict.reason }),
    });
    await saveState(db, "cr", base, { stage: "scope_queued", pending_action: null });
    return "ok";
  }

  await setStatus(db, "cr", { orgId: cr.org_id, id: cr.id, status: "under_review", fromStatus: cr.status });
  await postComment(db, "cr", { orgId: cr.org_id, id: cr.id, internal: true, author: "FRIDAY",
    body: `FRIDAY review: "${cr.title}" (${cr.request_type ?? "scope"}, ${cr.priority ?? "medium"}) — in scope. ${verdict.reason} ${crMarker(cr.id)}` });
  await saveState(db, "cr", base, { stage: "triaged", pending_action: null });
  await proposeCrAck(db, env, cr);
  return "ok";
}

/** An approved CR: cut an OS project task (idempotent by marker), hand it to the worker, then mark it in progress. */
async function startApprovedCr(db: SupabaseClient, cr: OsChangeRequest): Promise<boolean> {
  const marker = crMarker(cr.id);
  const { data: existing } = await db.from("project_tasks").select("id").eq("project_id", cr.project_id).like("description", `%${marker}%`).limit(1);
  if (!((existing ?? []) as unknown[]).length) {
    const { data: p } = await db.from("projects").select("created_by").eq("id", cr.project_id).maybeSingle();
    const createdBy = (p as { created_by: string } | null)?.created_by;
    if (!createdBy) return false;
    const { error } = await db.from("project_tasks").insert({
      org_id: cr.org_id, project_id: cr.project_id, created_by: createdBy, title: `[CR] ${cr.title}`.slice(0, 120),
      description: `${cr.description ?? ""}\n\nFrom approved change request ${cr.id}. ${marker}`, status: "todo",
      priority: ["low", "medium", "high"].includes(cr.priority ?? "") ? cr.priority : "medium",
    });
    if (error) return false;
  }
  await saveState(db, "cr", { orgId: cr.org_id, itemId: cr.id, projectId: cr.project_id }, {
    stage: "triaged", pipeline: { title: cr.title.slice(0, 60), details: `${cr.description ?? ""}\n\nApproved change request. ${marker}`, kind: "change", scope: "new", client_email: cr.client_email ?? null, status: "pending" },
  });
  return await setStatus(db, "cr", { orgId: cr.org_id, id: cr.id, status: "in_progress", fromStatus: cr.status });
}

export async function runCrTriage(db: SupabaseClient, env: Env, d: TriageDeps): Promise<TriageResult> {
  const out = empty();
  out.delivered = (await deliverDecidedPortal(db, env, { types: ["friday_cr_reply", "friday_cr_clarify", "friday_cr_scope"], budget: d.budget })).delivered;
  await drainResolvePending(db, env, "cr", d, out);

  const max = d.max ?? 5;
  const { data: subs } = await db.from("project_change_requests").select(CR_COLS).eq("status", "submitted").order("created_at", { ascending: true }).limit(max * 3);
  const crs = (subs ?? []) as OsChangeRequest[];
  const states = await statesFor(db, "cr", crs.map((c) => c.id));
  let handled = 0;
  for (const cr of crs) {
    if (!d.budget.ok() || handled >= max) break;
    const st = states.get(cr.id);
    if (st && ["clarify_queued", "clarify_awaiting", "resolve_pending", "scope_queued"].includes(st.stage)) continue;
    handled++;
    try {
      const clarity = await classifyClarity(d.model, { title: cr.title, description: cr.description ?? "" });
      if (!clarity.determinable) { out.retry++; continue; }
      if (clarity.needsClarify) {
        await queueClarifyAsk(db, "cr", { id: cr.id, org_id: cr.org_id, project_id: cr.project_id, subject: cr.title, client_name: cr.client_name }, clarity.clarifyQuestion as string, 1);
        out.clarifyAsked++;
        continue;
      }
      if (await triageCr(db, d.env, cr, cr.description ?? "", d.model) === "retry") out.retry++; else out.triaged++;
    } catch (e) {
      await saveState(db, "cr", { orgId: cr.org_id, itemId: cr.id, projectId: cr.project_id }, { stage: st?.stage ?? "triaged", attempts: (st?.attempts ?? 0) + 1, last_error: (e as Error).message.slice(0, 300) });
    }
  }

  // under_review with no client-visible FRIDAY comment: re-raise the ack (not while a scope decision is open).
  const { data: reviews } = await db.from("project_change_requests").select(CR_COLS).eq("status", "under_review").order("created_at", { ascending: true }).limit(15);
  const rev = (reviews ?? []) as OsChangeRequest[];
  const revStates = await statesFor(db, "cr", rev.map((c) => c.id));
  for (const cr of rev) {
    if (!d.budget.ok()) break;
    const st = revStates.get(cr.id);
    if (st && ["scope_queued", "clarify_awaiting", "clarify_queued"].includes(st.stage)) continue;
    if (nextAckAttempt(await approvalsFor(db, `cr-ack:${cr.id}:`)) === null) continue;
    const thread = await readThread(db, "cr", cr.id);
    if (hasClientVisibleReply(thread) || thread.some((c) => c.is_internal && (c.body ?? "").includes(SCOPE_PARKED))) continue;
    if (await proposeCrAck(db, d.env, cr)) out.acked++;
  }

  // Approved CRs: create the work and flip to in_progress.
  const { data: approved } = await db.from("project_change_requests").select(CR_COLS).eq("status", "approved").order("created_at", { ascending: true }).limit(5);
  for (const cr of (approved ?? []) as OsChangeRequest[]) {
    if (!d.budget.ok()) break;
    if (await startApprovedCr(db, cr)) out.handedOff++;
  }
  return out;
}
