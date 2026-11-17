/**
 * friday-client-health-report — cron-only (shadow until flipped), weekly Friday morning. Read-only per-project
 * status roll-up delivered to the owner as a brief-bound notification (never client-visible).
 */
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { isCronRequest } from "../_shared/auth.ts";
import { denoEnv, serviceClient } from "../_shared/clara/webhook.ts";
import { makeBudget } from "../_shared/friday/run-budget.ts";
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { "Content-Type": "application/json" } });
import { runClientHealthReport } from "../_shared/friday/client-health.ts";

Deno.serve(async (req: Request) => {
  if (!isCronRequest(req)) return json({ error: "Unauthorized" }, 401);
  const db = serviceClient();
  try {
    const { data: orgs } = await db.from("organizations").select("id");
    const out: Record<string, unknown> = {};
    for (const o of (orgs ?? []) as { id: string }[]) out[o.id] = await runClientHealthReport({ db, orgId: o.id });
    return json({ success: true, ran: out });
  } catch (e) {
    console.error("[friday-client-health-report]", e);
    return json({ success: false, error: (e as Error).message }, 500);
  }
});
