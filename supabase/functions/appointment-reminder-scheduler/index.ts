/**
 * appointment-reminder-scheduler
 *
 * Cron-driven reminder engine for the public booking flow. Until now, an
 * appointment reminder only ever fired if a user hand-wired the
 * `send_appointment_reminder` workflow action — there was no schedule behind it.
 * This closes the "Notifications" gap of the calendar-builder parity: every
 * appointment type carries `reminder_hours_before` (e.g. {24} = one reminder a
 * day out), and this job emails the visitor at each offset.
 *
 * Runs every ~15 minutes (see the cron migration). For each upcoming scheduled
 * appointment it finds the reminder offsets that have come due since the last
 * run and sends one per appointment per tick, recording the offset in
 * `appointments.reminders_sent` so a reminder is never sent twice — even if two
 * ticks overlap or the horizon is re-scanned.
 *
 * Auth: cron-only. pg_cron posts the vault `cron_secret` as an X-Cron-Secret
 * header (matching the workflow-condition-checker convention); isCronRequest
 * constant-time-compares it against the CRON_SECRET env. Deployed
 * verify_jwt=false so pg_cron can reach it, so this header check is the gate.
 * The function still holds the service-role key in its own env, which it uses to
 * call booking-email.
 */

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";
import { isCronRequest } from "../_shared/auth.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};

// Never scan further out than this. Covers reminder offsets up to 8 days; a type
// asking for a longer lead time simply won't remind (a sane ceiling, not a bug).
const HORIZON_DAYS = 8;
// Bound work per tick so a backlog can't make one invocation run unbounded.
const MAX_APPTS_PER_RUN = 300;

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 200, headers: corsHeaders });
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  if (!isCronRequest(req)) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

  const supabase = createClient(supabaseUrl, serviceKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const now = Date.now();
  const horizonIso = new Date(now + HORIZON_DAYS * 86_400_000).toISOString();
  const nowIso = new Date(now).toISOString();

  // Upcoming, still-scheduled appointments and their type's reminder config.
  const { data: appts, error } = await supabase
    .from("appointments")
    .select("id, start_at_utc, created_at, reminders_sent, appointment_type:appointment_types(reminder_hours_before)")
    .eq("status", "scheduled")
    .gt("start_at_utc", nowIso)
    .lt("start_at_utc", horizonIso)
    .order("start_at_utc", { ascending: true })
    .limit(MAX_APPTS_PER_RUN);

  if (error) {
    console.error("[appointment-reminder-scheduler] query failed:", error.message);
    return new Response(JSON.stringify({ error: "query_failed" }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  let sent = 0;
  let scanned = 0;
  for (const appt of appts ?? []) {
    scanned++;
    const type = appt.appointment_type as { reminder_hours_before?: number[] } | null;
    const offsets = (type?.reminder_hours_before ?? []).filter((h) => Number.isFinite(h) && h > 0);
    if (offsets.length === 0) continue;

    const startMs = Date.parse(appt.start_at_utc as string);
    const createdMs = Date.parse((appt.created_at as string) ?? "");
    const alreadySent: number[] = Array.isArray(appt.reminders_sent) ? appt.reminders_sent as number[] : [];

    // Consider the SOONEST-to-start offset first (largest lead time whose moment
    // has passed). Send at most one per appointment per tick.
    let toSend: number | null = null;
    for (const offset of [...offsets].sort((a, b) => b - a)) {
      if (alreadySent.includes(offset)) continue;
      const dueAt = startMs - offset * 3_600_000;
      // Due window opened, appointment still ahead, and the reminder's moment is
      // not from before the booking existed (so a same-day booking doesn't
      // instantly fire a "24h before" reminder that never applied).
      if (now >= dueAt && now < startMs && (!Number.isFinite(createdMs) || dueAt >= createdMs)) {
        toSend = offset;
        break;
      }
    }
    if (toSend === null) continue;

    try {
      const res = await fetch(`${supabaseUrl}/functions/v1/booking-email`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${serviceKey}` },
        body: JSON.stringify({ appointment_id: appt.id, action: "reminder" }),
      });
      const body = await res.json().catch(() => ({}));
      // Only mark as sent when the email actually went out; a mailgun-not-configured
      // / no-recipient response (success:false) leaves the offset unsent to retry.
      if (res.ok && body?.success) {
        await supabase
          .from("appointments")
          .update({ reminders_sent: [...alreadySent, toSend] })
          .eq("id", appt.id);
        sent++;
      } else {
        console.warn(`[appointment-reminder-scheduler] reminder not sent for ${appt.id}:`, body?.reason || body?.error || res.status);
      }
    } catch (e) {
      console.error(`[appointment-reminder-scheduler] send failed for ${appt.id}:`, e);
    }
  }

  return new Response(JSON.stringify({ ok: true, scanned, sent }), {
    status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
});
