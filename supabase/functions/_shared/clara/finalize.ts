/**
 * End of an inbound call (ported from CLARA's leads.ts finalizeInboundCall + workLineCalls.ts).
 *
 * TWO things end a call and both want to finalize: the brain setting done (voice webhook), and
 * Twilio's end-of-call status callback when the caller simply hangs up. Hangups are the common
 * case, so the status callback files most real leads. claimFinalize makes the race safe: whichever
 * arrives first wins and the other no-ops.
 *
 * Everything is logged to the OS conversation for the caller:
 *   call_event message (summary of what happened) + call_transcript message (the turns).
 * A contact is only CREATED when the caller actually told us something; a wrong number or a
 * greeting hang-up leaves a call_logs row and nothing else, so the CRM doesn't fill with junk.
 */
import type { SupabaseClient } from "npm:@supabase/supabase-js@2";
import type { CallState } from "./types.ts";
import type { Env } from "./phones.ts";
import { claimFinalize, getSession, linkConversation, type SessionRow } from "./call-state.ts";
import { bookReady, pendingBooking, bookingTz } from "./booking.ts";
import { summarize } from "./brain.ts";
import { type LeadReason, didLine, importantCallText, planWorkLineCall } from "./work-line-calls.ts";
import { speakSlot } from "./work-line.ts";
import { findOrCreateConversation, insertMessage, resolveContactByPhone, upsertCallLog } from "./conversations.ts";
import type { NotifyRequest } from "./notify.ts";
import { names } from "./persona.ts";

export interface FinalizeDeps {
  env: Env;
  fetch?: typeof fetch;
  notify: (req: NotifyRequest) => Promise<unknown>;
  /** Put the agreed slot on the owner's calendar. True on success. */
  bookOwnerSlot: (e: { subject: string; startISO: string; endISO: string; attendees: string[]; description: string }) => Promise<boolean>;
  /** The Clara agent user (conversation assignee). */
  agentUserId?: string | null;
  departmentId?: string | null;
  sleep?: (ms: number) => Promise<void>;
}

const sleepDefault = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const callerLines = (s: CallState) => s.turns.map((t) => `${t.role === "clara" ? "Clara" : "Caller"}: ${t.text}`).join("\n");

/** A mid-call booking may still be running in another invocation: poll the session for its outcome. */
export async function settlePendingBooking(db: SupabaseClient, callSid: string, d: Pick<FinalizeDeps, "sleep">, timeoutMs = 20_000): Promise<CallState["booking"] | undefined> {
  const sleep = d.sleep ?? sleepDefault;
  for (let waited = 0; waited <= timeoutMs; waited += 1_000) {
    const row = await getSession(db, callSid);
    if (row?.state.booking && row.state.booking.status !== "pending") return row.state.booking;
    if (!row?.state.booking) return undefined;
    await sleep(1_000);
  }
  return undefined;
}

/**
 * Find the caller's contact. Existing contacts are matched by phone first, then by email. Never
 * creates one: a contact exists only once a lead books, fills a form or is added by hand, so a call
 * from an unknown number is logged to call history without a contact (and no conversation thread).
 */
export async function contactForCall(
  db: SupabaseClient, orgId: string, state: CallState,
): Promise<{ id: string; created: boolean } | null> {
  const byPhone = await resolveContactByPhone(db, orgId, state.fromE164);
  if (byPhone) return byPhone;
  const l = state.learned;
  if (l.email) {
    const { data } = await db.from("contacts").select("id").eq("organization_id", orgId).ilike("email", l.email).limit(1).maybeSingle();
    if (data) return { id: (data as { id: string }).id, created: false };
  }
  return null;
}

/** Write the call into the caller's conversation and link the session and call_logs to it. */
export async function logCallToConversation(
  db: SupabaseClient, row: SessionRow, d: FinalizeDeps, summaryText: string, reason: LeadReason,
): Promise<{ conversationId: string; contactId: string } | null> {
  const contact = await contactForCall(db, row.organization_id, row.state);
  if (!contact) return null;
  const conv = await findOrCreateConversation(db, {
    orgId: row.organization_id, contactId: contact.id, channel: "voice",
    departmentId: d.departmentId, assignedUserId: d.agentUserId,
  });
  await linkConversation(db, row.call_sid, conv.id, contact.id);
  await upsertCallLog(db, {
    orgId: row.organization_id, callSid: row.call_sid, direction: "inbound",
    from: row.from_e164, to: row.to_e164 ?? "", conversationId: conv.id, contactId: contact.id,
    // The first voice hit already decided owner/work/business; only a work-line session overrides it.
    line: row.state.line === "work" ? "work" : undefined, agentUserId: d.agentUserId ?? null,
  });
  await insertMessage(db, {
    orgId: row.organization_id, conversationId: conv.id, contactId: contact.id, channel: "voice",
    direction: "system", messageType: "call_event", body: summaryText, externalId: null,
    metadata: { call_sid: row.call_sid, line: row.state.line ?? "business", reason, learned: row.state.learned },
  });
  const transcript = callerLines(row.state);
  if (transcript) {
    await insertMessage(db, {
      orgId: row.organization_id, conversationId: conv.id, contactId: contact.id, channel: "voice",
      direction: "inbound", messageType: "call_transcript", body: transcript, senderIdentifier: row.from_e164,
      metadata: { call_sid: row.call_sid },
    });
  }
  await db.from("contact_timeline").insert({
    contact_id: contact.id, event_type: "note_added",
    event_data: { by: "clara.inbound_call", call_sid: row.call_sid, from: row.from_e164, reason, turns: row.state.turns.length, learned: row.state.learned, summary: summaryText },
  });
  return { conversationId: conv.id, contactId: contact.id };
}

export async function finalizeInboundCall(db: SupabaseClient, callSid: string, reason: LeadReason, d: FinalizeDeps): Promise<"finalized" | "already"> {
  const claimed = await claimFinalize(db, callSid);
  if (!claimed) return "already";
  const tz = bookingTz(d.env);

  // Re-read after claiming: a mid-call booking may have settled since the claim winner's snapshot.
  let row = (await getSession(db, callSid)) ?? claimed;
  if (row.state.booking?.status === "pending") {
    const settled = await settlePendingBooking(db, callSid, d);
    if (settled) row = { ...row, state: { ...row.state, booking: settled } };
  }
  const state = row.state;
  const learnedAnything = Object.keys(state.learned).length > 0;

  if (state.line === "work") return await finalizeWorkLine(db, row, reason, d, tz);

  // Main line: they picked an offered time but never gave an email (or hung up first): book it
  // phone-only now so the time is held; the owner is told to confirm by phone.
  if (!state.booking) {
    const p = pendingBooking(state, { requireEmail: false });
    if (p) {
      const booking = await bookReady(d.env, state, p, d.fetch).catch(() => null);
      if (booking) row = { ...row, state: { ...state, booking } };
    }
  }
  const summary = summarize(row.state, row.status, tz);
  await logCallToConversation(db, row, d, summary, reason).catch((e) => console.error("[finalize] conversation log failed:", e));

  // A call that learned nothing is not worth a notification: wrong numbers and greeting hang-ups
  // would otherwise page the owner several times a day and train him to ignore the channel.
  if (learnedAnything || reason === "blocked") {
    await d.notify({
      kind: "lead.inbound_call",
      priority: reason === "wants-human" || reason === "blocked" ? "critical" : "normal",
      text: `${summary}${reason === "wants-human" ? "\n⚠ Asked for a person." : ""}`,
      dedupeKey: `lead:call:${callSid}`,
    }).catch((e) => console.error("[finalize] notify failed:", e));
  }
  return "finalized";
}

async function finalizeWorkLine(db: SupabaseClient, row: SessionRow, reason: LeadReason, d: FinalizeDeps, tz: string) {
  const state = row.state;
  const first = names(d.env).ownerFirst;
  const plan = planWorkLineCall(state, reason, first);
  const l = state.learned;

  let booked: string | null = null;
  if (plan.bookSlot) {
    const start = new Date(plan.bookSlot);
    const ok = await d.bookOwnerSlot({
      subject: `Call with ${plan.who}`,
      startISO: start.toISOString(),
      endISO: new Date(start.getTime() + 30 * 60_000).toISOString(),
      attendees: l.email ? [l.email] : [],
      description: `Booked by Clara from a call to your work phone.\nWhat they need: ${l.need ?? "not said"}\nCall them on: ${l.callback || state.fromE164}`,
    }).catch(() => false);
    if (ok) booked = speakSlot(plan.bookSlot, tz);
  }

  let texted = Boolean(state.vipImmediateTexted);
  if (plan.important) {
    const r = await d.notify({
      kind: "work_line.call", priority: "critical", category: "revenue",
      text: importantCallText(plan, state), dedupeKey: `workline:call:${row.call_sid}`,
    }).catch(() => "failed");
    texted = texted || r === "sms" || r === "email";
  }

  const did = didLine(plan, state, reason, booked);
  const detail = [
    l.company ? `Company: ${l.company}` : "",
    l.timeline ? `When: ${l.timeline}` : "",
    l.callback ? `Callback: ${l.callback}` : "",
    `${state.turns.filter((t) => t.role === "caller").length} caller turn(s); ${first}'s phone ${state.transferTried ? (state.transferAccepted ? "took the transfer" : `didn't take the transfer (${state.transferOutcome ?? "not reached"})`) : "wasn't rung"}.`,
  ].filter(Boolean).join(" · ");
  const summary = [`📞 ${plan.who} — work line`, plan.need ? `Needs: ${plan.need}` : "", did, detail, texted ? "(owner texted)" : ""].filter(Boolean).join("\n");
  await logCallToConversation(db, row, d, summary, reason).catch((e) => console.error("[finalize] conversation log failed:", e));
  return "finalized" as const;
}
