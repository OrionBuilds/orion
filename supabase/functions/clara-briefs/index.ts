/**
 * clara-briefs — hourly cron. Sends the morning (08:00), evening (20:00) and weekly (Fri 16:00)
 * briefs at org-local time, and retries any brief composed in the last 6 hours that failed to send.
 * Cron-only.
 */
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { isCronRequest } from "../_shared/auth.ts";
import { denoEnv, serviceClient } from "../_shared/clara/webhook.ts";
import { type BriefKind, briefDue, runBrief } from "../_shared/clara/briefs.ts";
import { callingSettings, sendEmailAsClara } from "../_shared/clara/runtime.ts";

Deno.serve(async (req: Request) => {
  if (!isCronRequest(req)) return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 });
  const db = serviceClient();
  const owner = denoEnv.get("OWNER_CC_EMAIL")?.trim();
  if (!owner) return new Response(JSON.stringify({ success: false, error: "OWNER_CC_EMAIL not set" }), { status: 500 });
  try {
    const now = new Date();
    const { data: orgs } = await db.from("organizations").select("id");
    const out: Record<string, string> = {};
    for (const o of (orgs ?? []) as { id: string }[]) {
      const { tz } = await callingSettings(db, denoEnv, o.id);
      const send = (subject: string, body: string) => sendEmailAsClara(db, denoEnv, { to: [owner], subject, body });
      const due = briefDue(now, tz);
      if (due) out[`${o.id}:${due.kind}`] = await runBrief(db, denoEnv, { orgId: o.id, now, due, send });
      // A brief that was composed but not delivered (mail outage) is retried within the next 6 hours.
      const { data: stuck } = await db.from("clara_briefs").select("kind, local_date").eq("organization_id", o.id).is("delivered_at", null)
        .gte("created_at", new Date(now.getTime() - 6 * 3_600_000).toISOString());
      for (const s of (stuck ?? []) as { kind: BriefKind; local_date: string }[]) {
        if (due && due.kind === s.kind && due.localDate === s.local_date) continue; // just handled above
        out[`${o.id}:${s.kind}:retry`] = await runBrief(db, denoEnv, { orgId: o.id, now, due: { kind: s.kind, localDate: s.local_date }, send });
      }
    }
    return new Response(JSON.stringify({ success: true, out }), { headers: { "Content-Type": "application/json" } });
  } catch (e) {
    console.error("[clara-briefs]", e);
    return new Response(JSON.stringify({ success: false, error: (e as Error).message }), { status: 500 });
  }
});
