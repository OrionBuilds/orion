/**
 * clara-stall-nudges — hourly cron; acts only at 09:00 org-local. Drafts check-ins for quiet
 * clients into the owner's approval queue (never sends). Cron-only.
 */
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { isCronRequest } from "../_shared/auth.ts";
import { denoEnv, serviceClient } from "../_shared/clara/webhook.ts";
import { isNudgeHour, runStallNudges } from "../_shared/clara/stall-nudges.ts";
import { callingSettings, draftStallNudge } from "../_shared/clara/runtime.ts";

Deno.serve(async (req: Request) => {
  if (!isCronRequest(req)) return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 });
  const db = serviceClient();
  try {
    const { data: orgs } = await db.from("organizations").select("id");
    const out: Record<string, unknown> = {};
    for (const o of (orgs ?? []) as { id: string }[]) {
      const { tz } = await callingSettings(db, denoEnv, o.id);
      if (!isNudgeHour(new Date(), tz)) continue;
      out[o.id] = await runStallNudges(db, denoEnv, {
        orgId: o.id, now: new Date(), ownerUserId: denoEnv.get("OWNER_USER_ID")?.trim() || null,
        draft: (c) => draftStallNudge(denoEnv, c),
      });
    }
    return new Response(JSON.stringify({ success: true, ran: out }), { headers: { "Content-Type": "application/json" } });
  } catch (e) {
    console.error("[clara-stall-nudges]", e);
    return new Response(JSON.stringify({ success: false, error: (e as Error).message }), { status: 500 });
  }
});
