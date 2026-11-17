import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2.57.4";
import { isCronRequest } from "../_shared/auth.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers":
    "Content-Type, Authorization, X-Client-Info, Apikey",
};

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 200, headers: corsHeaders });
  }

  // Cron-only. Deployed verify_jwt=false so pg_cron can reach it - which also means anyone on the
  // internet could, and until now nothing here checked. The scheduled job (cron.job 'signature-expiration-processor')
  // sends the service-role key, so require it. Constant-time compare lives in _shared/auth.ts.
  if (!isCronRequest(req)) {
    return new Response(
      JSON.stringify({ error: "Unauthorized" }),
      { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    const now = new Date().toISOString();

    const { data: expiredRequests, error: fetchError } = await supabase
      .from("proposal_signature_requests")
      .select("id, org_id, proposal_id, signer_name, signer_email, expires_at")
      .in("status", ["pending", "viewed"])
      .lt("expires_at", now)
      .limit(100);

    if (fetchError) {
      throw new Error(`Failed to fetch expired requests: ${fetchError.message}`);
    }

    if (!expiredRequests || expiredRequests.length === 0) {
      return new Response(
        JSON.stringify({ message: "No expired requests", processed: 0 }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    let processedCount = 0;

    for (const req of expiredRequests) {
      // Conditional on the request still being live: a signer who finalized after the select above (the finalize RPC
      // locks the row and sets it to signed) must win, so zero matched rows means skip, never overwrite.
      const { data: expiredNow, error: expireError } = await supabase
        .from("proposal_signature_requests")
        .update({ status: "expired" })
        .eq("id", req.id)
        .in("status", ["pending", "viewed"])
        .select("id");
      if (expireError) {
        console.error(`Could not expire request ${req.id}:`, expireError.message);
        continue;
      }
      if (!expiredNow || expiredNow.length === 0) continue;

      await supabase
        .from("proposals")
        .update({ signature_status: "expired" })
        .eq("id", req.proposal_id)
        .in("signature_status", ["pending_signature", "viewed"]);

      await supabase.from("proposal_audit_events").insert({
        org_id: req.org_id,
        proposal_id: req.proposal_id,
        event_type: "expired",
        actor_type: "system",
        metadata: {
          request_id: req.id,
          expired_at: now,
          signer_name: req.signer_name,
          signer_email: req.signer_email,
        },
      });

      processedCount++;
    }

    return new Response(
      JSON.stringify({
        processed: processedCount,
        message: `Expired ${processedCount} signature requests`,
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (error) {
    console.error("Signature expiration processor error:", error);
    return new Response(
      JSON.stringify({
        error: error instanceof Error ? error.message : "Unknown error",
      }),
      {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      }
    );
  }
});
