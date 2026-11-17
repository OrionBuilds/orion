import { supabase } from '../lib/supabase';
import { callEdgeFunction } from '../lib/edgeFunction';
import type {
  LLMProvider,
  LLMProviderFilters,
  CreateLLMProviderInput,
  UpdateLLMProviderInput,
} from '../types';

// api_key_encrypted is not readable or writable from the browser: keys are sealed and saved by the
// ai-settings-providers edge function, and only these columns come back.
const PROVIDER_COLUMNS = 'id, org_id, provider, base_url, enabled, created_at, updated_at';

export async function getProviders(
  orgId: string,
  filters?: LLMProviderFilters
): Promise<LLMProvider[]> {
  let query = supabase
    .from('llm_providers')
    .select(PROVIDER_COLUMNS)
    .eq('org_id', orgId)
    .order('provider');

  if (filters?.enabled !== undefined) {
    query = query.eq('enabled', filters.enabled);
  }

  const { data, error } = await query;

  if (error) throw error;
  return data || [];
}

export async function getProviderById(id: string): Promise<LLMProvider | null> {
  const { data, error } = await supabase
    .from('llm_providers')
    .select(PROVIDER_COLUMNS)
    .eq('id', id)
    .maybeSingle();

  if (error) throw error;
  return data;
}

export async function getProviderByType(
  orgId: string,
  provider: string
): Promise<LLMProvider | null> {
  const { data, error } = await supabase
    .from('llm_providers')
    .select(PROVIDER_COLUMNS)
    .eq('org_id', orgId)
    .eq('provider', provider)
    .maybeSingle();

  if (error) throw error;
  return data;
}

async function saveProvider(body: Record<string, unknown>): Promise<LLMProvider> {
  const response = await callEdgeFunction('ai-settings-providers', { action: 'save-provider', ...body });
  const result = await response.json();
  if (!response.ok || !result.success) throw new Error(result.error || 'Failed to save provider');
  return result.provider;
}

export async function createProvider(
  orgId: string,
  input: CreateLLMProviderInput
): Promise<LLMProvider> {
  return saveProvider({
    org_id: orgId,
    provider: input.provider,
    api_key: input.api_key,
    base_url: input.base_url || null,
    enabled: input.enabled ?? false,
  });
}

export async function updateProvider(
  id: string,
  input: UpdateLLMProviderInput
): Promise<LLMProvider> {
  return saveProvider({
    provider_id: id,
    ...(input.api_key !== undefined ? { api_key: input.api_key } : {}),
    ...(input.base_url !== undefined ? { base_url: input.base_url || null } : {}),
    ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
  });
}

export async function deleteProvider(id: string): Promise<void> {
  const { error } = await supabase
    .from('llm_providers')
    .delete()
    .eq('id', id);

  if (error) throw error;
}

export async function toggleProviderEnabled(
  id: string,
  enabled: boolean
): Promise<LLMProvider> {
  return updateProvider(id, { enabled });
}

export async function testProviderConnection(
  orgId: string,
  providerId: string
): Promise<{ success: boolean; error?: string }> {
  const response = await callEdgeFunction('ai-settings-providers', {
    action: 'test-connection',
    org_id: orgId,
    provider_id: providerId,
  });

  const result = await response.json();
  return result;
}
