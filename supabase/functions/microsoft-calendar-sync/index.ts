import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";
import { isCronRequest } from "../_shared/auth.ts";
import { getValidAccessToken, msConfig } from "../_shared/ms-graph.ts";
import { syncCalendarWindow } from "../_shared/ms-calendar.ts";
import { rotateSlice } from "../_shared/ms-connection-select.ts";

const PER_RUN = 10;                 // connections per run (Graph load / cron timeout)
const CRON_PERIOD_MS = 5 * 60_000; // */5 * * * *

const json = (b: unknown, status = 200) =>
  new Response(JSON.stringify(b), { status, headers: { "Content-Type": "application/json" } });

/**
 * Cron-only. Mirrors every active Microsoft connection's calendar window, across every calendar in
 * the mailbox (not just the default one; see listCalendarIds). `calendars` in the result is how
 * many calendars were read per user.
 */
Deno.serve(async (req: Request) => {
  if (!isCronRequest(req)) return json({ error: "Unauthorized" }, 401);
  const cfg = msConfig();
  if (!cfg) return json({ error: "MS_OAUTH_* not configured" }, 500);

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    { auth: { autoRefreshToken: false, persistSession: false } },
  );
  // Every active account (a user may have several), not the first few rows: PER_RUN of them per run, rotating.
  const { data: all, error } = await supabase.from("microsoft_oauth_master")
    .select("id, user_id, organization_id").eq("connection_status", "active");
  if (error) return json({ error: error.message }, 500);
  const conns = rotateSlice((all ?? []) as { id: string; user_id: string; organization_id: string }[], PER_RUN, Date.now() / CRON_PERIOD_MS);

  const results: unknown[] = [];
  for (const c of conns) {
    try {
      const token = await getValidAccessToken(supabase, c.user_id, { cfg, connectionId: c.id });
      results.push({ user_id: c.user_id, ...(await syncCalendarWindow(supabase, token, { orgId: c.organization_id, userId: c.user_id, connectionId: c.id }, { allCalendars: true })) });
    } catch (e) {
      console.error(`[ms-calendar-sync] ${c.user_id}/${c.id}: ${(e as Error).message}`);
      results.push({ user_id: c.user_id, error: (e as Error).message });
    }
  }
  return json({ success: true, results });
});
