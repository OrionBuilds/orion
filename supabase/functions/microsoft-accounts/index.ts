import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { extractUserContext, getSupabaseClient } from "../_shared/auth.ts";
import { runAccountsAction, type AccountsAction } from "../_shared/ms-accounts.ts";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};
const json = (b: unknown, status = 200) =>
  new Response(JSON.stringify(b), { status, headers: { ...cors, "Content-Type": "application/json" } });

/**
 * Owner JWT. Body `{action:'list'}` | `{action:'set-primary', connection_id}` | `{action:'set-label', connection_id, label}`.
 * Always answers `{accounts:[{id,email,label,is_primary,connection_status,login_enabled,account_type,last_refresh_at,last_refresh_error}], capabilities:{external,personal}}`
 * (primary first); never returns token columns. A connection id that is not the caller's gets 404.
 */
Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 200, headers: cors });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  const supabase = getSupabaseClient();
  const ctx = await extractUserContext(req, supabase);
  if (!ctx) return json({ error: "Unauthorized" }, 401);

  let body: Partial<AccountsAction> = { action: "list" };
  try { body = await req.json(); } catch { /* default: list */ }
  try {
    const r = await runAccountsAction(supabase, ctx.id, body as AccountsAction);
    return json(r.body, r.status);
  } catch (e) {
    console.error("[microsoft-accounts]", (e as Error).message);
    return json({ error: "Request failed" }, 500);
  }
});
