import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Check,
  X,
  Search,
  Calendar,
  RefreshCw,
  Clock,
  Link2,
} from 'lucide-react';
import { useAuth } from '../../../contexts/AuthContext';
import {
  getGoogleConnection,
  getTeamConnections,
  type GoogleConnection,
  type TeamConnectionItem,
} from '../../../services/googleCalendarConnections';
import { getSyncStatus } from '../../../services/googleCalendarEvents';
import {
  initiateUnifiedGoogleOAuth,
  openUnifiedGoogleOAuthPopup,
} from '../../../services/googleOAuthUnified';
import { useToast } from '../../../contexts/ToastContext';
import { useWorkspaceProvider } from '../../../hooks/useWorkspaceProvider';
import { reportBackgroundError } from '../../../lib/errors';
import { accountDisplayName, showAccountPicker } from '../../../lib/microsoftAccounts';

export function ConnectionsTab() {
  const { user, isSuperAdmin } = useAuth();
  const { showToast } = useToast();
  const navigate = useNavigate();
  const [loading, setLoading] = useState(true);
  const [connecting, setConnecting] = useState(false);
  const [connection, setConnection] = useState<GoogleConnection | null>(null);
  const [teamConnections, setTeamConnections] = useState<TeamConnectionItem[]>([]);
  const [teamSearch, setTeamSearch] = useState('');
  const [syncStatus, setSyncStatus] = useState<Awaited<ReturnType<typeof getSyncStatus>> | null>(null);
  const workspace = useWorkspaceProvider();
  const microsoftConnected = workspace.connected.includes('microsoft');
  const microsoftAccounts = workspace.accounts.microsoft;
  const multiMicrosoft = showAccountPicker(microsoftAccounts);
  const googleAccounts = workspace.accounts.google;
  const multiGoogle = showAccountPicker(googleAccounts);

  useEffect(() => {
    async function load() {
      try {
        const [conn] = await Promise.all([
          getGoogleConnection().catch(() => ({ connected: false }) as GoogleConnection),
          ...(isSuperAdmin ? [loadTeamConnections()] : []),
        ]);
        setConnection(conn);
        if (user?.id) {
          getSyncStatus(user.id).then(setSyncStatus).catch(reportBackgroundError('ConnectionsTab.getSyncStatus'));
        }
      } catch (error) {
        console.error('Failed to load connections:', error);
      } finally {
        setLoading(false);
      }
    }
    load();
  }, [user, isSuperAdmin]);

  async function handleConnect() {
    setConnecting(true);
    try {
      const authUrl = await initiateUnifiedGoogleOAuth();
      const result = await openUnifiedGoogleOAuthPopup(authUrl);

      const conn = await getGoogleConnection().catch(() => ({ connected: false }) as GoogleConnection);
      setConnection(conn);

      if (result.success || conn.connected) {
        showToast('success', 'Google Calendar connected successfully');
        if (user?.id) {
          getSyncStatus(user.id).then(setSyncStatus).catch(reportBackgroundError('ConnectionsTab.getSyncStatus'));
        }
      } else if (result.error && result.error !== 'Popup closed') {
        showToast('error', result.error);
      }
    } catch (error) {
      console.error('Failed to connect:', error);
      showToast('error', 'Failed to connect Google Calendar');
    } finally {
      setConnecting(false);
    }
  }

  async function loadTeamConnections() {
    try {
      const connections = await getTeamConnections();
      setTeamConnections(connections);
    } catch (error) {
      console.error('Failed to load team connections:', error);
    }
  }

  const filteredTeamConnections = teamConnections.filter(
    (c) =>
      c.userName.toLowerCase().includes(teamSearch.toLowerCase()) ||
      c.userEmail.toLowerCase().includes(teamSearch.toLowerCase())
  );

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <div className="w-8 h-8 border-2 border-hud-gold border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  return (
    <div className="space-y-8">
      <div className="bg-hud-bg-card/50 rounded-xl border border-hud-bg-elev p-6">
        <div className="flex items-center gap-3 mb-4">
          <Calendar className="w-5 h-5 text-hud-gold-soft" />
          <h3 className="text-lg font-medium text-white">My Calendar Connections</h3>
        </div>

        <div className="flex items-center justify-between p-4 bg-hud-bg-elev/30 rounded-lg mb-3">
          <div>
            <p className="text-hud-cream-mute text-xs uppercase tracking-wide mb-1">Microsoft 365 (Outlook)</p>
            {microsoftConnected ? (
              <div className="flex items-center gap-2">
                <div className="w-2 h-2 rounded-full bg-hud-emerald" />
                <span className="text-white font-medium">Connected</span>
                {!multiMicrosoft && workspace.emails.microsoft && (
                  <span className="text-hud-cream-dim text-sm">({workspace.emails.microsoft})</span>
                )}
                {multiMicrosoft && (
                  <span className="text-hud-cream-dim text-sm">({microsoftAccounts.length} accounts)</span>
                )}
              </div>
            ) : (
              <div className="flex items-center gap-2">
                <div className="w-2 h-2 rounded-full bg-hud-cream-mute" />
                <span className="text-hud-cream-dim">Not connected</span>
              </div>
            )}
            {multiMicrosoft && (
              <ul className="mt-2 space-y-1">
                {microsoftAccounts.map((a) => (
                  <li key={a.id} className="flex items-center gap-2 text-sm text-hud-cream-dim">
                    <span className={`w-1.5 h-1.5 rounded-full ${a.status === 'needs_reauth' ? 'bg-hud-rust' : 'bg-hud-emerald'}`} />
                    <span className="truncate">{accountDisplayName(a)}</span>
                    {a.isPrimary && <span className="text-xs text-hud-gold-soft">Primary</span>}
                    {a.status === 'needs_reauth' && <span className="text-xs text-hud-rust">Needs reconnect</span>}
                  </li>
                ))}
              </ul>
            )}
          </div>
          <button
            onClick={() => navigate('/settings/profile?tab=connected-accounts')}
            className="px-4 py-2 bg-hud-bg-elev text-white rounded-lg hover:bg-hud-cream-mute transition-colors flex items-center gap-2 text-sm font-medium whitespace-nowrap"
          >
            <Link2 className="w-4 h-4" />
            {microsoftConnected ? 'Manage' : 'Connect'}
          </button>
        </div>

        <div className="flex items-center justify-between p-4 bg-hud-bg-elev/30 rounded-lg">
          <div>
            <p className="text-hud-cream-mute text-xs uppercase tracking-wide mb-1">Google Calendar</p>
            {connection?.connected ? (
              <div className="flex items-center gap-2">
                <div className="w-2 h-2 rounded-full bg-hud-emerald" />
                <span className="text-white font-medium">Connected</span>
                {!multiGoogle && <span className="text-hud-cream-dim text-sm">({connection.email})</span>}
                {multiGoogle && (
                  <span className="text-hud-cream-dim text-sm">({googleAccounts.length} accounts)</span>
                )}
              </div>
            ) : (
              <div className="flex items-center gap-2">
                <div className="w-2 h-2 rounded-full bg-hud-cream-mute" />
                <span className="text-hud-cream-dim">Not connected</span>
              </div>
            )}
            {multiGoogle && (
              <ul className="mt-2 space-y-1">
                {googleAccounts.map((a) => (
                  <li key={a.id} className="flex items-center gap-2 text-sm text-hud-cream-dim">
                    <span className={`w-1.5 h-1.5 rounded-full ${a.status === 'needs_reauth' ? 'bg-hud-rust' : 'bg-hud-emerald'}`} />
                    <span className="truncate">{accountDisplayName(a)}</span>
                    {a.isPrimary && <span className="text-xs text-hud-gold-soft">Primary</span>}
                    {a.status === 'needs_reauth' && <span className="text-xs text-hud-rust">Needs reconnect</span>}
                  </li>
                ))}
              </ul>
            )}
            <p className="text-hud-cream-mute text-sm mt-1">
              {connection?.connected
                ? (multiGoogle ? 'Your Google calendars are connected and syncing.' : 'Your Google Calendar is connected and syncing.')
                : 'Connect your Google Calendar to enable two-way sync.'}
            </p>
          </div>
          <button
            onClick={connection?.connected ? () => navigate('/settings/profile?tab=connected-accounts') : handleConnect}
            disabled={connecting}
            className="px-4 py-2 bg-hud-bg-elev text-white rounded-lg hover:bg-hud-cream-mute transition-colors flex items-center gap-2 text-sm font-medium whitespace-nowrap disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {connecting ? (
              <RefreshCw className="w-4 h-4 animate-spin" />
            ) : (
              <Link2 className="w-4 h-4" />
            )}
            {connecting ? 'Connecting...' : multiGoogle ? 'Manage' : connection?.connected ? 'Reconnect' : 'Connect'}
          </button>
        </div>

        {syncStatus?.connected && (
          <div className="mt-4 p-4 bg-hud-bg-elev/30 rounded-lg space-y-3">
            <div className="flex items-center gap-2 text-sm">
              <RefreshCw className="w-4 h-4 text-hud-gold-soft" />
              <span className="text-white font-medium">
                2-Way Sync Status
                {syncStatus.providers.length > 0 && (
                  <span className="text-hud-cream-dim font-normal">
                    {' '}({syncStatus.providers.map((p) => (p.provider === 'google' ? 'Google' : 'Outlook')).join(' + ')})
                  </span>
                )}
              </span>
              {syncStatus.syncEnabled ? (
                <span className="ml-auto inline-flex items-center gap-1 px-2 py-0.5 bg-hud-emerald/20 text-hud-emerald rounded text-xs">
                  <Check className="w-3 h-3" />
                  Active
                </span>
              ) : (
                <span className="ml-auto inline-flex items-center gap-1 px-2 py-0.5 bg-hud-cream-mute/20 text-hud-cream-dim rounded text-xs">
                  Disabled
                </span>
              )}
            </div>
            <div className="grid grid-cols-3 gap-4 text-xs">
              <div>
                <p className="text-hud-cream-mute mb-0.5">Last Full Sync</p>
                <p className="text-hud-cream-soft flex items-center gap-1">
                  <Clock className="w-3 h-3" />
                  {syncStatus.lastFullSync
                    ? new Date(syncStatus.lastFullSync).toLocaleString()
                    : 'Never'}
                </p>
              </div>
              <div>
                <p className="text-hud-cream-mute mb-0.5">Last Incremental Sync</p>
                <p className="text-hud-cream-soft flex items-center gap-1">
                  <Clock className="w-3 h-3" />
                  {syncStatus.lastIncrementalSync
                    ? new Date(syncStatus.lastIncrementalSync).toLocaleString()
                    : 'Never'}
                </p>
              </div>
              <div>
                <p className="text-hud-cream-mute mb-0.5">Pending Jobs</p>
                <p className="text-hud-cream-soft">{syncStatus.pendingJobs}</p>
              </div>
            </div>
          </div>
        )}
      </div>

      {isSuperAdmin && (
        <div className="bg-hud-bg-card/50 rounded-xl border border-hud-bg-elev p-6">
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-lg font-medium text-white">Team Connections</h3>
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-hud-cream-dim" />
              <input
                type="text"
                placeholder="Search team..."
                value={teamSearch}
                onChange={(e) => setTeamSearch(e.target.value)}
                className="pl-10 pr-4 py-1.5 bg-hud-bg-elev border border-hud-cream-mute rounded text-white placeholder-hud-cream-dim text-sm focus:outline-none focus:ring-1 focus:ring-hud-gold w-48"
              />
            </div>
          </div>

          <p className="text-hud-cream-dim text-sm mb-4">
            View calendar connection status (Google Calendar or Microsoft 365) for all team members. Users must connect their own accounts from their profile settings.
          </p>

          <div className="overflow-hidden rounded-lg border border-hud-bg-elev">
            <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="bg-hud-bg-elev/50">
                  <th className="text-left px-4 py-2 text-hud-cream-dim font-medium text-sm">User</th>
                  <th className="text-left px-4 py-2 text-hud-cream-dim font-medium text-sm">Status</th>
                  <th className="text-left px-4 py-2 text-hud-cream-dim font-medium text-sm">Calendar Account</th>
                  <th className="text-left px-4 py-2 text-hud-cream-dim font-medium text-sm">Connected</th>
                </tr>
              </thead>
              <tbody>
                {filteredTeamConnections.map((conn) => (
                  <tr key={conn.userId} className="border-t border-hud-bg-elev/50">
                    <td className="px-4 py-3">
                      <div>
                        <p className="text-white font-medium">{conn.userName}</p>
                        <p className="text-hud-cream-dim text-sm">{conn.userEmail}</p>
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      {conn.connected ? (
                        <span className="inline-flex items-center gap-1 px-2 py-1 bg-hud-emerald/20 text-hud-emerald rounded text-xs">
                          <Check className="w-3 h-3" />
                          Connected
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1 px-2 py-1 bg-hud-cream-mute/20 text-hud-cream-dim rounded text-xs">
                          <X className="w-3 h-3" />
                          Not Connected
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-hud-cream-soft">
                      {[
                        conn.googleEmail ? `${conn.googleEmail} (Google)` : null,
                        conn.microsoftEmail ? `${conn.microsoftEmail} (Microsoft)` : null,
                      ].filter(Boolean).join(', ') || '-'}
                    </td>
                    <td className="px-4 py-3 text-hud-cream-dim text-sm">
                      {conn.connectedAt
                        ? new Date(conn.connectedAt).toLocaleDateString()
                        : '-'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            </div>

            {filteredTeamConnections.length === 0 && (
              <div className="text-center py-8 text-hud-cream-dim">
                No team members found
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
