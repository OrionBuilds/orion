/**
 * friday-clarify-watch — cron-only (every 5 min). Budget ~40 s per run (pg_net cuts a cron call at 60 s); state lives in
 * friday_triage_state so a cut-off run resumes. Never sends: client-visible text goes through the
 * owner approval queue. See _shared/friday/clarify.ts.
 */
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { isCronRequest } from "../_shared/auth.ts";
import { denoEnv, serviceClient } from "../_shared/clara/webhook.ts";
import { anthropicModel, startBudget } from "../_shared/friday/portal.ts";
import { runClarifyWatch } from "../_shared/friday/clarify.ts";

Deno.serve(async (req: Request) => {
  if (!isCronRequest(req)) return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 });
  try {
    const db = serviceClient();
    const budget = startBudget();
    const ran = await runClarifyWatch(db, denoEnv, { model: anthropicModel(denoEnv), budget });
    return new Response(JSON.stringify({ success: true, ran }), { headers: { "Content-Type": "application/json" } });
  } catch (e) {
    console.error("[friday-clarify-watch]", e);
    return new Response(JSON.stringify({ success: false, error: (e as Error).message }), { status: 500 });
  }
});
