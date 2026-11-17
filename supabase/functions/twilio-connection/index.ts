/**
 * twilio-connection — status & test endpoint for the Phone System settings page.
 *
 * Credentials live in platform-wide env vars (TWILIO_ACCOUNT_SID / AUTH_TOKEN).
 * This function verifies them by calling Twilio /Accounts/{Sid}.json, then
 * upserts the org's twilio_connection row with the latest friendly_name and
 * timestamp so the UI can render "Connected as <Account Name>".
 *
 * Body: { orgId: string, action: "status" | "test" }
 *   - "status": returns the cached row without re-hitting Twilio
 *   - "test":   re-validates env credentials and refreshes the row
 */
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";
import { getTwilioAccount, getTwilioEnvCreds } from "../_shared/twilio.ts";
import { extractUserContext } from "../_shared/auth.ts";

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

    // F-25: verify caller identity + derive orgId from JWT. Previously took
    // orgId from the request body with no auth check, so any anonymous caller
    // could read another org's twilio_connection row (revealing SID + friendly
    // name) or run test to write the platform-wide credentials into another
    // org's row.
    const userContext = await extractUserContext(req, supabase);
    if (!userContext) return jsonRes({ error: "Unauthorized" }, 401);
    if (!userContext.orgId) return jsonRes({ error: "No organization for caller" }, 403);

    const body = await req.json();
    const bodyOrgId = body.orgId as string | undefined;
    if (bodyOrgId && bodyOrgId !== userContext.orgId && !userContext.isSuperAdmin) {
      console.warn(`[twilio-connection] org mismatch: body=${bodyOrgId} caller=${userContext.orgId}`);
      return jsonRes({ error: "Forbidden" }, 403);
    }
    const orgId = userContext.isSuperAdmin && bodyOrgId ? bodyOrgId : userContext.orgId;
    const action = (body.action as string) ?? "status";

    if (action === "status") {
      const { data: row } = await supabase
        .from("twilio_connection")
        .select("*")
        .eq("org_id", orgId)
        .maybeSingle();
      const envOk = !!getTwilioEnvCreds();
      return jsonRes({
        envConfigured: envOk,
        connection: row,
      });
    }

    if (action === "test") {
      const creds = getTwilioEnvCreds();
      if (!creds) {
        return jsonRes({
          envConfigured: false,
          error: "TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN not configured",
        }, 400);
      }

      const result = await getTwilioAccount(creds.accountSid, creds.authToken);
      if (!result.ok || !result.account) {
        await supabase.from("twilio_connection").upsert(
          {
            org_id: orgId,
            account_sid: creds.accountSid,
            status: "error",
            last_tested_at: new Date().toISOString(),
          },
          { onConflict: "org_id" },
        );
        return jsonRes({ envConfigured: true, ok: false, error: result.error }, 400);
      }

      await supabase.from("twilio_connection").upsert(
        {
          org_id: orgId,
          account_sid: result.account.sid,
          friendly_name: result.account.friendly_name,
          status: "connected",
          connected_at: new Date().toISOString(),
          last_tested_at: new Date().toISOString(),
        },
        { onConflict: "org_id" },
      );

      return jsonRes({
        envConfigured: true,
        ok: true,
        account: result.account,
      });
    }

    return jsonRes({ error: "Unknown action" }, 400);
  } catch (e) {
    console.error("[twilio-connection] error:", e);
    return jsonRes({ error: e instanceof Error ? e.message : "Internal error" }, 500);
  }
});

function jsonRes(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
