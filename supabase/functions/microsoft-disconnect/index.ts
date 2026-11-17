import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { extractUserContext, getSupabaseClient } from "../_shared/auth.ts";
import { disconnectMicrosoft } from "../_shared/ms-accounts.ts";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};
const json = (b: unknown, status = 200) =>
  new Response(JSON.stringify(b), { status, headers: { ...cors, "Content-Type": "application/json" } });

/**
 * Removes one of the caller's Microsoft connections. Body `{connection_id?}`: with an id, only that account
 * (its sync state and calendar events); without one, the caller's only account (400 when they have several).
 * Synced mail stays in the OS.
 */
Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 200, headers: cors });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  const supabase = getSupabaseClient();
  const ctx = await extractUserContext(req, supabase);
  if (!ctx) return json({ error: "Unauthorized" }, 401);

  let connectionId: string | undefined;
  try {
    const body = await req.json();
    if (typeof body?.connection_id === "string" && body.connection_id) connectionId = body.connection_id;
  } catch { /* no body: single-account behaviour */ }

  const r = await disconnectMicrosoft(supabase, ctx.id, connectionId);
  return json(r.body, r.status);
});
