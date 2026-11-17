/**
 * twilio-sms-status — Twilio delivery-status callback for outbound SMS.
 *
 * Twilio posts form-urlencoded: MessageSid, MessageStatus, ErrorCode, To, From.
 * We update the corresponding `messages` row (matched by external_id =
 * MessageSid) with the new delivery_status.
 *
 * Twilio statuses: queued, sending, sent, failed, delivered, undelivered, read.
 */
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";
import {
  getTwilioEnvCreds,
  verifyTwilioWebhookSignature,
} from "../_shared/twilio.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey, X-Twilio-Signature",
};

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 200, headers: corsHeaders });

  try {
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
      { auth: { autoRefreshToken: false, persistSession: false } },
    );

    const rawBody = await req.text();
    const params = parseFormUrlEncoded(rawBody);

    // Require a valid Twilio signature — FAIL CLOSED (previously skipped when the
    // header was absent, allowing forged status callbacks to flip any message's
    // delivery_status cross-tenant).
    const creds = getTwilioEnvCreds();
    const signature = req.headers.get("X-Twilio-Signature") ?? "";
    if (
      !creds ||
      !signature ||
      !(await verifyTwilioWebhookSignature(req.url, params, signature, creds.authToken))
    ) {
      console.warn("[twilio-sms-status] rejected: missing or invalid signature");
      return new Response("forbidden", { status: 403 });
    }

    const sid = params.MessageSid;
    const status = params.MessageStatus;
    const errorCode = params.ErrorCode;

    if (!sid || !status) {
      return new Response("ok", { status: 200, headers: corsHeaders });
    }

    // Map Twilio status → our schema's delivery_status / status enum
    let messageStatus: string | null = null;
    if (status === "delivered" || status === "read") messageStatus = "sent";
    else if (status === "failed" || status === "undelivered") messageStatus = "failed";

    const update: Record<string, unknown> = {
      delivery_status: status,
    };
    if (messageStatus) update.status = messageStatus;
    if (errorCode) {
      update.metadata = {
        twilio_error_code: errorCode,
      };
    }

    await supabase
      .from("messages")
      .update(update)
      .eq("external_id", sid);

    return new Response("ok", { status: 200, headers: corsHeaders });
  } catch (e) {
    console.error("[twilio-sms-status] error:", e);
    return new Response("error", { status: 200, headers: corsHeaders });
  }
});

function parseFormUrlEncoded(text: string): Record<string, string> {
  const params: Record<string, string> = {};
  for (const pair of text.split("&")) {
    if (!pair) continue;
    const [k, v = ""] = pair.split("=");
    params[decodeURIComponent(k)] = decodeURIComponent(v.replace(/\+/g, " "));
  }
  return params;
}
