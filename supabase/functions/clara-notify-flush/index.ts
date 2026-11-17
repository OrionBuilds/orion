/** clara-notify-flush — cron (every minute). Delivers critical notifications agents wrote with agent_notify_owner. Cron-only. */
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { isCronRequest } from "../_shared/auth.ts";
import { denoEnv, serviceClient } from "../_shared/clara/webhook.ts";
import { flushAgentNotifications } from "../_shared/clara/notify.ts";
import { claraNumberFor, notifyDeps } from "../_shared/clara/runtime.ts";

Deno.serve(async (req: Request) => {
  if (!isCronRequest(req)) return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 });
  const db = serviceClient();
  try {
    // Deps are per-org (the number to text from); resolve the numbers up front so the flush stays synchronous per row.
    const { data: orgs } = await db.from("organizations").select("id");
    const numbers = new Map<string, string>();
    for (const o of (orgs ?? []) as { id: string }[]) numbers.set(o.id, await claraNumberFor(db, denoEnv, o.id));
    const out = await flushAgentNotifications(db, (org) => notifyDeps(db, denoEnv, org, numbers.get(org) ?? ""));
    return new Response(JSON.stringify({ success: true, ...out }), { headers: { "Content-Type": "application/json" } });
  } catch (e) {
    console.error("[clara-notify-flush]", e);
    return new Response(JSON.stringify({ success: false, error: (e as Error).message }), { status: 500 });
  }
});
