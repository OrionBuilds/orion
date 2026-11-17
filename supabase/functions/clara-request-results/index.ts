/**
 * clara-request-results — cron (every minute). Tells the owner how work Clara handed to another
 * agent ended, fails requests whose agent stopped answering, and warns about work nobody picked up.
 * Cron-only (verify_jwt=false + X-Cron-Secret).
 */
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { isCronRequest } from "../_shared/auth.ts";
import { denoEnv, serviceClient } from "../_shared/clara/webhook.ts";
import { processRequestResults } from "../_shared/clara/request-results.ts";
import { notifyOwner } from "../_shared/clara/notify.ts";
import { notifyDeps } from "../_shared/clara/runtime.ts";

Deno.serve(async (req: Request) => {
  if (!isCronRequest(req)) return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 });
  const db = serviceClient();
  try {
    const out = await processRequestResults(db, {
      now: () => new Date(),
      // The number to text from: Clara's published line for the org.
      notify: async (orgId, r) => {
        const { data } = await db.from("twilio_numbers").select("phone_number").eq("org_id", orgId).eq("agent_label", "Clara").limit(1).maybeSingle();
        return await notifyOwner(db, r, notifyDeps(db, denoEnv, orgId, (data as { phone_number: string } | null)?.phone_number ?? denoEnv.get("CLARA_TWILIO_NUMBER") ?? ""));
      },
    });
    return new Response(JSON.stringify({ success: true, ...out }), { headers: { "Content-Type": "application/json" } });
  } catch (e) {
    console.error("[clara-request-results]", e);
    return new Response(JSON.stringify({ success: false, error: (e as Error).message }), { status: 500 });
  }
});
