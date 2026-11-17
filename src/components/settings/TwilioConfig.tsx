import { useState, useEffect, useCallback } from 'react';
import {
  Copy, Check, AlertCircle, Loader2,
  Phone, MessageSquare, RefreshCw, User as UserIcon, Trash2,
  ChevronDown, ChevronRight, Wifi, WifiOff, Info,
} from 'lucide-react';
import { useAuth } from '../../contexts/AuthContext';
import { supabase } from '../../lib/supabase';
import {
  getTwilioStatus, testTwilio, type TwilioConnection,
} from '../../services/twilioConnection';
import {
  listTwilioNumbers, syncTwilioNumbers, updateTwilioAssignment, deleteTwilioNumber,
  type TwilioNumber, type TwilioSmsRoute,
} from '../../services/twilioNumbers';
import { TwilioAccountNumbersPanel } from './TwilioAccountNumbersPanel';

interface UserOption { id: string; name: string; email: string; }

const selectClass =
  'w-full px-2 py-1.5 text-xs rounded bg-hud-bg-card border border-hud-bg-elev text-white ' +
  'focus:outline-none focus:ring-2 focus:ring-hud-gold focus:border-transparent ' +
  'disabled:opacity-50 disabled:bg-hud-bg-mid disabled:text-hud-cream-mute';
const cardClass = 'bg-hud-bg-mid rounded-xl border border-hud-bg-card';
const primaryBtn =
  'inline-flex items-center gap-2 px-4 py-2 text-sm font-medium rounded-lg ' +
  'bg-gradient-to-r from-hud-gold to-hud-teal text-white ' +
  'hover:from-hud-gold-deep hover:to-hud-teal disabled:opacity-50 disabled:cursor-not-allowed transition-colors';
const subtleBtn =
  'inline-flex items-center gap-2 px-3 py-1.5 text-sm rounded-lg ' +
  'bg-hud-bg-card text-hud-cream-soft hover:bg-hud-bg-elev border border-hud-bg-elev ' +
  'disabled:opacity-50 disabled:cursor-not-allowed transition-colors';

export function TwilioConfig() {
  const { user, isSuperAdmin } = useAuth();
  const orgId = user?.organization_id;

  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  const [envConfigured, setEnvConfigured] = useState(false);
  const [connection, setConnection] = useState<TwilioConnection | null>(null);

  const [numbers, setNumbers] = useState<TwilioNumber[]>([]);
  const [users, setUsers] = useState<UserOption[]>([]);

  const [showWebhookUrls, setShowWebhookUrls] = useState(false);

  const webhookBaseUrl = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1`;

  const load = useCallback(async () => {
    if (!orgId) return;
    setLoading(true);
    try {
      const [status, nums, usersData] = await Promise.all([
        getTwilioStatus(orgId).catch(() => ({ envConfigured: false, connection: null })),
        listTwilioNumbers(orgId).catch(() => []),
        supabase.from('users').select('id, name, email').eq('organization_id', orgId).order('name'),
      ]);
      setEnvConfigured(status.envConfigured);
      setConnection(status.connection);
      setNumbers(nums);
      setUsers((usersData.data as UserOption[]) || []);
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  }, [orgId]);

  useEffect(() => { load(); }, [load]);

  function flash(msg: string, kind: 'success' | 'error' = 'success') {
    if (kind === 'success') {
      setSuccess(msg);
      setTimeout(() => setSuccess(null), 3000);
    } else {
      setError(msg);
      setTimeout(() => setError(null), 5000);
    }
  }

  async function handleTest() {
    if (!orgId) return;
    setSubmitting(true);
    try {
      const r = await testTwilio(orgId);
      if (r.ok) {
        flash(`Twilio credentials valid · ${r.account?.friendly_name ?? r.account?.sid ?? ''}`);
      } else {
        flash(r.error ?? 'Twilio test failed', 'error');
      }
      await load();
    } finally {
      setSubmitting(false);
    }
  }

  async function handleSync() {
    if (!orgId) return;
    setSubmitting(true);
    try {
      const r = await syncTwilioNumbers(orgId);
      flash(`Refreshed ${r.updated} number${r.updated === 1 ? '' : 's'} from Twilio`);
      await load();
    } catch (e) {
      flash(e instanceof Error ? e.message : 'Refresh failed', 'error');
    } finally {
      setSubmitting(false);
    }
  }

  async function handleAssignmentChange(num: TwilioNumber, patch: {
    smsRoute?: TwilioSmsRoute; assignedUserId?: string | null;
    agentLabel?: string | null;
  }) {
    if (!orgId) return;
    setSubmitting(true);
    try {
      const dbPatch: Parameters<typeof updateTwilioAssignment>[1]['patch'] = {};
      if (patch.smsRoute !== undefined) dbPatch.sms_route = patch.smsRoute;
      if (patch.assignedUserId !== undefined) dbPatch.assigned_user_id = patch.assignedUserId;
      if (patch.agentLabel !== undefined) dbPatch.agent_label = patch.agentLabel;
      const updated = await updateTwilioAssignment(orgId, { numberId: num.id, patch: dbPatch });
      setNumbers(prev => prev.map(n => n.id === num.id ? { ...n, ...updated } : n));
    } catch (e) {
      flash(e instanceof Error ? e.message : 'Update failed', 'error');
    } finally {
      setSubmitting(false);
    }
  }

  async function handleDelete(num: TwilioNumber) {
    if (!orgId) return;
    if (!confirm(`Remove ${num.phone_number} from this org's number list? Re-sync to add it back.`)) return;
    setSubmitting(true);
    try {
      await deleteTwilioNumber(orgId, num.id);
      await load();
    } finally {
      setSubmitting(false);
    }
  }

  function copy(text: string, key: string) {
    navigator.clipboard.writeText(text);
    setCopied(key);
    setTimeout(() => setCopied(null), 2000);
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="w-8 h-8 animate-spin text-hud-cream-mute" />
      </div>
    );
  }

  const connected = envConfigured && connection?.status === 'connected';

  return (
    <div className="space-y-6">
      {error && (
        <div className="flex items-center gap-2 p-3 rounded-lg bg-hud-plum/10 border border-hud-plum/30 text-hud-plum text-sm">
          <AlertCircle size={16} className="flex-shrink-0" /> {error}
        </div>
      )}
      {success && (
        <div className="flex items-center gap-2 p-3 rounded-lg bg-hud-emerald/10 border border-hud-emerald/30 text-hud-emerald text-sm">
          <Check size={16} className="flex-shrink-0" /> {success}
        </div>
      )}

      {/* Super-admin importer (location assignment for the whole Twilio account) */}
      {isSuperAdmin && envConfigured && <TwilioAccountNumbersPanel />}

      {/* Connection status */}
      <div className={cardClass}>
        <div className="p-4 border-b border-hud-bg-card">
          <h3 className="text-lg font-semibold text-white">Connection</h3>
          <p className="text-xs text-hud-cream-dim mt-1">
            Twilio credentials are managed as platform-wide environment variables
            (<code className="px-1 bg-hud-bg-card rounded text-[10px]">TWILIO_ACCOUNT_SID</code>{' '}
            and <code className="px-1 bg-hud-bg-card rounded text-[10px]">TWILIO_AUTH_TOKEN</code>).
            Set them in your Supabase project secrets.
          </p>
        </div>
        <div className="p-4 space-y-3">
          {!envConfigured ? (
            <div className="flex items-start gap-2 p-3 rounded-lg bg-hud-rust/10 border border-hud-rust/30">
              <AlertCircle size={16} className="text-hud-rust flex-shrink-0 mt-0.5" />
              <div className="text-sm text-hud-rust/25">
                <strong>Env vars not configured.</strong>{' '}
                Set <code className="px-1 bg-hud-rust/10 rounded text-xs">TWILIO_ACCOUNT_SID</code>{' '}
                and <code className="px-1 bg-hud-rust/10 rounded text-xs">TWILIO_AUTH_TOKEN</code>{' '}
                with <code className="px-1 bg-hud-rust/10 rounded text-xs">supabase secrets set</code>,
                then refresh.
              </div>
            </div>
          ) : connected ? (
            <div className="space-y-3">
              <div className="flex items-center gap-2 text-sm flex-wrap">
                <span className="inline-flex items-center gap-1 text-hud-emerald bg-hud-emerald/10 border border-hud-emerald/30 px-2 py-0.5 rounded-full text-xs font-medium">
                  <Check size={12} /> Connected
                </span>
                <span className="text-hud-cream-soft">{connection?.friendly_name || connection?.account_sid}</span>
                {connection?.connected_at && (
                  <span className="text-xs text-hud-cream-mute">
                    · since {new Date(connection.connected_at).toLocaleDateString()}
                  </span>
                )}
              </div>
              <div className="flex gap-2">
                <button onClick={handleTest} disabled={submitting} className={subtleBtn}>
                  {submitting ? <Loader2 size={14} className="animate-spin" /> : null}
                  Test
                </button>
              </div>
            </div>
          ) : (
            <div className="space-y-3">
              <div className="text-sm text-hud-cream-dim">
                Env vars present, but the connection hasn't been validated yet.
              </div>
              <button onClick={handleTest} disabled={submitting} className={primaryBtn}>
                {submitting ? <Loader2 size={14} className="animate-spin" /> : null}
                Test connection
              </button>
            </div>
          )}
        </div>
      </div>

      {/* Numbers + assignments */}
      {connected && (
        <div className={`${cardClass} overflow-hidden`}>
          <div className="p-4 border-b border-hud-bg-card flex items-center justify-between">
            <div>
              <h3 className="text-lg font-semibold text-white">Phone Numbers</h3>
              <p className="text-xs text-hud-cream-dim mt-0.5">
                {numbers.length} assigned to this organization
              </p>
            </div>
            <button onClick={handleSync} disabled={submitting || numbers.length === 0} className={primaryBtn}>
              {submitting ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
              Refresh metadata
            </button>
          </div>

          {numbers.length === 0 ? (
            <div className="p-8 text-center text-sm text-hud-cream-dim">
              {isSuperAdmin
                ? <>No numbers assigned to this organization yet. Use <strong className="text-hud-cream-soft">Twilio Account Numbers</strong> above to import and assign.</>
                : <>No numbers assigned to this organization yet. A super admin must import and assign numbers from the Twilio account.</>}
            </div>
          ) : (
            <div className="divide-y divide-hud-bg-card">
              {numbers.map(num => (
                <div key={num.id} className="p-4">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="text-sm font-semibold text-white">{num.phone_number}</div>
                      <div className="text-xs text-hud-cream-dim mt-1 flex items-center gap-3 flex-wrap">
                        {num.capabilities.sms && <span className="inline-flex items-center gap-1"><MessageSquare size={11} /> SMS</span>}
                        {num.capabilities.mms && <span className="inline-flex items-center gap-1"><MessageSquare size={11} /> MMS</span>}
                        {num.capabilities.voice && <span className="inline-flex items-center gap-1"><Phone size={11} /> Voice</span>}
                        {num.country_code && <span>· {num.country_code}</span>}
                        <span className={`px-1.5 py-0.5 rounded text-[10px] uppercase tracking-wide font-medium ${
                          num.status === 'active'
                            ? 'bg-hud-emerald/10 text-hud-emerald border border-hud-emerald/30'
                            : 'bg-hud-bg-card text-hud-cream-mute border border-hud-bg-elev'
                        }`}>
                          {num.status}
                        </span>
                        {num.webhook_configured ? (
                          <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] bg-hud-emerald/10 text-hud-emerald border border-hud-emerald/30">
                            <Wifi size={11} /> Webhooks configured
                          </span>
                        ) : (
                          <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] bg-hud-rust/10 text-hud-rust border border-hud-rust/30">
                            <WifiOff size={11} /> Webhooks pending (set manually in Twilio console)
                          </span>
                        )}
                      </div>
                    </div>
                    <button onClick={() => handleDelete(num)} disabled={submitting}
                      className="p-1.5 text-hud-cream-mute hover:text-hud-plum rounded transition-colors">
                      <Trash2 size={14} />
                    </button>
                  </div>

                  <div className="mt-3 grid grid-cols-1 gap-3">
                    {/* SMS routing */}
                    <div className="rounded-lg border border-hud-bg-card bg-hud-bg-deep/40 p-3">
                      <div className="flex items-center gap-1.5 text-xs font-medium text-hud-cream-soft mb-2">
                        <MessageSquare size={12} /> SMS routing
                      </div>
                      <select value={num.sms_route} disabled={submitting}
                        onChange={e => handleAssignmentChange(num, { smsRoute: e.target.value as TwilioSmsRoute })}
                        className={selectClass}>
                        <option value="clara">Clara (auto-reply)</option>
                        <option value="user">User inbox</option>
                        <option value="external">External AI agent (mirror)</option>
                      </select>
                      {num.sms_route === 'external' && (
                        <>
                          <input
                            type="text"
                            defaultValue={num.agent_label || ''}
                            disabled={submitting}
                            placeholder="Agent name (e.g. Friday)"
                            onBlur={e => {
                              const v = e.target.value.trim();
                              if (v !== (num.agent_label || '')) {
                                handleAssignmentChange(num, { agentLabel: v || null });
                              }
                            }}
                            className={`${selectClass} mt-2`}
                          />
                          <div className="text-[10px] text-hud-cream-mute mt-1.5">
                            Traffic is mirrored from Twilio every 2 min and shown read-only.
                            Leave this number's Twilio webhook pointed at the agent's platform.
                          </div>
                        </>
                      )}
                      {num.sms_route === 'user' && (
                        <select value={num.assigned_user_id || ''} disabled={submitting}
                          onChange={e => handleAssignmentChange(num, { smsRoute: 'user', assignedUserId: e.target.value || null })}
                          className={`${selectClass} mt-2`}>
                          <option value="">Choose a user…</option>
                          {users.map(u => (
                            <option key={u.id} value={u.id}>{u.name || u.email}</option>
                          ))}
                        </select>
                      )}
                      {num.sms_route === 'user' && num.assigned_user && (
                        <div className="text-[10px] text-hud-cream-mute mt-1.5 inline-flex items-center gap-1">
                          <UserIcon size={10} /> Owned by {num.assigned_user.name}
                        </div>
                      )}
                    </div>

                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Webhook URLs (manual configuration in Twilio console) */}
      {connected && (
        <div className={cardClass}>
          <div className="p-4 space-y-3">
            <div className="flex items-start gap-2">
              <Info size={16} className="text-hud-gold-soft mt-0.5 flex-shrink-0" />
              <div className="flex-1">
                <h3 className="text-sm font-semibold text-white">Webhook URLs</h3>
                <p className="text-xs text-hud-cream-dim mt-1">
                  In your Twilio console, point each number's messaging + voice webhooks at the
                  URLs below. Twilio doesn't expose webhook configuration via the API for
                  fully-verified numbers, so this is a manual step.
                </p>
              </div>
            </div>
            <button
              onClick={() => setShowWebhookUrls(!showWebhookUrls)}
              className="text-xs text-hud-gold-soft hover:text-hud-gold-soft inline-flex items-center gap-1"
            >
              {showWebhookUrls ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
              {showWebhookUrls ? 'Hide URLs' : 'Show URLs'}
            </button>
            {showWebhookUrls && (
              <div className="space-y-2 pt-2 border-t border-hud-bg-card">
                {[
                  { label: 'Inbound SMS (Messaging Webhook)', path: '/twilio-sms-inbound', key: 'sms' },
                  { label: 'SMS Status Callback', path: '/twilio-sms-status', key: 'sms-status' },
                  { label: 'Inbound Voice — Clara (Answer URL)', path: '/clara-voice', key: 'voice' },
                  { label: 'Voice Fallback URL', path: '/twilio-voice-fallback', key: 'voice-fallback' },
                  { label: 'Voice Status / Hangup Callback — Clara', path: '/clara-voice-status', key: 'voice-status' },
                ].map(w => (
                  <div key={w.key}>
                    <label className="block text-xs font-medium text-hud-cream-dim mb-1">{w.label}</label>
                    <div className="flex items-center gap-2">
                      <code className="flex-1 px-3 py-2 bg-hud-bg-card border border-hud-bg-elev rounded text-xs text-hud-cream-soft overflow-x-auto">
                        {webhookBaseUrl}{w.path}
                      </code>
                      <button onClick={() => copy(`${webhookBaseUrl}${w.path}`, w.key)}
                        className="p-2 text-hud-cream-dim hover:text-hud-cream-soft rounded transition-colors">
                        {copied === w.key ? <Check size={16} className="text-hud-emerald" /> : <Copy size={16} />}
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
