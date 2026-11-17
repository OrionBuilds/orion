import { useEffect, useState } from 'react';
import { Building2, CheckCircle2, Loader2 } from 'lucide-react';
import { useAuth } from '../../contexts/AuthContext';
import { supabase } from '../../lib/supabase';
import { updateOrganization } from '../../services/organizations';
import type { Organization } from '../../types';

type ProfileFields = Pick<
  Organization,
  'legal_name' | 'signatory_name' | 'signatory_title' | 'gov_company_profile' | 'gov_past_performance'
>;

const EMPTY: ProfileFields = {
  legal_name: '',
  signatory_name: '',
  signatory_title: '',
  gov_company_profile: '',
  gov_past_performance: '',
};

/**
 * Org setting: the company the AI proposal/contract generators write for. The legal name and
 * signatory pre-fill every contract's Signatures section; the company profile and past-performance
 * library are given to the model for government (SAM.gov) bids.
 */
export function CompanyProfileSettings({ canManage }: { canManage: boolean }) {
  const { user } = useAuth();
  const orgId = user?.organization?.id ?? user?.organization_id ?? null;
  const [fields, setFields] = useState<ProfileFields>(EMPTY);
  const [saved, setSaved] = useState<ProfileFields>(EMPTY);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => {
    if (!orgId) return;
    let cancelled = false;
    setLoading(true);
    supabase
      .from('organizations')
      .select('legal_name, signatory_name, signatory_title, gov_company_profile, gov_past_performance')
      .eq('id', orgId)
      .maybeSingle()
      .then(({ data, error }) => {
        if (cancelled) return;
        if (error) {
          setMessage({ ok: false, text: error.message });
        } else {
          const loaded = { ...EMPTY, ...Object.fromEntries(Object.entries(data ?? {}).map(([k, v]) => [k, v ?? ''])) };
          setFields(loaded);
          setSaved(loaded);
        }
        setLoading(false);
      });
    return () => { cancelled = true; };
  }, [orgId]);

  const set = (key: keyof ProfileFields) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
    setFields((prev) => ({ ...prev, [key]: e.target.value }));

  const handleSave = async () => {
    if (!orgId || !user) return;
    setSaving(true);
    setMessage(null);
    try {
      const updates = Object.fromEntries(
        Object.entries(fields).map(([k, v]) => [k, typeof v === 'string' && v.trim() ? v.trim() : null]),
      ) as Partial<Organization>;
      await updateOrganization(orgId, updates, user);
      setSaved(fields);
      setMessage({ ok: true, text: 'Saved. New proposals and contracts will use this profile.' });
    } catch (e) {
      setMessage({ ok: false, text: e instanceof Error ? e.message : 'Failed to save' });
    } finally {
      setSaving(false);
    }
  };

  const dirty = JSON.stringify(fields) !== JSON.stringify(saved);
  const inputClass =
    'w-full px-3 py-2 rounded-lg bg-hud-bg-card border border-hud-bg-elev text-white text-sm disabled:opacity-60';

  return (
    <div className="bg-hud-bg-mid rounded-xl border border-hud-bg-card">
      <div className="p-4 border-b border-hud-bg-card">
        <h3 className="text-lg font-semibold text-white flex items-center gap-2">
          <Building2 className="w-5 h-5 text-hud-gold" />
          Company profile
        </h3>
        <p className="text-sm text-hud-cream-dim mt-1">
          Used by the AI proposal and contract generators. The legal name and signatory pre-fill the
          Signatures section of every contract; the profile and past performance are used for government bids.
        </p>
      </div>
      <div className="p-4 space-y-4">
        {loading ? (
          <div className="flex items-center gap-2 text-sm text-hud-cream-dim"><Loader2 className="w-4 h-4 animate-spin" /> Loading...</div>
        ) : (
          <>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <label className="block">
                <span className="text-xs text-hud-cream-dim">Legal name</span>
                <input className={inputClass} value={fields.legal_name ?? ''} onChange={set('legal_name')} disabled={!canManage} placeholder="Acme Inc. DBA: Acme Labs" />
              </label>
              <label className="block">
                <span className="text-xs text-hud-cream-dim">Signatory name</span>
                <input className={inputClass} value={fields.signatory_name ?? ''} onChange={set('signatory_name')} disabled={!canManage} placeholder="Leave blank to sign manually" />
              </label>
              <label className="block">
                <span className="text-xs text-hud-cream-dim">Signatory title</span>
                <input className={inputClass} value={fields.signatory_title ?? ''} onChange={set('signatory_title')} disabled={!canManage} placeholder="CEO" />
              </label>
            </div>
            <label className="block">
              <span className="text-xs text-hud-cream-dim">Government company profile (NAICS codes, capabilities, differentiators, contact details)</span>
              <textarea className={`${inputClass} font-mono h-48`} value={fields.gov_company_profile ?? ''} onChange={set('gov_company_profile')} disabled={!canManage} />
            </label>
            <label className="block">
              <span className="text-xs text-hud-cream-dim">Past performance library (projects, clients, outcomes the AI may cite)</span>
              <textarea className={`${inputClass} font-mono h-48`} value={fields.gov_past_performance ?? ''} onChange={set('gov_past_performance')} disabled={!canManage} />
            </label>
          </>
        )}
        {message && (
          <p className={`text-sm flex items-center gap-1.5 ${message.ok ? 'text-emerald-400' : 'text-rose-400'}`}>
            {message.ok && <CheckCircle2 className="w-4 h-4" />}{message.text}
          </p>
        )}
        {canManage && !loading && (
          <div className="flex justify-end">
            <button
              onClick={handleSave}
              disabled={saving || !dirty}
              className="inline-flex items-center gap-2 px-5 py-2 rounded-lg bg-gradient-to-r from-hud-gold to-hud-teal text-white font-medium disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {saving && <Loader2 className="w-4 h-4 animate-spin" />}
              Save company profile
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
