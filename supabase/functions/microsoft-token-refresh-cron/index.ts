import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";
import { isCronRequest } from "../_shared/auth.ts";
import { msConfig } from "../_shared/ms-graph.ts";
import { refreshActiveConnections } from "../_shared/ms-accounts.ts";

const MAX_BATCH = 20;
// Refresh anything expiring within 15 minutes. Keeping the access token fresh also keeps
// the rotating refresh token alive (Microsoft expires idle refresh tokens after 90 days).
const WINDOW_MS = 15 * 60 * 1000;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

Deno.serve(async (req: Request) => {
  // Cron-only (verify_jwt=false so pg_cron can reach it); same gate as google-token-refresh-cron.
  if (!isCronRequest(req)) return json({ error: "Unauthorized" }, 401);

  const cfg = msConfig();
  if (!cfg) return json({ success: false, error: "MS_OAUTH_* not configured" }, 500);

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    { auth: { autoRefreshToken: false, persistSession: false } },
  );

  try {
    const r = await refreshActiveConnections(supabase, cfg, { windowMs: WINDOW_MS, maxBatch: MAX_BATCH });
    return json({ success: true, ...r });
  } catch (e) {
    return json({ success: false, error: (e as Error).message }, 500);
  }
});
