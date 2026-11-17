/**
 * The user's Google accounts: each Google Workspace / Gmail sign-in covers Gmail, Calendar, Meet and
 * Drive. Shown in My Profile → Connected Accounts and in Settings → Integrations (next to
 * MicrosoftConnectionCard), so both places add, rename, switch the primary and disconnect the same
 * accounts. A user with one account sees that account and the Add button.
 */
import { useState, useEffect } from 'react';
import { CheckCircle, Loader2, Mail, Calendar, Video, HardDrive, RefreshCw, Plus, Pencil, Star } from 'lucide-react';
import { useAuth } from '../../../contexts/AuthContext';
import {
  getGoogleConnections,
  getUnifiedGoogleConnection,
  initiateUnifiedGoogleOAuth,
  openUnifiedGoogleOAuthPopup,
  disconnectUnifiedGoogle,
  setGoogleAccountLabel,
  setPrimaryGoogleAccount,
  type GoogleOAuthOptions,
  type UnifiedGoogleConnection,
} from '../../../services/googleOAuthUnified';
import { GOOGLE_CONSENT_NOTE, connectionIdParam, shapeGoogleAccounts, type GoogleAccountDetail } from '../../../lib/googleAccounts';
import {
  getGoogleCalendarList,
  updateSelectedCalendars,
  testGoogleSync,
  type GoogleCalendarItem,
} from '../../../services/googleCalendarConnections';
import { getGmailConnectionStatus } from '../../../services/gmailApi';
import { useToast } from '../../../contexts/ToastContext';
import { logError } from '../../../lib/errors';
import { invalidateProviderCache } from '../../../services/connectedProvider';
import { Portal } from '../../shared/Portal';

export function GoogleIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none">
      <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" fill="#4285F4" />
      <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853" />
      <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" fill="#FBBC05" />
      <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335" />
    </svg>
  );
}

interface GoogleService {
  id: string;
  name: string;
  icon: typeof Mail;
  description: string;
  scopeKey: 'gmail' | 'calendar' | 'drive';
}

const googleServices: GoogleService[] = [
  { id: 'gmail', name: 'Gmail', icon: Mail, description: 'Send and receive emails', scopeKey: 'gmail' },
  { id: 'calendar', name: 'Calendar', icon: Calendar, description: 'Sync appointments and events', scopeKey: 'calendar' },
  { id: 'meet', name: 'Meet', icon: Video, description: 'Video conferencing integration', scopeKey: 'calendar' },
  { id: 'drive', name: 'Drive', icon: HardDrive, description: 'Access and store files', scopeKey: 'drive' },
];

const NOT_CONNECTED: UnifiedGoogleConnection = {
  connected: false, email: null, gmail: false, calendar: false, drive: false, scopes: [],
};

interface CalendarState {
  calendars: GoogleCalendarItem[];
  selected: string[];
}

export function GoogleConnectionCard() {
  const { user } = useAuth();
  const { showToast } = useToast();
  const [isLoading, setIsLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [confirmDisconnect, setConfirmDisconnect] = useState<GoogleAccountDetail | null>(null);
  const [renaming, setRenaming] = useState<{ id: string; value: string } | null>(null);

  const [connection, setConnection] = useState<UnifiedGoogleConnection>(NOT_CONNECTED);
  const [accounts, setAccounts] = useState<GoogleAccountDetail[]>([]);

  const [calendarsById, setCalendarsById] = useState<Record<string, CalendarState>>({});
  const [savingCalendars, setSavingCalendars] = useState<string | null>(null);
  const [testingSync, setTestingSync] = useState<string | null>(null);
  const [syncTestResult, setSyncTestResult] = useState<Record<string, { success: boolean; message: string }>>({});

  const connected = accounts.length > 0 || connection.connected;
  const hasReauth = accounts.some((a) => a.needsReauth);
  const multi = accounts.length > 1;

  /** Account id to send for per-account calls: none for a single account (as before). */
  const callId = (a: GoogleAccountDetail) => (multi ? connectionIdParam(a) : undefined);

  const loadCalendars = async (list: GoogleAccountDetail[]) => {
    const many = list.length > 1;
    const entries = await Promise.all(list.map(async (a) => {
      try {
        const { calendars, selectedCalendarIds } = await getGoogleCalendarList(many ? connectionIdParam(a) : undefined);
        return [a.id, { calendars, selected: selectedCalendarIds }] as const;
      } catch (err) {
        logError('GoogleConnectionCard.loadCalendars', err);
        return null;
      }
    }));
    setCalendarsById(Object.fromEntries(entries.filter((e): e is [string, CalendarState] => e !== null)));
  };

  const load = async () => {
    if (!user) return;
    try {
      const [conn, list] = await Promise.all([
        getUnifiedGoogleConnection().catch(() => NOT_CONNECTED),
        getGoogleConnections().catch(() => [] as GoogleAccountDetail[]),
      ]);
      setConnection(conn);
      let accts = list;
      if (accts.length === 0 && conn.connected && conn.email) {
        // The status view is not available yet: show the one legacy connection.
        const gmailConn = await getGmailConnectionStatus(user.id).catch(() => null);
        accts = shapeGoogleAccounts([{
          email: conn.email,
          is_primary: true,
          connection_status: conn.tokenExpired ? 'needs_reauth' : 'active',
          sync_status: gmailConn?.syncStatus ?? null,
          last_incremental_sync_at: gmailConn?.lastSyncAt ?? null,
        }]);
      }
      setAccounts(accts);
      if (conn.calendar || accts.length > 0) await loadCalendars(accts);
    } catch (error) {
      console.error('Failed to load the Google connection:', error);
    }
  };

  useEffect(() => {
    load().finally(() => setIsLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user]);

  /** Opens the Google sign-in popup; `opts` adds an account or re-authorises a specific one. */
  const startOAuth = async (opts?: GoogleOAuthOptions) => {
    setBusy(true);
    try {
      const authUrl = await initiateUnifiedGoogleOAuth(opts);
      const result = await openUnifiedGoogleOAuthPopup(authUrl);
      if (result.success) {
        await load();
        invalidateProviderCache();
        showToast('success', `Google Workspace connected${result.email ? ` as ${result.email}` : ''}`);
      } else if (result.error && result.error !== 'Popup closed') {
        showToast('warning', result.error);
      }
    } catch (error) {
      logError('GoogleConnectionCard.startOAuth', error);
      showToast('warning', error instanceof Error ? error.message : 'Failed to connect Google Workspace');
    } finally {
      setBusy(false);
    }
  };

  const handleConnect = () => startOAuth();
  const handleAddAccount = () => startOAuth({ mode: 'add' });
  const handleReconnect = (a: GoogleAccountDetail) => startOAuth({ loginHint: a.email });

  const handleDisconnect = async (a: GoogleAccountDetail) => {
    setBusy(true);
    try {
      // An id equal to the email means the account came from the legacy status: no id to send.
      await disconnectUnifiedGoogle(connectionIdParam(a));
      setConfirmDisconnect(null);
      invalidateProviderCache();
      await load();
      showToast('success', `${a.email} disconnected`);
    } catch (error) {
      logError('GoogleConnectionCard.disconnect', error);
      showToast('warning', error instanceof Error ? error.message : 'Failed to disconnect Google Workspace');
    } finally {
      setBusy(false);
    }
  };

  const makePrimary = async (a: GoogleAccountDetail) => {
    setBusy(true);
    try {
      await setPrimaryGoogleAccount(a.id);
      invalidateProviderCache();
      await load();
      showToast('success', `${a.email} is now the primary account`);
    } catch (error) {
      logError('GoogleConnectionCard.makePrimary', error);
      showToast('warning', error instanceof Error ? error.message : 'Failed to change the primary account');
    } finally {
      setBusy(false);
    }
  };

  const saveLabel = async () => {
    if (!renaming) return;
    setBusy(true);
    try {
      await setGoogleAccountLabel(renaming.id, renaming.value);
      setRenaming(null);
      invalidateProviderCache();
      await load();
    } catch (error) {
      logError('GoogleConnectionCard.saveLabel', error);
      showToast('warning', error instanceof Error ? error.message : 'Failed to rename the account');
    } finally {
      setBusy(false);
    }
  };

  const handleSaveCalendars = async (a: GoogleAccountDetail) => {
    setSavingCalendars(a.id);
    try {
      await updateSelectedCalendars(calendarsById[a.id]?.selected ?? [], callId(a));
      showToast('success', 'Calendar selection saved');
    } catch (error) {
      console.error('Failed to save calendars:', error);
      showToast('warning', 'Failed to save calendar selection');
    } finally {
      setSavingCalendars(null);
    }
  };

  const handleTestSync = async (a: GoogleAccountDetail) => {
    setTestingSync(a.id);
    setSyncTestResult((prev) => Object.fromEntries(Object.entries(prev).filter(([id]) => id !== a.id)));
    try {
      const result = await testGoogleSync(callId(a));
      setSyncTestResult((prev) => ({
        ...prev,
        [a.id]: { success: result.success, message: result.message || result.error || 'Test completed' },
      }));
    } catch {
      setSyncTestResult((prev) => ({ ...prev, [a.id]: { success: false, message: 'Failed to test sync' } }));
    } finally {
      setTestingSync(null);
    }
  };

  const handleCalendarToggle = (accountId: string, calendarId: string) => {
    setCalendarsById((prev) => {
      const cur = prev[accountId];
      if (!cur) return prev;
      const selected = cur.selected.includes(calendarId)
        ? cur.selected.filter((id) => id !== calendarId)
        : [...cur.selected, calendarId];
      return { ...prev, [accountId]: { ...cur, selected } };
    });
  };

  return (
    <div className="bg-hud-bg-mid rounded-xl border border-hud-bg-card p-6">
      <div className="flex items-start gap-4">
        <div className="p-3 rounded-xl bg-white">
          <GoogleIcon className="w-8 h-8" />
        </div>

        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1">
            <h3 className="text-lg font-semibold text-white">Google Workspace</h3>
            {connected && !hasReauth && (
              <span className="flex items-center gap-1 px-2 py-0.5 text-xs font-medium rounded-full bg-hud-emerald/20 text-hud-emerald">
                <CheckCircle className="w-3 h-3" />
                Connected
              </span>
            )}
          </div>

          {isLoading ? (
            <div className="py-4">
              <Loader2 className="w-5 h-5 text-hud-gold-soft animate-spin" />
            </div>
          ) : (
            <>
              {!connected && (
                <p className="text-sm text-hud-cream-dim mb-4">
                  Connect your Google account to sync email, calendar, video meetings, and files
                </p>
              )}

              <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
                {googleServices.map((service) => {
                  const Icon = service.icon;
                  const serviceConnected = connection[service.scopeKey] || false;
                  return (
                    <div
                      key={service.id}
                      className={`flex items-center gap-2 p-3 rounded-lg border transition-colors ${
                        serviceConnected
                          ? 'bg-hud-emerald/5 border-hud-emerald/20'
                          : 'bg-hud-bg-card/50 border-hud-bg-elev'
                      }`}
                    >
                      <div className="relative">
                        <Icon className={`w-4 h-4 ${serviceConnected ? 'text-hud-emerald' : 'text-hud-cream-mute'}`} />
                        {serviceConnected && (
                          <CheckCircle className="absolute -top-1 -right-1 w-2.5 h-2.5 text-hud-emerald" />
                        )}
                      </div>
                      <div>
                        <p className={`text-sm font-medium ${serviceConnected ? 'text-white' : 'text-hud-cream-dim'}`}>
                          {service.name}
                        </p>
                        <p className="text-xs text-hud-cream-mute">{service.description}</p>
                      </div>
                    </div>
                  );
                })}
              </div>

              {connected ? (
                <div className="space-y-4">
                  <ul className="space-y-3" aria-label="Connected Google accounts">
                    {accounts.map((a) => {
                      const cal = calendarsById[a.id];
                      const test = syncTestResult[a.id];
                      return (
                        <li key={a.id} className="p-3 rounded-lg border border-hud-bg-elev bg-hud-bg-card/40">
                          <div className="flex items-start justify-between gap-3">
                            <div className="min-w-0">
                              <div className="flex flex-wrap items-center gap-2">
                                <span className="text-sm text-white font-medium truncate">{a.email}</span>
                                {a.label && <span className="text-xs text-hud-cream-dim">{a.label}</span>}
                                {a.isPrimary && (
                                  <span className="inline-flex items-center gap-1 px-2 py-0.5 text-xs rounded-full bg-hud-gold/20 text-hud-gold-soft">
                                    <Star className="w-3 h-3" /> Primary
                                  </span>
                                )}
                                {a.needsReauth && (
                                  <span className="px-2 py-0.5 text-xs rounded-full bg-hud-rust/20 text-hud-rust">Needs reconnect</span>
                                )}
                              </div>
                              {a.needsReauth && (
                                <p className="mt-1 text-xs text-hud-rust">
                                  Google has revoked access. Please reconnect this account.
                                </p>
                              )}
                              {a.syncStatus === 'syncing' && (
                                <span className="flex items-center gap-1.5 mt-1 text-xs text-hud-gold-soft">
                                  <RefreshCw size={12} className="animate-spin" /> Syncing...
                                </span>
                              )}
                              {a.lastSyncAt && (
                                <p className="mt-1 text-xs text-hud-cream-mute">Gmail last synced: {new Date(a.lastSyncAt).toLocaleString()}</p>
                              )}
                              {a.syncStatus === 'error' && a.error && <p className="mt-1 text-xs text-hud-plum">Sync error: {a.error}</p>}
                            </div>
                            <div className="flex flex-wrap justify-end gap-2 shrink-0">
                              {a.needsReauth && (
                                <button
                                  onClick={() => handleReconnect(a)}
                                  disabled={busy}
                                  className="px-3 py-1 bg-hud-rust/20 text-hud-rust rounded text-xs hover:bg-hud-rust/30 transition-colors disabled:opacity-50"
                                >
                                  Reconnect
                                </button>
                              )}
                              {multi && !a.isPrimary && (
                                <button
                                  onClick={() => makePrimary(a)}
                                  disabled={busy}
                                  className="px-3 py-1 bg-hud-bg-card text-white rounded text-xs hover:bg-hud-bg-elev transition-colors disabled:opacity-50"
                                >
                                  Make primary
                                </button>
                              )}
                              {multi && (
                                <button
                                  onClick={() => setRenaming({ id: a.id, value: a.label ?? '' })}
                                  disabled={busy}
                                  aria-label={`Rename ${a.email}`}
                                  className="p-1 bg-hud-bg-card text-hud-cream-dim rounded hover:bg-hud-bg-elev transition-colors disabled:opacity-50"
                                >
                                  <Pencil className="w-3.5 h-3.5" />
                                </button>
                              )}
                              <button
                                onClick={() => setConfirmDisconnect(a)}
                                disabled={busy}
                                className="px-3 py-1 bg-hud-bg-card text-hud-plum rounded text-xs hover:bg-hud-bg-elev transition-colors disabled:opacity-50"
                              >
                                {multi ? 'Disconnect' : 'Disconnect Google'}
                              </button>
                            </div>
                          </div>

                          {renaming?.id === a.id && (
                            <form
                              className="mt-3 flex items-center gap-2"
                              onSubmit={(e) => { e.preventDefault(); void saveLabel(); }}
                            >
                              <input
                                autoFocus
                                value={renaming.value}
                                onChange={(e) => setRenaming({ id: a.id, value: e.target.value })}
                                maxLength={60}
                                placeholder="Label, e.g. Work or Personal"
                                aria-label="Account label"
                                className="flex-1 px-3 py-1.5 rounded-lg bg-hud-bg-card border border-hud-bg-elev text-white text-sm placeholder-hud-cream-dim focus:outline-none focus:ring-2 focus:ring-hud-gold"
                              />
                              <button type="submit" disabled={busy} className="px-3 py-1.5 rounded-lg bg-hud-gold text-black text-xs font-medium disabled:opacity-50">Save</button>
                              <button type="button" onClick={() => setRenaming(null)} className="px-3 py-1.5 rounded-lg bg-hud-bg-card text-white text-xs">Cancel</button>
                            </form>
                          )}

                          {cal && cal.calendars.length > 0 && (
                            <div className="mt-3 pt-3 border-t border-hud-bg-card">
                              <div className="flex items-center justify-between mb-2">
                                <p className="text-xs text-hud-cream-dim font-medium uppercase tracking-wider">
                                  Calendars checked for conflicts
                                </p>
                                <button
                                  onClick={() => handleSaveCalendars(a)}
                                  disabled={savingCalendars === a.id}
                                  className="text-hud-gold-soft hover:text-hud-gold-soft text-xs transition-colors"
                                >
                                  {savingCalendars === a.id ? 'Saving...' : 'Save Selection'}
                                </button>
                              </div>
                              <div className="space-y-1">
                                {cal.calendars.map((c) => (
                                  <label
                                    key={c.id}
                                    className="flex items-center gap-2.5 px-3 py-2 bg-hud-bg-card/50 rounded-lg cursor-pointer hover:bg-hud-bg-card transition-colors"
                                  >
                                    <input
                                      type="checkbox"
                                      checked={cal.selected.includes(c.id)}
                                      onChange={() => handleCalendarToggle(a.id, c.id)}
                                      className="w-3.5 h-3.5 rounded border-hud-cream-mute bg-hud-bg-elev text-hud-gold focus:ring-hud-gold"
                                    />
                                    <span className="text-sm text-white">{c.name}</span>
                                    {c.primary && (
                                      <span className="text-[10px] px-1.5 py-0.5 bg-hud-gold/20 text-hud-gold-soft rounded font-medium">
                                        Primary
                                      </span>
                                    )}
                                  </label>
                                ))}
                              </div>
                            </div>
                          )}

                          {cal && (
                            <div className="mt-3 flex items-center gap-3">
                              <button
                                onClick={() => handleTestSync(a)}
                                disabled={testingSync === a.id}
                                className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-hud-bg-card text-hud-cream-soft rounded-lg hover:bg-hud-bg-elev transition-colors text-xs font-medium"
                              >
                                <RefreshCw className={`w-3 h-3 ${testingSync === a.id ? 'animate-spin' : ''}`} />
                                {testingSync === a.id ? 'Testing...' : 'Test Calendar Sync'}
                              </button>
                              {test && (
                                <span className={`text-xs ${test.success ? 'text-hud-emerald' : 'text-hud-plum'}`}>
                                  {test.message}
                                </span>
                              )}
                            </div>
                          )}
                        </li>
                      );
                    })}
                  </ul>

                  <div>
                    <button
                      onClick={handleAddAccount}
                      disabled={busy}
                      className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-hud-bg-card text-white hover:bg-hud-bg-elev transition-colors text-sm font-medium disabled:opacity-50"
                    >
                      {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />}
                      Add another Google account
                    </button>
                    <p className="mt-2 text-xs text-hud-cream-mute">{GOOGLE_CONSENT_NOTE}</p>
                  </div>
                </div>
              ) : (
                <button
                  onClick={handleConnect}
                  disabled={busy}
                  className="inline-flex items-center gap-2 px-5 py-2.5 rounded-lg bg-white text-hud-bg-mid hover:bg-hud-cream transition-colors text-sm font-semibold shadow-lg shadow-white/5 disabled:opacity-50"
                >
                  {busy ? (
                    <Loader2 className="w-4 h-4 animate-spin" />
                  ) : (
                    <GoogleIcon className="w-4 h-4" />
                  )}
                  {busy ? 'Connecting...' : 'Connect Google Workspace'}
                </button>
              )}
            </>
          )}
        </div>
      </div>

      {confirmDisconnect && (
        <Portal><div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50 backdrop-blur-sm">
          <div className="bg-hud-bg-mid rounded-xl border border-hud-bg-card p-6 max-w-md w-full">
            <h3 className="text-lg font-semibold text-white mb-2">
              {multi ? `Disconnect ${confirmDisconnect.email}?` : 'Disconnect Google Workspace?'}
            </h3>
            <p className="text-sm text-hud-cream-dim mb-2">
              This will disconnect the Google account ({confirmDisconnect.email}) from the CRM.
              {confirmDisconnect.isPrimary && multi && ' Another account becomes the primary.'}
            </p>
            <ul className="text-sm text-hud-cream-dim mb-6 space-y-1">
              <li>- Gmail sync will stop{multi ? '' : ', outbound emails fall back to the default provider'}</li>
              <li>- Calendar busy-time sync and double-booking prevention will be disabled for it</li>
              <li>- Google Drive file access will be revoked for it</li>
              <li>- Previously synced messages, events, and files remain in the CRM</li>
            </ul>
            <div className="flex justify-end gap-3">
              <button
                onClick={() => setConfirmDisconnect(null)}
                className="px-4 py-2 rounded-lg bg-hud-bg-card text-white hover:bg-hud-bg-elev transition-colors text-sm font-medium"
              >
                Cancel
              </button>
              <button
                onClick={() => handleDisconnect(confirmDisconnect)}
                disabled={busy}
                className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-hud-plum text-white hover:bg-hud-plum transition-colors text-sm font-medium disabled:opacity-50"
              >
                {busy && <Loader2 className="w-4 h-4 animate-spin" />}
                {busy ? 'Disconnecting...' : 'Disconnect'}
              </button>
            </div>
          </div>
        </div></Portal>
      )}
    </div>
  );
}
