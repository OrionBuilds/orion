import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";
import { getMailboxToken, mailboxForState } from "../_shared/gmail-mailbox.ts";
import { isCronRequest } from "../_shared/auth.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers":
    "Content-Type, Authorization, X-Client-Info, Apikey",
};

const GMAIL_API_URL = "https://gmail.googleapis.com/gmail/v1";

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 200, headers: corsHeaders });
  }

  // Cron-only. Deployed verify_jwt=false so pg_cron can reach it - which also means anyone on the
  // internet could, and until now nothing here checked. The scheduled job (cron.job 'gmail-watch-renew')
  // sends X-Cron-Secret (vault cron_secret), so require it. Constant-time compare lives in _shared/auth.ts.
  if (!isCronRequest(req)) {
    return new Response(
      JSON.stringify({ error: "Unauthorized" }),
      { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const pubsubTopic = Deno.env.get("GMAIL_PUBSUB_TOPIC");

    if (!supabaseUrl || !serviceRoleKey) {
      return new Response(
        JSON.stringify({ error: "Missing configuration" }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    if (!pubsubTopic) {
      return new Response(
        JSON.stringify({ error: "GMAIL_PUBSUB_TOPIC not configured" }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const supabase = createClient(supabaseUrl, serviceRoleKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });

    const twoDaysFromNow = new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString();

    // Fetch sync states that need watch renewal (expired or never set)
    const { data: expiringSyncs, error: queryError } = await supabase
      .from("gmail_sync_state")
      .select("*")
      .or(`watch_expiration.is.null,watch_expiration.lt.${twoDaysFromNow}`);

    if (queryError) {
      console.error("Failed to query sync states:", queryError);
      return new Response(
        JSON.stringify({ error: "Failed to query sync states", detail: queryError.message }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    if (!expiringSyncs || expiringSyncs.length === 0) {
      return new Response(
        JSON.stringify({ renewed: 0, message: "No watches need renewal" }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    let renewed = 0;
    let failed = 0;
    const errors: string[] = [];

    for (const sync of expiringSyncs) {
      try {
        // The mailbox (Google connection) this watch belongs to; each one is renewed with its own token.
        const mailbox = await mailboxForState(supabase, sync);

        if (!mailbox) {
          errors.push(`No token found for user ${sync.user_id}`);
          failed++;
          continue;
        }

        // getMailboxToken handles decryption and refresh for exactly this connection
        const accessToken = await getMailboxToken(supabase, mailbox);

        const watchRes = await fetch(`${GMAIL_API_URL}/users/me/watch`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${accessToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            topicName: pubsubTopic,
            labelIds: ["INBOX", "SENT"],
            labelFilterBehavior: "include",
          }),
        });

        if (!watchRes.ok) {
          const errText = await watchRes.text();
          errors.push(`Watch renewal failed for ${mailbox.email}: ${errText}`);
          failed++;
          continue;
        }

        const watchData = await watchRes.json();

        await supabase
          .from("gmail_sync_state")
          .update({
            connection_id: mailbox.connectionId,
            history_id: String(watchData.historyId),
            watch_expiration: new Date(Number(watchData.expiration)).toISOString(),
            error_message: null,
            updated_at: new Date().toISOString(),
          })
          .eq("id", sync.id);

        console.log(`Watch renewed for ${mailbox.email}, expires ${new Date(Number(watchData.expiration)).toISOString()}`);
        renewed++;
      } catch (err) {
        errors.push(`Error for sync ${sync.id}: ${(err as Error).message}`);
        failed++;
      }
    }

    return new Response(
      JSON.stringify({ renewed, failed, total: expiringSyncs.length, errors }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (err) {
    console.error("gmail-watch-renew error:", err);
    return new Response(
      JSON.stringify({ error: (err as Error).message }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
