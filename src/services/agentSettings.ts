import { supabase } from '../lib/supabase';
import { callEdgeFunction } from '../lib/edgeFunction';

/**
 * Per-agent settings for FRIDAY, CLARA and their subagents (table agent_settings).
 * Every setting is nullable; null = inherit (subagent → parent → org defaults). The agents read
 * the resolved result through the agent-settings-get edge function.
 */

export type AgentStatus = 'active' | 'paused' | 'disabled';

export interface AgentSettings {
  id?: string;
  org_id?: string;
  agent_key: string;
  parent_key?: string | null;
  display_name: string | null;
  status: AgentStatus;
  primary_model_id: string | null;
  fallback_model_id: string | null;
  voice_id: string | null;
  voice_settings: Record<string, unknown>;
  persona_override: string | null;
  persona_mode: 'append' | 'replace';
  prompt_template_ids: string[];
  knowledge_collection_ids: string[] | null;
  include_global_knowledge: boolean | null;
  allowed_tools: string[] | null;
  denied_tools: string[];
  daily_budget_usd: number | null;
  max_tokens: number | null;
  max_calls_per_day: number | null;
  rate_limit_per_minute: number | null;
  max_turns: number | null;
  require_approval: boolean | null;
  updated_at?: string;
}

export type AgentSettingsInput = Omit<AgentSettings, 'id' | 'org_id' | 'parent_key' | 'updated_at'>;

const COLUMNS =
  'id, org_id, agent_key, parent_key, display_name, status, primary_model_id, fallback_model_id, voice_id, ' +
  'voice_settings, persona_override, persona_mode, prompt_template_ids, knowledge_collection_ids, ' +
  'include_global_knowledge, allowed_tools, denied_tools, daily_budget_usd, max_tokens, max_calls_per_day, ' +
  'rate_limit_per_minute, max_turns, require_approval, updated_at';

export function emptyAgentSettings(agentKey: string): AgentSettings {
  return {
    agent_key: agentKey,
    display_name: null,
    status: 'active',
    primary_model_id: null,
    fallback_model_id: null,
    voice_id: null,
    voice_settings: {},
    persona_override: null,
    persona_mode: 'append',
    prompt_template_ids: [],
    knowledge_collection_ids: null,
    include_global_knowledge: null,
    allowed_tools: null,
    denied_tools: [],
    daily_budget_usd: null,
    max_tokens: null,
    max_calls_per_day: null,
    rate_limit_per_minute: null,
    max_turns: null,
    require_approval: null,
  };
}

function normalize(row: Record<string, unknown>): AgentSettings {
  const r = row as unknown as AgentSettings & { daily_budget_usd: number | string | null };
  return {
    ...r,
    daily_budget_usd: r.daily_budget_usd === null || r.daily_budget_usd === undefined ? null : Number(r.daily_budget_usd),
    voice_settings: r.voice_settings ?? {},
    prompt_template_ids: r.prompt_template_ids ?? [],
    denied_tools: r.denied_tools ?? [],
  };
}

export async function listAgentSettings(orgId: string): Promise<AgentSettings[]> {
  const { data, error } = await supabase
    .from('agent_settings')
    .select(COLUMNS)
    .eq('org_id', orgId)
    .order('agent_key');
  if (error) throw error;
  return ((data ?? []) as unknown as Record<string, unknown>[]).map(normalize);
}

export async function saveAgentSettings(orgId: string, userId: string | undefined, input: AgentSettingsInput): Promise<AgentSettings> {
  const { data, error } = await supabase
    .from('agent_settings')
    .upsert(
      { ...input, org_id: orgId, updated_by: userId ?? null },
      { onConflict: 'org_id,agent_key' },
    )
    .select(COLUMNS)
    .single();
  if (error) throw error;
  return normalize(data as unknown as Record<string, unknown>);
}

/** Drops the row so the agent goes back to inheriting everything. */
export async function resetAgentSettings(orgId: string, agentKey: string): Promise<void> {
  const { error } = await supabase.from('agent_settings').delete().eq('org_id', orgId).eq('agent_key', agentKey);
  if (error) throw error;
}

/** Exactly what the agent receives from agent-settings-get (admin preview). */
export async function previewEffectiveSettings(agentKey: string): Promise<Record<string, unknown>> {
  const response = await callEdgeFunction('agent-settings-get', { agent: agentKey });
  const result = await response.json();
  if (!response.ok || !result.success) throw new Error(result.error || 'Failed to load effective settings');
  return result.data;
}

export interface ModelSyncResult {
  results: { provider: string; fetched: number; inserted: number; updated: number; unavailable: number }[];
  errors: { provider: string; error: string }[];
}

/** Pulls each connected provider's live model list into llm_models (server-side). */
export async function syncModelsFromProviders(provider?: string): Promise<ModelSyncResult> {
  const response = await callEdgeFunction('fetch-provider-models', {
    action: 'sync-models',
    ...(provider ? { provider } : {}),
  });
  const result = await response.json();
  if (!response.ok || !result.success) {
    throw new Error(result.error || result.data?.errors?.[0]?.error || 'Failed to sync models');
  }
  return result.data;
}
