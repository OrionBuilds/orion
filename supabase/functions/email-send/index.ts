/**
 * email-send — outbound Resend email for signed-in users: the Email Services settings page
 * (status + Test Email) and Conversations (org "Resend" sender).
 *
 * Every send goes through _shared/email-defaults.ts `sendOrgEmail`, so the org's Defaults
 * (default from address, reply-to, unsubscribe group -> List-Unsubscribe + footer, suppression
 * check) apply uniformly. Server-side callers (crons, booking, notifications) import that helper
 * directly rather than calling this function — it requires a user JWT.
 *
 * Actions:
 *   - "check-status" — setup-readiness snapshot for the Overview / Test tabs
 *   - "test"         — one-off test email (fromAddressId optional = org default); test + audit logs
 *   - "send"         — send an email (fromAddressId optional = org default)
 *   - "send-message" — send a pending outbound `messages` row (Conversations, send via Resend)
 *                      and record the Resend id as external_id so resend-webhook can track it
 */
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";
import { getResendEnvCreds } from "../_shared/resend.ts";
import { loadOrgEmailDefaults, sendOrgEmail } from "../_shared/email-defaults.ts";
import { normalizeEmailBodyToHtml } from "../_shared/email-format.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};

interface TestEmailRequest {
  action: "test";
  toEmail: string;
  fromAddressId?: string;
  subject?: string;
  body?: string;
}

interface SendEmailRequest {
  action: "send";
  toEmail: string;
  toName?: string;
  fromAddressId?: string;
  subject: string;
  htmlBody?: string;
  textBody?: string;
  replyTo?: string;
  unsubscribeGroupId?: string;
  /** Accepted for compatibility; Resend tracking is per domain (Defaults tab). */
  trackOpens?: boolean;
  trackClicks?: boolean;
  transactional?: boolean;
  /** Raw headers passed through to Resend (e.g. a caller-built List-Unsubscribe, which then
   *  replaces the default-group one). */
  headers?: Record<string, string>;
}

interface SendMessageRequest {
  action: "send-message";
  messageId: string;
}

interface CheckStatusRequest {
  action: "check-status";
}

type RequestPayload = TestEmailRequest | SendEmailRequest | SendMessageRequest | CheckStatusRequest;

interface EmailSetupStatus {
  isConfigured: boolean;
  providerConnected: boolean;
  verifiedDomainsCount: number;
  activeFromAddressesCount: number;
  hasDefaultFromAddress: boolean;
  hasDefaultUnsubscribeGroup: boolean;
  blockingReasons: string[];
}

async function getEmailSetupStatus(
  orgId: string,
  supabase: ReturnType<typeof createClient>,
): Promise<EmailSetupStatus> {
  const status: EmailSetupStatus = {
    isConfigured: false,
    providerConnected: false,
    verifiedDomainsCount: 0,
    activeFromAddressesCount: 0,
    hasDefaultFromAddress: false,
    hasDefaultUnsubscribeGroup: false,
    blockingReasons: [],
  };

  status.providerConnected = !!getResendEnvCreds();
  if (!status.providerConnected) {
    status.blockingReasons.push("Resend is not configured — add the API key in Settings → Integrations → Resend");
    return status;
  }

  const { data: domains } = await supabase
    .from("email_domains")
    .select("id")
    .eq("org_id", orgId)
    .eq("status", "verified");

  const { data: fromAddresses } = await supabase
    .from("email_from_addresses")
    .select("id, is_default")
    .eq("org_id", orgId)
    .eq("active", true);

  status.verifiedDomainsCount = domains?.length || 0;
  if (status.verifiedDomainsCount === 0) {
    status.blockingReasons.push("No verified domains — add one (or click Sync) in the Domains tab");
  }

  status.activeFromAddressesCount = fromAddresses?.length || 0;
  if (status.activeFromAddressesCount === 0) {
    status.blockingReasons.push("No active from addresses — add one in the From Addresses tab");
  }

  const defaults = await loadOrgEmailDefaults(supabase, orgId);
  status.hasDefaultFromAddress = !!defaults.fromAddressId;
  status.hasDefaultUnsubscribeGroup = !!defaults.unsubscribeGroup;

  status.isConfigured = status.blockingReasons.length === 0;
  return status;
}

function splitAddresses(v: unknown): string[] | undefined {
  if (Array.isArray(v)) return v.map(String).map((s) => s.trim()).filter(Boolean);
  if (typeof v === "string" && v.trim()) return v.split(/[,;]/).map((s) => s.trim()).filter(Boolean);
  return undefined;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 200, headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const authHeader = req.headers.get("Authorization");

    if (!authHeader) {
      return jsonRes({ error: "Authorization required" }, 401);
    }

    const supabase = createClient(supabaseUrl, serviceRoleKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });

    const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
    const userClient = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: authHeader } },
      auth: { autoRefreshToken: false, persistSession: false },
    });

    const { data: { user }, error: userError } = await userClient.auth.getUser();
    if (userError || !user) {
      return jsonRes({ error: "Invalid user token" }, 401);
    }

    const { data: userData } = await supabase
      .from("users")
      .select("organization_id")
      .eq("id", user.id)
      .maybeSingle();

    if (!userData) return jsonRes({ error: "User not found" }, 404);

    const orgId = userData.organization_id as string;
    const payload: RequestPayload = await req.json();

    if (payload.action === "check-status") {
      const { data: hasViewPermission } = await supabase.rpc("user_has_email_permission", {
        user_id: user.id,
        required_permission: "email.settings.view",
      });
      if (!hasViewPermission) return jsonRes({ error: "Permission denied" }, 403);

      const status = await getEmailSetupStatus(orgId, supabase);
      return jsonRes({ success: true, status });
    }

    if (payload.action === "test") {
      const { data: hasTestPermission } = await supabase.rpc("user_has_email_permission", {
        user_id: user.id,
        required_permission: "email.send.test",
      });
      if (!hasTestPermission) return jsonRes({ error: "Permission denied" }, 403);
      if (!payload.toEmail) return jsonRes({ error: "toEmail required" }, 400);

      const defaults = await loadOrgEmailDefaults(supabase, orgId);
      const fromAddressId = payload.fromAddressId || defaults.fromAddressId || null;

      const status = await getEmailSetupStatus(orgId, supabase);
      if (!status.isConfigured) {
        await supabase.from("email_test_logs").insert({
          org_id: orgId,
          sent_by: user.id,
          to_email: payload.toEmail,
          from_address_id: fromAddressId,
          status: "failed",
          error_message: status.blockingReasons.join(", "),
          provider: "resend",
        });
        return jsonRes({
          success: false,
          error: "Email not configured",
          blockingReasons: status.blockingReasons,
        }, 400);
      }

      const { data: org } = await supabase
        .from("organizations")
        .select("name")
        .eq("id", orgId)
        .single();
      const orgName = (org?.name as string | undefined) || "Your Organization";

      const subject = payload.subject || `Test Email from ${orgName}`;
      const html = payload.body
        ? normalizeEmailBodyToHtml(payload.body)
        : `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
          <h2>Test Email</h2>
          <p>This is a test email sent from your Email Services configuration.</p>
          <p>If you received this email, Resend is working with your organization's defaults
          (from address, reply-to and unsubscribe group).</p>
          <hr style="border: none; border-top: 1px solid #eee; margin: 20px 0;">
          <p style="color: #666; font-size: 12px;">Sent from ${orgName}</p>
        </div>
      `;

      const result = await sendOrgEmail(supabase, orgId, {
        to: payload.toEmail,
        subject,
        html,
        fromAddressId,
        categories: ["test"],
        customArgs: { org_id: orgId },
        defaults,
      });

      if (!result.ok) {
        await supabase.from("email_test_logs").insert({
          org_id: orgId,
          sent_by: user.id,
          to_email: payload.toEmail,
          from_address_id: fromAddressId,
          status: "failed",
          error_message: result.error,
          provider: "resend",
        });
        await supabase.from("audit_logs").insert({
          org_id: orgId,
          user_id: user.id,
          action: "email.test.failed",
          entity_type: "email_test",
          details: { to_email: payload.toEmail, error: result.error },
        });
        return jsonRes({ success: false, error: result.error }, result.status >= 400 ? result.status : 502);
      }

      await supabase.from("email_test_logs").insert({
        org_id: orgId,
        sent_by: user.id,
        to_email: payload.toEmail,
        from_address_id: fromAddressId,
        status: "success",
        provider_message_id: result.messageId,
        provider: "resend",
      });
      await supabase.from("audit_logs").insert({
        org_id: orgId,
        user_id: user.id,
        action: "email.test.sent",
        entity_type: "email_test",
        details: { to_email: payload.toEmail, message_id: result.messageId },
      });

      return jsonRes({
        success: true,
        messageId: result.messageId,
        from: result.from,
        replyTo: result.replyTo ?? null,
        unsubscribeUrl: result.unsubscribeUrl ?? null,
      });
    }

    if (payload.action === "send") {
      const status = await getEmailSetupStatus(orgId, supabase);
      if (!status.isConfigured) {
        return jsonRes({
          success: false,
          error: "Email not configured",
          blockingReasons: status.blockingReasons,
        }, 400);
      }
      if (!payload.htmlBody && !payload.textBody) {
        return jsonRes({ error: "Email body required (htmlBody or textBody)" }, 400);
      }

      const result = await sendOrgEmail(supabase, orgId, {
        to: payload.toEmail,
        toName: payload.toName,
        subject: payload.subject,
        html: payload.htmlBody,
        text: payload.textBody,
        replyTo: payload.replyTo,
        fromAddressId: payload.fromAddressId || null,
        transactional: payload.transactional,
        unsubscribeGroupId: payload.unsubscribeGroupId,
        customArgs: { org_id: orgId },
        customHeaders: payload.headers,
      });

      if (!result.ok) {
        return jsonRes({ success: false, error: result.error, suppressed: result.suppressed }, result.status >= 400 ? result.status : 502);
      }
      return jsonRes({ success: true, messageId: result.messageId });
    }

    if (payload.action === "send-message") {
      if (!payload.messageId) return jsonRes({ error: "messageId required" }, 400);
      const { data: msg } = await supabase
        .from("messages")
        .select("id, organization_id, contact_id, channel, direction, body, subject, metadata, status")
        .eq("id", payload.messageId)
        .eq("organization_id", orgId)
        .maybeSingle();
      if (!msg) return jsonRes({ error: "Message not found" }, 404);
      if (msg.channel !== "email" || msg.direction !== "outbound") {
        return jsonRes({ error: "Not an outbound email message" }, 400);
      }
      if (msg.status !== "pending" && msg.status !== "failed") {
        return jsonRes({ error: `Message already ${msg.status}` }, 409);
      }

      const meta = (msg.metadata ?? {}) as Record<string, unknown>;
      let to = typeof meta.to_email === "string" ? meta.to_email.trim() : "";
      if (!to && msg.contact_id) {
        const { data: contact } = await supabase
          .from("contacts")
          .select("email")
          .eq("id", msg.contact_id)
          .eq("organization_id", orgId)
          .maybeSingle();
        to = (contact?.email as string | undefined)?.trim() ?? "";
      }

      const markFailed = async (error: string) => {
        await supabase
          .from("messages")
          .update({ status: "failed", metadata: { ...meta, sent_via: "resend", error_message: error } })
          .eq("id", msg.id);
      };

      if (!to) {
        await markFailed("No recipient email address");
        return jsonRes({ success: false, error: "No recipient email address" }, 400);
      }

      // Honor the composer's chosen sender only when it is one of the org's active From Addresses
      // (anything else is not on a verified Resend domain); otherwise the org default applies.
      let fromAddressId: string | null = null;
      const metaFrom = typeof meta.from_email === "string" ? meta.from_email.trim().toLowerCase() : "";
      if (metaFrom) {
        const { data: fa } = await supabase
          .from("email_from_addresses")
          .select("id")
          .eq("org_id", orgId)
          .eq("active", true)
          .ilike("email", metaFrom)
          .limit(1)
          .maybeSingle();
        fromAddressId = (fa?.id as string | undefined) ?? null;
      }

      const result = await sendOrgEmail(supabase, orgId, {
        to,
        subject: (msg.subject as string | null) || "(no subject)",
        html: normalizeEmailBodyToHtml((msg.body as string | null) ?? ""),
        fromAddressId,
        cc: splitAddresses(meta.cc),
        bcc: splitAddresses(meta.bcc),
        contactId: (msg.contact_id as string | null) ?? null,
        categories: ["conversation"],
        customArgs: { org_id: orgId },
      });

      if (!result.ok) {
        await markFailed(result.error ?? "Send failed");
        return jsonRes({ success: false, error: result.error, suppressed: result.suppressed }, result.status >= 400 ? result.status : 502);
      }

      await supabase
        .from("messages")
        .update({
          status: "sent",
          external_id: result.messageId ?? null,
          delivery_status: "queued",
          metadata: { ...meta, to_email: to, sent_via: "resend", from_email: result.from, error_message: null },
        })
        .eq("id", msg.id);

      return jsonRes({ success: true, messageId: result.messageId, status: "sent" });
    }

    return jsonRes({ error: "Invalid action" }, 400);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return jsonRes({ error: message }, 500);
  }
});

function jsonRes(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
