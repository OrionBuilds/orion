/**
 * friday-release-approvals — cron-only (shadow until flipped). Files one pending client sign-off card per
 * opted-in project for its newest shippable feature PR. Portal record only; nothing is sent or merged.
 */
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { isCronRequest } from "../_shared/auth.ts";
import { denoEnv, serviceClient } from "../_shared/clara/webhook.ts";
import { makeBudget } from "../_shared/friday/run-budget.ts";
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { "Content-Type": "application/json" } });
import { makeAsk, makeSay } from "../_shared/friday/json-llm.ts";
import { makeGh } from "../_shared/friday/gh-api.ts";
import { runReleaseApprovals } from "../_shared/friday/release-approvals.ts";

Deno.serve(async (req: Request) => {
  if (!isCronRequest(req)) return json({ error: "Unauthorized" }, 401);
  const budget = makeBudget();
  try {
    const r = await runReleaseApprovals({
      db: serviceClient(), gh: makeGh(denoEnv, () => budget.timeout(8_000)), budget,
      ask: makeAsk(makeSay(denoEnv, "friday-release-approvals")),
      enabled: (denoEnv.get("FRIDAY_RELEASE_APPROVALS") ?? "off").trim().toLowerCase() === "on",
    });
    return json({ success: true, ...r });
  } catch (e) {
    console.error("[friday-release-approvals]", e);
    return json({ success: false, error: (e as Error).message }, 500);
  }
});
