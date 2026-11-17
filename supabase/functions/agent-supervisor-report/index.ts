/**
 * agent-supervisor-report — where a supervisor says WHY it cannot start its agent.
 *
 * THE OUTAGE THIS EXISTS FOR. On 2026-08-03 all three agents were down for six hours and every
 * layer of the recovery chain did its job: the supervisors retried 4,523 times, the watchdogs ran
 * every minute, and agent-liveness-alarm paged the owner 20 minutes in.
 *
 * It was still a six-hour outage, because the alarm could only observe "no heartbeat" and then
 * GUESS at a cause. It guessed "the workstation rebooted and nobody signed back in" — confidently,
 * in the text — and that was wrong. The box was up. The real error was
 * "Could not find a production build in the '.next' directory", which the supervisor had written
 * to a local log file 4,523 times, on the one machine nobody could see.
 *
 * A confidently wrong diagnosis is worse than no diagnosis: it tells the owner what to stop
 * worrying about. This endpoint closes that gap — the supervisor pushes its actual last error off
 * the box, and the alarm quotes it instead of speculating.
 *
 * AUTH. A shared key in the X-Supervisor-Key header, checked fail-closed. The payload lands in an
 * alert the owner will act on at 4am, so an unauthenticated writer could fabricate an outage or,
 * worse, a plausible false cause. The key lives in Supabase secrets and in a file on the
 * workstation that the supervisors read at startup.
 */

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const ALLOWED = new Set(["clara", "friday"]);

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return new Response("POST only", { status: 405 });

  // Fail CLOSED. An unset key means the endpoint refuses everything rather than accepting
  // everything — the opposite default would let anyone inject an outage cause.
  const expected = (Deno.env.get("SUPERVISOR_REPORT_KEY") ?? "").trim();
  if (!expected) return json({ error: "reporting is not configured" }, 503);
  const presented = (req.headers.get("x-supervisor-key") ?? "").trim();
  if (!presented || !timingSafeEqual(presented, expected)) return json({ error: "unauthorized" }, 401);

  const body = await req.json().catch(() => null) as {
    agent?: string; ok?: boolean; error?: string; consecutiveFails?: number; host?: string;
  } | null;

  const agent = String(body?.agent ?? "").toLowerCase().trim();
  if (!ALLOWED.has(agent)) return json({ error: "unknown agent" }, 400);

  const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const now = new Date().toISOString();
  const healthy = body?.ok === true;

  const { error } = await supabase.from("agent_supervisor_state").upsert({
    agent_slug: agent,
    consecutive_fails: healthy ? 0 : Math.max(0, Number(body?.consecutiveFails ?? 1)),
    // Cleared on success so a stale error can never be quoted in a live alert as if it were current.
    last_error: healthy ? null : String(body?.error ?? "").slice(0, 1000),
    last_failure_at: healthy ? null : now,
    ...(healthy ? { last_success_at: now } : {}),
    host: String(body?.host ?? "").slice(0, 120) || null,
    updated_at: now,
  }, { onConflict: "agent_slug" });

  if (error) return json({ error: error.message }, 500);
  return json({ ok: true, agent, healthy });
});
