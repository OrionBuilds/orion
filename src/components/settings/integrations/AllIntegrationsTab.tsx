import { useState, useEffect } from 'react';
import { Search, Filter, ExternalLink, CheckCircle, XCircle, AlertCircle, Settings, Loader2 } from 'lucide-react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useToast } from '../../../contexts/ToastContext';
import { getIntegrations } from '../../../services/integrations';
import { getTwilioStatus } from '../../../services/twilioConnection';
import { GoogleConnectionCard } from '../profile/GoogleConnectionCard';
import { MicrosoftConnectionCard } from '../profile/MicrosoftConnectionCard';
import { ACCOUNT_INTEGRATION_KEYS, ACCOUNT_SEARCH_TERMS } from './accountIntegrations';
import { useAuth } from '../../../contexts/AuthContext';
import type { Integration, IntegrationCategory } from '../../../types';
import { INTEGRATION_CATEGORY_LABELS } from '../../../types';
import { IntegrationDetailPanel } from './IntegrationDetailPanel';
import { LLMIntegrationCard } from './LLMIntegrationCard';

interface AllIntegrationsTabProps {
  onSuccess?: () => void;
}

const categoryOptions: { value: IntegrationCategory | ''; label: string }[] = [
  { value: '', label: 'All Categories' },
  { value: 'Channels', label: 'Communication Channels' },
  { value: 'Advertising', label: 'Advertising' },
  { value: 'AI_LLM', label: 'AI & LLM' },
  { value: 'Calendars', label: 'Calendars' },
  { value: 'CRM_Data', label: 'CRM & Data' },
  { value: 'Email', label: 'Email' },
  { value: 'Payments', label: 'Payments' },
  { value: 'Phone', label: 'Phone' },
  { value: 'Storage', label: 'Storage' },
  { value: 'Other', label: 'Other' },
];

function getIntegrationIcon(key: string): string {
  const icons: Record<string, string> = {
    gmail: 'https://www.gstatic.com/images/branding/product/2x/gmail_2020q4_48dp.png',
    google_workspace: 'https://www.gstatic.com/images/branding/product/2x/drive_2020q4_48dp.png',
    google_calendar: 'https://www.gstatic.com/images/branding/product/2x/calendar_2020q4_48dp.png',
    resend: 'https://resend.com/favicon.ico',
    twilio: 'https://www.twilio.com/assets/icons/twilio-icon-512.png',
    quickbooks_online: 'https://quickbooks.intuit.com/oidam/intuit/ic/en_us/images/qb-logo-63x63.png',
    openai: 'https://upload.wikimedia.org/wikipedia/commons/thumb/4/4d/OpenAI_Logo.svg/512px-OpenAI_Logo.svg.png',
    anthropic: 'https://www.anthropic.com/images/icons/apple-touch-icon.png',
    elevenlabs: 'https://elevenlabs.io/favicon.ico',
    google_gemini: 'https://www.gstatic.com/lamda/images/gemini_sparkle_v002_d4735304ff6292a690345.svg',
    meta_ads: 'https://www.facebook.com/images/fb_icon_325x325.png',
    google_ads: 'https://www.gstatic.com/adsense/publishers/ui/images/apub/ae/ae-home-advert-icon-x2.png',
  };
  return icons[key] || '';
}

export function AllIntegrationsTab({ onSuccess }: AllIntegrationsTabProps) {
  const navigate = useNavigate();
  const { showToast } = useToast();
  const { user } = useAuth();
  const [integrations, setIntegrations] = useState<Integration[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [category, setCategory] = useState<IntegrationCategory | ''>('');
  const [selectedIntegration, setSelectedIntegration] = useState<Integration | null>(null);
  // Categories that have at least one visible card, learned from the unfiltered load, so the
  // filter never offers an empty category (e.g. after Advertising/CRM integrations were removed).
  const [availableCategories, setAvailableCategories] = useState<Set<string> | null>(null);

  useEffect(() => {
    loadIntegrations();
  }, [category, user?.organization_id]);

  // ?open=<integration key> opens that card's panel (e.g. Settings → AI Agents → "Connect in
  // Integrations" for Google Gemini, whose key is entered only here).
  const [searchParams, setSearchParams] = useSearchParams();
  const openParam = searchParams.get('open');
  useEffect(() => {
    if (!openParam || loading) return;
    const target = integrations.find((int) => int.key === openParam);
    if (target) setSelectedIntegration(target);
    const next = new URLSearchParams(searchParams);
    next.delete('open');
    setSearchParams(next, { replace: true });
  }, [openParam, loading, integrations, searchParams, setSearchParams]);

  const loadIntegrations = async () => {
    try {
      setLoading(true);
      const [data, twilioStatus] = await Promise.all([
        getIntegrations({ category: category || undefined }),
        // Twilio stores its connection in its own `twilio_connection` table, not
        // `integration_connections`, so this card showed "Not Connected" even with live
        // numbers routing traffic. Bridge its status onto the card.
        user?.organization_id
          ? getTwilioStatus(user.organization_id).catch(() => null)
          : Promise.resolve(null),
      ]);

      const merged = data.map((int) => {
        if (int.key === 'twilio' && twilioStatus?.connection?.status === 'connected') {
          return {
            ...int,
            connection: {
              ...(int.connection || {}),
              id: int.connection?.id || 'twilio-bridge',
              status: 'connected' as const,
              account_info: { name: twilioStatus.connection.friendly_name || 'Twilio' },
              connected_at: twilioStatus.connection.connected_at || new Date().toISOString(),
            } as unknown as Integration['connection'],
          };
        }

        return int;
      });

      setIntegrations(merged);
      if (!category) {
        setAvailableCategories(new Set(
          merged.filter((int) => int.key !== 'mailgun' && !ACCOUNT_INTEGRATION_KEYS.includes(int.key)).map((int) => int.category),
        ));
      }
    } catch (error) {
      console.error('Failed to load integrations:', error);
      showToast('warning', 'Failed to load integrations', 'Please check your connection and try again.');
    } finally {
      setLoading(false);
    }
  };

  const filteredIntegrations = integrations.filter((int) => {
    // Hide legacy Mailgun row if any historical rows remain — migration drops
    // them, but be defensive.
    if (int.key === 'mailgun') return false;
    if (ACCOUNT_INTEGRATION_KEYS.includes(int.key)) return false;
    if (search) {
      const searchLower = search.toLowerCase();
      return (
        int.name.toLowerCase().includes(searchLower) ||
        int.description?.toLowerCase().includes(searchLower)
      );
    }
    return true;
  });

  const groupedIntegrations = filteredIntegrations.reduce((acc, int) => {
    if (!acc[int.category]) {
      acc[int.category] = [];
    }
    acc[int.category].push(int);
    return acc;
  }, {} as Record<string, Integration[]>);

  const searchLower = search.trim().toLowerCase();
  const showAccounts = !category && (!searchLower || ACCOUNT_SEARCH_TERMS.some((t) => t.includes(searchLower) || searchLower.includes(t)));

  const handleIntegrationClick = (integration: Integration) => {
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

  const getStatusBadge = (integration: Integration) => {
    const status = integration.connection?.status;
    if (status === 'connected') {
      return (
        <span className="inline-flex items-center gap-1 rounded-full bg-hud-emerald/10 px-2 py-1 text-xs font-medium text-hud-emerald">
          <CheckCircle className="h-3 w-3" />
          Connected
        </span>
      );
    }
    if (status === 'error') {
      return (
        <span className="inline-flex items-center gap-1 rounded-full bg-hud-plum/10 px-2 py-1 text-xs font-medium text-hud-plum">
          <AlertCircle className="h-3 w-3" />
          Error
        </span>
      );
    }
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-hud-bg-elev px-2 py-1 text-xs font-medium text-hud-cream-dim">
        <XCircle className="h-3 w-3" />
        Not Connected
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

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="relative flex-1 max-w-md">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-hud-cream-mute" />
          <input
            type="text"
            placeholder="Search integrations..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full rounded-lg border border-hud-bg-elev bg-hud-bg-card py-2 pl-10 pr-4 text-sm text-white placeholder-hud-cream-dim focus:border-hud-gold focus:outline-none focus:ring-1 focus:ring-hud-gold"
          />
        </div>
        <div className="flex items-center gap-2">
          <Filter className="h-4 w-4 text-hud-cream-mute" />
          <select
            value={category}
            onChange={(e) => setCategory(e.target.value as IntegrationCategory | '')}
            className="rounded-lg border border-hud-bg-elev bg-hud-bg-card py-2 pl-3 pr-8 text-sm text-white focus:border-hud-gold focus:outline-none focus:ring-1 focus:ring-hud-gold"
          >
            {categoryOptions
              .filter((opt) => !opt.value || !availableCategories || availableCategories.has(opt.value) || opt.value === category)
              .map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
        </div>
      </div>

      {showAccounts && (
        <div>
          <h3 className="mb-4 text-sm font-semibold uppercase tracking-wider text-hud-cream-mute">Accounts</h3>
          <div className="space-y-4">
            <GoogleConnectionCard />
            <MicrosoftConnectionCard />
          </div>
        </div>
      )}

      {Object.keys(groupedIntegrations).length === 0 && !showAccounts ? (
        <div className="rounded-lg border border-hud-bg-elev bg-hud-bg-card p-12 text-center">
          <Settings className="mx-auto h-12 w-12 text-hud-cream-mute" />
          <p className="mt-4 text-hud-cream-dim">No integrations found</p>
        </div>
      ) : (
        <div className="space-y-8">
          {Object.entries(groupedIntegrations).map(([cat, ints]) => (
            <div key={cat}>
              <h3 className="mb-4 text-sm font-semibold uppercase tracking-wider text-hud-cream-mute">
                {INTEGRATION_CATEGORY_LABELS[cat as IntegrationCategory] || cat}
              </h3>
              <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                {ints.map((integration) => {
                  const isLLMIntegration = integration.category === 'AI_LLM' &&
                    ['anthropic', 'google', 'google_ai'].includes(integration.key);

                  if (isLLMIntegration) {
                    return (
                      <LLMIntegrationCard
                        key={integration.id}
                        integration={integration}
                        onOpenPanel={() => setSelectedIntegration(integration)}
                      />
                    );
                  }

                  return (
                    <button
                      key={integration.id}
                      onClick={() => handleIntegrationClick(integration)}
                      className="group relative flex flex-col rounded-lg border border-hud-bg-elev bg-hud-bg-card p-4 text-left transition-all hover:border-hud-gold/50 hover:shadow-lg hover:shadow-hud-gold/5"
                    >
                      <div className="flex items-start justify-between">
                        <div className="flex items-center gap-3">
                          {getIntegrationIcon(integration.key) ? (
                            <img
                              src={getIntegrationIcon(integration.key)}
                              alt={integration.name}
                              className="h-10 w-10 rounded-lg object-contain bg-white p-1"
                            />
                          ) : (
                            <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-hud-bg-elev text-hud-cream-dim">
                              <Settings className="h-5 w-5" />
                            </div>
                          )}
                          <div>
                            <h4 className="font-medium text-white">{integration.name}</h4>
                            <div className="flex items-center gap-2 text-xs text-hud-cream-mute">
                              <span className="capitalize">{integration.scope}</span>
                              <span>-</span>
                              <span className="capitalize">{integration.connection_type.replace('_', ' ')}</span>
                            </div>
                          </div>
                        </div>
                        {integration.settings_path && (
                          <ExternalLink className="h-4 w-4 text-hud-cream-mute opacity-0 transition-opacity group-hover:opacity-100 reveal-on-touch" />
                        )}
                      </div>
                      <p className="mt-3 text-sm text-hud-cream-dim line-clamp-2">
                        {integration.description}
                      </p>
                      <div className="mt-4 flex items-center justify-between">
                        {getStatusBadge(integration)}
                        {!integration.enabled && (
                          <span className="text-xs text-hud-cream-mute">Disabled</span>
                        )}
                      </div>
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      )}

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
