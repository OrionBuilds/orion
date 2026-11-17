/**
 * twilio-sms-send — outbound SMS/MMS via Twilio Messages API.
 *
 * Entry point for the frontend SMS composer and internal service-role callers
 * (see the tenant-isolation note below) — all POST here to dispatch a message.
 *
 * Body:
 *   {
 *     orgId: string,
 *     contactId?: string,
 *     conversationId?: string,
 *     fromNumber?: string,           // E.164; otherwise platform default
 *     toNumber: string,
 *     body: string,
 *     mediaUrls?: string[],
 *     existingMessageId?: string,    // update-in-place for optimistic composer
 *     metadata?: Record<string, unknown>,
 *   }
 */
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";
import { getTwilioEnvCreds, sendTwilioSms } from "../_shared/twilio.ts";
import { extractUserContext, isServiceRoleRequest } from "../_shared/auth.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 200, headers: corsHeaders });

  try {
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
      { auth: { autoRefreshToken: false, persistSession: false } },
    );

    const body = await req.json();

    // Tenant isolation. verify_jwt=true proves only that SOME valid JWT was presented, not which
    // org it belongs to - so trusting body.orgId let any authenticated user send SMS as another
    // organization, from that org's numbers. (The existing from-number check below limited the
    // damage but assumed orgId itself was trustworthy.)
    //
    // Internal callers - payment-reminder-scheduler, phone-test -
    // invoke this with the service-role key and legitimately pass an
    // explicit orgId, so that path is preserved.
    let orgId: string;
    if (isServiceRoleRequest(req)) {
      orgId = body.orgId as string;
    } else {
      const userContext = await extractUserContext(req, supabase);
      if (!userContext) return jsonRes({ error: "Unauthorized" }, 401);
      if (!userContext.orgId) return jsonRes({ error: "No organization for caller" }, 403);
      orgId = userContext.orgId;
      if (body.orgId && body.orgId !== orgId) {
        console.warn(`[twilio-sms-send] org mismatch: body=${body.orgId} caller=${orgId}`);
        return jsonRes({ error: "Forbidden" }, 403);
      }
    }
    const toNumber = body.toNumber as string;
    const text = (body.body as string) ?? "";
    const mediaUrls = (body.mediaUrls as string[]) || [];
    const contactId = (body.contactId as string) || null;
    const conversationId = (body.conversationId as string) || null;
    const metadata = (body.metadata as Record<string, unknown>) || {};
    const existingMessageId = (body.existingMessageId as string) || null;
    const overrideFromNumber = (body.fromNumber as string) || undefined;

    if (!orgId || !toNumber || (!text && mediaUrls.length === 0)) {
      return jsonRes({ error: "orgId, toNumber, and body or mediaUrls required" }, 400);
    }

    const creds = getTwilioEnvCreds();
    if (!creds) {
      return jsonRes({ error: "Twilio not configured" }, 400);
    }

    // Resolve from number: explicit > org default > env fallback
    let fromNumber: string | undefined = overrideFromNumber;
    if (overrideFromNumber) {
      // orgId is now established from the caller's identity (above), so this check is a
      // second layer rather than the only one: the chosen number must belong to that org.
      const { data: numRow } = await supabase
        .from("twilio_numbers")
        .select("id")
        .eq("org_id", orgId)
        .eq("phone_number", overrideFromNumber)
        .eq("status", "active")
        .maybeSingle();
      if (!numRow) {
        return jsonRes({ error: "fromNumber is not an active number for this organization" }, 400);
      }
    }
    if (!fromNumber && !creds.messagingServiceSid) {
      const { data: defaultRow } = await supabase
        .from("phone_settings")
        .select("default_sms_number_id, twilio_numbers!default_sms_number_id(phone_number)")
        .eq("org_id", orgId)
        .maybeSingle();
      const numField = (defaultRow as { twilio_numbers?: { phone_number?: string } } | null)?.twilio_numbers;
      if (numField?.phone_number) fromNumber = numField.phone_number;
      else fromNumber = creds.defaultFromNumber ?? undefined;
    }

    const result = await sendTwilioSms({
      accountSid: creds.accountSid,
      authToken: creds.authToken,
      to: toNumber,
      body: text,
      from: fromNumber,
      messagingServiceSid: creds.messagingServiceSid ?? undefined,
      mediaUrls: mediaUrls.length > 0 ? mediaUrls : undefined,
    });

    const success = result.ok;
    const sid = result.sid ?? null;
    const providerStatus = result.providerStatus ?? null;
    const errorMessage = result.ok ? undefined : result.error;
    const sentAt = new Date().toISOString();

    if (existingMessageId) {
      // Preserve the metadata the composer already wrote (to_number/from_number)
      // rather than replacing the whole column.
      const { data: existingRow } = await supabase
        .from("messages")
        .select("metadata")
        .eq("id", existingMessageId)
        .maybeSingle();
      const baseMeta = (existingRow?.metadata as Record<string, unknown>) || {};
      await supabase
        .from("messages")
        .update({
          status: success ? "sent" : "failed",
          delivery_status: success ? (providerStatus ?? "queued") : "failed",
          external_id: sid,
          sent_at: sentAt,
          metadata: {
            ...baseMeta,
            ...metadata,
            to_number: toNumber,
            from_number: fromNumber,
            rail: "twilio",
            provider_message_id: sid,
            provider_status: providerStatus,
            error: errorMessage,
          },
        })
        .eq("id", existingMessageId);
    } else if (conversationId) {
      await supabase.from("messages").insert({
        organization_id: orgId,
        conversation_id: conversationId,
        contact_id: contactId,
        channel: "sms",
        direction: "outbound",
        body: text,
        media_urls: mediaUrls.length > 0 ? mediaUrls : null,
        metadata: {
          ...metadata,
          to_number: toNumber,
          from_number: fromNumber,
          rail: "twilio",
          provider_message_id: sid,
          provider_status: providerStatus,
          error: errorMessage,
        },
        status: success ? "sent" : "failed",
        delivery_status: success ? (providerStatus ?? "queued") : "failed",
        external_id: sid,
        sent_at: sentAt,
      });

      await supabase
        .from("conversations")
        .update({ last_message_at: sentAt })
        .eq("id", conversationId);
    }

    return jsonRes({ ok: success, sid, error: errorMessage }, success ? 200 : 502);
  } catch (e) {
    console.error("[twilio-sms-send] error:", e);
    return jsonRes({ error: e instanceof Error ? e.message : "Internal error" }, 500);
  }
});

function jsonRes(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
