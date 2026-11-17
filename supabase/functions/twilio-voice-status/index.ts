/**
 * twilio-voice-status — Twilio voice-call status callback.
 *
 * Configured per-number's Voice → Call Status Changes → this URL.
 * Twilio sends CallSid, CallStatus, CallDuration, etc.
 *
 * We update the matching call_logs row (by twilio_call_sid).
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

    // Require a valid Twilio signature — FAIL CLOSED. Verification used to run only
    // `if (signature)`, so omitting the header skipped it entirely and let anyone post forged
    // call-status updates. Same fix already applied to twilio-sms-inbound and twilio-sms-status;
    // the voice pair was missed.
    const creds = getTwilioEnvCreds();
    const signature = req.headers.get("X-Twilio-Signature") ?? "";
    if (
      !creds ||
      !signature ||
      !(await verifyTwilioWebhookSignature(req.url, params, signature, creds.authToken))
    ) {
      console.warn("[twilio-voice-status] rejected: missing or invalid signature for", req.url);
      return new Response("forbidden", { status: 403 });
    }

    const sid = params.CallSid;
    const status = params.CallStatus;
    const duration = params.CallDuration ? parseInt(params.CallDuration, 10) : null;

    if (!sid || !status) return new Response("ok", { status: 200, headers: corsHeaders });

    const update: Record<string, unknown> = { status };
    if (duration !== null && !Number.isNaN(duration)) update.duration = duration; // the column is `duration`; duration_seconds never existed
    if (status === "completed" || status === "failed" || status === "busy" || status === "no-answer") {
      update.ended_at = new Date().toISOString();
    }

    await supabase
      .from("call_logs")
      .update(update)
      .eq("twilio_call_sid", sid);

    return new Response("ok", { status: 200, headers: corsHeaders });
  } catch (e) {
    console.error("[twilio-voice-status] error:", e);
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
