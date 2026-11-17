/**
 * Live call state in Postgres (replaces CLARA's in-memory InboundCallState map).
 *
 * Every Twilio webhook is a fresh stateless request, so what CLARA kept in process memory lives in
 * clara_call_sessions.state. Twilio sends one webhook per call at a time during the conversation
 * loop, so read-modify-write is safe there; the one real race (the voice webhook and the
 * end-of-call status callback both finalizing) is closed by an atomic claim.
 */
import type { SupabaseClient } from "npm:@supabase/supabase-js@2";
import type { CallState, CallStatePatch, CallStatus, CallTurn } from "./types.ts";

export interface SessionRow {
  call_sid: string;
  organization_id: string;
  direction: "inbound" | "outbound";
  from_e164: string;
  to_e164: string | null;
  status: CallStatus;
  state: CallState;
  finalized: boolean;
  conversation_id: string | null;
  contact_id: string | null;
}

const COLS = "call_sid, organization_id, direction, from_e164, to_e164, status, state, finalized, conversation_id, contact_id";

export async function getSession(db: SupabaseClient, callSid: string): Promise<SessionRow | null> {
  const { data, error } = await db.from("clara_call_sessions").select(COLS).eq("call_sid", callSid).maybeSingle();
  if (error) throw new Error(`clara_call_sessions read failed: ${error.message}`);
  return (data as SessionRow | null) ?? null;
}

/** Get-or-create: Twilio retries webhooks, and the first hit of a call has no row yet. */
export async function ensureSession(
  db: SupabaseClient,
  i: { callSid: string; orgId: string; direction: "inbound" | "outbound"; from: string; to?: string },
): Promise<SessionRow> {
  const existing = await getSession(db, i.callSid);
  if (existing) return existing;
  const row = {
    call_sid: i.callSid, organization_id: i.orgId, direction: i.direction, from_e164: i.from, to_e164: i.to ?? null,
    status: "in-progress", state: { fromE164: i.from, turns: [], learned: {} } satisfies CallState, finalized: false,
  };
  const { error } = await db.from("clara_call_sessions").insert(row);
  // 23505: a concurrent retry created it between our read and insert; read theirs.
  if (error && error.code !== "23505") throw new Error(`clara_call_sessions insert failed: ${error.message}`);
  const created = await getSession(db, i.callSid);
  if (!created) throw new Error("clara_call_sessions row missing after insert");
  return created;
}

async function mutate(db: SupabaseClient, callSid: string, fn: (s: CallState) => CallState): Promise<CallState | null> {
  const row = await getSession(db, callSid);
  if (!row) return null;
  const next = fn(row.state);
  const { error } = await db.from("clara_call_sessions")
    .update({ state: next, updated_at: new Date().toISOString() }).eq("call_sid", callSid);
  if (error) throw new Error(`clara_call_sessions update failed: ${error.message}`);
  return next;
}

export const appendTurn = (db: SupabaseClient, callSid: string, turn: CallTurn) =>
  mutate(db, callSid, (s) => ({ ...s, turns: [...s.turns, turn] }));

/** A later blank value must never overwrite an earlier good one (the model sometimes returns {need:""}). */
export const updateLearned = (db: SupabaseClient, callSid: string, patch: Record<string, string>) =>
  mutate(db, callSid, (s) => {
    const learned = { ...s.learned };
    for (const [k, v] of Object.entries(patch)) if (typeof v === "string" && v.trim()) learned[k] = v;
    return { ...s, learned };
  });

export const patchSession = (db: SupabaseClient, callSid: string, patch: CallStatePatch) =>
  mutate(db, callSid, (s) => ({ ...s, ...patch }));

/** Read-modify-write of the owner's pending question; returns it as stored. */
export async function updateOwnerAsk(
  db: SupabaseClient, callSid: string, fn: (a: CallState["ownerAsk"]) => CallState["ownerAsk"],
): Promise<CallState["ownerAsk"]> {
  return (await mutate(db, callSid, (s) => ({ ...s, ownerAsk: fn(s.ownerAsk) })))?.ownerAsk;
}

export async function setStatus(db: SupabaseClient, callSid: string, status: CallStatus): Promise<void> {
  const { error } = await db.from("clara_call_sessions")
    .update({ status, updated_at: new Date().toISOString() }).eq("call_sid", callSid);
  if (error) throw new Error(`clara_call_sessions status failed: ${error.message}`);
}

export async function linkConversation(db: SupabaseClient, callSid: string, conversationId: string | null, contactId: string | null) {
  const { error } = await db.from("clara_call_sessions")
    .update({ conversation_id: conversationId, contact_id: contactId, updated_at: new Date().toISOString() }).eq("call_sid", callSid);
  if (error) throw new Error(`clara_call_sessions link failed: ${error.message}`);
}

/**
 * Claim the right to finalize this call exactly once. The voice webhook's "done" branch and
 * Twilio's end-of-call callback both want to, and race: the conditional update lets one win.
 */
export async function claimFinalize(db: SupabaseClient, callSid: string): Promise<SessionRow | null> {
  const { data, error } = await db.from("clara_call_sessions")
    .update({ finalized: true, updated_at: new Date().toISOString() })
    .eq("call_sid", callSid).eq("finalized", false).select(COLS);
  if (error) throw new Error(`clara_call_sessions claim failed: ${error.message}`);
  return ((data as SessionRow[] | null) ?? [])[0] ?? null;
}
