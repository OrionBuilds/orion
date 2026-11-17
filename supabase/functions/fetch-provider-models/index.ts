import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";
import { extractUserContext } from "../_shared/auth.ts";
import { openSecret } from "../_shared/secrets.ts";
import {
  fetchModelsFromProvider,
  isLlmProviderKind,
  type LlmProviderKind,
  type SyncResult,
  syncProviderModelsToOrg,
} from "../_shared/llm-provider-models.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};

interface RequestPayload {
  /**
   * fetch-models: live list from the vendor, annotated with llm_model_catalog flags (read-only).
   * sync-catalog: upsert the live list into llm_model_catalog (legacy Integrations card).
   * sync-models:  upsert the live list into llm_models — the table AI agents, ai_agents.model_id and
   *               agent_settings reference. `provider` optional: omitted = every enabled provider
   *               that has a key.
   */
  action: "fetch-models" | "sync-catalog" | "sync-models";
  /** Honored for SuperAdmins only (org pivot); everyone else is pinned to their own org. */
  org_id?: string;
  provider?: string;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 200, headers: corsHeaders });
  }

  try {
    const supabaseAdmin = createClient(
      Deno.env.get("SUPABASE_URL") ?? "",
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
    );

    const user = await extractUserContext(req, supabaseAdmin);
    if (!user) return json({ success: false, error: "Invalid authentication" }, 401);

    // Same rule as the llm_models / llm_providers write policies (and ai-settings-providers).
    // Agent roles hold ai_agents.manage for other reasons; they may read the model list but not
    // rewrite the org's catalog.
    const isAgentRole = /Agent$/.test(user.roleName);
    const canManage = user.isSuperAdmin || (user.permissions.includes("ai_agents.manage") && !isAgentRole);

    const payload: RequestPayload = await req.json();
    const { action } = payload;

    if (payload.org_id && payload.org_id !== user.orgId && !user.isSuperAdmin) {
      return json({ success: false, error: "Organization mismatch" }, 403);
    }
    const orgId = (user.isSuperAdmin && payload.org_id) || user.orgId;

    if (action !== "fetch-models" && !canManage) {
      return json({ success: false, error: "You need the ai_agents.manage permission" }, 403);
    }
    if (action === "fetch-models" && !canManage && !user.permissions.includes("ai.settings.view")) {
      return json({ success: false, error: "You need the ai.settings.view permission" }, 403);
    }

    if (action === "sync-models") {
      let query = supabaseAdmin
        .from("llm_providers")
        .select("id, provider, api_key_encrypted, enabled")
        .eq("org_id", orgId);
      if (payload.provider) query = query.eq("provider", payload.provider);
      else query = query.eq("enabled", true);
      const { data: providers, error } = await query;
      if (error) return json({ success: false, error: "Failed to read providers" }, 500);

      const results: SyncResult[] = [];
      const errors: { provider: string; error: string }[] = [];
      for (const p of providers ?? []) {
        if (!isLlmProviderKind(p.provider) || !p.api_key_encrypted) continue;
        try {
          const key = (await openSecret(p.api_key_encrypted)) ?? "";
          results.push(await syncProviderModelsToOrg(supabaseAdmin, orgId, { id: p.id, provider: p.provider }, key));
        } catch (e) {
          errors.push({ provider: p.provider, error: e instanceof Error ? e.message : "Sync failed" });
        }
      }
      if (payload.provider && results.length === 0 && errors.length === 0) {
        return json({ success: false, error: "Provider not configured or API key missing" }, 400);
      }
      return json({ success: errors.length === 0 || results.length > 0, data: { results, errors } });
    }

    if (!isLlmProviderKind(payload.provider)) {
      return json({ success: false, error: `Unsupported provider: ${payload.provider}` }, 400);
    }
    const provider: LlmProviderKind = payload.provider;

    const { data: providerConfig, error: providerError } = await supabaseAdmin
      .from("llm_providers")
      .select("id, api_key_encrypted")
      .eq("org_id", orgId)
      .eq("provider", provider)
      .maybeSingle();
    if (providerError) return json({ success: false, error: "Failed to fetch provider config" }, 500);
    if (!providerConfig?.api_key_encrypted) {
      return json({ success: false, error: "Provider not configured or API key missing" }, 400);
    }

    const models = await fetchModelsFromProvider(provider, (await openSecret(providerConfig.api_key_encrypted)) ?? "");

    const { data: existingModels } = await supabaseAdmin
      .from("llm_model_catalog")
      .select("id, model_key, is_enabled, is_default")
      .eq("org_id", orgId)
      .eq("provider", provider);
    const existingMap = new Map((existingModels || []).map((m) => [m.model_key, m]));

    if (action === "fetch-models") {
      const enrichedModels = models.map((model) => {
        const existing = existingMap.get(model.model_key);
        return { ...model, is_enabled: existing?.is_enabled ?? false, is_default: existing?.is_default ?? false };
      });
      return json({ success: true, data: { models: enrichedModels } });
    }

    if (action === "sync-catalog") {
      const now = new Date().toISOString();
      const upsertData = models.map((model) => {
        const existing = existingMap.get(model.model_key);
        return {
          ...(existing?.id ? { id: existing.id } : {}),
          org_id: orgId,
          provider,
          model_key: model.model_key,
          display_name: model.display_name,
          context_window: model.context_window,
          capabilities: model.capabilities,
          is_deprecated: model.is_deprecated,
          is_enabled: existing?.is_enabled ?? false,
          is_default: existing?.is_default ?? false,
          last_synced_at: now,
        };
      });
      const { error: upsertError } = await supabaseAdmin
        .from("llm_model_catalog")
        .upsert(upsertData, { onConflict: "org_id,provider,model_key" });
      if (upsertError) {
        console.error("Upsert error:", upsertError);
        return json({ success: false, error: "Failed to sync catalog" }, 500);
      }
      return json({ success: true, data: { synced_count: models.length } });
    }

    return json({ success: false, error: "Unknown action" }, 400);
  } catch (error) {
    console.error("Error in fetch-provider-models:", error);
    return json({ success: false, error: error instanceof Error ? error.message : "Unknown error" }, 500);
  }
});
