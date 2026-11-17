/**
 * Server-side model discovery and key validation for the per-org LLM providers (llm_providers).
 *
 * One place that knows how to talk to each vendor's "list models" endpoint, shared by:
 *   - fetch-provider-models  (fetch-models / sync-catalog / sync-models actions)
 *   - ai-settings-providers  (test-connection)
 *   - integrations-connect   (Google Gemini card: validate the key, then seed llm_models)
 *
 * Keys are passed in already opened (openSecret); nothing here logs or returns them, and keys go in
 * request headers rather than URLs so they never land in proxy/access logs.
 */
import type { SupabaseClient } from "npm:@supabase/supabase-js@2";

export type LlmProviderKind = "anthropic" | "google" | "openai" | "groq";

export interface ProviderModel {
  model_key: string;
  display_name: string;
  context_window: number | null;
  max_output_tokens: number | null;
  capabilities: Record<string, boolean>;
  is_deprecated: boolean;
}

/**
 * Models enabled automatically the first time they are synced into an org (everything else lands
 * disabled until an admin turns it on). Anthropic's current family plus Gemini's current tier.
 */
export const RECOMMENDED_MODEL_KEYS = new Set<string>([
  "claude-opus-5-5",
  "claude-sonnet-5-5",
  "claude-haiku-5-5",
  "claude-fable-5-1",
  "gemini-2.5-pro",
  "gemini-2.5-flash",
]);

export function isLlmProviderKind(v: unknown): v is LlmProviderKind {
  return v === "anthropic" || v === "google" || v === "openai" || v === "groq";
}

class ProviderApiError extends Error {}

async function readError(response: Response, vendor: string): Promise<string> {
  const body = await response.json().catch(() => ({}));
  const message = body?.error?.message ?? body?.message;
  return typeof message === "string" && message
    ? message
    : `${vendor} API returned status ${response.status}`;
}

// ---------------------------------------------------------------- Anthropic

interface AnthropicModelRow {
  id: string;
  display_name?: string;
  max_input_tokens?: number;
  max_tokens?: number;
  capabilities?: Record<string, unknown>;
}

export async function fetchAnthropicModels(apiKey: string): Promise<ProviderModel[]> {
  const rows: AnthropicModelRow[] = [];
  let afterId: string | null = null;
  // /v1/models is paginated (limit max 1000); loop defensively in case the family grows.
  for (let page = 0; page < 10; page++) {
    const url = new URL("https://api.anthropic.com/v1/models");
    url.searchParams.set("limit", "1000");
    if (afterId) url.searchParams.set("after_id", afterId);
    const response = await fetch(url, {
      headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
    });
    if (!response.ok) throw new ProviderApiError(await readError(response, "Anthropic"));
    const data = await response.json();
    rows.push(...((data.data ?? []) as AnthropicModelRow[]));
    if (!data.has_more || !data.last_id) break;
    afterId = data.last_id;
  }

  return rows
    .filter((m) => typeof m.id === "string" && m.id.toLowerCase().startsWith("claude"))
    .map((m) => ({
      model_key: m.id,
      display_name: m.display_name || formatAnthropicModelName(m.id),
      context_window: m.max_input_tokens ?? anthropicContextWindow(m.id),
      max_output_tokens: m.max_tokens ?? null,
      capabilities: {
        streaming: true,
        function_calling: true,
        vision: true,
        thinking: true,
      },
      is_deprecated: isLegacyAnthropic(m.id),
    }))
    .sort((a, b) => modelSortScore(b.model_key) - modelSortScore(a.model_key));
}

function isLegacyAnthropic(id: string): boolean {
  return /^claude-(instant|2|3)/.test(id) || /^claude-3-/.test(id);
}

function anthropicContextWindow(id: string): number {
  // Every 4.6+ family model has a 1M window; older Claude models top out at 200K.
  const v = anthropicVersion(id);
  return v >= 4.6 ? 1_000_000 : 200_000;
}

/** Numeric family version from an id like claude-opus-5-5 -> 5.5, claude-sonnet-4-20250514 -> 4. */
function anthropicVersion(id: string): number {
  const m = id.match(/^claude-(?:opus|sonnet|haiku|fable|mythos)-(\d+)(?:-(\d{1,2}))?(?:-|$)/);
  if (m) return Number(m[1]) + (m[2] ? Number(m[2]) / 10 : 0);
  const legacy = id.match(/^claude-(\d+)(?:-(\d))?-/);
  if (legacy) return Number(legacy[1]) + (legacy[2] ? Number(legacy[2]) / 10 : 0);
  return 0;
}

function formatAnthropicModelName(id: string): string {
  const m = id.match(/^claude-(opus|sonnet|haiku|fable|mythos)-(\d+)(?:-(\d{1,2}))?/);
  if (!m) return id;
  const family = m[1].charAt(0).toUpperCase() + m[1].slice(1);
  return `Claude ${family} ${m[2]}${m[3] ? `.${m[3]}` : ""}`;
}

// ---------------------------------------------------------------- Google Gemini (AI Studio key)

interface GeminiModelRow {
  name: string;
  displayName?: string;
  inputTokenLimit?: number;
  outputTokenLimit?: number;
  supportedGenerationMethods?: string[];
  thinking?: boolean;
}

export async function fetchGeminiModels(apiKey: string): Promise<ProviderModel[]> {
  const rows: GeminiModelRow[] = [];
  let pageToken: string | null = null;
  for (let page = 0; page < 10; page++) {
    const url = new URL("https://generativelanguage.googleapis.com/v1beta/models");
    url.searchParams.set("pageSize", "1000");
    if (pageToken) url.searchParams.set("pageToken", pageToken);
    const response = await fetch(url, { headers: { "x-goog-api-key": apiKey } });
    if (!response.ok) throw new ProviderApiError(await readError(response, "Gemini"));
    const data = await response.json();
    rows.push(...((data.models ?? []) as GeminiModelRow[]));
    if (!data.nextPageToken) break;
    pageToken = data.nextPageToken;
  }

  return rows
    .filter((m) => m.supportedGenerationMethods?.includes("generateContent"))
    .map((m) => ({ ...m, id: m.name.replace(/^models\//, "") }))
    .filter((m) => m.id.startsWith("gemini") && !/embedding|aqa|imagen|tts|image-generation/.test(m.id))
    .map((m) => ({
      model_key: m.id,
      display_name: m.displayName || m.id,
      context_window: m.inputTokenLimit ?? null,
      max_output_tokens: m.outputTokenLimit ?? null,
      capabilities: {
        streaming: true,
        function_calling: true,
        vision: true,
        thinking: m.thinking === true,
      },
      is_deprecated: /gemini-(1\.0|1\.5)/.test(m.id),
    }))
    .sort((a, b) => modelSortScore(b.model_key) - modelSortScore(a.model_key));
}

// ---------------------------------------------------------------- OpenAI

export async function fetchOpenAIModels(apiKey: string): Promise<ProviderModel[]> {
  const response = await fetch("https://api.openai.com/v1/models", {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  if (!response.ok) throw new ProviderApiError(await readError(response, "OpenAI"));
  const data = await response.json();
  return ((data.data ?? []) as { id: string }[])
    .map((m) => m.id)
    .filter((id) => /^(gpt-|o\d)/.test(id))
    .filter((id) => !/(audio|realtime|transcribe|tts|image|search|embedding|instruct)/.test(id))
    .map((id) => ({
      model_key: id,
      display_name: id.replace(/^gpt-/, "GPT-"),
      context_window: null,
      max_output_tokens: null,
      capabilities: { streaming: true, function_calling: true },
      is_deprecated: /^gpt-(3\.5|4)(-|$)/.test(id),
    }))
    .sort((a, b) => modelSortScore(b.model_key) - modelSortScore(a.model_key));
}

// ---------------------------------------------------------------- Groq

export async function fetchGroqModels(apiKey: string): Promise<ProviderModel[]> {
  const response = await fetch("https://api.groq.com/openai/v1/models", {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  if (!response.ok) throw new ProviderApiError(await readError(response, "Groq"));
  const data = await response.json();
  return ((data.data ?? []) as { id: string; context_window?: number }[])
    .filter((m) => !/(whisper|tts|guard)/i.test(m.id))
    .map((m) => ({
      model_key: m.id,
      display_name: m.id,
      context_window: m.context_window ?? null,
      max_output_tokens: null,
      capabilities: { streaming: true, function_calling: true },
      is_deprecated: false,
    }));
}

// ---------------------------------------------------------------- dispatch

export function fetchModelsFromProvider(
  provider: LlmProviderKind,
  apiKey: string,
): Promise<ProviderModel[]> {
  switch (provider) {
    case "anthropic":
      return fetchAnthropicModels(apiKey);
    case "google":
      return fetchGeminiModels(apiKey);
    case "openai":
      return fetchOpenAIModels(apiKey);
    case "groq":
      return fetchGroqModels(apiKey);
  }
}

/** Validates a key by listing models with it. Never throws; never echoes the key. */
export async function validateProviderKey(
  provider: LlmProviderKind,
  apiKey: string,
): Promise<{ success: boolean; error?: string; model_count?: number }> {
  if (!apiKey.trim()) return { success: false, error: "API key is empty" };
  try {
    const models = await fetchModelsFromProvider(provider, apiKey.trim());
    return { success: true, model_count: models.length };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : "Connection test failed",
    };
  }
}

/**
 * Higher = newer/more capable; used only for display order. Parses the family version so new
 * releases sort correctly without a code change.
 */
export function modelSortScore(id: string): number {
  if (id.startsWith("claude")) {
    const tier = /fable|mythos/.test(id) ? 3 : /opus/.test(id) ? 2 : /sonnet/.test(id) ? 1 : 0;
    return anthropicVersion(id) * 10 + tier;
  }
  const gem = id.match(/^gemini-(\d+(?:\.\d+)?)/);
  if (gem) {
    const tier = /pro/.test(id) ? 2 : /flash-lite/.test(id) ? 0 : /flash/.test(id) ? 1 : 0;
    const preview = /preview|exp/.test(id) ? -0.5 : 0;
    return Number(gem[1]) * 10 + tier + preview;
  }
  const gpt = id.match(/^gpt-(\d+(?:\.\d+)?)/);
  if (gpt) return Number(gpt[1]) * 10;
  return 0;
}

// ---------------------------------------------------------------- llm_models sync

export interface SyncResult {
  provider: LlmProviderKind;
  fetched: number;
  inserted: number;
  updated: number;
  unavailable: number;
}

/**
 * Upserts the provider's live model list into llm_models (the table AI agents and agent_settings
 * reference). Existing rows keep their enabled/is_default flags; new rows are enabled only when they
 * are in RECOMMENDED_MODEL_KEYS. Rows the vendor no longer lists are kept (agents may reference them)
 * but flagged metadata.available = false so the UI can say so.
 */
export async function syncProviderModelsToOrg(
  admin: SupabaseClient,
  orgId: string,
  provider: { id: string; provider: LlmProviderKind },
  apiKey: string,
): Promise<SyncResult> {
  const models = await fetchModelsFromProvider(provider.provider, apiKey);
  const now = new Date().toISOString();

  const { data: existing, error: existingError } = await admin
    .from("llm_models")
    .select("id, model_key, provider_id, metadata")
    .eq("org_id", orgId);
  if (existingError) throw new Error(`Failed to read llm_models: ${existingError.message}`);

  const byKey = new Map((existing ?? []).map((m) => [m.model_key as string, m]));
  let inserted = 0;
  let updated = 0;

  for (const model of models) {
    const metadata = {
      capabilities: Object.entries(model.capabilities).filter(([, v]) => v).map(([k]) => k),
      max_output_tokens: model.max_output_tokens,
      deprecated: model.is_deprecated,
      available: true,
      synced_at: now,
      source: "provider_api",
    };
    const row = byKey.get(model.model_key);
    if (row) {
      // llm_models.model_key is unique per org; a row that belongs to another provider (e.g. a
      // custom proxy) is left alone rather than silently re-parented.
      if (row.provider_id !== provider.id) continue;
      const { error } = await admin
        .from("llm_models")
        .update({
          display_name: model.display_name,
          context_window: model.context_window,
          metadata: { ...(row.metadata ?? {}), ...metadata },
          updated_at: now,
        })
        .eq("id", row.id);
      if (error) throw new Error(`Failed to update ${model.model_key}: ${error.message}`);
      updated++;
    } else {
      const { error } = await admin.from("llm_models").insert({
        org_id: orgId,
        provider_id: provider.id,
        model_key: model.model_key,
        display_name: model.display_name,
        context_window: model.context_window,
        enabled: RECOMMENDED_MODEL_KEYS.has(model.model_key),
        is_default: false,
        metadata,
      });
      if (error) throw new Error(`Failed to insert ${model.model_key}: ${error.message}`);
      inserted++;
    }
  }

  const live = new Set(models.map((m) => m.model_key));
  const stale = (existing ?? []).filter(
    (m) => m.provider_id === provider.id && !live.has(m.model_key as string) &&
      (m.metadata as Record<string, unknown> | null)?.available !== false,
  );
  for (const m of stale) {
    await admin
      .from("llm_models")
      .update({ metadata: { ...(m.metadata ?? {}), available: false, synced_at: now }, updated_at: now })
      .eq("id", m.id);
  }

  return { provider: provider.provider, fetched: models.length, inserted, updated, unavailable: stale.length };
}
