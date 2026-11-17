/** clara-feedback-replies — cron (every 10 min). Records "how'd we do?" replies from the synced mailbox. Cron-only. */
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { isCronRequest } from "../_shared/auth.ts";
import { denoEnv, serviceClient } from "../_shared/clara/webhook.ts";
import { captureFeedbackReplies } from "../_shared/clara/feedback.ts";
import { notifyOwner } from "../_shared/clara/notify.ts";
import { claraNumberFor, notifyDeps } from "../_shared/clara/runtime.ts";

Deno.serve(async (req: Request) => {
  if (!isCronRequest(req)) return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 });
  const db = serviceClient();
  try {
    const { data: orgs } = await db.from("organizations").select("id");
    let recorded = 0;
    for (const o of (orgs ?? []) as { id: string }[]) {
      const number = await claraNumberFor(db, denoEnv, o.id);
      recorded += (await captureFeedbackReplies(db, { orgId: o.id, now: new Date(), notify: (r) => notifyOwner(db, r, notifyDeps(db, denoEnv, o.id, number)) })).recorded;
    }
    return new Response(JSON.stringify({ success: true, recorded }), { headers: { "Content-Type": "application/json" } });
  } catch (e) {
    console.error("[clara-feedback-replies]", e);
    return new Response(JSON.stringify({ success: false, error: (e as Error).message }), { status: 500 });
  }
});
