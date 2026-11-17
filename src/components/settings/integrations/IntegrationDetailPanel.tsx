import { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { X, ExternalLink, CheckCircle, AlertCircle, XCircle, Loader2, Eye, EyeOff, AlertTriangle } from 'lucide-react';
import { useAuth } from '../../../contexts/AuthContext';
import {
  getIntegrationUsage,
  initiateOAuthConnection,
  connectWithApiKey,
  disconnectIntegration,
  toggleIntegration,
  testIntegrationConnection,
} from '../../../services/integrations';
import type { Integration, ModuleIntegrationRequirement, ApiKeyFieldConfig } from '../../../types';
import { Portal } from '../../shared/Portal';

/** Cards whose key is an LLM provider key stored in llm_providers (see integrations-connect). */
const LLM_KEY_INTEGRATIONS = new Set(['google_gemini']);

interface IntegrationDetailPanelProps {
  integration: Integration;
  onClose: () => void;
  onSuccess?: () => void;
}

export function IntegrationDetailPanel({ integration, onClose, onSuccess }: IntegrationDetailPanelProps) {
  const { hasPermission } = useAuth();
  const [usage, setUsage] = useState<ModuleIntegrationRequirement[]>([]);
  const [loading, setLoading] = useState(true);
  const [connecting, setConnecting] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);
  const [testing, setTesting] = useState(false);
  const [toggling, setToggling] = useState(false);
  const [showDisconnectWarning, setShowDisconnectWarning] = useState(false);
  const [credentials, setCredentials] = useState<Record<string, string>>({});
  const [showSecrets, setShowSecrets] = useState<Record<string, boolean>>({});
  const [error, setError] = useState<string | null>(null);

  const canManage = hasPermission('integrations.manage');
  const isConnected = integration.connection?.status === 'connected';

  useEffect(() => {
    loadUsage();
  }, [integration.key]);

  const loadUsage = async () => {
    try {
      setLoading(true);
      const data = await getIntegrationUsage(integration.key);
      setUsage(data);
    } catch (err) {
      console.error('Failed to load usage:', err);
    } finally {
      setLoading(false);
    }
  };

  const handleOAuthConnect = async () => {
    try {
      setConnecting(true);
      setError(null);
      const { authorization_url } = await initiateOAuthConnection(integration.key);
      window.location.href = authorization_url;
    } catch (err: any) {
      setError(err.message || 'Failed to initiate connection');
      setConnecting(false);
    }
  };

  const handleApiKeyConnect = async () => {
    try {
      setConnecting(true);
      setError(null);
      await connectWithApiKey({
        integration_key: integration.key,
        credentials,
      });
      onSuccess?.();
    } catch (err: any) {
      setError(err.message || 'Failed to connect');
    } finally {
      setConnecting(false);
    }
  };

  const handleDisconnect = async (force: boolean = false) => {
    try {
      setDisconnecting(true);
      setError(null);
      const result = await disconnectIntegration(integration.key, force);
      if (!result.success && result.affected_modules?.length) {
        setShowDisconnectWarning(true);
        setDisconnecting(false);
        return;
      }
      onSuccess?.();
    } catch (err: any) {
      setError(err.message || 'Failed to disconnect');
      setDisconnecting(false);
    }
  };

  const handleTest = async () => {
    try {
      setTesting(true);
      setError(null);
      await testIntegrationConnection(integration.key);
    } catch (err: any) {
      setError(err.message || 'Connection test failed');
    } finally {
      setTesting(false);
    }
  };

  const handleToggle = async () => {
    try {
      setToggling(true);
      setError(null);
      await toggleIntegration(integration.key, !integration.enabled);
      onSuccess?.();
    } catch (err: any) {
      setError(err.message || 'Failed to toggle');
    } finally {
      setToggling(false);
    }
  };

  const apiKeyFields = (integration.api_key_config?.fields || []).map((f) => {
    const field = f as ApiKeyFieldConfig;
    if (field.type === 'password' && field.secret === undefined) {
      field.secret = true;
    }
    return field;
  });

  return (
    <>
      {/* Backdrop and panel share one Portal so the panel stays above its backdrop. */}
      <Portal>
      <div className="fixed inset-0 z-40 bg-black/60" onClick={onClose} />
      <div className="fixed inset-y-0 right-0 z-50 w-full max-w-lg overflow-y-auto bg-hud-bg-mid shadow-xl">
        <div className="sticky top-0 z-10 flex items-center justify-between border-b border-hud-bg-elev bg-hud-bg-mid px-6 py-4">
          <h2 className="text-lg font-semibold text-white">{integration.name}</h2>
          <button
            onClick={onClose}
            className="rounded-lg p-2 text-hud-cream-dim hover:bg-hud-bg-card hover:text-white"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="space-y-6 p-6">
          {error && (
            <div className="rounded-lg border border-hud-plum/30 bg-hud-plum/10 p-4 text-sm text-hud-plum">
              {error}
            </div>
          )}

          <div>
            <h3 className="text-sm font-medium text-hud-cream-soft">Overview</h3>
            <p className="mt-2 text-sm text-hud-cream-dim">{integration.description}</p>
            <div className="mt-4 flex flex-wrap gap-2">
              <span className="rounded-full bg-hud-bg-card border border-hud-bg-elev px-3 py-1 text-xs font-medium text-hud-cream-soft capitalize">
                {integration.scope}
              </span>
              <span className="rounded-full bg-hud-bg-card border border-hud-bg-elev px-3 py-1 text-xs font-medium text-hud-cream-soft capitalize">
                {integration.connection_type.replace('_', ' ')}
              </span>
              <span className="rounded-full bg-hud-bg-card border border-hud-bg-elev px-3 py-1 text-xs font-medium text-hud-cream-soft">
                {integration.category.replace('_', ' ')}
              </span>
            </div>
            {integration.docs_url && (
              <a
                href={integration.docs_url}
                target="_blank"
                rel="noopener noreferrer"
                className="mt-4 inline-flex items-center gap-1 text-sm text-hud-gold-soft hover:text-hud-gold-soft"
              >
                View Documentation
                <ExternalLink className="h-3 w-3" />
              </a>
            )}
          </div>

          {LLM_KEY_INTEGRATIONS.has(integration.key) && (
            <div className="rounded-lg border border-hud-gold/20 bg-hud-gold/5 p-4 text-sm text-hud-cream-dim">
              This is the one place to enter the {integration.name} key. It is checked against the
              provider before saving and stored sealed on the server. Pick {integration.name} models for
              CLARA, FRIDAY and their subagents in{' '}
              <Link to="/settings/ai-agents?tab=agents" className="text-hud-gold-soft underline">Settings → AI Agents</Link>.
            </div>
          )}

          <div className="border-t border-hud-bg-elev pt-6">
            <h3 className="text-sm font-medium text-hud-cream-soft">Connection Status</h3>
            <div className="mt-3 flex items-center gap-3">
              {isConnected ? (
                <>
                  <span className="inline-flex items-center gap-1 rounded-full bg-hud-emerald/10 px-3 py-1 text-sm font-medium text-hud-emerald">
                    <CheckCircle className="h-4 w-4" />
                    Connected
                  </span>
                  {integration.connection?.account_info?.email && (
                    <span className="text-sm text-hud-cream-mute">
                      as {integration.connection.account_info.email}
                    </span>
                  )}
                </>
              ) : integration.connection?.status === 'error' ? (
                <span className="inline-flex items-center gap-1 rounded-full bg-hud-plum/10 px-3 py-1 text-sm font-medium text-hud-plum">
                  <AlertCircle className="h-4 w-4" />
                  Error: {integration.connection.error_message || 'Unknown error'}
                </span>
              ) : (
                <span className="inline-flex items-center gap-1 rounded-full bg-hud-bg-elev px-3 py-1 text-sm font-medium text-hud-cream-dim">
                  <XCircle className="h-4 w-4" />
                  Not Connected
                </span>
              )}
            </div>
            {integration.connection?.connected_at && (
              <p className="mt-2 text-xs text-hud-cream-mute">
                Connected on {new Date(integration.connection.connected_at).toLocaleDateString()}
              </p>
            )}
          </div>

          {loading ? (
            <div className="flex items-center justify-center py-4">
              <Loader2 className="h-5 w-5 animate-spin text-hud-gold" />
            </div>
          ) : usage.length > 0 && (
            <div className="border-t border-hud-bg-elev pt-6">
              <h3 className="text-sm font-medium text-hud-cream-soft">Used By Modules</h3>
              <ul className="mt-3 space-y-2">
                {usage.map((u) => (
                  <li key={u.id} className="flex items-start gap-2 text-sm">
                    <CheckCircle className="mt-0.5 h-4 w-4 text-hud-emerald" />
                    <div>
                      <span className="font-medium text-white capitalize">
                        {u.module_key.replace('_', ' ')}
                      </span>
                      {u.feature_description && (
                        <span className="text-hud-cream-dim"> - {u.feature_description}</span>
                      )}
                      {u.is_required && (
                        <span className="ml-2 rounded bg-hud-rust/10 px-1.5 py-0.5 text-xs font-medium text-hud-rust">
                          Required
                        </span>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {canManage && (
            <div className="border-t border-hud-bg-elev pt-6">
              <h3 className="text-sm font-medium text-hud-cream-soft">Connection</h3>
              <div className="mt-4 space-y-4">
                {!isConnected && integration.connection_type === 'oauth' && (
                  <button
                    onClick={handleOAuthConnect}
                    disabled={connecting}
                    className="flex w-full items-center justify-center gap-2 rounded-lg bg-gradient-to-r from-hud-gold to-hud-teal px-4 py-2.5 text-sm font-medium text-white shadow-lg shadow-hud-gold/25 hover:shadow-hud-gold/40 disabled:opacity-50"
                  >
                    {connecting ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <>Connect with {integration.name}</>
                    )}
                  </button>
                )}

                {!isConnected && integration.connection_type === 'api_key' && (
                  <div className="space-y-4">
                    {apiKeyFields.map((field) => (
                      <div key={field.name}>
                        <label className="block text-sm font-medium text-hud-cream-soft">
                          {field.label}
                          {field.required && <span className="text-hud-plum ml-1">*</span>}
                        </label>
                        {field.type === 'select' && field.options ? (
                          <select
                            value={credentials[field.name] || field.default || ''}
                            onChange={(e) =>
                              setCredentials({ ...credentials, [field.name]: e.target.value })
                            }
                            className="mt-1 block w-full rounded-lg border border-hud-bg-elev bg-hud-bg-card px-3 py-2 text-sm text-white focus:border-hud-gold focus:outline-none focus:ring-1 focus:ring-hud-gold"
                          >
                            {field.options.map((opt) => (
                              <option key={opt} value={opt}>
                                {opt.charAt(0).toUpperCase() + opt.slice(1)}
                              </option>
                            ))}
                          </select>
                        ) : (
                          <div className="relative mt-1">
                            <input
                              type={field.secret && !showSecrets[field.name] ? 'password' : 'text'}
                              value={credentials[field.name] || ''}
                              onChange={(e) =>
                                setCredentials({ ...credentials, [field.name]: e.target.value })
                              }
                              placeholder={field.placeholder || ''}
                              className="block w-full rounded-lg border border-hud-bg-elev bg-hud-bg-card px-3 py-2 pr-10 text-sm text-white placeholder-hud-cream-dim focus:border-hud-gold focus:outline-none focus:ring-1 focus:ring-hud-gold"
                            />
                            {field.secret && (
                              <button
                                type="button"
                                onClick={() =>
                                  setShowSecrets({ ...showSecrets, [field.name]: !showSecrets[field.name] })
                                }
                                className="absolute inset-y-0 right-0 flex items-center pr-3 text-hud-cream-dim hover:text-white"
                              >
                                {showSecrets[field.name] ? (
                                  <EyeOff className="h-4 w-4" />
                                ) : (
                                  <Eye className="h-4 w-4" />
                                )}
                              </button>
                            )}
                          </div>
                        )}
                      </div>
                    ))}
                    <button
                      onClick={handleApiKeyConnect}
                      disabled={connecting || apiKeyFields.some((f) => f.required && !credentials[f.name])}
                      className="flex w-full items-center justify-center gap-2 rounded-lg bg-gradient-to-r from-hud-gold to-hud-teal px-4 py-2.5 text-sm font-medium text-white shadow-lg shadow-hud-gold/25 hover:shadow-hud-gold/40 disabled:opacity-50"
                    >
                      {connecting ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Connect'}
                    </button>
                  </div>
                )}

                {isConnected && (
                  <div className="flex gap-3">
                    <button
                      onClick={handleTest}
                      disabled={testing}
                      className="flex flex-1 items-center justify-center gap-2 rounded-lg border border-hud-bg-elev bg-hud-bg-card px-4 py-2 text-sm font-medium text-white hover:bg-hud-bg-elev disabled:opacity-50"
                    >
                      {testing ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Test Connection'}
                    </button>
                    <button
                      onClick={() => handleDisconnect(false)}
                      disabled={disconnecting}
                      className="flex flex-1 items-center justify-center gap-2 rounded-lg border border-hud-plum/30 bg-hud-plum/10 px-4 py-2 text-sm font-medium text-hud-plum hover:bg-hud-plum/20 disabled:opacity-50"
                    >
                      {disconnecting ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Disconnect'}
                    </button>
                  </div>
                )}
              </div>
            </div>
          )}

          {canManage && isConnected && (
            <div className="border-t border-hud-bg-elev pt-6">
              <h3 className="text-sm font-medium text-hud-cream-soft">Settings</h3>
              <div className="mt-4 flex items-center justify-between">
                <div>
                  <p className="text-sm font-medium text-white">
                    {integration.enabled ? 'Enabled' : 'Disabled'}
                  </p>
                  <p className="text-xs text-hud-cream-mute">
                    {integration.enabled
                      ? 'This integration is active and can be used'
                      : 'This integration is disabled and will not function'}
                  </p>
                </div>
                <button
                  onClick={handleToggle}
                  disabled={toggling}
                  className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
                    integration.enabled ? 'bg-hud-gold' : 'bg-hud-bg-elev'
                  }`}
                >
                  <span
                    className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                      integration.enabled ? 'translate-x-6' : 'translate-x-1'
                    }`}
                  />
                </button>
              </div>
            </div>
          )}
        </div>
      </div>

      {showDisconnectWarning && (
        <Portal><div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/70">
          <div className="w-full max-w-md rounded-lg border border-hud-bg-elev bg-hud-bg-card p-6 shadow-xl">
            <div className="flex items-center gap-3 text-hud-rust">
              <AlertTriangle className="h-6 w-6" />
              <h3 className="text-lg font-semibold">Affected Modules</h3>
            </div>
            <p className="mt-3 text-sm text-hud-cream-dim">
              Disconnecting this integration will affect the following modules:
            </p>
            <ul className="mt-3 space-y-1">
              {usage.map((u) => (
                <li key={u.id} className="text-sm text-white capitalize">
                  - {u.module_key.replace('_', ' ')}
                </li>
              ))}
            </ul>
            <div className="mt-6 flex gap-3">
              <button
                onClick={() => setShowDisconnectWarning(false)}
                className="flex-1 rounded-lg border border-hud-bg-elev bg-hud-bg-mid px-4 py-2 text-sm font-medium text-white hover:bg-hud-bg-card"
              >
                Cancel
              </button>
              <button
                onClick={() => {
                  setShowDisconnectWarning(false);
                  handleDisconnect(true);
                }}
                className="flex-1 rounded-lg bg-hud-plum px-4 py-2 text-sm font-medium text-white hover:bg-hud-plum"
              >
                Disconnect Anyway
              </button>
            </div>
          </div>
        </div></Portal>
      )}
      </Portal>
    </>
  );
}
