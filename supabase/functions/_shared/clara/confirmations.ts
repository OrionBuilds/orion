/**
 * Queue confirmation calls for upcoming appointments (the dialer decides WHEN, and applies hours,
 * opt-outs and attempt limits). One request per appointment, ever: the unique index on
 * (appointment_id, kind) makes re-running this every hour safe.
 */
import type { SupabaseClient } from "npm:@supabase/supabase-js@2";
import type { Env } from "./phones.ts";
import { normalizeE164 } from "./phones.ts";
import { names } from "./persona.ts";

/** Appointments starting in this window get a confirmation call (about a day ahead). */
export const WINDOW_START_H = 18;
export const WINDOW_END_H = 30;

export function confirmationGoal(business: string, startIso: string, tz: string): string {
  const d = new Date(startIso);
  const day = d.toLocaleDateString("en-US", { timeZone: tz, weekday: "long" });
  const time = d.toLocaleTimeString("en-US", { timeZone: tz, hour: "numeric", minute: "2-digit" });
  return `I'm calling to confirm your appointment with ${business} on ${day} at ${time}. Will you still be able to make it?`;
}

export async function queueConfirmations(db: SupabaseClient, env: Env, now: Date): Promise<{ queued: number; skipped: number }> {
  const from = new Date(now.getTime() + WINDOW_START_H * 3_600_000).toISOString();
  const to = new Date(now.getTime() + WINDOW_END_H * 3_600_000).toISOString();
  const { data } = await db.from("appointments").select("id, org_id, contact_id, start_at_utc, visitor_timezone")
    .eq("status", "scheduled").gte("start_at_utc", from).lte("start_at_utc", to).limit(100);
  const business = names(env).business;
  const defaultTz = env.get("CLARA_TZ") || "America/New_York";
  let queued = 0, skipped = 0;
  for (const a of (data ?? []) as { id: string; org_id: string; contact_id: string | null; start_at_utc: string; visitor_timezone: string | null }[]) {
    if (!a.contact_id) { skipped++; continue; }
    const { data: c } = await db.from("contacts").select("first_name, last_name, phone, status").eq("id", a.contact_id).maybeSingle();
    const contact = c as { first_name: string | null; last_name: string | null; phone: string | null; status: string } | null;
    const phone = normalizeE164(contact?.phone);
    if (!contact || contact.status !== "active" || !phone) { skipped++; continue; }
    let tz = a.visitor_timezone || defaultTz;
    try { new Intl.DateTimeFormat("en-US", { timeZone: tz }); } catch { tz = defaultTz; }
    const { error } = await db.from("clara_call_requests").insert({
      organization_id: a.org_id, requested_by: "system", kind: "confirm_appointment", contact_id: a.contact_id,
      name: `${contact.first_name ?? ""} ${contact.last_name ?? ""}`.trim() || phone, phone_e164: phone,
      goal: confirmationGoal(business, a.start_at_utc, tz),
      must_confirm: ["Whether they will attend", "A new time, if they cannot"], appointment_id: a.id,
    });
    if (error) { if (error.code === "23505") skipped++; else console.error("[confirmations]", error.message); continue; }
    queued++;
  }
  return { queued, skipped };
}
