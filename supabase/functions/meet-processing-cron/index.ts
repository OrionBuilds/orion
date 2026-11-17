import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";
import { isCronRequest } from "../_shared/auth.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};

const MAX_RETRIES = 5;

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
    // this endpoint was effectively open. Callers verified before gating: pg_cron only.
    if (!isCronRequest(req)) {
      return new Response(
        JSON.stringify({ error: "Unauthorized" }),
        { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const supabase = getSupabaseClient();
    const now = new Date().toISOString();

    // A session can only be processed if the Google connection that owns it can still
    // refresh a token. When someone leaves (or revokes access), their connection is left
    // with sync_enabled=false — but the pipeline used to keep retrying those sessions until
    // MAX_RETRIES and then strand them as permanent "failed"/"queued" noise. Every historical
    // failure in this table traced to exactly that: two departed users' dead connections.
    const { data: liveConnections } = await supabase
      .from("google_calendar_connections")
      .select("id")
      .eq("sync_enabled", true);
    const liveConnectionIds = (liveConnections ?? []).map((c: { id: string }) => c.id);

    // Retire anything still queued against a connection that can no longer authenticate,
    // so it stops being retried and stops inflating the failure count.
    const { data: openSessions } = await supabase
      .from("google_meet_sessions")
      .select("id, connection_id")
      .eq("processed", false)
      .in("status", ["detected", "queued"])
      .limit(500);

    const strandedIds = (openSessions ?? [])
      .filter((s: { connection_id: string | null }) =>
        !s.connection_id || !liveConnectionIds.includes(s.connection_id))
      .map((s: { id: string }) => s.id);

    if (strandedIds.length > 0) {
      await supabase
        .from("google_meet_sessions")
        .update({
          status: "failed",
          processed: true,
          processing_error: "Google connection disconnected — reconnect the owner's account to process this meeting",
          updated_at: now,
        })
        .in("id", strandedIds);

      console.log(`[MeetCron] Retired ${strandedIds.length} sessions on disconnected Google connections`);
    }

    const { count: pendingCount } = await supabase
      .from("google_meet_sessions")
      .select("id", { count: "exact", head: true })
      .eq("processed", false)
      .in("status", ["detected", "queued"])
      .in("connection_id", liveConnectionIds)
      .lt("retry_count", MAX_RETRIES)
      .lte("first_check_after", now);

    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    const fortyEightHoursAgo = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();

    const { data: noArtifactRetries } = await supabase
      .from("google_meet_sessions")
      .select("id")
      .eq("status", "no_artifacts")
      .eq("processed", true)
      .gt("event_end_time", fortyEightHoursAgo)
      .lt("event_end_time", twoHoursAgo)
      .limit(5);

    if (noArtifactRetries && noArtifactRetries.length > 0) {
      const retryIds = noArtifactRetries.map((s: { id: string }) => s.id);
      await supabase
        .from("google_meet_sessions")
        .update({
          status: "detected",
          processed: false,
          retry_count: 0,
          updated_at: now,
        })
        .in("id", retryIds);

      console.log(`[MeetCron] Reset ${retryIds.length} no_artifacts sessions for retry`);
    }

    const totalPending = (pendingCount || 0) + (noArtifactRetries?.length || 0);

    if (totalPending === 0) {
      return new Response(
        JSON.stringify({ success: true, pending: 0, message: "No sessions to process" }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

    try {
      const processorUrl = `${supabaseUrl}/functions/v1/meet-processing-job`;
      const resp = await fetch(processorUrl, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${serviceRoleKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({}),
      });

      if (!resp.ok) {
        console.error("[MeetCron] Processor invocation failed:", await resp.text());
      } else {
        const result = await resp.json();
        console.log("[MeetCron] Processor result:", JSON.stringify(result));
      }
    } catch (invokeErr) {
      console.error("[MeetCron] Failed to invoke processor:", invokeErr);
    }

    return new Response(
      JSON.stringify({
        success: true,
        pending: totalPending,
        noArtifactRetries: noArtifactRetries?.length || 0,
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (error) {
    console.error("[MeetCron] Unhandled error:", error);
    return new Response(
      JSON.stringify({ success: false, error: (error as Error).message }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
