/** clara-email-triage — cron (every 4 min). Triage of inbound client email; see _shared/clara/email-triage.ts. Cron-only. */
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { isCronRequest } from "../_shared/auth.ts";
import { denoEnv, serviceClient } from "../_shared/clara/webhook.ts";
import { runClientEmailTriage } from "../_shared/clara/email-triage.ts";
import { claraNumberFor, triageDeps } from "../_shared/clara/runtime.ts";

Deno.serve(async (req: Request) => {
  if (!isCronRequest(req)) return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 });
  const db = serviceClient();
  try {
    const { data: orgs } = await db.from("organizations").select("id");
    const out: Record<string, unknown> = {};
    for (const o of (orgs ?? []) as { id: string }[]) {
      out[o.id] = await runClientEmailTriage(db, triageDeps(db, denoEnv, o.id, await claraNumberFor(db, denoEnv, o.id)));
    }
    return new Response(JSON.stringify({ success: true, ...out }), { headers: { "Content-Type": "application/json" } });
  } catch (e) {
    console.error("[clara-email-triage]", e);
    return new Response(JSON.stringify({ success: false, error: (e as Error).message }), { status: 500 });
  }
});
