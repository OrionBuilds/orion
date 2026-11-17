/**
 * friday-portal-updates — cron-only (shadow until flipped). Posts client-portal development updates from
 * GitHub activity on each repo-linked project. ~40 s budget per run; per-repo cursors make it resumable.
 */
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { isCronRequest } from "../_shared/auth.ts";
import { denoEnv, serviceClient } from "../_shared/clara/webhook.ts";
import { makeBudget } from "../_shared/friday/run-budget.ts";
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { "Content-Type": "application/json" } });
import { makeAsk, makeSay } from "../_shared/friday/json-llm.ts";
import { makeGh } from "../_shared/friday/gh-api.ts";
import { runPortalUpdates } from "../_shared/friday/portal-updates.ts";

Deno.serve(async (req: Request) => {
  if (!isCronRequest(req)) return json({ error: "Unauthorized" }, 401);
  const budget = makeBudget();
  try {
    const r = await runPortalUpdates({
      db: serviceClient(), gh: makeGh(denoEnv, () => budget.timeout(8_000)), budget,
      ask: makeAsk(makeSay(denoEnv, "friday-portal-updates")),
      enabled: (denoEnv.get("FRIDAY_PORTAL_UPDATES") ?? "on").trim().toLowerCase() !== "off",
    });
    return json({ success: true, ...r });
  } catch (e) {
    console.error("[friday-portal-updates]", e);
    return json({ success: false, error: (e as Error).message }, 500);
  }
});
