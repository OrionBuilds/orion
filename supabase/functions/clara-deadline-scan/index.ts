/** clara-deadline-scan — cron (hourly). Owner alerts for overdue / due-today / due-tomorrow project tasks. Cron-only. */
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { isCronRequest } from "../_shared/auth.ts";
import { denoEnv, serviceClient } from "../_shared/clara/webhook.ts";
import { scanTaskDeadlines } from "../_shared/clara/deadline-scan.ts";
import { notifyOwner } from "../_shared/clara/notify.ts";
import { claraNumberFor, notifyDeps } from "../_shared/clara/runtime.ts";

Deno.serve(async (req: Request) => {
  if (!isCronRequest(req)) return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 });
  const db = serviceClient();
  try {
    const { data: orgs } = await db.from("organizations").select("id");
    const out: Record<string, unknown> = {};
    for (const o of (orgs ?? []) as { id: string }[]) {
      const number = await claraNumberFor(db, denoEnv, o.id);
      const notify = (r: Parameters<typeof notifyOwner>[1]) => notifyOwner(db, r, notifyDeps(db, denoEnv, o.id, number));
      out[o.id] = await scanTaskDeadlines(db, denoEnv, { orgId: o.id, now: new Date(), notify });
    }
    return new Response(JSON.stringify({ success: true, ...out }), { headers: { "Content-Type": "application/json" } });
  } catch (e) {
    console.error("[clara-deadline-scan]", e);
    return new Response(JSON.stringify({ success: false, error: (e as Error).message }), { status: 500 });
  }
});
