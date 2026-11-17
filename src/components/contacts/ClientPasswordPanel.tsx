import { useState, useEffect, useCallback } from 'react';
import { KeyRound, Lock, Unlock, RefreshCw, Loader2, Copy, Check } from 'lucide-react';
import { supabase } from '../../lib/supabase';

// Admin-only panel on the contact card. The password is a server-generated random 6-digit
// number the agents require before discussing this client's projects/reports/requests.
// The value is shown exactly once at generation — only its bcrypt hash is stored, in a
// deny-all-RLS table reachable solely through SECURITY DEFINER RPCs
// (migration 20260817061000_contact_voice_credentials.sql).

interface PinStatus {
  has_pin: boolean;
  admin_locked?: boolean;
  set_at?: string;
  last_verified_at?: string | null;
  locked_until?: string | null;
}

interface Props {
  contactId: string;
  /** Render nothing unless the signed-in user is Admin/SuperAdmin (the RPCs enforce it server-side too). */
  isAdmin: boolean;
}

export function ClientPasswordPanel({ contactId, isAdmin }: Props) {
  const [status, setStatus] = useState<PinStatus | null>(null);
  const [freshPin, setFreshPin] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadStatus = useCallback(async () => {
    const { data, error: err } = await supabase.rpc('get_contact_voice_pin_status', {
      p_contact_id: contactId,
    });
    if (!err && data) setStatus(data as PinStatus);
  }, [contactId]);

  useEffect(() => {
    if (isAdmin) loadStatus();
  }, [isAdmin, loadStatus]);

  if (!isAdmin) return null;

  async function regenerate() {
    if (status?.has_pin && !window.confirm('Generate a new password? The current one stops working immediately.')) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const { data, error: err } = await supabase.rpc('admin_regenerate_contact_voice_pin', {
        p_contact_id: contactId,
      });
      if (err) throw new Error(err.message);
      setFreshPin((data as { pin: string }).pin);
      await loadStatus();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to generate password');
    } finally {
      setBusy(false);
    }
  }

  async function toggleLock() {
    if (!status?.has_pin) return;
    setBusy(true);
    setError(null);
    try {
      const { error: err } = await supabase.rpc('admin_set_contact_voice_pin_lock', {
        p_contact_id: contactId,
        p_locked: !status.admin_locked,
      });
      if (err) throw new Error(err.message);
      await loadStatus();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to update lock');
    } finally {
      setBusy(false);
    }
  }

  function copyPin() {
    if (!freshPin) return;
    navigator.clipboard.writeText(freshPin).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }

  const autoLocked = !!(status?.locked_until && new Date(status.locked_until) > new Date());

  return (
    <div className="bg-hud-bg-mid rounded-xl border border-hud-bg-card p-4">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <KeyRound className="w-4 h-4 text-hud-gold-soft" />
          <h3 className="text-sm font-semibold text-white">Client Password</h3>
        </div>
        {status?.has_pin && (
          <span
            className={`px-2 py-0.5 rounded text-[11px] font-medium ${
              status.admin_locked
                ? 'bg-hud-plum/15 text-hud-plum'
                : autoLocked
                ? 'bg-amber-500/15 text-amber-400'
                : 'bg-hud-teal/15 text-hud-teal'
            }`}
          >
            {status.admin_locked ? 'LOCKED' : autoLocked ? 'AUTO-LOCKED' : 'ACTIVE'}
          </span>
        )}
      </div>

      {error && <p className="text-xs text-hud-plum mb-2">{error}</p>}

      {freshPin && (
        <div className="mb-3 p-3 bg-hud-gold/10 border border-hud-gold/30 rounded-lg">
          <p className="text-[11px] text-hud-cream-dim mb-1">
            New password — shown once, relay it to the client now:
          </p>
          <div className="flex items-center justify-between">
            <span className="text-xl font-mono font-bold tracking-[0.3em] text-white">{freshPin}</span>
            <button
              onClick={copyPin}
              className="p-1.5 rounded hover:bg-hud-bg-card transition-colors"
              title="Copy"
            >
              {copied ? (
                <Check className="w-4 h-4 text-hud-teal" />
              ) : (
                <Copy className="w-4 h-4 text-hud-cream-dim" />
              )}
            </button>
          </div>
        </div>
      )}

      <p className="text-xs text-hud-cream-mute mb-3">
        {status?.has_pin
          ? `Agents require this before discussing this client's projects, reports, or requests.${
              status.last_verified_at
                ? ` Last verified ${new Date(status.last_verified_at).toLocaleDateString()}.`
                : ' Never used yet.'
            }`
          : 'No password set. Agents will not discuss project details with this client over the phone until one exists.'}
      </p>

      <div className="flex gap-2">
        <button
          onClick={regenerate}
          disabled={busy}
          className="flex-1 flex items-center justify-center gap-1.5 px-3 py-2 bg-hud-gold-deep hover:bg-hud-gold-deep text-white rounded-lg text-xs font-medium disabled:opacity-50 transition-colors"
        >
          {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
          {status?.has_pin ? 'Regenerate' : 'Generate'}
        </button>
        {status?.has_pin && (
          <button
            onClick={toggleLock}
            disabled={busy}
            className="flex items-center justify-center gap-1.5 px-3 py-2 bg-hud-bg-card hover:bg-hud-bg-elev border border-hud-bg-elev text-hud-cream-soft rounded-lg text-xs font-medium disabled:opacity-50 transition-colors"
          >
            {status.admin_locked ? <Unlock className="w-3.5 h-3.5" /> : <Lock className="w-3.5 h-3.5" />}
            {status.admin_locked ? 'Unlock' : 'Lock'}
          </button>
        )}
      </div>
    </div>
  );
}
