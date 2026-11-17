/** clara-appointment-confirmations — hourly cron: queue confirmation calls for tomorrow's appointments. Cron-only. */
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { isCronRequest } from "../_shared/auth.ts";
import { denoEnv, serviceClient } from "../_shared/clara/webhook.ts";
import { queueConfirmations } from "../_shared/clara/confirmations.ts";

Deno.serve(async (req: Request) => {
  if (!isCronRequest(req)) return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 });
  try {
    return new Response(JSON.stringify({ success: true, ...(await queueConfirmations(serviceClient(), denoEnv, new Date())) }), { headers: { "Content-Type": "application/json" } });
  } catch (e) {
    console.error("[clara-appointment-confirmations]", e);
    return new Response(JSON.stringify({ success: false, error: (e as Error).message }), { status: 500 });
  }
});
