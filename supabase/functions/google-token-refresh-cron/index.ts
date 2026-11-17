import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";
import { refreshStaleGoogleConnections } from "../_shared/google-accounts.ts";
import { isCronRequest } from "../_shared/auth.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};

const MAX_FAIL_COUNT = 5;

function getServiceClient() {
  return createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    { auth: { autoRefreshToken: false, persistSession: false } }
  );
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 200, headers: corsHeaders });
  }

  // Cron-only. Deployed verify_jwt=false so pg_cron can reach it - which also means anyone on the
  // internet could, and until now nothing here checked. The scheduled job (cron.job 'google-token-refresh')
  // sends X-Cron-Secret (vault cron_secret), so require it. Constant-time compare lives in _shared/auth.ts.
  if (!isCronRequest(req)) {
    return new Response(
      JSON.stringify({ error: "Unauthorized" }),
      { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }

  try {
    const supabase = getServiceClient();

    // Every master row (one per Google account) is refreshed with ITS OWN refresh token and failures are recorded on that
    // row only: invalid_grant flips it to needs_reauth, other errors bump its counter (rows at MAX_FAIL_COUNT are skipped).
    const result = await refreshStaleGoogleConnections(supabase, { windowMs: 10 * 60 * 1000, maxBatch: 20, maxFail: MAX_FAIL_COUNT });

    if (result.total === 0) {
      return new Response(JSON.stringify({ success: true, refreshed: 0, message: "No tokens need refresh" }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    console.log(`[TokenRefreshCron] ${result.refreshed}/${result.total} refreshed, ${result.failed} failed`);
    return new Response(JSON.stringify({
      success: true, total: result.total, refreshed: result.refreshed, failed: result.failed, skipped: 0,
      errors: result.errors.length > 0 ? result.errors : undefined,
    }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error) {
    console.error("[TokenRefreshCron] Unhandled error:", error);
    return new Response(JSON.stringify({ success: false, error: (error as Error).message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
