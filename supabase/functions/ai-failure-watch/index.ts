/**
 * ai-failure-watch — daily (pg_cron, see 20261112140000_ai_failing_sources.sql).
 * For each org, finds model-call sources that mostly fail (ai_failing_sources_internal) and sends the owner one
 * in-app notification listing them with their latest error. Quiet when nothing is failing; at most one
 * notification per day per set of failing sources.
 */
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";
import { isCronRequest } from "../_shared/auth.ts";
import { buildFailureDigest, type FailingSource } from "../_shared/ai-failure-watch.ts";

const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { "Content-Type": "application/json" } });

Deno.serve(async (req: Request) => {
  if (!isCronRequest(req)) return json({ error: "Unauthorized" }, 401);
  const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { autoRefreshToken: false, persistSession: false } });
  try {
    const { data: orgs, error: orgErr } = await db.from("organizations").select("id");
    if (orgErr) throw new Error(orgErr.message);
    let sent = 0;
    for (const org of (orgs ?? []) as { id: string }[]) {
      const { data: rows, error } = await db.rpc("ai_failing_sources_internal", { p_org: org.id, p_hours: 48, p_min_calls: 3, p_min_rate: 0.8 });
      if (error) { console.warn("[ai-failure-watch] detector failed:", error.message); continue; }
      const digest = buildFailureDigest((rows ?? []) as FailingSource[]);
      if (!digest) continue;

      // Owner: OWNER_USER_ID, else the org's active SuperAdmins.
      let userIds: string[] = [];
      const ownerId = Deno.env.get("OWNER_USER_ID")?.trim();
      if (ownerId) userIds = [ownerId];
      else {
        const { data: admins } = await db.from("users").select("id, roles!inner(name)").eq("organization_id", org.id).eq("status", "active").eq("roles.name", "SuperAdmin");
        userIds = ((admins ?? []) as { id: string }[]).map((u) => u.id);
      }
      for (const uid of userIds) {
        const { data: dup } = await db.from("notifications").select("id").eq("user_id", uid).eq("type", "ai_failure").eq("metadata->>dedupe", digest.dedupe).limit(1);
        if (dup && dup.length) continue;
        const { error: insErr } = await db.from("notifications").insert({
          user_id: uid, type: "ai_failure", title: digest.title, body: digest.body,
          link: "/settings/ai-agents?tab=usage", metadata: { dedupe: digest.dedupe },
        });
        if (insErr) console.warn("[ai-failure-watch] notify failed:", insErr.message); else sent++;
      }
    }
    return json({ ok: true, notifications: sent });
  } catch (e) {
    console.error("[ai-failure-watch]", (e as Error).message);
    return json({ ok: false, error: (e as Error).message }, 500);
  }
});
