/**
 * friday-ticket-triage — cron-only (hourly). Budget ~40 s per run (pg_net cuts a cron call at 60 s); state lives in
 * friday_triage_state so a cut-off run resumes. Never sends: client-visible text goes through the
 * owner approval queue. See _shared/friday/triage.ts.
 */
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { isCronRequest } from "../_shared/auth.ts";
import { denoEnv, serviceClient } from "../_shared/clara/webhook.ts";
import { anthropicModel, startBudget } from "../_shared/friday/portal.ts";
import { runTicketTriage } from "../_shared/friday/triage.ts";

Deno.serve(async (req: Request) => {
  if (!isCronRequest(req)) return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 });
  try {
    const db = serviceClient();
    const budget = startBudget();
    const ran = await runTicketTriage(db, denoEnv, { model: anthropicModel(denoEnv), budget, env: denoEnv });
    return new Response(JSON.stringify({ success: true, ran }), { headers: { "Content-Type": "application/json" } });
  } catch (e) {
    console.error("[friday-ticket-triage]", e);
    return new Response(JSON.stringify({ success: false, error: (e as Error).message }), { status: 500 });
  }
});
