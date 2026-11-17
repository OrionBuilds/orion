/**
 * agent-settings-get — read-only effective configuration for the calling agent.
 *
 * Who can call:
 *   - Agent accounts (users with the ClaraAgent / FridayAgent role) get their own tree only:
 *     no params → their root agent; `subagent: "front-desk"` or `agent: "clara.front-desk"` → that
 *     subagent; `include_subagents: true` → the root plus every configured subagent.
 *   - Humans with ai.settings.view (admins previewing from Settings → AI Agents) may pass any `agent`.
 *
 * Accepts GET (?agent=&subagent=&include_subagents=1) or POST with the same fields as JSON.
 * Never returns API keys: model entries carry the provider name and model id only; agents keep
 * calling vendors with their own credentials.
 */
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2";
import { extractUserContext } from "../_shared/auth.ts";
import {
  type AgentSettingsRow,
  authorizeAgentKey,
  describeModel,
  effectiveModel,
  type ModelChoice,
  type ModelRow,
  type OrgAgentDefaults,
  parentKeyOf,
  type ResolvedAgentSettings,
  resolveAgentSettings,
} from "../_shared/agent-settings.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

const SETTINGS_COLUMNS = [
  "agent_key", "display_name", "status", "primary_model_id", "fallback_model_id", "voice_id",
  "voice_settings", "persona_override", "persona_mode", "prompt_template_ids", "knowledge_collection_ids",
  "include_global_knowledge", "allowed_tools", "denied_tools", "daily_budget_usd", "max_tokens",
  "max_calls_per_day", "rate_limit_per_minute", "max_turns", "require_approval", "updated_at",
].join(", ");

interface Params {
  agent?: string | null;
  subagent?: string | null;
  include_subagents?: boolean;
}

async function readParams(req: Request): Promise<Params> {
  if (req.method === "GET") {
    const u = new URL(req.url);
    const inc = u.searchParams.get("include_subagents");
    return {
      agent: u.searchParams.get("agent"),
      subagent: u.searchParams.get("subagent"),
      include_subagents: inc === "1" || inc === "true",
    };
  }
  const body = await req.json().catch(() => ({}));
  return {
    agent: typeof body.agent === "string" ? body.agent : null,
    subagent: typeof body.subagent === "string" ? body.subagent : null,
    include_subagents: body.include_subagents === true,
  };
}

async function loadOrgDefaults(admin: SupabaseClient, orgId: string): Promise<OrgAgentDefaults> {
  const [{ data: defaults }, { data: defaultModel }, { data: defaultVoice }] = await Promise.all([
    admin.from("ai_agent_settings_defaults")
      .select("default_model_id, require_human_approval_default")
      .eq("org_id", orgId).maybeSingle(),
    admin.from("llm_models").select("id").eq("org_id", orgId).eq("is_default", true).eq("enabled", true)
      .limit(1).maybeSingle(),
    admin.from("elevenlabs_voices").select("voice_id").eq("org_id", orgId).eq("is_default", true)
      .limit(1).maybeSingle(),
  ]);
  return {
    default_model_id: defaults?.default_model_id ?? defaultModel?.id ?? null,
    default_voice_id: defaultVoice?.voice_id ?? null,
    require_approval: defaults?.require_human_approval_default ?? null,
  };
}

interface Hydration {
  models: Map<string, ModelRow>;
  voices: Map<string, { voice_name: string; enabled: boolean }>;
  templates: Map<string, { id: string; name: string; status: string; body: string | null; version: number | null }>;
  collections: Map<string, { id: string; name: string; status: string; apply_to_all_agents: boolean }>;
  globalCollections: { id: string; name: string }[];
}

async function hydrate(admin: SupabaseClient, orgId: string, resolved: ResolvedAgentSettings[], org: OrgAgentDefaults): Promise<Hydration> {
  const modelIds = new Set<string>();
  const voiceIds = new Set<string>();
  const templateIds = new Set<string>();
  const collectionIds = new Set<string>();
  if (org.default_model_id) modelIds.add(org.default_model_id);
  for (const r of resolved) {
    if (r.primary_model_id.value) modelIds.add(r.primary_model_id.value);
    if (r.fallback_model_id.value) modelIds.add(r.fallback_model_id.value);
    if (r.voice_id.value) voiceIds.add(r.voice_id.value);
    r.prompt_template_ids.forEach((id) => templateIds.add(id));
    r.knowledge_collection_ids.forEach((id) => collectionIds.add(id));
  }

  const [models, voices, templates, versions, collections, globals] = await Promise.all([
    modelIds.size
      ? admin.from("llm_models")
        .select("id, model_key, display_name, context_window, enabled, metadata, provider:llm_providers(provider, enabled)")
        .eq("org_id", orgId).in("id", [...modelIds])
      : Promise.resolve({ data: [] }),
    voiceIds.size
      ? admin.from("elevenlabs_voices").select("voice_id, voice_name, enabled").eq("org_id", orgId).in("voice_id", [...voiceIds])
      : Promise.resolve({ data: [] }),
    templateIds.size
      ? admin.from("prompt_templates").select("id, name, status").eq("org_id", orgId).in("id", [...templateIds])
      : Promise.resolve({ data: [] }),
    templateIds.size
      ? admin.from("prompt_template_versions").select("template_id, version_number, body").in("template_id", [...templateIds])
      : Promise.resolve({ data: [] }),
    collectionIds.size
      ? admin.from("knowledge_collections").select("id, name, status, apply_to_all_agents").eq("org_id", orgId).in("id", [...collectionIds])
      : Promise.resolve({ data: [] }),
    admin.from("knowledge_collections").select("id, name").eq("org_id", orgId).eq("status", "active").eq("apply_to_all_agents", true),
  ]);

  const latest = new Map<string, { version_number: number; body: string }>();
  for (const v of (versions.data ?? []) as { template_id: string; version_number: number; body: string }[]) {
    const cur = latest.get(v.template_id);
    if (!cur || v.version_number > cur.version_number) latest.set(v.template_id, v);
  }

  return {
    models: new Map(((models.data ?? []) as unknown as ModelRow[]).map((m) => [m.id, m])),
    voices: new Map(((voices.data ?? []) as { voice_id: string; voice_name: string; enabled: boolean }[])
      .map((v) => [v.voice_id, { voice_name: v.voice_name, enabled: v.enabled }])),
    templates: new Map(((templates.data ?? []) as { id: string; name: string; status: string }[]).map((t) => [t.id, {
      ...t,
      body: latest.get(t.id)?.body ?? null,
      version: latest.get(t.id)?.version_number ?? null,
    }])),
    collections: new Map(((collections.data ?? []) as { id: string; name: string; status: string; apply_to_all_agents: boolean }[])
      .map((c) => [c.id, c])),
    globalCollections: (globals.data ?? []) as { id: string; name: string }[],
  };
}

function present(r: ResolvedAgentSettings, h: Hydration, org: OrgAgentDefaults) {
  const primary = describeModel(r.primary_model_id.value ? h.models.get(r.primary_model_id.value) : undefined);
  const fallback = describeModel(r.fallback_model_id.value ? h.models.get(r.fallback_model_id.value) : undefined);
  const orgDefault = describeModel(org.default_model_id ? h.models.get(org.default_model_id) : undefined);
  const voice = r.voice_id.value ? h.voices.get(r.voice_id.value) : undefined;
  const templates = r.prompt_template_ids
    .map((id) => h.templates.get(id))
    .filter((t): t is NonNullable<typeof t> => !!t && t.status === "active" && !!t.body)
    .map((t) => ({ id: t.id, name: t.name, version: t.version, body: t.body }));
  const collections = r.knowledge_collection_ids
    .map((id) => h.collections.get(id))
    .filter((c): c is NonNullable<typeof c> => !!c && c.status === "active")
    .map((c) => ({ id: c.id, name: c.name }));

  return {
    agent_key: r.agent_key,
    parent_key: r.parent_key,
    display_name: r.display_name,
    status: r.status,
    model: {
      // What to call: first available of primary → fallback → org default. null = keep the
      // agent's built-in default (e.g. CLARA_CLAUDE_MODEL).
      effective: effectiveModel([primary, fallback, orgDefault]),
      primary: primary as ModelChoice | null,
      primary_source: r.primary_model_id.source,
      fallback: fallback as ModelChoice | null,
      fallback_source: r.fallback_model_id.source,
    },
    voice: {
      provider: "elevenlabs",
      voice_id: r.voice_id.value,
      voice_name: voice?.voice_name ?? null,
      available: r.voice_id.value ? (voice?.enabled ?? false) : null,
      source: r.voice_id.source,
      settings: r.voice_settings,
    },
    prompts: {
      persona_override: r.persona_override,
      persona_mode: r.persona_mode,
      templates,
    },
    knowledge: {
      collections,
      include_global: r.include_global_knowledge,
      global_collections: r.include_global_knowledge ? h.globalCollections : [],
    },
    tools: {
      // null = no OS-side restriction beyond the agent's compiled allowlist (agent-core osmcp/allowlists.ts).
      allowed: r.allowed_tools,
      denied: r.denied_tools,
    },
    limits: r.limits,
    require_approval: r.require_approval,
    updated_at: r.updated_at,
  };
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 200, headers: corsHeaders });
  if (req.method !== "GET" && req.method !== "POST") return json({ success: false, error: "Method not allowed" }, 405);

  try {
    const admin = createClient(
      Deno.env.get("SUPABASE_URL") ?? "",
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
      { auth: { autoRefreshToken: false, persistSession: false } },
    );

    const user = await extractUserContext(req, admin);
    if (!user) return json({ success: false, error: "Unauthenticated" }, 401);

    const params = await readParams(req);
    const auth = authorizeAgentKey({
      roleName: user.roleName,
      canPreview: user.isSuperAdmin || user.permissions.includes("ai.settings.view"),
      requestedAgent: params.agent,
      requestedSubagent: params.subagent,
    });
    if ("error" in auth) return json({ success: false, error: auth.error }, auth.status);

    const agentKey = auth.agentKey;
    const rootKey = parentKeyOf(agentKey) ?? agentKey;
    const wantTree = params.include_subagents === true && agentKey === rootKey;

    let query = admin.from("agent_settings").select(SETTINGS_COLUMNS).eq("org_id", user.orgId);
    query = wantTree
      ? query.or(`agent_key.eq.${rootKey},parent_key.eq.${rootKey}`)
      : query.in("agent_key", agentKey === rootKey ? [rootKey] : [rootKey, agentKey]);
    const { data: rows, error } = await query;
    if (error) {
      console.error("[agent-settings-get] read failed:", error.message);
      return json({ success: false, error: "Failed to read agent settings" }, 500);
    }

    const byKey = new Map(((rows ?? []) as unknown as AgentSettingsRow[]).map((r) => [r.agent_key, r]));
    const org = await loadOrgDefaults(admin, user.orgId);
    const root = resolveAgentSettings(rootKey, byKey.get(rootKey) ?? null, null, org);

    const resolved: ResolvedAgentSettings[] = [];
    if (wantTree) {
      resolved.push(root);
      for (const key of [...byKey.keys()].filter((k) => k !== rootKey).sort()) {
        resolved.push(resolveAgentSettings(key, byKey.get(key) ?? null, root, org));
      }
    } else {
      resolved.push(agentKey === rootKey ? root : resolveAgentSettings(agentKey, byKey.get(agentKey) ?? null, root, org));
    }

    const h = await hydrate(admin, user.orgId, resolved, org);
    const [self, ...subagents] = resolved.map((r) => present(r, h, org));

    return json({
      success: true,
      data: {
        ...self,
        ...(wantTree ? { subagents } : {}),
        caller: { user_id: user.id, role: user.roleName },
        generated_at: new Date().toISOString(),
      },
    });
  } catch (error) {
    console.error("[agent-settings-get] error:", error);
    return json({ success: false, error: error instanceof Error ? error.message : "Unknown error" }, 500);
  }
});
