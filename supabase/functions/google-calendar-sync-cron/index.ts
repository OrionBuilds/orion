import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";
import { isCronRequest, isServiceRoleRequest } from "../_shared/auth.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};

function getSupabaseClient() {
  return createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    { auth: { autoRefreshToken: false, persistSession: false } }
  );
}

Deno.serve(async (req: Request) => {
  try {
    if (req.method === "OPTIONS") {
      return new Response(null, { status: 200, headers: corsHeaders });
    }

    // Deployed verify_jwt=false. Its cron job used to authenticate with the PUBLIC anon key, so
    // this endpoint was effectively open. Callers verified before gating: pg_cron, plus
    // google-calendar-cron which calls with Bearer ${serviceRoleKey}.
    if (!isCronRequest(req) && !isServiceRoleRequest(req)) {
      return new Response(
        JSON.stringify({ error: "Unauthorized" }),
        { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const supabase = getSupabaseClient();

    const { data: connections, error: connError } = await supabase
      .from("google_calendar_connections")
      .select("id, org_id, user_id, sync_enabled, sync_interval_minutes, last_incremental_sync_at")
      .eq("sync_enabled", true);

    if (connError) {
      console.error("[Cron] Failed to fetch connections:", connError);
      return new Response(JSON.stringify({ success: false, error: "Failed to fetch connections" }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (!connections || connections.length === 0) {
      return new Response(JSON.stringify({ success: true, enqueued: 0, message: "No sync-enabled connections" }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    let enqueued = 0;
    let skipped = 0;

    for (const conn of connections) {
      const intervalMinutes = conn.sync_interval_minutes || 1;
      const lastSync = conn.last_incremental_sync_at
        ? new Date(conn.last_incremental_sync_at).getTime()
        : 0;
      const nextSyncDue = lastSync + intervalMinutes * 60 * 1000;

      if (Date.now() < nextSyncDue) {
        skipped++;
        continue;
      }

      // NOTE: must not use .maybeSingle() here — it errors once a connection has
      // more than one in-flight job, and a discarded error would let this guard
      // fall through and enqueue a duplicate on every tick (see incident 2026-07).
      const { data: existingJobs, error: existingErr } = await supabase
        .from("google_calendar_sync_jobs")
        .select("id")
        .eq("connection_id", conn.id)
        .in("status", ["pending", "processing"])
        .limit(1);

      if (existingErr) {
        // Fail closed: never enqueue when we cannot prove the queue is empty.
        console.error(`[Cron] Dedupe check failed for connection ${conn.id}:`, existingErr);
        skipped++;
        continue;
      }

      if (existingJobs && existingJobs.length > 0) {
        skipped++;
        continue;
      }

      const jobType = lastSync === 0 ? "initial_sync" : "incremental_sync";

      const { error: insertError } = await supabase
        .from("google_calendar_sync_jobs")
        .insert({
          org_id: conn.org_id,
          connection_id: conn.id,
          job_type: jobType,
          status: "pending",
          scheduled_at: new Date().toISOString(),
          attempts: 0,
          max_attempts: 5,
        });

      if (insertError) {
        console.error(`[Cron] Failed to enqueue job for connection ${conn.id}:`, insertError);
        continue;
      }

      enqueued++;
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

    if (enqueued > 0) {
      try {
        const runnerUrl = `${supabaseUrl}/functions/v1/google-calendar-sync-runner`;
        const runnerResp = await fetch(runnerUrl, {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${serviceRoleKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({}),
        });

        if (!runnerResp.ok) {
          console.error("[Cron] Runner invocation failed:", await runnerResp.text());
        }
      } catch (runnerErr) {
        console.error("[Cron] Failed to invoke runner:", runnerErr);
      }
    }

    return new Response(JSON.stringify({
      success: true,
      enqueued,
      skipped,
      totalConnections: connections.length,
    }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error) {
    console.error("[Cron] Unhandled error:", error);
    return new Response(JSON.stringify({ success: false, error: (error as Error).message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
