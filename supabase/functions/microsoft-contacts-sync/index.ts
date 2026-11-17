import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";
import { isCronRequest } from "../_shared/auth.ts";
import { getValidAccessToken, msConfig } from "../_shared/ms-graph.ts";
import { enrichCrmFromOutlook } from "../_shared/ms-contacts.ts";
import { rotateSlice } from "../_shared/ms-connection-select.ts";

const PER_RUN = 10;                       // connections per run
const CRON_PERIOD_MS = 6 * 3_600_000;   // 17 */6 * * *

const json = (b: unknown, status = 200) =>
  new Response(JSON.stringify(b), { status, headers: { "Content-Type": "application/json" } });

/** Cron-only. Fills EMPTY CRM contact fields from each connected user's Outlook contacts. */
Deno.serve(async (req: Request) => {
  if (!isCronRequest(req)) return json({ error: "Unauthorized" }, 401);
  const cfg = msConfig();
  if (!cfg) return json({ error: "MS_OAUTH_* not configured" }, 500);

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    { auth: { autoRefreshToken: false, persistSession: false } },
  );
  // Every active account (a user may have several): PER_RUN of them per run, rotating so none is starved.
  const { data: all, error } = await supabase.from("microsoft_oauth_master")
    .select("id, user_id, organization_id").eq("connection_status", "active");
  if (error) return json({ error: error.message }, 500);
  const conns = rotateSlice((all ?? []) as { id: string; user_id: string; organization_id: string }[], PER_RUN, Date.now() / CRON_PERIOD_MS);

  const results: unknown[] = [];
  for (const c of conns) {
    try {
      const token = await getValidAccessToken(supabase, c.user_id, { cfg, connectionId: c.id });
      results.push({ user_id: c.user_id, ...(await enrichCrmFromOutlook(supabase, token, { orgId: c.organization_id })) });
    } catch (e) {
      console.error(`[ms-contacts-sync] ${c.user_id}/${c.id}: ${(e as Error).message}`);
      results.push({ user_id: c.user_id, error: (e as Error).message });
    }
  }
  return json({ success: true, results });
});
