/**
 * friday-website-monitoring — cron-only (shadow until flipped), every 10 min. The ONE uptime check
 * (friday.website_system_monitoring merged with FRIDAY's flap-damped "uptime" job). Alerts go to the owner only.
 */
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { isCronRequest } from "../_shared/auth.ts";
import { denoEnv, serviceClient } from "../_shared/clara/webhook.ts";
import { makeBudget } from "../_shared/friday/run-budget.ts";
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { "Content-Type": "application/json" } });
import { runWebsiteMonitoring } from "../_shared/friday/site-monitor.ts";

Deno.serve(async (req: Request) => {
  if (!isCronRequest(req)) return json({ error: "Unauthorized" }, 401);
  try {
    return json({ success: true, ...(await runWebsiteMonitoring({ db: serviceClient(), budget: makeBudget() })) });
  } catch (e) {
    console.error("[friday-website-monitoring]", e);
    return json({ success: false, error: (e as Error).message }, 500);
  }
});
