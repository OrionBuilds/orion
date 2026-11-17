/**
 * friday-weekly-client-update — cron-only (shadow until flipped). Fridays from 14:00 org-local: a portal
 * Project Update plus an email DRAFT in the owner's approval queue per active client (never a direct send).
 */
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { isCronRequest } from "../_shared/auth.ts";
import { denoEnv, serviceClient } from "../_shared/clara/webhook.ts";
import { makeBudget } from "../_shared/friday/run-budget.ts";
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { "Content-Type": "application/json" } });
import { makeSay } from "../_shared/friday/json-llm.ts";
import { isWeeklyWindow, runWeeklyUpdates } from "../_shared/friday/weekly-update.ts";
import { callingSettings } from "../_shared/clara/runtime.ts";

Deno.serve(async (req: Request) => {
  if (!isCronRequest(req)) return json({ error: "Unauthorized" }, 401);
  const budget = makeBudget();
  const db = serviceClient();
  try {
    const { data: orgs } = await db.from("organizations").select("id");
    const out: Record<string, unknown> = {};
    for (const o of (orgs ?? []) as { id: string }[]) {
      const { tz } = await callingSettings(db, denoEnv, o.id);
      const now = new Date();
      if (!isWeeklyWindow(now, tz)) { out[o.id] = "not Friday afternoon"; continue; }
      out[o.id] = await runWeeklyUpdates({
        db, env: denoEnv, say: makeSay(denoEnv, "friday-weekly-client-update"), budget, now, orgId: o.id,
        ownerUserId: denoEnv.get("OWNER_USER_ID")?.trim() || null,
        enabled: (denoEnv.get("FRIDAY_WEEKLY_UPDATE") ?? "on").trim().toLowerCase() !== "off",
      });
    }
    return json({ success: true, ran: out });
  } catch (e) {
    console.error("[friday-weekly-client-update]", e);
    return json({ success: false, error: (e as Error).message }, 500);
  }
});
