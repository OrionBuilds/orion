import { useState, useEffect, useCallback, useRef } from 'react';
import { Link } from 'react-router-dom';
import { Check, AlertCircle, Loader2, Star, Trash2, Clock, RefreshCw, ExternalLink } from 'lucide-react';
import { useAuth } from '../../../contexts/AuthContext';
import * as providersService from '../../../services/llmProviders';
import * as modelsService from '../../../services/llmModels';
import { syncModelsFromProviders } from '../../../services/agentSettings';
import type { LLMProvider, LLMModel, LLMProviderType } from '../../../types';
import { LLM_PROVIDER_LABELS } from '../../../types';
import { Portal } from '../../shared/Portal';

/** Deep link to the one place the Gemini key is entered (Settings → Integrations → Google Gemini). */
export const GEMINI_INTEGRATION_LINK = '/settings/integrations?tab=all&open=google_gemini';

const LEGACY_MODEL_KEYS = new Set([
  'gpt-4o', 'gpt-4o-mini', 'gpt-4-turbo', 'gpt-4', 'gpt-3.5-turbo',
  'gpt-4.1', 'gpt-4.1-mini', 'gpt-4.1-nano', 'o3', 'o3-pro', 'o4-mini',
  'o1', 'o1-mini', 'o1-preview',
  'gemini-1.5-pro', 'gemini-1.5-flash', 'gemini-1.0-pro',
]);

interface ProviderConfig {
  id: LLMProviderType;
  name: string;
  description: string;
  docsUrl: string;
  /** Key is entered on the Integrations card instead of here. */
  managedIn?: { label: string; to: string };
  /** Only shown once a key exists (OpenAI was retired as the default provider). */
  onlyWhenConnected?: boolean;
}

const PROVIDER_CONFIGS: ProviderConfig[] = [
  {
    id: 'anthropic',
    name: 'Anthropic',
    description: 'Claude Opus 5.5, Sonnet 5.5, Haiku 5.5 and Fable 5.1',
    docsUrl: 'https://console.anthropic.com/settings/keys',
  },
  {
    id: 'google',
    name: 'Google Gemini',
    description: 'Gemini Pro and Flash models via a Google AI Studio key',
    docsUrl: 'https://aistudio.google.com/app/apikey',
    managedIn: { label: 'Settings → Integrations', to: GEMINI_INTEGRATION_LINK },
  },
  {
    id: 'openai',
    name: 'OpenAI',
    description: 'GPT models',
    docsUrl: 'https://platform.openai.com/api-keys',
    onlyWhenConnected: true,
  },
];

function isLegacy(model: LLMModel): boolean {
  return LEGACY_MODEL_KEYS.has(model.model_key) || model.metadata?.deprecated === true ||
    /^claude-(3|instant|2)/.test(model.model_key);
}

function formatContext(tokens: number | null): string {
  if (!tokens) return '-';
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(tokens % 1_000_000 ? 1 : 0)}M`;
  return `${Math.round(tokens / 1000)}k`;
}

export function ModelsSettingsTab() {
  const { user, hasPermission } = useAuth();
  const orgId = user?.organization_id;
  const canManage = hasPermission('ai_agents.manage');

  const [providers, setProviders] = useState<LLMProvider[]>([]);
  const [models, setModels] = useState<LLMModel[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [editingProvider, setEditingProvider] = useState<LLMProviderType | null>(null);
  const [apiKey, setApiKey] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [testingProvider, setTestingProvider] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<{ success: boolean; error?: string } | null>(null);
  const [savingProvider, setSavingProvider] = useState(false);
  const [syncing, setSyncing] = useState(false);

  const [filterProvider, setFilterProvider] = useState<string>('all');
  const [showInactive, setShowInactive] = useState(false);
  const autoSynced = useRef(false);

  const loadData = useCallback(async () => {
    if (!orgId) return;
    try {
      setLoading(true);
      const [providersData, modelsData] = await Promise.all([
        providersService.getProviders(orgId),
        modelsService.getModels(orgId),
      ]);
      setProviders(providersData);
      setModels(modelsData);
      return { providersData, modelsData };
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load data');
    } finally {
      setLoading(false);
    }
  }, [orgId]);

  const runSync = useCallback(async (provider?: string, quiet = false) => {
    try {
      setSyncing(true);
      const result = await syncModelsFromProviders(provider);
      const fetched = result.results.reduce((n, r) => n + r.fetched, 0);
      const added = result.results.reduce((n, r) => n + r.inserted, 0);
      if (!quiet || added > 0) {
        setNotice(`Synced ${fetched} models from ${result.results.map((r) => LLM_PROVIDER_LABELS[r.provider as LLMProviderType] ?? r.provider).join(', ') || 'no providers'}${added ? ` (${added} new)` : ''}.`);
      }
      if (result.errors.length) {
        setError(result.errors.map((e) => `${LLM_PROVIDER_LABELS[e.provider as LLMProviderType] ?? e.provider}: ${e.error}`).join(' · '));
      }
      await loadData();
    } catch (err) {
      if (!quiet) setError(err instanceof Error ? err.message : 'Failed to sync models');
    } finally {
      setSyncing(false);
    }
  }, [loadData]);

  useEffect(() => {
    if (!orgId) return;
    loadData().then((loaded) => {
      // First visit after connecting a provider: if an enabled provider has no models yet, pull its
      // list from the vendor once (server-side) instead of showing an empty table.
      if (!loaded || autoSynced.current || !canManage) return;
      const enabled = loaded.providersData.filter((p) => p.enabled && p.provider !== 'custom' && p.provider in LLM_PROVIDER_LABELS);
      const missing = enabled.filter((p) => !loaded.modelsData.some((m) => m.provider_id === p.id));
      if (missing.length) {
        autoSynced.current = true;
        runSync(undefined, true);
      }
    });
  }, [orgId, canManage, loadData, runSync]);

  const providerOf = (type: LLMProviderType) => providers.find((p) => p.provider === type);

  const handleConfigureProvider = (providerType: LLMProviderType) => {
    setEditingProvider(providerType);
    setApiKey('');
    setBaseUrl(providerOf(providerType)?.base_url || '');
    setTestResult(null);
  };

  const handleTestConnection = async () => {
    if (!orgId || !editingProvider) return;
    const existing = providerOf(editingProvider);
    try {
      setTestingProvider(editingProvider);
      setTestResult(null);
      if (existing) {
        if (apiKey) await providersService.updateProvider(existing.id, { api_key: apiKey, base_url: baseUrl });
        setTestResult(await providersService.testProviderConnection(orgId, existing.id));
      } else {
        if (!apiKey) {
          setTestResult({ success: false, error: 'API key is required' });
          return;
        }
        const created = await providersService.createProvider(orgId, {
          provider: editingProvider,
          api_key: apiKey,
          base_url: baseUrl || undefined,
          enabled: false,
        });
        setTestResult(await providersService.testProviderConnection(orgId, created.id));
        await loadData();
      }
    } catch (err) {
      setTestResult({ success: false, error: err instanceof Error ? err.message : 'Test failed' });
    } finally {
      setTestingProvider(null);
    }
  };

  const handleSaveProvider = async () => {
    if (!orgId || !editingProvider) return;
    const existing = providerOf(editingProvider);
    try {
      setSavingProvider(true);
      if (existing) {
        const updates: { api_key?: string; base_url?: string; enabled?: boolean } = { enabled: true };
        if (apiKey) updates.api_key = apiKey;
        if (baseUrl !== existing.base_url) updates.base_url = baseUrl;
        await providersService.updateProvider(existing.id, updates);
      } else {
        if (!apiKey) {
          setError('API key is required');
          return;
        }
        await providersService.createProvider(orgId, {
          provider: editingProvider,
          api_key: apiKey,
          base_url: baseUrl || undefined,
          enabled: true,
        });
      }
      // ai-settings-providers syncs the provider's model list server-side on save.
      await loadData();
      setEditingProvider(null);
      setApiKey('');
      setBaseUrl('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save provider');
    } finally {
      setSavingProvider(false);
    }
  };

  const handleToggleProviderEnabled = async (providerId: string, enabled: boolean) => {
    try {
      await providersService.toggleProviderEnabled(providerId, enabled);
      await loadData();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update provider');
    }
  };

  const handleToggleModelEnabled = async (modelId: string, enabled: boolean) => {
    try {
      await modelsService.toggleModelEnabled(modelId, enabled);
      await loadData();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update model');
    }
  };

  const handleSetDefaultModel = async (modelId: string) => {
    if (!orgId) return;
    try {
      await modelsService.setDefaultModel(orgId, modelId);
      await loadData();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to set default model');
    }
  };

  const handleDeleteModel = async (modelId: string) => {
    if (!confirm('Remove this model from the list? Agents using it fall back to their next choice.')) return;
    try {
      await modelsService.deleteModel(modelId);
      await loadData();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete model');
    }
  };

  const connectedProviderIds = new Set(providers.filter((p) => p.enabled).map((p) => p.id));
  const filteredModels = models
    .filter((m) => showInactive || connectedProviderIds.has(m.provider_id))
    .filter((m) => filterProvider === 'all' || m.provider?.provider === filterProvider)
    .sort((a, b) => Number(b.enabled) - Number(a.enabled) || a.display_name.localeCompare(b.display_name));
  const hiddenCount = models.filter((m) => !connectedProviderIds.has(m.provider_id)).length;

  if (loading && providers.length === 0) {
    return (
      <div className="flex items-center justify-center py-12">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-hud-gold" />
      </div>
    );
  }

  return (
    <div className="space-y-8">
      {error && (
        <div className="bg-hud-plum/10 border border-hud-plum/20 rounded-lg p-4 text-hud-plum">
          {error}
          <button onClick={() => setError(null)} className="ml-2 underline">Dismiss</button>
        </div>
      )}
      {notice && (
        <div className="bg-hud-emerald/10 border border-hud-emerald/20 rounded-lg p-4 text-hud-emerald flex items-center gap-2">
          <Check className="w-4 h-4" /> {notice}
          <button onClick={() => setNotice(null)} className="ml-auto underline text-sm">Dismiss</button>
        </div>
      )}

      <section>
        <h2 className="text-lg font-medium text-white mb-2">LLM Providers</h2>
        <p className="text-sm text-hud-cream-dim mb-4">
          Provider keys that power FRIDAY, CLARA and their subagents. Keys are validated against the
          vendor and stored sealed server-side. Each provider's key is entered in exactly one place.
        </p>

        <div className="grid gap-4 md:grid-cols-3">
          {PROVIDER_CONFIGS.map((config) => {
            const status = providerOf(config.id);
            if (config.onlyWhenConnected && !status) return null;
            const modelCount = models.filter((m) => m.provider_id === status?.id && m.enabled).length;

            return (
              <div key={config.id} className="bg-hud-bg-card border border-hud-bg-elev rounded-lg p-4 flex flex-col">
                <div className="flex items-start justify-between mb-3 gap-2">
                  <div>
                    <h3 className="font-medium text-white">{config.name}</h3>
                    <p className="text-xs text-hud-cream-dim mt-1">{config.description}</p>
                  </div>
                  <span
                    className={`inline-flex items-center px-2 py-1 rounded-full text-xs whitespace-nowrap ${
                      status?.enabled
                        ? 'bg-hud-emerald/10 text-hud-emerald'
                        : status
                          ? 'bg-hud-cream-mute/10 text-hud-cream-dim'
                          : 'bg-hud-bg-elev text-hud-cream-mute'
                    }`}
                  >
                    {status?.enabled ? 'Connected' : status ? 'Disabled' : 'Not connected'}
                  </span>
                </div>
                {status?.enabled && (
                  <p className="text-xs text-hud-cream-mute mb-3">{modelCount} model{modelCount === 1 ? '' : 's'} enabled</p>
                )}

                <div className="flex items-center gap-2 mt-auto">
                  {config.managedIn ? (
                    <Link
                      to={config.managedIn.to}
                      className="flex-1 inline-flex items-center justify-center gap-1.5 px-3 py-2 bg-hud-bg-elev text-white rounded hover:bg-hud-cream-mute transition-colors text-sm"
                      title={`The ${config.name} key is managed in ${config.managedIn.label}`}
                    >
                      {status ? 'Manage key' : 'Connect'} in Integrations
                      <ExternalLink className="w-3.5 h-3.5" />
                    </Link>
                  ) : (
                    <button
                      onClick={() => handleConfigureProvider(config.id)}
                      disabled={!canManage}
                      className="flex-1 px-3 py-2 bg-hud-bg-elev text-white rounded hover:bg-hud-cream-mute transition-colors text-sm disabled:opacity-50"
                    >
                      {status ? 'Configure' : 'Connect'}
                    </button>
                  )}
                  {status && canManage && !config.managedIn && (
                    <button
                      onClick={() => handleToggleProviderEnabled(status.id, !status.enabled)}
                      className={`px-3 py-2 rounded text-sm ${
                        status.enabled
                          ? 'bg-hud-bg-elev text-hud-cream-soft hover:bg-hud-cream-mute'
                          : 'bg-hud-gold-deep text-white hover:bg-hud-gold-deep'
                      }`}
                    >
                      {status.enabled ? 'Disable' : 'Enable'}
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </section>

      {editingProvider && (
        <Portal><div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 px-4">
          <div className="bg-hud-bg-mid border border-hud-bg-elev rounded-lg w-full max-w-md p-6">
            <h3 className="text-lg font-medium text-white mb-4">
              Configure {LLM_PROVIDER_LABELS[editingProvider]}
            </h3>

            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-hud-cream-soft mb-1">API Key</label>
                <input
                  type="password"
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                  placeholder={providerOf(editingProvider) ? '••••••••••••••••' : 'Enter API key'}
                  className="w-full px-3 py-2 bg-hud-bg-card border border-hud-bg-elev rounded-lg text-white focus:outline-none focus:ring-2 focus:ring-hud-gold"
                />
                <a
                  href={PROVIDER_CONFIGS.find((c) => c.id === editingProvider)?.docsUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-xs text-hud-gold-soft hover:underline mt-1 inline-block"
                >
                  Get API key
                </a>
              </div>

              <div>
                <label className="block text-sm font-medium text-hud-cream-soft mb-1">Base URL (Optional)</label>
                <input
                  type="text"
                  value={baseUrl}
                  onChange={(e) => setBaseUrl(e.target.value)}
                  placeholder="For proxies or custom endpoints"
                  className="w-full px-3 py-2 bg-hud-bg-card border border-hud-bg-elev rounded-lg text-white focus:outline-none focus:ring-2 focus:ring-hud-gold"
                />
              </div>

              {testResult && (
                <div className={`flex items-center gap-2 p-3 rounded-lg ${testResult.success ? 'bg-hud-emerald/10 text-hud-emerald' : 'bg-hud-plum/10 text-hud-plum'}`}>
                  {testResult.success ? <Check className="w-5 h-5" /> : <AlertCircle className="w-5 h-5" />}
                  <span>{testResult.success ? 'Connection successful!' : testResult.error}</span>
                </div>
              )}

              <div className="flex justify-end gap-3 pt-4">
                <button
                  onClick={() => {
                    setEditingProvider(null);
                    setApiKey('');
                    setBaseUrl('');
                    setTestResult(null);
                  }}
                  className="px-4 py-2 text-hud-cream-soft hover:text-white"
                >
                  Cancel
                </button>
                <button
                  onClick={handleTestConnection}
                  disabled={testingProvider !== null}
                  className="px-4 py-2 bg-hud-bg-elev text-white rounded-lg hover:bg-hud-cream-mute disabled:opacity-50"
                >
                  {testingProvider ? <Loader2 className="w-4 h-4 animate-spin" /> : 'Test Connection'}
                </button>
                <button
                  onClick={handleSaveProvider}
                  disabled={savingProvider}
                  className="px-4 py-2 bg-hud-gold-deep text-white rounded-lg hover:bg-hud-gold-deep disabled:opacity-50"
                >
                  {savingProvider ? 'Saving...' : 'Save & Enable'}
                </button>
              </div>
            </div>
          </div>
        </div></Portal>
      )}

      <section>
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between mb-4">
          <div>
            <h2 className="text-lg font-medium text-white">Available Models</h2>
            <p className="text-sm text-hud-cream-dim">
              Pulled live from connected providers. Enabled models can be picked per agent; the starred model is the org default.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <select
              value={filterProvider}
              onChange={(e) => setFilterProvider(e.target.value)}
              className="px-3 py-2 bg-hud-bg-card border border-hud-bg-elev rounded-lg text-white text-sm"
            >
              <option value="all">All Providers</option>
              {providers.filter((p) => p.enabled && p.provider in LLM_PROVIDER_LABELS).map((p) => (
                <option key={p.id} value={p.provider}>
                  {LLM_PROVIDER_LABELS[p.provider as LLMProviderType]}
                </option>
              ))}
            </select>
            {canManage && (
              <button
                onClick={() => runSync()}
                disabled={syncing}
                className="inline-flex items-center gap-1.5 px-3 py-2 bg-hud-bg-elev text-white rounded-lg hover:bg-hud-cream-mute text-sm disabled:opacity-50"
              >
                <RefreshCw className={`w-4 h-4 ${syncing ? 'animate-spin' : ''}`} />
                Sync from providers
              </button>
            )}
          </div>
        </div>

        {filteredModels.length === 0 ? (
          <div className="text-center py-8 bg-hud-bg-card/50 rounded-lg border border-hud-bg-elev">
            <p className="text-hud-cream-dim">
              {syncing
                ? 'Loading models from your providers…'
                : connectedProviderIds.size === 0
                  ? 'No provider connected. Connect Anthropic or Google Gemini above.'
                  : 'No models yet. Use "Sync from providers" to load them.'}
            </p>
          </div>
        ) : (
          <div className="bg-hud-bg-card rounded-lg border border-hud-bg-elev overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr className="border-b border-hud-bg-elev">
                    <th className="text-left px-4 py-3 text-sm font-medium text-hud-cream-dim">Model</th>
                    <th className="text-left px-4 py-3 text-sm font-medium text-hud-cream-dim">Provider</th>
                    <th className="text-left px-4 py-3 text-sm font-medium text-hud-cream-dim">Context</th>
                    <th className="text-left px-4 py-3 text-sm font-medium text-hud-cream-dim">Status</th>
                    <th className="w-24"></th>
                  </tr>
                </thead>
                <tbody>
                  {filteredModels.map((model) => (
                    <tr key={model.id} className="border-b border-hud-bg-elev/50 last:border-0 hover:bg-hud-bg-elev/30">
                      <td className="px-4 py-3">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="font-medium text-white">{model.display_name}</span>
                          {model.is_default && <Star className="w-4 h-4 text-yellow-400 fill-yellow-400" aria-label="Org default" />}
                          {isLegacy(model) && (
                            <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium bg-hud-rust/10 text-hud-rust border border-hud-rust/20">
                              <Clock className="w-3 h-3" /> Legacy
                            </span>
                          )}
                          {model.metadata?.available === false && (
                            <span className="px-1.5 py-0.5 rounded text-[10px] font-medium bg-hud-plum/10 text-hud-plum border border-hud-plum/20">
                              No longer offered
                            </span>
                          )}
                        </div>
                        <span className="text-xs text-hud-cream-mute">{model.model_key}</span>
                      </td>
                      <td className="px-4 py-3 text-sm text-hud-cream-soft">
                        {model.provider ? LLM_PROVIDER_LABELS[model.provider.provider as LLMProviderType] ?? model.provider.provider : '-'}
                        {model.provider && !model.provider.enabled && <span className="text-xs text-hud-cream-mute"> (disabled)</span>}
                      </td>
                      <td className="px-4 py-3 text-sm text-hud-cream-soft">{formatContext(model.context_window)}</td>
                      <td className="px-4 py-3">
                        <select
                          value={model.enabled ? 'enabled' : 'disabled'}
                          onChange={(e) => handleToggleModelEnabled(model.id, e.target.value === 'enabled')}
                          disabled={!canManage}
                          aria-label={`${model.display_name} status`}
                          className={`px-2 py-1 rounded text-xs font-medium border-0 cursor-pointer focus:outline-none focus:ring-2 focus:ring-hud-gold disabled:cursor-default ${
                            model.enabled ? 'bg-hud-emerald/10 text-hud-emerald' : 'bg-hud-cream-mute/10 text-hud-cream-dim'
                          }`}
                        >
                          <option value="enabled">Enabled</option>
                          <option value="disabled">Disabled</option>
                        </select>
                      </td>
                      <td className="px-4 py-3">
                        {canManage && (
                          <div className="flex items-center gap-2">
                            {model.enabled && !model.is_default && (
                              <button onClick={() => handleSetDefaultModel(model.id)} title="Set as org default" className="p-1 text-hud-cream-dim hover:text-yellow-400">
                                <Star className="w-4 h-4" />
                              </button>
                            )}
                            <button onClick={() => handleDeleteModel(model.id)} title="Remove model" className="p-1 text-hud-cream-dim hover:text-hud-plum">
                              <Trash2 className="w-4 h-4" />
                            </button>
                          </div>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
        {hiddenCount > 0 && (
          <button onClick={() => setShowInactive((v) => !v)} className="mt-2 text-xs text-hud-cream-mute hover:text-white underline">
            {showInactive ? 'Hide' : 'Show'} {hiddenCount} model{hiddenCount === 1 ? '' : 's'} from disabled providers
          </button>
        )}
      </section>
    </div>
  );
}
