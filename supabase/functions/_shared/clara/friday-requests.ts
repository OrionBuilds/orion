/**
 * FRIDAY's agent_requests, from the OS side: who FRIDAY is, and how an owner's answer to a FRIDAY
 * question goes back (FRIDAY audit gap 7, contract §5).
 *
 * The answer is a NEW request ("Re: <title>", payload.in_reply_to = the old id) and the old request is
 * closed (cancelled, result.superseded_by). FRIDAY's poller skips ids it has already handled, so
 * re-queueing the same row never reaches it; a new id always does.
 */
import type { SupabaseClient } from "npm:@supabase/supabase-js@2";
import type { Env } from "./phones.ts";

export interface WaitingRequest {
  id: string; org_id: string; from_user_id: string; to_user_id: string; kind: string; title: string; body: string;
  result_summary: string | null; source: Record<string, unknown> | null; payload: Record<string, unknown> | null;
  result?: Record<string, unknown> | null;
}

export const WAITING_COLUMNS = "id, org_id, from_user_id, to_user_id, kind, title, body, result_summary, result, source, payload";

/** FRIDAY's OS user in an org: FRIDAY_USER_ID, else the org's FridayAgent-role user, else friday@<any>. */
export async function fridayUserId(db: SupabaseClient, env: Env, orgId: string): Promise<string | null> {
  const fromEnv = env.get("FRIDAY_USER_ID")?.trim();
  if (fromEnv) return fromEnv;
  const { data: role } = await db.from("roles").select("id").eq("name", "FridayAgent").limit(1).maybeSingle();
  const roleId = (role as { id: string } | null)?.id;
  if (roleId) {
    const { data } = await db.from("users").select("id").eq("organization_id", orgId).eq("role_id", roleId).limit(1).maybeSingle();
    if (data) return (data as { id: string }).id;
  }
  const { data } = await db.from("users").select("id").eq("organization_id", orgId).ilike("email", "friday@%").limit(1).maybeSingle();
  return (data as { id: string } | null)?.id ?? null;
}

/** The body FRIDAY gets for a follow-up: the original brief, its question, the owner's answer. */
export function answerBody(r: Pick<WaitingRequest, "id" | "title" | "body" | "result_summary">, answer: string): string {
  return `Follow-up on "${r.title}" (OS request ${r.id}).\n\n${r.body}\n\n--- FRIDAY asked ---\n${r.result_summary ?? "(question not recorded)"}\n--- Owner answered ---\n${answer}`.slice(0, 20_000);
}

export interface RequeueOpts {
  /** The owner's thread message this answer came from: its turn tracks the new request. */
  turnMessageId?: string;
  /** Last thread turns, carried to FRIDAY as payload.history. */
  history?: { role: string; text: string; at: string }[];
  now: Date;
}

export type RequeueResult = { ok: true; newId: string } | { ok: false; reason: "already_answered" | "insert_failed"; error?: string };

/**
 * Answer a needs_input request: close it (compare-and-set, so two answers never both go through),
 * create the follow-up request, and make the thread follow the new one.
 */
export async function requeueWithAnswer(db: SupabaseClient, old: WaitingRequest, answer: string, o: RequeueOpts): Promise<RequeueResult> {
  const at = o.now.toISOString();
  const { data: closed } = await db.from("agent_requests")
    .update({ status: "cancelled", finished_at: at, notified_at: at, updated_at: at })
    .eq("id", old.id).eq("status", "needs_input").select("id");
  if (!((closed ?? []) as unknown[]).length) return { ok: false, reason: "already_answered" };

  const source = { ...(old.source ?? {}), requested_by: "owner", parent_request_id: old.id };
  const payload: Record<string, unknown> = { in_reply_to: old.id };
  const history = o.history ?? (Array.isArray(old.payload?.history) ? old.payload!.history as unknown[] : undefined);
  if (history?.length) payload.history = history;
  const { data, error } = await db.from("agent_requests").insert({
    org_id: old.org_id, from_user_id: old.from_user_id, to_user_id: old.to_user_id, kind: old.kind || "task",
    title: `Re: ${old.title}`.slice(0, 300), body: answerBody(old, answer), source, payload,
  }).select("id").maybeSingle();
  if (error || !data) {
    // Put the question back so the answer can be given again.
    await db.from("agent_requests").update({ status: "needs_input", finished_at: null, notified_at: null, updated_at: at }).eq("id", old.id).eq("status", "cancelled");
    return { ok: false, reason: "insert_failed", error: error?.message ?? "no row returned" };
  }
  const newId = (data as { id: string }).id;
  await db.from("agent_requests").update({ result: { ...(old.result ?? {}), superseded_by: newId }, updated_at: at }).eq("id", old.id);

  // The thread shows FRIDAY's reply to the new request: on the owner's answer message when there is
  // one, else on the original thread turn (an answer given through Clara).
  if (o.turnMessageId) {
    await db.from("agent_thread_turns").update({ status: "queued", agent_request_id: newId, updated_at: at }).eq("message_id", o.turnMessageId);
  } else {
    await db.from("agent_thread_turns").update({ status: "queued", agent_request_id: newId, updated_at: at }).eq("agent_request_id", old.id);
  }
  return { ok: true, newId };
}
