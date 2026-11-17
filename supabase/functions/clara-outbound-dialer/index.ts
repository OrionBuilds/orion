/**
 * clara-outbound-dialer — cron (every 2 minutes). Places due calls from clara_call_requests,
 * applying every guardrail (opt-outs, calling hours, attempt limits, a real reason) in one place:
 * _shared/clara/outbound.ts. Cron-only.
 */
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { isCronRequest } from "../_shared/auth.ts";
import { denoEnv, functionsBase, serviceClient, twilioAuth } from "../_shared/clara/webhook.ts";
import { dialRequest, dueRequests } from "../_shared/clara/outbound.ts";
import { callingSettings, claraNumberFor } from "../_shared/clara/runtime.ts";

Deno.serve(async (req: Request) => {
  if (!isCronRequest(req)) return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 });
  const auth = twilioAuth(denoEnv);
  if (!auth) return new Response(JSON.stringify({ success: false, error: "Twilio not configured" }), { status: 500 });
  const db = serviceClient();
  const tally: Record<string, number> = {};
  try {
    for (const r of await dueRequests(db, new Date())) {
      const s = await callingSettings(db, denoEnv, r.organization_id);
      const out = await dialRequest(db, r, {
        env: denoEnv, auth, fromNumber: await claraNumberFor(db, denoEnv, r.organization_id), base: functionsBase(denoEnv),
        now: () => new Date(), tz: s.tz, quiet: s.quiet,
      });
      tally[out] = (tally[out] ?? 0) + 1;
    }
    return new Response(JSON.stringify({ success: true, ...tally }), { headers: { "Content-Type": "application/json" } });
  } catch (e) {
    console.error("[clara-outbound-dialer]", e);
    return new Response(JSON.stringify({ success: false, error: (e as Error).message }), { status: 500 });
  }
});
