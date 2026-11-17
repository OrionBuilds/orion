import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";
import { isCronRequest } from "../_shared/auth.ts";
import { msConfig } from "../_shared/ms-graph.ts";
import { syncMailConnections } from "../_shared/ms-mail.ts";

// Per run: connections (mailboxes), not users. Oldest-synced first, so a user with several mailboxes cannot starve others.
const MAX_CONNECTIONS_PER_RUN = 10;
const json = (b: unknown, status = 200) =>
  new Response(JSON.stringify(b), { status, headers: { "Content-Type": "application/json" } });

/**
 * Pulls Inbox + Sent Items for every active Microsoft connection into conversations/messages.
 * Cron-only (verify_jwt=false). Optional body {user_id} limits the run to one user's connections (used by
 * the OAuth callback / a manual "sync now").
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

  let onlyUser: string | undefined;
  try { onlyUser = (await req.json())?.user_id; } catch { /* no body */ }

  const { results, error } = await syncMailConnections(supabase, { cfg, onlyUser, max: MAX_CONNECTIONS_PER_RUN });
  if (error) return json({ error }, 500);
  return json({ success: true, results });
});
