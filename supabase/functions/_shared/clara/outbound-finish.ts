/**
 * Settling an outbound call: what happened, what to do about it, and who needs to know.
 *
 * Runs once per call (the voice webhook's "done" and Twilio's status callback race; the session's
 * atomic finalize claim lets one win). Unanswered/voicemail calls are retried later up to the
 * attempt limit; everything else ends the request. The call is logged to the contact's
 * conversation, and the requester hears the outcome in terms of what actually happened.
 */
import type { SupabaseClient } from "npm:@supabase/supabase-js@2";
import type { CallState } from "./types.ts";
import type { NotifyRequest } from "./notify.ts";
import { type CallRequest, MAX_ATTEMPTS, RETRY_GAP_MS } from "./outbound.ts";
import { claimFinalize, getSession } from "./call-state.ts";
import { findOrCreateConversation, insertMessage, upsertCallLog } from "./conversations.ts";

export type CallEnding = "conversation" | "voicemail" | "no_answer" | "failed";

export interface FinishDeps {
  now: () => Date;
  notify: (orgId: string, r: NotifyRequest) => Promise<unknown>;
  agentUserId?: string | null;
  fromNumber: string;
}

const REQ_COLS = "id, organization_id, requested_by, kind, contact_id, name, phone_e164, goal, must_confirm, context, appointment_id, agent_request_id, not_before, status, attempts, last_attempt_at, call_sid";
const clip = (s: string | undefined, n: number) => (s ?? "").replace(/\s+/g, " ").trim().slice(0, n);

/** Pure: the one-line outcome used in the log and the message to the requester. */
export function summarizeOutcome(r: Pick<CallRequest, "kind" | "name" | "goal">, ending: CallEnding, learned: Record<string, string>): string {
  if (ending === "no_answer") return `${r.name} didn't answer.`;
  if (ending === "voicemail") return `Reached ${r.name}'s voicemail and left a short message.`;
  if (ending === "failed") return `The call to ${r.name} didn't connect.`;
  if (r.kind === "confirm_appointment") {
    if (learned.confirmed === "yes") return `${r.name} confirmed the appointment.`;
    if (learned.confirmed === "reschedule" || learned.newTime) return `${r.name} wants to reschedule${learned.newTime ? ` — ${clip(learned.newTime, 80)}` : ""}.`;
    if (learned.confirmed === "no") return `${r.name} can't make the appointment.`;
    return `Spoke with ${r.name} but didn't get a clear answer on the appointment.`;
  }
  const bits = [learned.answer && `Answer: ${clip(learned.answer, 240)}`, learned.notes && `Notes: ${clip(learned.notes, 200)}`].filter(Boolean);
  return bits.length ? `Spoke with ${r.name}. ${bits.join(" ")}` : `Spoke with ${r.name}; nothing specific came out of it.`;
}

export async function finishOutbound(db: SupabaseClient, callSid: string, ending: CallEnding, d: FinishDeps): Promise<"finished" | "already" | "unknown"> {
  const { data: rq } = await db.from("clara_call_requests").select(REQ_COLS).eq("call_sid", callSid).maybeSingle();
  const r = rq as CallRequest | null;
  if (!r) return "unknown";

  // Claim: the status callback and the voice webhook both finish calls. A call that never reached a
  // webhook has no session; the request's own state is the guard then.
  const session = await getSession(db, callSid);
  if (session) {
    if (!(await claimFinalize(db, callSid))) return "already";
  } else if (r.status !== "dialing") return "already";

  const state: CallState | undefined = session?.state;
  const learned = state?.learned ?? {};
  const spoke = ending === "conversation" || Object.keys(learned).length > 0;
  const final: CallEnding = spoke ? "conversation" : ending;
  const summary = summarizeOutcome(r, final, learned);
  const nowIso = d.now().toISOString();

  // Unanswered: try again later if the request is still worth it.
  const willRetry = (final === "no_answer" || final === "voicemail" || final === "failed") && r.attempts < MAX_ATTEMPTS;
  await db.from("clara_call_requests").update(willRetry
    ? { status: "queued", not_before: new Date(d.now().getTime() + RETRY_GAP_MS).toISOString(), summary, updated_at: nowIso }
    : { status: final === "conversation" ? "completed" : final, summary, outcome: learned, updated_at: nowIso },
  ).eq("id", r.id);

  // Log to the contact's conversation.
  if (r.contact_id) {
    try {
      const conv = await findOrCreateConversation(db, { orgId: r.organization_id, contactId: r.contact_id, channel: "voice", assignedUserId: d.agentUserId });
      await upsertCallLog(db, { orgId: r.organization_id, callSid, direction: "outbound", from: d.fromNumber, to: r.phone_e164, conversationId: conv.id, contactId: r.contact_id, line: "business", agentUserId: d.agentUserId ?? null });
      await insertMessage(db, { orgId: r.organization_id, conversationId: conv.id, contactId: r.contact_id, channel: "voice", direction: "system", messageType: "call_event", body: `Clara called — ${summary}`, metadata: { call_sid: callSid, request_id: r.id, kind: r.kind, learned } });
      const transcript = (state?.turns ?? []).map((t) => `${t.role === "clara" ? "Clara" : r.name}: ${t.text}`).join("\n");
      if (transcript) await insertMessage(db, { orgId: r.organization_id, conversationId: conv.id, contactId: r.contact_id, channel: "voice", direction: "outbound", messageType: "call_transcript", body: transcript, metadata: { call_sid: callSid } });
    } catch (e) { console.error("[outbound-finish] conversation log failed:", e); }
  }

  // Asked not to be called again: honored immediately, whatever else the call was about.
  if (learned.optOut === "yes") {
    await db.from("dnc_numbers").upsert({ org_id: r.organization_id, phone_number: r.phone_e164, reason: "Asked not to be called (phone)" }, { onConflict: "org_id,phone_number", ignoreDuplicates: true });
  }

  if (willRetry) return "finished";

  // Consequences + who to tell.
  const notify = (req: NotifyRequest) => d.notify(r.organization_id, req).catch((e) => console.error("[outbound-finish] notify failed:", e));
  if (r.kind === "confirm_appointment" && r.appointment_id) {
    if (final === "conversation" && learned.confirmed === "yes") {
      const { data: a } = await db.from("appointments").select("internal_notes").eq("id", r.appointment_id).maybeSingle();
      const note = `Confirmed by phone (Clara) ${nowIso.slice(0, 10)}.`;
      await db.from("appointments").update({ internal_notes: [(a as { internal_notes: string | null } | null)?.internal_notes, note].filter(Boolean).join("\n") }).eq("id", r.appointment_id);
    } else {
      // Anything but a clean yes needs a human; Clara never cancels or moves an appointment herself.
      await notify({ kind: "appointment.confirmation", priority: "critical", category: "revenue", text: `${summary} Appointment is unchanged — your call.`, dedupeKey: `confirm-call:${r.id}` });
    }
  } else if (r.agent_request_id && r.kind === "clarify") {
    if (final === "conversation" && learned.answer) {
      const { data: ar } = await db.from("agent_requests").select("body").eq("id", r.agent_request_id).maybeSingle();
      await db.from("agent_requests").update({
        status: "queued", notified_at: null, finished_at: null, lease_expires_at: null, attempt: 0, updated_at: nowIso,
        body: `${(ar as { body: string } | null)?.body ?? ""}\n\n--- Clara called ${r.name} to ask: ${r.goal} ---\n--- They answered ---\n${learned.answer}${learned.notes ? `\n(${learned.notes})` : ""}`,
      }).eq("id", r.agent_request_id);
      await notify({ kind: "call.clarify", priority: "normal", text: `${summary} Passed to FRIDAY.`, dedupeKey: `clarify-call:${r.id}` });
    } else {
      await notify({ kind: "call.clarify", priority: "critical", category: "revenue", text: `${summary} FRIDAY is still waiting on that answer.`, dedupeKey: `clarify-call:${r.id}` });
    }
  } else {
    // Owner asked for the call: he hears how it went either way.
    await notify({ kind: "call.owner_request", priority: "critical", category: "revenue", text: summary, dedupeKey: `owner-call:${r.id}` });
  }
  return "finished";
}
