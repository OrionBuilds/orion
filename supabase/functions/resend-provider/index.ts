/**
 * resend-provider — Resend status for the Email Services Overview (one line linking to
 * Settings → Integrations → Resend, where the key is managed) and a "test" probe.
 *
 * Body: { orgId?: string, action: "status" | "test" }
 *
 * "test" validates RESEND_API_KEY by listing domains (GET /domains) and upserts the org's
 * email_providers row (provider='resend', status connected/disconnected). email_providers is
 * keyed by `org_id` (UNIQUE) — it has no organization_id / enabled / last_validated_at columns.
 * The API key itself is never returned.
 */
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";
import {
  getResendEnvCreds,
  listResendApiKeys,
  validateResendCredentials,
} from "../_shared/resend.ts";
import { extractUserContext } from "../_shared/auth.ts";
import type { UserContext } from "../_shared/types.ts";

// Same rule as _shared/permissions.ts hasPermission (inlined: that module drags in unrelated
// type errors under `deno check`).
function hasPermission(user: UserContext, permission: string): boolean {
  return user.isSuperAdmin || user.permissions.includes(permission);
}

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
    // could read or write email_providers rows for any organization - status
    // enumerated org config, test upserted rows on behalf of another org.
    const userContext = await extractUserContext(req, supabase);
    if (!userContext) return jsonRes({ error: "Unauthorized" }, 401);
    if (!userContext.orgId) return jsonRes({ error: "No organization for caller" }, 403);

    const body = await req.json();
    const bodyOrgId = body.orgId as string | undefined;
    if (bodyOrgId && bodyOrgId !== userContext.orgId && !userContext.isSuperAdmin) {
      console.warn(`[resend-provider] org mismatch: body=${bodyOrgId} caller=${userContext.orgId}`);
      return jsonRes({ error: "Forbidden" }, 403);
    }
    const orgId = userContext.isSuperAdmin && bodyOrgId ? bodyOrgId : userContext.orgId;
    const action = (body.action as string) ?? "status";

    const creds = getResendEnvCreds();
    const envConfigured = !!creds;

    if (action === "status") {
      const { data: row } = await supabase
        .from("email_providers")
        .select("provider, status, updated_at")
        .eq("org_id", orgId)
        .eq("provider", "resend")
        .maybeSingle();
      return jsonRes({
        envConfigured,
        fromEmail: creds?.fromEmail ?? null,
        fromName: creds?.fromName ?? null,
        // Which keys exist (names only, never values): RESEND_API_KEY plus RESEND_API_KEY__<DOMAIN>.
        keys: listResendApiKeys().map((k) => k.label),
        provider: row ?? null,
      });
    }

    if (action === "test") {
      if (!hasPermission(userContext, "email.settings.manage")) {
        return jsonRes({ error: "Permission denied (email.settings.manage)" }, 403);
      }
      if (!creds) {
        return jsonRes({
          envConfigured: false,
          error: "RESEND_API_KEY / RESEND_FROM_EMAIL not configured",
        }, 400);
      }

      // Validate every configured key; the connection is "connected" only if all of them work.
      const keys = listResendApiKeys();
      const perKey = await Promise.all(keys.map(async (k) => ({ label: k.label, ...(await validateResendCredentials(k.apiKey)) })));
      const failed = perKey.filter((k) => !k.valid);
      const result = failed.length === 0
        ? { valid: true as const }
        : { valid: false as const, error: failed.map((k) => `${k.label}: ${k.error ?? "invalid"}`).join("; ") };
      const now = new Date().toISOString();

      const { error: upErr } = await supabase.from("email_providers").upsert(
        {
          org_id: orgId,
          provider: "resend",
          status: result.valid ? "connected" : "disconnected",
          account_nickname: "Resend",
          updated_at: now,
        },
        { onConflict: "org_id" },
      );
      if (upErr) console.error("[resend-provider] email_providers upsert failed:", upErr.message);

      if (!result.valid) {
        return jsonRes({ envConfigured: true, ok: false, error: result.error }, 400);
      }

      return jsonRes({
        envConfigured: true,
        ok: true,
        fromEmail: creds.fromEmail,
        fromName: creds.fromName,
        keys: perKey.map((k) => k.label),
      });
    }

    return jsonRes({ error: "Unknown action" }, 400);
  } catch (e) {
    console.error("[resend-provider] error:", e);
    return jsonRes({ error: e instanceof Error ? e.message : "Internal error" }, 500);
  }
});

function jsonRes(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
