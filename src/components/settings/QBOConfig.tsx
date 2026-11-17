import { useState, useEffect } from 'react';
import { useAuth } from '../../contexts/AuthContext';
import {
  getQBOConnectionStatus,
  generateQBOAuthUrl,
  exchangeQBOCode,
  disconnectQBO,
} from '../../services/qboAuth';
import {
  FileText,
  Link2,
  Unlink,
  Loader2,
  CheckCircle2,
  AlertCircle,
  ExternalLink,
  RefreshCw,
} from 'lucide-react';
import { formatDateTimeNumeric } from '../../utils/formatters';

interface QBOConnectionStatus {
  connected: boolean;
  companyName?: string;
  realmId?: string;
  lastSyncAt?: string;
  tokenExpiring?: boolean;
}

export function QBOConfig() {
  const { user, hasPermission } = useAuth();
  const [status, setStatus] = useState<QBOConnectionStatus | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isConnecting, setIsConnecting] = useState(false);
  const [isDisconnecting, setIsDisconnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const canManage = hasPermission('settings.manage');

  useEffect(() => {
    loadStatus();
    handleOAuthCallback();
  }, []);

  const loadStatus = async () => {
    try {
      setIsLoading(true);
      const connectionStatus = await getQBOConnectionStatus();
      setStatus(connectionStatus);
    } catch (err) {
      console.error('Failed to load QBO status:', err);
    } finally {
      setIsLoading(false);
    }
  };

  const handleOAuthCallback = async () => {
    const urlParams = new URLSearchParams(window.location.search);
    const code = urlParams.get('code');
    const realmId = urlParams.get('realmId');
    const state = urlParams.get('state');

    if (code && realmId && state) {
      try {
        setIsConnecting(true);
        setError(null);

        const redirectUri = `${window.location.origin}/admin/settings`;
        await exchangeQBOCode(code, realmId, redirectUri);

        window.history.replaceState({}, '', window.location.pathname);

        await loadStatus();
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to connect to QuickBooks');
      } finally {
        setIsConnecting(false);
      }
    }
  };

  const handleConnect = async () => {
    if (!user?.organization_id) return;

    try {
      setIsConnecting(true);
      setError(null);
      const redirectUri = `${window.location.origin}/admin/settings`;
      const authUrl = await generateQBOAuthUrl(user.organization_id, redirectUri);
      window.location.href = authUrl;
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to initiate QuickBooks connection');
      setIsConnecting(false);
    }
  };

  const handleDisconnect = async () => {
    if (!confirm('Are you sure you want to disconnect QuickBooks Online? This will remove the integration.')) {
      return;
    }

    try {
      setIsDisconnecting(true);
      setError(null);
      await disconnectQBO();
      await loadStatus();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to disconnect QuickBooks');
    } finally {
      setIsDisconnecting(false);
    }
  };

  if (isLoading) {
    return (
      <div className="bg-hud-bg-mid rounded-xl border border-hud-bg-card">
        <div className="p-4 border-b border-hud-bg-card">
          <h2 className="text-lg font-semibold text-white flex items-center gap-2">
            <FileText className="w-5 h-5 text-hud-emerald" />
            QuickBooks Online
          </h2>
        </div>
        <div className="p-8 flex items-center justify-center">
          <Loader2 className="w-6 h-6 animate-spin text-hud-cream-dim" />
        </div>
      </div>
    );
  }

  return (
    <div className="bg-hud-bg-mid rounded-xl border border-hud-bg-card">
      <div className="p-4 border-b border-hud-bg-card">
        <h2 className="text-lg font-semibold text-white flex items-center gap-2">
          <FileText className="w-5 h-5 text-hud-emerald" />
          QuickBooks Online
        </h2>
        <p className="text-sm text-hud-cream-dim mt-1">
          Connect to QuickBooks Online for invoicing and payments
        </p>
      </div>

      <div className="p-4 space-y-4">
        {error && (
          <div className="flex items-center gap-2 p-3 rounded-lg bg-hud-plum/10 border border-hud-plum/20 text-hud-plum text-sm">
            <AlertCircle className="w-4 h-4 flex-shrink-0" />
            <span>{error}</span>
          </div>
        )}

        {isConnecting && (
          <div className="flex items-center gap-3 p-4 rounded-lg bg-hud-gold/10 border border-hud-gold/20">
            <Loader2 className="w-5 h-5 animate-spin text-hud-gold-soft" />
            <span className="text-hud-gold-soft">Connecting to QuickBooks Online...</span>
          </div>
        )}

        {!isConnecting && status?.connected ? (
          <div className="space-y-4">
            <div className="flex items-center gap-3 p-4 rounded-lg bg-hud-emerald/10 border border-hud-emerald/20">
              <CheckCircle2 className="w-5 h-5 text-hud-emerald" />
              <div className="flex-1">
                <p className="text-hud-emerald/40 font-medium">Connected</p>
                <p className="text-sm text-hud-emerald/70">
                  {status.companyName}
                </p>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-4 text-sm">
              <div>
                <p className="text-hud-cream-dim">Company ID (Realm)</p>
                <p className="text-white font-mono">{status.realmId}</p>
              </div>
              <div>
                <p className="text-hud-cream-dim">Last Sync</p>
                <p className="text-white">{formatDateTimeNumeric(status.lastSyncAt, { fallback: 'Never' })}</p>
              </div>
            </div>

            {status.tokenExpiring && (
              <div className="flex items-center gap-2 p-3 rounded-lg bg-hud-rust/10 border border-hud-rust/20 text-hud-rust text-sm">
                <AlertCircle className="w-4 h-4 flex-shrink-0" />
                <span>Access token is expiring soon. Re-authorize to refresh.</span>
              </div>
            )}

            {canManage && (
              <div className="flex items-center gap-3 pt-2">
                <button
                  onClick={handleDisconnect}
                  disabled={isDisconnecting}
                  className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-hud-plum/10 text-hud-plum hover:bg-hud-plum/20 transition-colors disabled:opacity-50"
                >
                  {isDisconnecting ? (
                    <Loader2 className="w-4 h-4 animate-spin" />
                  ) : (
                    <Unlink className="w-4 h-4" />
                  )}
                  Disconnect
                </button>
                <a
                  href="https://app.qbo.intuit.com"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-hud-bg-card text-hud-cream-soft hover:bg-hud-bg-elev transition-colors"
                >
                  <ExternalLink className="w-4 h-4" />
                  Open QuickBooks
                </a>
              </div>
            )}
          </div>
        ) : (
          <div className="space-y-4">
            <div className="p-4 rounded-lg bg-hud-bg-card/50 border border-hud-bg-elev">
              <p className="text-hud-cream-soft">
                Connect your QuickBooks Online account to enable invoicing and payment features.
                Invoices created in this CRM will sync to QuickBooks, and customers will pay
                through QuickBooks' secure payment pages.
              </p>
              <ul className="mt-3 space-y-1 text-sm text-hud-cream-dim">
                <li className="flex items-center gap-2">
                  <CheckCircle2 className="w-4 h-4 text-hud-emerald" />
                  Create and send invoices
                </li>
                <li className="flex items-center gap-2">
                  <CheckCircle2 className="w-4 h-4 text-hud-emerald" />
                  Track payment status automatically
                </li>
                <li className="flex items-center gap-2">
                  <CheckCircle2 className="w-4 h-4 text-hud-emerald" />
                  Sync products and services
                </li>
                <li className="flex items-center gap-2">
                  <CheckCircle2 className="w-4 h-4 text-hud-emerald" />
                  Set up recurring billing
                </li>
              </ul>
            </div>

            {canManage ? (
              <button
                onClick={handleConnect}
                disabled={isConnecting}
                className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-gradient-to-r from-hud-emerald to-hud-teal text-white font-medium hover:from-hud-emerald-dim hover:to-hud-teal transition-colors disabled:opacity-50"
              >
                {isConnecting ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                  <Link2 className="w-4 h-4" />
                )}
                Connect to QuickBooks Online
              </button>
            ) : (
              <p className="text-sm text-hud-cream-dim">
                Contact an administrator to connect QuickBooks Online.
              </p>
            )}
          </div>
        )}
      </div>
    </div>
  );
}