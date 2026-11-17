import { useEffect, useState } from 'react';
import { CheckCircle2, Loader2, Send } from 'lucide-react';
import { useAuth } from '../../contexts/AuthContext';
import { supabase } from '../../lib/supabase';
import { updateOrganization } from '../../services/organizations';

/**
 * Org setting: may AI agents (FRIDAY, …) contact this org's clients? Off by default. When off,
 * no agent-originated client notice goes out: "ready for your review" emails, delivery emails,
 * and anything else an agent would send a client. An agent's own local setting can only turn it
 * further off, never on. Portal comments staff post themselves are unaffected.
 */
export function AgentClientCommsSettings({ canManage }: { canManage: boolean }) {
  const { user } = useAuth();
  const orgId = user?.organization?.id ?? user?.organization_id ?? null;
  const [enabled, setEnabled] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => {
    if (!orgId) return;
    let cancelled = false;
    supabase.from('organizations').select('agent_client_comms_enabled').eq('id', orgId).maybeSingle()
      .then(({ data, error }) => {
        if (cancelled) return;
        if (error) setMessage({ ok: false, text: error.message });
        else setEnabled((data as { agent_client_comms_enabled?: boolean } | null)?.agent_client_comms_enabled === true);
        setLoading(false);
      });
    return () => { cancelled = true; };
  }, [orgId]);

  const toggle = async () => {
    if (!orgId || !user || !canManage) return;
    const next = !enabled;
    setSaving(true);
    setMessage(null);
    try {
      await updateOrganization(orgId, { agent_client_comms_enabled: next }, user);
      setEnabled(next);
      setMessage({ ok: true, text: next ? 'Agents may now contact clients.' : 'Agents will not contact clients.' });
    } catch (e) {
      setMessage({ ok: false, text: e instanceof Error ? e.message : 'Failed to save' });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="bg-hud-bg-mid rounded-xl border border-hud-bg-card">
      <div className="p-4 border-b border-hud-bg-card">
        <h3 className="text-lg font-semibold text-white flex items-center gap-2">
          <Send className="w-5 h-5 text-hud-gold" />
          Let agents contact clients
        </h3>
        <p className="text-sm text-hud-cream-dim mt-1">
          When this is off (the default), AI agents never reach your clients on their own: no
          "ready for your review" emails and no agent emails to clients. Reviews still appear in
          the client's portal, and everything that is sent is logged in Conversations.
        </p>
      </div>
      <div className="p-4 flex items-center gap-3">
        {loading ? (
          <span className="flex items-center gap-2 text-sm text-hud-cream-dim"><Loader2 className="w-4 h-4 animate-spin" /> Loading...</span>
        ) : (
          <>
            <button
              type="button"
              role="switch"
              aria-checked={enabled}
              aria-label="Let agents contact clients"
              disabled={!canManage || saving}
              onClick={() => void toggle()}
              className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${enabled ? 'bg-hud-gold' : 'bg-hud-bg-card'}`}
            >
              <span className={`inline-block h-5 w-5 transform rounded-full bg-white transition-transform ${enabled ? 'translate-x-5' : 'translate-x-0.5'}`} />
            </button>
            <span className="text-sm text-white">{enabled ? 'On: agents may contact clients' : 'Off: agents never contact clients'}</span>
            {saving && <Loader2 className="w-4 h-4 animate-spin text-hud-cream-dim" />}
            {!canManage && <span className="text-xs text-hud-cream-mute">Only admins can change this.</span>}
          </>
        )}
        {message && (
          <span className={`text-sm flex items-center gap-1.5 ml-auto ${message.ok ? 'text-emerald-400' : 'text-rose-400'}`}>
            {message.ok && <CheckCircle2 className="w-4 h-4" />}{message.text}
          </span>
        )}
      </div>
    </div>
  );
}
