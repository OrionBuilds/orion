/**
 * Placing Clara's outbound calls, and settling them.
 *
 * Every call is a row in clara_call_requests; this module is the ONLY thing that dials, so the
 * guardrails live in one place:
 *   - opt-outs: a number on dnc_numbers is never called (blocked, not retried);
 *   - hours: only inside calling hours (default 08:00-20:00 in the org's timezone, and never inside
 *     the org's own quiet hours); outside them the request simply waits;
 *   - a real reason: confirmation calls need a still-scheduled future appointment, everything else
 *     needs an explicit request from the owner, FRIDAY or the confirmation cron. There is no
 *     list to work through, so there is nothing to cold-call;
 *   - limits: two attempts per request, at least 3 hours apart, and one live call at a time per
 *     number.
 */
import type { SupabaseClient } from "npm:@supabase/supabase-js@2";
import type { CallObjective } from "./types.ts";
import type { Env } from "./phones.ts";
import { normalizeE164 } from "./phones.ts";
import { inQuietHours } from "./notify.ts";
import { type TwilioAuth, placeCall } from "./twilio-rest.ts";
import { ensureSession, getSession } from "./call-state.ts";

export const MAX_ATTEMPTS = 2;
export const RETRY_GAP_MS = 3 * 3_600_000;

export interface CallRequest {
  id: string; organization_id: string; requested_by: "owner" | "friday" | "system";
  kind: CallObjective["kind"]; contact_id: string | null; name: string; phone_e164: string; goal: string;
  must_confirm: string[]; context: string | null; appointment_id: string | null; agent_request_id: string | null;
  not_before: string; status: string; attempts: number; last_attempt_at: string | null; call_sid: string | null;
}
const COLS = "id, organization_id, requested_by, kind, contact_id, name, phone_e164, goal, must_confirm, context, appointment_id, agent_request_id, not_before, status, attempts, last_attempt_at, call_sid";

export type Callable = { ok: true } | { ok: false; reason: string; retry: boolean };

/** Pure: inside the calling window and outside the org's quiet hours? */
export function withinCallingHours(now: Date, tz: string, quiet: string | undefined, openHour = 8, closeHour = 20): boolean {
  const h = Number(new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric", hour12: false }).format(now)) % 24;
  return h >= openHour && h < closeHour && !inQuietHours(quiet, tz, now);
}

export interface Guard { now: Date; tz: string; quiet?: string; openHour?: number; closeHour?: number }

export async function checkCallable(db: SupabaseClient, r: CallRequest, g: Guard): Promise<Callable> {
  if (!normalizeE164(r.phone_e164)) return { ok: false, reason: "invalid number", retry: false };
  const { data: dnc } = await db.from("dnc_numbers").select("id").eq("org_id", r.organization_id).eq("phone_number", r.phone_e164).maybeSingle();
  if (dnc) return { ok: false, reason: "on the opt-out list", retry: false };
  if (r.attempts >= MAX_ATTEMPTS) return { ok: false, reason: "attempt limit reached", retry: false };
  if (r.last_attempt_at && g.now.getTime() - new Date(r.last_attempt_at).getTime() < RETRY_GAP_MS) return { ok: false, reason: "tried recently", retry: true };
  if (r.kind === "confirm_appointment") {
    const { data: a } = r.appointment_id
      ? await db.from("appointments").select("status, start_at_utc").eq("id", r.appointment_id).maybeSingle()
      : { data: null };
    const appt = a as { status: string; start_at_utc: string } | null;
    if (!appt || appt.status !== "scheduled" || new Date(appt.start_at_utc).getTime() <= g.now.getTime()) {
      return { ok: false, reason: "the appointment is no longer upcoming", retry: false };
    }
  }
  // Beyond the owner's own asks, Clara only phones people she has a relationship with: someone who
  // booked an appointment or is a project client. A new lead who hasn't booked is never called.
  if (r.requested_by !== "owner" && r.kind !== "confirm_appointment") {
    const has = async (table: "appointments" | "projects") => {
      if (!r.contact_id) return false;
      const { count } = await db.from(table).select("id", { count: "exact", head: true }).eq("contact_id", r.contact_id);
      return (count ?? 0) > 0;
    };
    if (!(await has("appointments")) && !(await has("projects"))) return { ok: false, reason: "not a booked client (no appointment or project)", retry: false };
  }
  if (!withinCallingHours(g.now, g.tz, g.quiet, g.openHour, g.closeHour)) return { ok: false, reason: "outside calling hours", retry: true };
  const { count } = await db.from("clara_call_requests").select("id", { count: "exact", head: true }).eq("phone_e164", r.phone_e164).eq("status", "dialing");
  if ((count ?? 0) > 0) return { ok: false, reason: "a call to this number is already in progress", retry: true };
  return { ok: true };
}

export interface DialDeps {
  env: Env; auth: TwilioAuth; fromNumber: string; base: string; now: () => Date;
  fetch?: typeof fetch;
  quiet?: string; tz: string;
}

/** Try to place one request's call. Returns what happened; never throws on a normal refusal. */
export async function dialRequest(db: SupabaseClient, r: CallRequest, d: DialDeps): Promise<"dialed" | "waiting" | "blocked" | "failed"> {
  const can = await checkCallable(db, r, { now: d.now(), tz: d.tz, quiet: d.quiet });
  if (!can.ok) {
    if (can.retry) return "waiting";
    await db.from("clara_call_requests").update({ status: "blocked", blocked_reason: can.reason, updated_at: d.now().toISOString() }).eq("id", r.id).eq("status", "queued");
    return "blocked";
  }
  // Claim it: only one dialer pass may place this call.
  const { data: claimed } = await db.from("clara_call_requests")
    .update({ status: "dialing", attempts: r.attempts + 1, last_attempt_at: d.now().toISOString(), updated_at: d.now().toISOString() })
    .eq("id", r.id).eq("status", "queued").select("id");
  if (!((claimed as unknown[] | null) ?? []).length) return "waiting";

  const res = await placeCall(d.auth, d.fromNumber, r.phone_e164, { url: `${d.base}/clara-voice-outbound?requestId=${encodeURIComponent(r.id)}` }, {
    // Detection first so a voicemail greeting isn't treated as a person; recording starts only
    // after the spoken disclosure, inside the TwiML.
    machineDetection: "DetectMessageEnd", machineDetectionTimeoutSec: 8, timeoutSec: 25,
    statusCallback: `${d.base}/clara-voice-status`, statusCallbackEvent: ["completed"],
  }, d.fetch);
  if (!res.ok) {
    await db.from("clara_call_requests").update({
      status: r.attempts + 1 >= MAX_ATTEMPTS ? "failed" : "queued", summary: `Couldn't place the call: ${res.error?.slice(0, 160)}`,
      not_before: new Date(d.now().getTime() + RETRY_GAP_MS).toISOString(), updated_at: d.now().toISOString(),
    }).eq("id", r.id);
    return "failed";
  }
  await db.from("clara_call_requests").update({ call_sid: res.sid ?? null }).eq("id", r.id);
  return "dialed";
}

export async function dueRequests(db: SupabaseClient, now: Date, limit = 5): Promise<CallRequest[]> {
  const { data } = await db.from("clara_call_requests").select(COLS).eq("status", "queued").lte("not_before", now.toISOString()).order("not_before").limit(limit);
  return (data ?? []) as CallRequest[];
}

export const objectiveOf = (r: CallRequest): CallObjective => ({
  requestId: r.id, kind: r.kind, name: r.name, phone: r.phone_e164, goal: r.goal, mustConfirm: r.must_confirm ?? [], context: r.context ?? undefined,
});

/** First webhook hit of a placed call: create its session from the request (rehydrates after retries). */
export async function sessionForRequest(db: SupabaseClient, r: CallRequest, callSid: string, orgId: string, from: string) {
  const row = await ensureSession(db, { callSid, orgId, direction: "outbound", from: r.phone_e164, to: from });
  if (!row.state.objective) {
    await db.from("clara_call_sessions").update({ state: { ...row.state, objective: objectiveOf(r), line: "business" } }).eq("call_sid", callSid);
    await db.from("clara_call_requests").update({ call_sid: callSid }).eq("id", r.id);
  }
  return (await getSession(db, callSid))!;
}
