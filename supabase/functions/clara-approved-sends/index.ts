/**
 * clara-approved-sends — cron (every minute). Acts on the owner's decisions about Clara's drafts:
 * approved emails are sent from her mailbox (owner CC'd) and approved texts from her number,
 * rejected/expired ones are closed. Approved drafts with a send_after in the future, or that must
 * respect quiet hours while the org is in them, wait for a later pass. A draft is never sent
 * without an approved queue row. Cron-only.
 */
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { isCronRequest } from "../_shared/auth.ts";
import { denoEnv, serviceClient } from "../_shared/clara/webhook.ts";
import { deliverDecided } from "../_shared/clara/approvals.ts";
import { approvedSendDeps, claraNumberFor, notifyDeps } from "../_shared/clara/runtime.ts";
import { notifyOwner } from "../_shared/clara/notify.ts";

Deno.serve(async (req: Request) => {
  if (!isCronRequest(req)) return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 });
  const db = serviceClient();
  try {
    const out = await deliverDecided(db, {
      ...approvedSendDeps(db, denoEnv),
      onFailure: async (id, title, err) => {
        const { data } = await db.from("workflow_approval_queue").select("org_id").eq("id", id).maybeSingle();
        const org = (data as { org_id: string } | null)?.org_id;
        if (org) await notifyOwner(db, { kind: "approval.send_failed", priority: "critical", category: "revenue", text: `You approved "${title.slice(0, 80)}" but I couldn't send it: ${err.slice(0, 120)}. I'll keep retrying.`, dedupeKey: `send-failed:${id}` }, notifyDeps(db, denoEnv, org, await claraNumberFor(db, denoEnv, org))).catch(() => {});
      },
    });
    return new Response(JSON.stringify({ success: true, ...out }), { headers: { "Content-Type": "application/json" } });
  } catch (e) {
    console.error("[clara-approved-sends]", e);
    return new Response(JSON.stringify({ success: false, error: (e as Error).message }), { status: 500 });
  }
});
