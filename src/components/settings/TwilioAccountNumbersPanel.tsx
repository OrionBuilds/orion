import { useState, useEffect, useCallback } from 'react';
import {
  RefreshCw, Loader2, AlertCircle, Check, Phone, MessageSquare, Shield, Building2,
} from 'lucide-react';
import { useAuth } from '../../contexts/AuthContext';
import { supabase } from '../../lib/supabase';
import {
  listAccountNumbers, assignNumberToOrg, unassignNumber,
  type TwilioAccountNumber,
} from '../../services/twilioNumbers';

interface OrgOption {
  id: string;
  name: string;
  display_name: string | null;
}

const cardClass = 'bg-hud-bg-mid rounded-xl border border-hud-gold/30';
const primaryBtn =
  'inline-flex items-center gap-2 px-4 py-2 text-sm font-medium rounded-lg ' +
  'bg-gradient-to-r from-hud-gold to-hud-teal text-white ' +
  'hover:from-hud-gold-deep hover:to-hud-teal disabled:opacity-50 disabled:cursor-not-allowed transition-colors';
const selectClass =
  'px-2 py-1.5 text-xs rounded bg-hud-bg-card border border-hud-bg-elev text-white ' +
  'focus:outline-none focus:ring-2 focus:ring-hud-gold focus:border-transparent ' +
  'disabled:opacity-50';

/**
 * TwilioAccountNumbersPanel — super-admin-only importer that lists every
 * IncomingPhoneNumber in the platform's Twilio account and lets the super
 * admin assign each to a location (organization).
 *
 * Once assigned, the number is visible in that org's Phone System page
 * where org admins can configure routing (SMS → Clara/user).
 */
export function TwilioAccountNumbersPanel() {
  const { isSuperAdmin } = useAuth();

  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [savingSid, setSavingSid] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const [numbers, setNumbers] = useState<TwilioAccountNumber[]>([]);
  const [orgs, setOrgs] = useState<OrgOption[]>([]);

  const load = useCallback(async () => {
    if (!isSuperAdmin) return;
    setLoading(true);
    setError(null);
    try {
      const [accountNumbers, orgsRes] = await Promise.all([
        listAccountNumbers(),
        supabase
          .from('organizations')
          .select('id, name, display_name')
          .order('display_name', { ascending: true, nullsFirst: false }),
      ]);
      setNumbers(accountNumbers);
      setOrgs((orgsRes.data as OrgOption[]) ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load Twilio numbers');
    } finally {
      setLoading(false);
    }
  }, [isSuperAdmin]);

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

  async function handleRefresh() {
    setRefreshing(true);
    try {
      await load();
      flash('Refreshed from Twilio account');
    } catch (e) {
      flash(e instanceof Error ? e.message : 'Refresh failed', 'error');
    } finally {
      setRefreshing(false);
    }
  }

  async function handleAssignmentChange(num: TwilioAccountNumber, newOrgId: string) {
    setSavingSid(num.sid);
    setError(null);
    try {
      if (newOrgId === '') {
        await unassignNumber(num.sid);
        flash(`${num.phone_number} unassigned`);
      } else {
        await assignNumberToOrg(num.sid, newOrgId);
        const org = orgs.find((o) => o.id === newOrgId);
        flash(`${num.phone_number} assigned to ${org?.display_name ?? org?.name ?? 'org'}`);
      }
      await load();
    } catch (e) {
      flash(e instanceof Error ? e.message : 'Assignment failed', 'error');
    } finally {
      setSavingSid(null);
    }
  }

  if (!isSuperAdmin) return null;

  if (loading) {
    return (
      <div className={`${cardClass} p-6 flex items-center justify-center`}>
        <Loader2 className="w-6 h-6 animate-spin text-hud-gold-soft" />
      </div>
    );
  }

  const orgLabel = (o: OrgOption) => o.display_name || o.name;
  const assignedCount = numbers.filter((n) => n.assigned_org_id !== null).length;
  const unassignedCount = numbers.length - assignedCount;

  return (
    <div className={cardClass}>
      <div className="p-4 border-b border-hud-gold/30 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Shield className="w-4 h-4 text-hud-gold-soft" />
          <div>
            <h3 className="text-lg font-semibold text-white">Twilio Account Numbers</h3>
            <p className="text-xs text-hud-cream-dim mt-0.5">
              <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-hud-gold/10 border border-hud-gold/30 text-hud-gold-soft mr-1.5">
                Super admin
              </span>
              {numbers.length} number{numbers.length === 1 ? '' : 's'} · {assignedCount} assigned · {unassignedCount} unassigned
            </p>
          </div>
        </div>
        <button onClick={handleRefresh} disabled={refreshing} className={primaryBtn}>
          {refreshing ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
          Refresh from Twilio
        </button>
      </div>

      {error && (
        <div className="m-4 flex items-center gap-2 p-3 rounded-lg bg-hud-plum/10 border border-hud-plum/30 text-hud-plum text-sm">
          <AlertCircle size={16} className="flex-shrink-0" /> {error}
        </div>
      )}
      {success && (
        <div className="m-4 flex items-center gap-2 p-3 rounded-lg bg-hud-emerald/10 border border-hud-emerald/30 text-hud-emerald text-sm">
          <Check size={16} className="flex-shrink-0" /> {success}
        </div>
      )}

      {numbers.length === 0 ? (
        <div className="p-8 text-center text-sm text-hud-cream-dim">
          No numbers found in the Twilio account. Buy a number in the Twilio Console first,
          then click <strong className="text-hud-cream-soft">Refresh from Twilio</strong>.
        </div>
      ) : (
        <div className="divide-y divide-hud-bg-card">
          {numbers.map((num) => (
            <div key={num.sid} className="p-4 flex items-start justify-between gap-4">
              <div className="min-w-0 flex-1">
                <div className="text-sm font-semibold text-white">{num.phone_number}</div>
                {num.friendly_name && num.friendly_name !== num.phone_number && (
                  <div className="text-xs text-hud-cream-mute mt-0.5">{num.friendly_name}</div>
                )}
                <div className="text-xs text-hud-cream-dim mt-1 flex items-center gap-3 flex-wrap">
                  {num.capabilities.sms && (
                    <span className="inline-flex items-center gap-1">
                      <MessageSquare size={11} /> SMS
                    </span>
                  )}
                  {num.capabilities.mms && (
                    <span className="inline-flex items-center gap-1">
                      <MessageSquare size={11} /> MMS
                    </span>
                  )}
                  {num.capabilities.voice && (
                    <span className="inline-flex items-center gap-1">
                      <Phone size={11} /> Voice
                    </span>
                  )}
                  <span className="font-mono text-[10px] text-hud-cream-mute truncate" title={num.sid}>
                    {num.sid}
                  </span>
                </div>
              </div>

              <div className="flex flex-col items-end gap-1 w-72">
                <label className="text-[10px] text-hud-cream-mute uppercase tracking-wide flex items-center gap-1">
                  <Building2 size={10} /> Location
                </label>
                <select
                  value={num.assigned_org_id ?? ''}
                  disabled={savingSid === num.sid}
                  onChange={(e) => handleAssignmentChange(num, e.target.value)}
                  className={`${selectClass} w-full`}
                >
                  <option value="">— Unassigned —</option>
                  {orgs.map((o) => (
                    <option key={o.id} value={o.id}>
                      {orgLabel(o)}
                    </option>
                  ))}
                </select>
                {num.assigned_org_id && (
                  <div className="text-[10px] text-hud-emerald inline-flex items-center gap-1">
                    <Check size={10} /> Assigned to {num.assigned_org_name ?? 'an org'}
                  </div>
                )}
                {savingSid === num.sid && (
                  <div className="text-[10px] text-hud-gold-soft inline-flex items-center gap-1">
                    <Loader2 size={10} className="animate-spin" /> Saving…
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
