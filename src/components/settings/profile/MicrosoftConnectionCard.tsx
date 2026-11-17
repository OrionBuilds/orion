import { useEffect, useState } from 'react';
import { CheckCircle, Loader2, Mail, Calendar, HardDrive, Video, RefreshCw, Plus, Pencil, Star, ChevronDown } from 'lucide-react';
import { useToast } from '../../../contexts/ToastContext';
import { logError } from '../../../lib/errors';
import {
  clientIdFromAuthUrl,
  disconnectMicrosoft,
  getAgentMailbox,
  getMicrosoftCapabilities,
  getMicrosoftConnections,
  type AgentMailbox,
  initiateMicrosoftOAuth,
  setMicrosoftAccountLabel,
  setPrimaryMicrosoftAccount,
  type MsAccountDetail,
} from '../../../services/microsoftOAuth';
import {
  ACCOUNT_TYPE_BADGE,
  EXTERNAL_ADMIN_NOTE,
  NO_MS_CAPABILITIES,
  OTHER_ACCOUNTS_DISABLED_NOTE,
  accountNote,
  addAccountOptions,
  adminConsentUrl,
  type MsAccountType,
  type MsCapabilities,
} from '../../../lib/microsoftAccounts';
import { invalidateProviderCache } from '../../../services/connectedProvider';
import { Portal } from '../../shared/Portal';

function MicrosoftIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 23 23">
      <rect x="1" y="1" width="10" height="10" fill="#F25022" />
      <rect x="12" y="1" width="10" height="10" fill="#7FBA00" />
      <rect x="1" y="12" width="10" height="10" fill="#00A4EF" />
      <rect x="12" y="12" width="10" height="10" fill="#FFB900" />
    </svg>
  );
}

export function MicrosoftConnectionCard() {
  const { showToast } = useToast();
  const [accounts, setAccounts] = useState<MsAccountDetail[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [confirmDisconnect, setConfirmDisconnect] = useState<MsAccountDetail | null>(null);
  const [renaming, setRenaming] = useState<{ id: string; value: string } | null>(null);
  const [caps, setCaps] = useState<MsCapabilities>(NO_MS_CAPABILITIES);
  const [menuOpen, setMenuOpen] = useState(false);
  const [externalOpen, setExternalOpen] = useState(false);
  const [tenant, setTenant] = useState('');
  const [adminLink, setAdminLink] = useState<string | null>(null);
  const [clara, setClara] = useState<AgentMailbox | null>(null);

  const connected = accounts.length > 0;
  const hasReauth = accounts.some((a) => a.needsReauth);

  const load = async () => {
    try {
      const list = await getMicrosoftConnections();
      setAccounts(list);
      if (list.length > 0) setCaps(await getMicrosoftCapabilities());
    } catch (err) {
      logError('MicrosoftConnectionCard.load', err);
    }
    // Clara's mailbox is on her own user, so the per-user list above never contains it.
    setClara(await getAgentMailbox('clara').catch(() => null));
  };

  useEffect(() => {
    // Returning from the Microsoft sign-in redirect.
    const params = new URLSearchParams(window.location.search);
    if (params.get('microsoft_connected') === 'true') {
      invalidateProviderCache();
      showToast('success', `Microsoft 365 connected${params.get('email') ? ` as ${params.get('email')}` : ''}`);
      params.delete('microsoft_connected');
      params.delete('email');
      const qs = params.toString();
      window.history.replaceState({}, '', `${window.location.pathname}${qs ? `?${qs}` : ''}`);
    }
    load().finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** Starts Microsoft sign-in and leaves the page; `what` names the action in the error toast. */
  const startOAuth = async (what: string, agent?: string, opts?: Parameters<typeof initiateMicrosoftOAuth>[1]) => {
    setBusy(true);
    try {
      window.location.assign(await initiateMicrosoftOAuth(agent, opts));
    } catch (err) {
      logError(`MicrosoftConnectionCard.${what}`, err);
      showToast('warning', err instanceof Error ? err.message : 'Failed to start Microsoft sign-in');
      setBusy(false);
    }
  };

  const connect = () => startOAuth('connect');
  const addAccount = (accountType: MsAccountType) => {
    setMenuOpen(false);
    if (accountType === 'external') {
      setExternalOpen(true);
      return;
    }
    return startOAuth('add', undefined, { mode: 'add', accountType });
  };
  const continueExternal = () => startOAuth('addExternal', undefined, { mode: 'add', accountType: 'external' });
  /** Builds the admin approval link for a typed tenant; the client id comes from the sign-in URL. */
  const buildAdminLink = async () => {
    setBusy(true);
    try {
      const clientId = clientIdFromAuthUrl(await initiateMicrosoftOAuth(undefined, { mode: 'add', accountType: 'external' }));
      const link = adminConsentUrl(tenant, clientId);
      setAdminLink(link);
      if (!link) showToast('warning', 'Enter the tenant domain (contoso.com) or its ID to build the approval link');
    } catch (err) {
      logError('MicrosoftConnectionCard.adminLink', err);
      showToast('warning', err instanceof Error ? err.message : 'Failed to build the approval link');
    } finally {
      setBusy(false);
    }
  };
  const reconnect = (a: MsAccountDetail) => startOAuth('reconnect', undefined, { loginHint: a.email });
  const connectAgent = (agent: string) => startOAuth('connectAgent', agent);

  const disconnect = async (a: MsAccountDetail) => {
    setBusy(true);
    try {
      // An id equal to the email means the account list came from the pre-migration view: no id to send.
      await disconnectMicrosoft(a.id !== a.email ? a.id : undefined);
      setConfirmDisconnect(null);
      invalidateProviderCache();
      await load();
      showToast('success', `${a.email} disconnected`);
    } catch (err) {
      logError('MicrosoftConnectionCard.disconnect', err);
      showToast('warning', err instanceof Error ? err.message : 'Failed to disconnect Microsoft 365');
    } finally {
      setBusy(false);
    }
  };

  const makePrimary = async (a: MsAccountDetail) => {
    setBusy(true);
    try {
      await setPrimaryMicrosoftAccount(a.id);
      invalidateProviderCache();
      await load();
      showToast('success', `${a.email} is now the primary account`);
    } catch (err) {
      logError('MicrosoftConnectionCard.makePrimary', err);
      showToast('warning', err instanceof Error ? err.message : 'Failed to change the primary account');
    } finally {
      setBusy(false);
    }
  };

  const saveLabel = async () => {
    if (!renaming) return;
    setBusy(true);
    try {
      await setMicrosoftAccountLabel(renaming.id, renaming.value);
      setRenaming(null);
      invalidateProviderCache();
      await load();
    } catch (err) {
      logError('MicrosoftConnectionCard.saveLabel', err);
      showToast('warning', err instanceof Error ? err.message : 'Failed to rename the account');
    } finally {
      setBusy(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-8">
        <Loader2 className="w-6 h-6 text-hud-gold-soft animate-spin" />
      </div>
    );
  }

  const multi = accounts.length > 1;

  return (
    <div className="bg-hud-bg-mid rounded-xl border border-hud-bg-card p-6">
      <div className="flex items-start gap-4">
        <div className="p-3 rounded-xl bg-white">
          <MicrosoftIcon className="w-8 h-8" />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1">
            <h3 className="text-lg font-semibold text-white">Microsoft 365</h3>
            {connected && !hasReauth && (
              <span className="flex items-center gap-1 px-2 py-0.5 text-xs font-medium rounded-full bg-hud-emerald/20 text-hud-emerald">
                <CheckCircle className="w-3 h-3" /> Connected
              </span>
            )}
          </div>

          {!connected && (
            <p className="text-sm text-hud-cream-dim mb-4">
              Connect Outlook mail and calendar. Pick the account on the Microsoft sign-in page.
            </p>
          )}

          <div className="grid grid-cols-2 gap-3 mb-4">
            {[
              { icon: Mail, name: 'Outlook Mail', desc: 'Send and receive emails' },
              { icon: Calendar, name: 'Outlook Calendar', desc: 'Events, booking and busy times' },
              { icon: HardDrive, name: 'SharePoint / OneDrive', desc: 'Browse and attach files' },
              { icon: Video, name: 'Teams', desc: 'Meeting transcripts and chat' },
            ].map(({ icon: Icon, name, desc }) => (
              <div
                key={name}
                className={`flex items-center gap-2 p-3 rounded-lg border ${
                  connected ? 'bg-hud-emerald/5 border-hud-emerald/20' : 'bg-hud-bg-card/50 border-hud-bg-elev'
                }`}
              >
                <Icon className={`w-4 h-4 ${connected ? 'text-hud-emerald' : 'text-hud-cream-mute'}`} />
                <div>
                  <p className={`text-sm font-medium ${connected ? 'text-white' : 'text-hud-cream-dim'}`}>{name}</p>
                  <p className="text-xs text-hud-cream-mute">{desc}</p>
                </div>
              </div>
            ))}
          </div>

          {connected && (
            <ul className="space-y-3 mb-4" aria-label="Connected Microsoft accounts">
              {accounts.map((a) => (
                <li key={a.id} className="p-3 rounded-lg border border-hud-bg-elev bg-hud-bg-card/40">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-sm text-white font-medium truncate">{a.email}</span>
                        {a.label && <span className="text-xs text-hud-cream-dim">{a.label}</span>}
                        {a.accountType !== 'work' && (
                          <span className="px-2 py-0.5 text-xs rounded-full bg-hud-bg-elev text-hud-cream-dim">
                            {ACCOUNT_TYPE_BADGE[a.accountType]}
                          </span>
                        )}
                        {a.isPrimary && (
                          <span className="inline-flex items-center gap-1 px-2 py-0.5 text-xs rounded-full bg-hud-gold/20 text-hud-gold-soft">
                            <Star className="w-3 h-3" /> Primary
                          </span>
                        )}
                        {a.needsReauth && (
                          <span className="px-2 py-0.5 text-xs rounded-full bg-hud-rust/20 text-hud-rust">Needs reconnect</span>
                        )}
                      </div>
                      {accountNote(a.accountType) && (
                        <p className="mt-1 text-xs text-hud-cream-mute">{accountNote(a.accountType)}</p>
                      )}
                      {a.syncStatus === 'syncing' && (
                        <span className="flex items-center gap-1.5 mt-1 text-xs text-hud-gold-soft">
                          <RefreshCw size={12} className="animate-spin" /> Syncing...
                        </span>
                      )}
                      {a.lastSyncAt && (
                        <p className="mt-1 text-xs text-hud-cream-mute">Mail last synced: {new Date(a.lastSyncAt).toLocaleString()}</p>
                      )}
                      {a.syncStatus === 'error' && a.error && <p className="mt-1 text-xs text-hud-plum">Sync error: {a.error}</p>}
                    </div>
                    <div className="flex flex-wrap justify-end gap-2 shrink-0">
                      {a.needsReauth && (
                        <button
                          onClick={() => reconnect(a)}
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
                        {multi ? 'Disconnect' : 'Disconnect Microsoft'}
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
                        placeholder="Label, e.g. Work or Sales"
                        aria-label="Account label"
                        className="flex-1 px-3 py-1.5 rounded-lg bg-hud-bg-card border border-hud-bg-elev text-white text-sm placeholder-hud-cream-dim focus:outline-none focus:ring-2 focus:ring-hud-gold"
                      />
                      <button type="submit" disabled={busy} className="px-3 py-1.5 rounded-lg bg-hud-gold text-black text-xs font-medium disabled:opacity-50">Save</button>
                      <button type="button" onClick={() => setRenaming(null)} className="px-3 py-1.5 rounded-lg bg-hud-bg-card text-white text-xs">Cancel</button>
                    </form>
                  )}
                </li>
              ))}
            </ul>
          )}

          {connected ? (
            <div className="relative inline-block">
              <button
                onClick={() => setMenuOpen((o) => !o)}
                disabled={busy}
                aria-haspopup="menu"
                aria-expanded={menuOpen}
                className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-hud-bg-card text-white hover:bg-hud-bg-elev transition-colors text-sm font-medium disabled:opacity-50"
              >
                {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />}
                Add account
                <ChevronDown className="w-4 h-4" />
              </button>
              {menuOpen && (
                <div role="menu" className="absolute z-10 mt-2 w-80 rounded-lg border border-hud-bg-elev bg-hud-bg-mid p-1 shadow-lg">
                  {addAccountOptions(caps).map((o) => (
                    <button
                      key={o.type}
                      role="menuitem"
                      onClick={() => void addAccount(o.type)}
                      className="block w-full text-left px-3 py-2 rounded text-sm text-white hover:bg-hud-bg-card"
                    >
                      {o.label}
                    </button>
                  ))}
                  {!caps.external && !caps.personal && (
                    <p className="px-3 py-2 text-xs text-hud-cream-mute">{OTHER_ACCOUNTS_DISABLED_NOTE}</p>
                  )}
                </div>
              )}
            </div>
          ) : (
            <button
              onClick={connect}
              disabled={busy}
              className="inline-flex items-center gap-2 px-5 py-2.5 rounded-lg bg-white text-hud-bg-mid hover:bg-hud-cream transition-colors text-sm font-semibold shadow-lg shadow-white/5 disabled:opacity-50"
            >
              {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <MicrosoftIcon className="w-4 h-4" />}
              {busy ? 'Redirecting...' : 'Connect Microsoft 365'}
            </button>
          )}
        </div>
      </div>

      {externalOpen && (
        <div className="mt-4 p-3 rounded-lg border border-hud-bg-elev bg-hud-bg-card/40">
          <p className="text-sm text-hud-cream-dim mb-2">{EXTERNAL_ADMIN_NOTE}</p>
          <div className="flex flex-wrap items-center gap-2">
            <input
              value={tenant}
              onChange={(e) => { setTenant(e.target.value); setAdminLink(null); }}
              placeholder="Tenant domain or ID (optional), e.g. contoso.com"
              aria-label="Tenant domain or ID"
              className="flex-1 min-w-[14rem] px-3 py-1.5 rounded-lg bg-hud-bg-card border border-hud-bg-elev text-white text-sm placeholder-hud-cream-dim focus:outline-none focus:ring-2 focus:ring-hud-gold"
            />
            {tenant.trim() && (
              <button onClick={() => void buildAdminLink()} disabled={busy} className="px-3 py-1.5 rounded-lg bg-hud-bg-card text-white text-xs disabled:opacity-50">
                Get admin approval link
              </button>
            )}
            <button onClick={continueExternal} disabled={busy} className="px-3 py-1.5 rounded-lg bg-hud-gold text-black text-xs font-medium disabled:opacity-50">
              Continue to Microsoft
            </button>
            <button onClick={() => { setExternalOpen(false); setAdminLink(null); }} className="px-3 py-1.5 rounded-lg bg-hud-bg-card text-white text-xs">
              Cancel
            </button>
          </div>
          {adminLink && (
            <p className="mt-2 text-xs break-all">
              <a href={adminLink} target="_blank" rel="noreferrer" className="text-hud-gold-soft underline">{adminLink}</a>
            </p>
          )}
        </div>
      )}

      <div className="mt-5 pt-4 border-t border-hud-bg-card flex items-center justify-between gap-4">
        {clara ? (
          <div className="text-xs">
            <p className="text-hud-cream-mute">
              Clara's mailbox: <span className="text-white">{clara.email}</span>{' '}
              <span className={clara.connected ? 'text-hud-emerald' : 'text-hud-rust'}>
                {clara.connected ? 'Connected' : clara.needsReauth ? 'Needs reconnecting' : 'Not active'}
              </span>
            </p>
            {clara.lastSyncAt && <p className="mt-0.5 text-hud-cream-mute">Mail last synced: {new Date(clara.lastSyncAt).toLocaleString()}</p>}
            {clara.error && !clara.connected && <p className="mt-0.5 text-hud-rust break-words">{clara.error}</p>}
          </div>
        ) : (
          <p className="text-xs text-hud-cream-mute">
            Agent mailbox (SuperAdmin): attach Clara's own Microsoft account (sign in as her on the next screen).
          </p>
        )}
        <button
          onClick={() => connectAgent('clara')}
          disabled={busy}
          className="shrink-0 px-3 py-1.5 rounded-lg bg-hud-bg-card text-white hover:bg-hud-bg-elev transition-colors text-xs font-medium disabled:opacity-50"
        >
          {clara ? 'Reconnect Clara' : "Connect Clara's mailbox"}
        </button>
      </div>

      {confirmDisconnect && (
        <Portal><div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50 backdrop-blur-sm">
          <div className="bg-hud-bg-mid rounded-xl border border-hud-bg-card p-6 max-w-md w-full">
            <h3 className="text-lg font-semibold text-white mb-2">
              {multi ? `Disconnect ${confirmDisconnect.email}?` : 'Disconnect Microsoft 365?'}
            </h3>
            <p className="text-sm text-hud-cream-dim mb-6">
              Mail and calendar sync for {confirmDisconnect.email} will stop and its calendar busy times are removed.
              Previously synced messages remain in the CRM.
              {confirmDisconnect.isPrimary && multi && ' Another account becomes the primary.'}
            </p>
            <div className="flex justify-end gap-3">
              <button
                onClick={() => setConfirmDisconnect(null)}
                className="px-4 py-2 rounded-lg bg-hud-bg-card text-white hover:bg-hud-bg-elev transition-colors text-sm font-medium"
              >
                Cancel
              </button>
              <button
                onClick={() => disconnect(confirmDisconnect)}
                disabled={busy}
                className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-hud-plum text-white transition-colors text-sm font-medium disabled:opacity-50"
              >
                {busy && <Loader2 className="w-4 h-4 animate-spin" />}
                Disconnect
              </button>
            </div>
          </div>
        </div></Portal>
      )}
    </div>
  );
}
