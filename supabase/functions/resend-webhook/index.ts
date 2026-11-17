/**
 * resend-webhook — Resend Webhook receiver (replaces sendgrid-webhook).
 *
 * Resend posts a single event object per request, signed with Svix. Configure
 * in the Resend dashboard: Webhooks → add endpoint → this URL, subscribing to
 * email.sent / email.delivered / email.delivery_delayed / email.opened /
 * email.clicked / email.bounced / email.complained.
 *
 * Payload shape: { type, created_at, data: { email_id, to, subject, ... } }
 * Reference: https://resend.com/docs/dashboard/webhooks/introduction
 *
 * Signature verification is MANDATORY (fail closed): the Svix HMAC over
 * `${svix-id}.${svix-timestamp}.${rawBody}` must validate against
 * RESEND_WEBHOOK_SECRET. The matching `messages` row is updated by
 * external_id = data.email_id (Resend ids are clean UUIDs — no suffix split).
 */
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";
import {
  getResendEnvCreds,
  listResendWebhookSecrets,
  verifyResendWebhookSignature,
} from "../_shared/resend.ts";
import { failureNotification, shouldSuppress, tagValue, type ResendEventData } from "../_shared/resend-events.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers":
    "Content-Type, Authorization, X-Client-Info, Apikey, svix-id, svix-timestamp, svix-signature",
};

// Map Resend event type → our messages.delivery_status vocabulary + messages.status.
// Kept in lockstep with the delivery_status values the DB triggers consume.
// Resend has no dropped/unsubscribe events, so those statuses are never produced.
const EVENT_TO_DELIVERY: Record<string, { delivery_status: string; status?: string }> = {
  "email.sent": { delivery_status: "queued" },
  "email.delivered": { delivery_status: "delivered", status: "sent" },
  "email.delivery_delayed": { delivery_status: "deferred" },
  "email.opened": { delivery_status: "opened" },
  "email.clicked": { delivery_status: "clicked" },
  "email.bounced": { delivery_status: "bounced", status: "failed" },
  "email.complained": { delivery_status: "complained", status: "failed" },
};

/** Hard bounce / spam complaint -> an immediate email suppression. The suppression is the one
 *  write that must never be skipped. */
async function suppressOnBounceOrComplaint(
  supabase: ReturnType<typeof createClient>,
  orgId: string,
  eventType: string,
  toEmail: string | undefined,
): Promise<void> {
  if (!toEmail) return;
  const reason = eventType === "email.complained" ? "complaint" : eventType === "email.bounced" ? "bounce_hard" : null;
  if (!reason) return;
  const { error } = await supabase.from("suppressions").insert({
    org_id: orgId, kind: "email", value: toEmail.trim().toLowerCase(), channel: "email",
    reason, source: "resend", evidence: { event_type: eventType },
  });
  if (error && error.code !== "23505") console.error("[resend-webhook] suppressions insert failed:", error);
}

async function suppressFromMessage(
  supabase: ReturnType<typeof createClient>,
  eventType: string,
  providerMessageId: string,
  data: Record<string, unknown>,
): Promise<void> {
  if (!shouldSuppress(eventType, data as ResendEventData)) return;
  const toEmail = typeof data.to === "string" ? data.to : Array.isArray(data.to) ? String(data.to[0]) : undefined;
  if (!toEmail) return;

  // Scope the suppression to the org that sent the message. (Prospecting retirement: this used to
  // come from the matching outreach_events row; the platform `messages` row is now the source.)
  const { data: msg, error: lookupErr } = await supabase
    .from("messages")
    .select("organization_id")
    .eq("external_id", providerMessageId)
    .limit(1)
    .maybeSingle();
  const orgId = (msg as { organization_id?: string } | null)?.organization_id;
  if (lookupErr || !orgId) return;

  await suppressOnBounceOrComplaint(supabase, orgId, eventType, toEmail);
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 200, headers: corsHeaders });
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });

  try {
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
      { auth: { autoRefreshToken: false, persistSession: false } },
    );

    const rawBody = await req.text();

    // Signature verification is mandatory — fail closed if the secret or any
    // Svix header is missing, or if the HMAC does not match.
    // One Resend team per sending domain, each with its own webhook secret
    // (RESEND_WEBHOOK_SECRET, RESEND_WEBHOOK_SECRET__<DOMAIN>): accept a payload signed by any of them.
    const secrets = listResendWebhookSecrets();
    if (secrets.length === 0) {
      console.error("[resend-webhook] RESEND_WEBHOOK_SECRET not configured");
      return new Response("webhook secret not configured", { status: 401 });
    }
    const svixId = req.headers.get("svix-id") ?? "";
    const svixTimestamp = req.headers.get("svix-timestamp") ?? "";
    const svixSignature = req.headers.get("svix-signature") ?? "";
    if (!svixId || !svixTimestamp || !svixSignature) {
      return new Response("missing signature headers", { status: 401 });
    }
    let valid = false;
    for (const secret of secrets) {
      if (await verifyResendWebhookSignature(rawBody, svixId, svixTimestamp, svixSignature, secret)) { valid = true; break; }
    }
    if (!valid) {
      console.warn("[resend-webhook] signature verification failed");
      return new Response("forbidden", { status: 403 });
    }

    let payload: { type?: string; data?: Record<string, unknown> };
    try {
      payload = JSON.parse(rawBody);
    } catch {
      return new Response("invalid json", { status: 400 });
    }

    const eventType = payload.type ?? null;
    const emailId = (payload.data?.email_id as string) ?? null;
    if (!eventType || !emailId) {
      return new Response(JSON.stringify({ ok: true, processed: 0 }), {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const mapping = EVENT_TO_DELIVERY[eventType];
    if (!mapping) {
      return new Response(JSON.stringify({ ok: true, processed: 0, ignored: eventType }), {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const update: Record<string, unknown> = {
      delivery_status: mapping.delivery_status,
    };
    if (mapping.status) update.status = mapping.status;

    await supabase.from("messages").update(update).eq("external_id", emailId);

    // Hard bounce / complaint -> email suppression (unsubscribe/compliance list).
    await suppressFromMessage(supabase, eventType, emailId, payload.data ?? {});

    // Mail sent through mail-dispatch carries the sender's user id as a tag. Tell the sender and the owner
    // (the owner sees every bounce, since agents like Clara send on their behalf) once per email and person,
    // even if the send wasn't logged to a conversation.
    const evData = (payload.data ?? {}) as ResendEventData;
    const senderId = tagValue(evData, "orion_user");
    if (senderId) {
      const people = [...new Set([senderId, Deno.env.get("OWNER_USER_ID")?.trim() ?? ""].filter(Boolean))];
      for (const uid of people) {
        const note = failureNotification(eventType, evData, uid);
        if (!note) break;
        const { data: seen } = await supabase.from("notifications").select("id")
          .eq("user_id", uid).eq("type", "email_delivery_failed").eq("metadata->>external_id", emailId).limit(1).maybeSingle();
        if (!seen) await supabase.from("notifications").insert(note);
      }
    }

    return new Response(JSON.stringify({ ok: true, processed: 1 }), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e) {
    console.error("[resend-webhook] error:", e);
    return new Response("error", { status: 200 });
  }
});
