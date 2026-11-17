import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";
import { extractUserContext, isServiceRoleRequest } from "../_shared/auth.ts";
import { openSecret, sealSecret } from "../_shared/secrets.ts";
import {
  isLlmProviderKind,
  syncProviderModelsToOrg,
  validateProviderKey,
} from "../_shared/llm-provider-models.ts";

// What the browser gets back: never api_key_encrypted (the column isn't readable by browser roles).
const PUBLIC_COLUMNS = "id, org_id, provider, base_url, enabled, created_at, updated_at";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};

interface RequestPayload {
  action: "test-connection" | "save-provider";
  /** Honored for service-role and SuperAdmin callers only; derived from the JWT otherwise. */
  org_id?: string;
  /** Required for test-connection; for save-provider, absent = create a new provider row. */
  provider_id?: string;
  provider?: string;
  api_key?: string;
  base_url?: string | null;
  enabled?: boolean;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 200, headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
    const supabaseAdmin = createClient(supabaseUrl, serviceRoleKey);

    // A valid JWT proves only that the caller is *some* user of the platform. Without an
    // org check, `org_id` from the body picked whose provider row — and therefore whose
    // stored LLM API key — this function loaded and exercised (F-25 pattern).
    const isServiceRole = isServiceRoleRequest(req);
    let callerOrgId: string | null = null;
    let callerIsSuperAdmin = false;
    let callerCanManage = isServiceRole;

    if (!isServiceRole) {
      const userContext = await extractUserContext(req, supabaseAdmin);
      if (!userContext) {
        return new Response(
          JSON.stringify({ success: false, error: "Unauthenticated" }),
          { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }
      callerOrgId = userContext.orgId;
      callerIsSuperAdmin = userContext.isSuperAdmin;
      // Same rule as the llm_providers write policies.
      callerCanManage = userContext.isSuperAdmin || userContext.permissions.includes("ai_agents.manage");
    }

    const payload: RequestPayload = await req.json();
    const { action, provider_id } = payload;
    const org_id = isServiceRole || callerIsSuperAdmin
      ? (payload.org_id || callerOrgId)
      : callerOrgId;

    if (!isServiceRole && !callerIsSuperAdmin && payload.org_id && payload.org_id !== callerOrgId) {
      return new Response(
        JSON.stringify({ success: false, error: "Not a member of this organization" }),
        { status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Keys are written here, sealed, instead of by the browser (which can no longer touch the column).
    if (action === "save-provider") {
      if (!org_id) {
        return new Response(
          JSON.stringify({ success: false, error: "Missing required fields" }),
          { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }
      if (!callerCanManage) {
        return new Response(
          JSON.stringify({ success: false, error: "You need the ai_agents.manage permission" }),
          { status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }
      const fields: Record<string, unknown> = {};
      if (payload.api_key !== undefined) {
        if (!payload.api_key.trim()) {
          return new Response(
            JSON.stringify({ success: false, error: "API key is empty" }),
            { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
          );
        }
        fields.api_key_encrypted = await sealSecret(payload.api_key.trim());
      }
      if (payload.base_url !== undefined) fields.base_url = payload.base_url || null;
      if (payload.enabled !== undefined) fields.enabled = payload.enabled;

      const query = provider_id
        ? supabaseAdmin.from("llm_providers").update({ ...fields, updated_at: new Date().toISOString() })
            .eq("id", provider_id).eq("org_id", org_id)
        : supabaseAdmin.from("llm_providers").insert({
            org_id,
            provider: payload.provider,
            enabled: false,
            ...fields,
          });
      if (!provider_id && (!payload.provider || !fields.api_key_encrypted)) {
        return new Response(
          JSON.stringify({ success: false, error: "provider and api_key are required" }),
          { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }
      const { data, error } = await query.select(PUBLIC_COLUMNS).single();
      if (error || !data) {
        return new Response(
          JSON.stringify({ success: false, error: error?.message ?? "Provider not found" }),
          { status: error ? 400 : 404, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }
      // A new key (or re-enabled provider) should make its models selectable right away, so the
      // Available Models list is populated server-side from the vendor instead of a client seed
      // list. Best effort: a sync failure doesn't undo the save.
      let modelsSync: unknown = null;
      if ((payload.api_key !== undefined || payload.enabled === true) && isLlmProviderKind(data.provider)) {
        try {
          const { data: sealed } = await supabaseAdmin
            .from("llm_providers").select("api_key_encrypted").eq("id", data.id).single();
          const key = (await openSecret(sealed?.api_key_encrypted)) ?? "";
          modelsSync = await syncProviderModelsToOrg(supabaseAdmin, data.org_id, { id: data.id, provider: data.provider }, key);
        } catch (e) {
          modelsSync = { error: e instanceof Error ? e.message : "Model sync failed" };
        }
      }
      return new Response(
        JSON.stringify({ success: true, provider: data, models_sync: modelsSync }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    if (!action || !org_id || !provider_id) {
      return new Response(
        JSON.stringify({ success: false, error: "Missing required fields" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    if (!isServiceRole && !callerIsSuperAdmin && payload.org_id && payload.org_id !== callerOrgId) {
      console.warn(`[ai-settings-providers] org mismatch: body=${payload.org_id} caller=${callerOrgId}`);
      return new Response(
        JSON.stringify({ success: false, error: "Not a member of this organization" }),
        { status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const { data: provider, error: providerError } = await supabaseAdmin
      .from("llm_providers")
      .select("*")
      .eq("id", provider_id)
      .eq("org_id", org_id)
      .single();

    if (providerError || !provider) {
      return new Response(
        JSON.stringify({ success: false, error: "Provider not found" }),
        { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    if (action === "test-connection") {
      const result = await testProviderConnection({
        ...provider,
        api_key_encrypted: (await openSecret(provider.api_key_encrypted)) ?? "",
      });
      return new Response(
        JSON.stringify(result),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    return new Response(
      JSON.stringify({ success: false, error: "Unknown action" }),
      { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (error) {
    console.error("Error in ai-settings-providers:", error);
    return new Response(
      JSON.stringify({ success: false, error: error instanceof Error ? error.message : "Unknown error" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});

interface Provider {
  provider: string;
  api_key_encrypted: string;
}

async function testProviderConnection(provider: Provider): Promise<{ success: boolean; error?: string }> {
  if (!isLlmProviderKind(provider.provider)) {
    return { success: false, error: `Unknown provider type: ${provider.provider}` };
  }
  const result = await validateProviderKey(provider.provider, provider.api_key_encrypted);
  return result.success ? { success: true } : { success: false, error: result.error };
}
