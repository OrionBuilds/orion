/** clara-calendar-watch — cron (every 10 min). Pre-meeting briefings for client meetings + calendar conflict flags. Cron-only. */
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { isCronRequest } from "../_shared/auth.ts";
import { denoEnv, serviceClient } from "../_shared/clara/webhook.ts";
import { prepMeetings, scanConflicts } from "../_shared/clara/calendar-watch.ts";
import { notifyOwner } from "../_shared/clara/notify.ts";
import { claraNumberFor, notifyDeps } from "../_shared/clara/runtime.ts";

Deno.serve(async (req: Request) => {
  if (!isCronRequest(req)) return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 });
  const userId = denoEnv.get("CLARA_CALENDAR_USER_ID")?.trim() || denoEnv.get("CLARA_USER_ID")?.trim();
  if (!userId) return new Response(JSON.stringify({ success: false, error: "no calendar user configured" }), { status: 500 });
  const db = serviceClient();
  try {
    const { data: orgs } = await db.from("organizations").select("id");
    const ownerEmails = [...(denoEnv.get("OWNER_EMAILS") ?? "").split(","), denoEnv.get("OWNER_CC_EMAIL") ?? ""].map((e) => e.trim().toLowerCase()).filter(Boolean);
    const out: Record<string, unknown> = {};
    for (const o of (orgs ?? []) as { id: string }[]) {
      const number = await claraNumberFor(db, denoEnv, o.id);
      const notify = (r: Parameters<typeof notifyOwner>[1]) => notifyOwner(db, r, notifyDeps(db, denoEnv, o.id, number));
      const prep = await prepMeetings(db, denoEnv, { orgId: o.id, userId, now: new Date(), ownerEmails, notify });
      const conflicts = await scanConflicts(db, denoEnv, { userId, now: new Date(), notify });
      out[o.id] = { ...prep, conflicts };
    }
    return new Response(JSON.stringify({ success: true, ...out }), { headers: { "Content-Type": "application/json" } });
  } catch (e) {
    console.error("[clara-calendar-watch]", e);
    return new Response(JSON.stringify({ success: false, error: (e as Error).message }), { status: 500 });
  }
});
