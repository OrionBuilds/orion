import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { CheckCircle, AlertCircle, AlertTriangle, ExternalLink, RefreshCw, Power, Settings, Globe, User, Loader2 } from 'lucide-react';
import { useToast } from '../../../contexts/ToastContext';
import { getIntegrations, testIntegrationConnection, toggleIntegration } from '../../../services/integrations';
import type { Integration } from '../../../types';
import { IntegrationDetailPanel } from './IntegrationDetailPanel';
import { ACCOUNT_INTEGRATION_KEYS } from './accountIntegrations';
import { GoogleConnectionCard } from '../profile/GoogleConnectionCard';
import { MicrosoftConnectionCard } from '../profile/MicrosoftConnectionCard';
import { formatDateTimeShort } from '../../../utils/formatters';

interface ConnectedIntegrationsTabProps {
  onSuccess?: () => void;
}

export function ConnectedIntegrationsTab({ onSuccess }: ConnectedIntegrationsTabProps) {
  const navigate = useNavigate();
  const { showToast } = useToast();
  const [integrations, setIntegrations] = useState<Integration[]>([]);
  const [loading, setLoading] = useState(true);
  const [testingId, setTestingId] = useState<string | null>(null);
  const [togglingId, setTogglingId] = useState<string | null>(null);
  const [selectedIntegration, setSelectedIntegration] = useState<Integration | null>(null);

  useEffect(() => {
    loadIntegrations();
  }, []);

  const loadIntegrations = async () => {
    try {
      setLoading(true);
      const allData = await getIntegrations();

      // Google and Microsoft show as their account cards above the list instead.
      setIntegrations(
        allData.filter(
          (int) =>
            int.connection?.status === 'connected' &&
            int.key !== 'resend' &&
            !ACCOUNT_INTEGRATION_KEYS.includes(int.key),
        ),
      );
    } catch (error) {
      console.error('Failed to load integrations:', error);
      showToast('warning', 'Failed to load integrations', 'Please check your connection and try again.');
    } finally {
      setLoading(false);
    }
  };

  const handleTest = async (integration: Integration) => {
    try {
      setTestingId(integration.id);
      await testIntegrationConnection(integration.key);
      showToast('success', 'Connection test passed', `${integration.name} is working correctly.`);
      loadIntegrations();
    } catch (error) {
      console.error('Test failed:', error);
      showToast('warning', 'Connection test failed', `${integration.name} could not be reached. Please check the configuration.`);
    } finally {
      setTestingId(null);
    }
  };

  const handleToggle = async (integration: Integration) => {
    try {
      setTogglingId(integration.id);
      await toggleIntegration(integration.key, !integration.enabled);
      loadIntegrations();
      onSuccess?.();
    } catch (error) {
      console.error('Toggle failed:', error);
      showToast('warning', 'Failed to toggle integration', `Could not ${integration.enabled ? 'disable' : 'enable'} ${integration.name}.`);
    } finally {
      setTogglingId(null);
    }
  };

  const handleClick = (integration: Integration) => {
    if (integration.settings_path) {
      navigate(integration.settings_path);
    } else {
      setSelectedIntegration(integration);
    }
  };

  const handlePanelClose = () => {
    setSelectedIntegration(null);
    loadIntegrations();
    onSuccess?.();
  };

  const getHealthBadge = (integration: Integration) => {
    const health = integration.health?.status || (integration.connection?.status === 'connected' ? 'healthy' : 'unknown');

    switch (health) {
      case 'healthy':
        return (
          <span className="inline-flex items-center gap-1 rounded-full bg-hud-emerald/10 px-2 py-1 text-xs font-medium text-hud-emerald">
            <CheckCircle className="h-3 w-3" />
            Healthy
          </span>
        );
      case 'degraded':
        return (
          <span className="inline-flex items-center gap-1 rounded-full bg-hud-rust/10 px-2 py-1 text-xs font-medium text-hud-rust">
            <AlertTriangle className="h-3 w-3" />
            Degraded
          </span>
        );
      case 'down':
        return (
          <span className="inline-flex items-center gap-1 rounded-full bg-hud-plum/10 px-2 py-1 text-xs font-medium text-hud-plum">
            <AlertCircle className="h-3 w-3" />
            Down
          </span>
        );
      default:
        return (
          <span className="inline-flex items-center gap-1 rounded-full bg-hud-bg-elev px-2 py-1 text-xs font-medium text-hud-cream-dim">
            Unknown
          </span>
        );
    }
  };

  const getScopeBadge = (scope: string) => {
    if (scope === 'global') {
      return (
        <span className="inline-flex items-center gap-1 rounded bg-hud-gold/10 px-2 py-0.5 text-xs font-medium text-hud-gold-soft">
          <Globe className="h-3 w-3" />
          Global
        </span>
      );
    }
    return (
      <span className="inline-flex items-center gap-1 rounded bg-hud-bg-elev px-2 py-0.5 text-xs font-medium text-hud-cream-dim">
        <User className="h-3 w-3" />
        User
      </span>
    );
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="h-8 w-8 animate-spin text-hud-gold" />
      </div>
    );
  }

  const accounts = (
    <div className="space-y-4">
      <GoogleConnectionCard />
      <MicrosoftConnectionCard />
    </div>
  );

  if (integrations.length === 0) {
    return (
      <div className="space-y-4">
        {accounts}
        <div className="rounded-lg border border-hud-bg-elev bg-hud-bg-card p-12 text-center">
          <Settings className="mx-auto h-12 w-12 text-hud-cream-mute" />
          <h3 className="mt-4 text-lg font-medium text-white">No Other Connected Integrations</h3>
          <p className="mt-2 text-sm text-hud-cream-dim">
            Connect integrations from the All Integrations tab to see them here.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {accounts}
      <div className="overflow-hidden rounded-lg border border-hud-bg-elev bg-hud-bg-card">
        <div className="overflow-x-auto">
        <table className="min-w-full divide-y divide-hud-bg-elev">
          <thead className="bg-hud-bg-card/50">
            <tr>
              <th className="px-6 py-3 text-left text-xs font-medium uppercase tracking-wider text-hud-cream-dim">
                Integration
              </th>
              <th className="px-6 py-3 text-left text-xs font-medium uppercase tracking-wider text-hud-cream-dim">
                Scope
              </th>
              <th className="px-6 py-3 text-left text-xs font-medium uppercase tracking-wider text-hud-cream-dim">
                Connected By
              </th>
              <th className="px-6 py-3 text-left text-xs font-medium uppercase tracking-wider text-hud-cream-dim">
                Status
              </th>
              <th className="px-6 py-3 text-left text-xs font-medium uppercase tracking-wider text-hud-cream-dim">
                Last Sync
              </th>
              <th className="px-6 py-3 text-left text-xs font-medium uppercase tracking-wider text-hud-cream-dim">
                Health
              </th>
              <th className="px-6 py-3 text-right text-xs font-medium uppercase tracking-wider text-hud-cream-dim">
                Actions
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-hud-bg-elev/50 bg-hud-bg-mid">
            {integrations.map((integration) => (
              <tr key={integration.id} className="transition-colors hover:bg-hud-bg-card/50">
                <td className="whitespace-nowrap px-6 py-4">
                  <button
                    onClick={() => handleClick(integration)}
                    className="flex items-center gap-3 text-left hover:text-hud-gold-soft"
                  >
                    <div>
                      <div className="font-medium text-white">{integration.name}</div>
                      <div className="text-sm text-hud-cream-mute">{integration.category.replace('_', ' ')}</div>
                    </div>
                    {integration.settings_path && (
                      <ExternalLink className="h-4 w-4 text-hud-cream-mute" />
                    )}
                  </button>
                </td>
                <td className="whitespace-nowrap px-6 py-4">
                  {getScopeBadge(integration.scope)}
                </td>
                <td className="whitespace-nowrap px-6 py-4 text-sm text-hud-cream-dim">
                  {integration.connection?.connected_by_user?.name ||
                   integration.connection?.connected_by_user?.email ||
                   'System'}
                </td>
                <td className="whitespace-nowrap px-6 py-4">
                  {integration.connection?.status === 'connected' ? (
                    <span className="inline-flex items-center gap-1 rounded-full bg-hud-emerald/10 px-2 py-1 text-xs font-medium text-hud-emerald">
                      <CheckCircle className="h-3 w-3" />
                      Connected
                    </span>
                  ) : (
                    <span className="inline-flex items-center gap-1 rounded-full bg-hud-plum/10 px-2 py-1 text-xs font-medium text-hud-plum">
                      <AlertCircle className="h-3 w-3" />
                      Error
                    </span>
                  )}
                </td>
                <td className="whitespace-nowrap px-6 py-4 text-sm text-hud-cream-dim">
                  {formatDateTimeShort(integration.connection?.updated_at || integration.connection?.connected_at || null, { fallback: 'Unknown' })}
                </td>
                <td className="whitespace-nowrap px-6 py-4">
                  {getHealthBadge(integration)}
                </td>
                <td className="whitespace-nowrap px-6 py-4 text-right">
                  <div className="flex items-center justify-end gap-2">
                    <button
                      onClick={() => handleTest(integration)}
                      disabled={testingId === integration.id}
                      className="rounded p-1.5 text-hud-cream-dim transition-colors hover:bg-hud-bg-elev hover:text-white disabled:opacity-50"
                      title="Test Connection"
                    >
                      <RefreshCw
                        className={`h-4 w-4 ${testingId === integration.id ? 'animate-spin' : ''}`}
                      />
                    </button>
                    <button
                      onClick={() => handleToggle(integration)}
                      disabled={togglingId === integration.id}
                      className={`rounded p-1.5 transition-colors hover:bg-hud-bg-elev disabled:opacity-50 ${
                        integration.enabled ? 'text-hud-emerald' : 'text-hud-cream-mute'
                      }`}
                      title={integration.enabled ? 'Disable' : 'Enable'}
                    >
                      <Power className="h-4 w-4" />
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        </div>
      </div>

      {selectedIntegration && (
        <IntegrationDetailPanel
          integration={selectedIntegration}
          onClose={handlePanelClose}
          onSuccess={handlePanelClose}
        />
      )}
    </div>
  );
}
