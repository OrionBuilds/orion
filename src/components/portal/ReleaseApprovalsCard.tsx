import { useEffect, useState } from 'react';
import { Rocket, ChevronDown, CheckCircle2, Clock } from 'lucide-react';
import {
  portalListReleaseApprovals,
  portalDecideReleaseApproval,
  type PortalReleaseApproval,
} from '../../services/clientPortal';
import { PortalStepUpModal } from './PortalStepUpModal';

/** "Build ready for your review" — the client's per-build go-live sign-off.
 *  Rendered on the portal home. Hidden entirely when nothing is pending. */
export function ReleaseApprovalsCard() {
  const [items, setItems] = useState<PortalReleaseApproval[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // A decision awaiting a fresh OTP: retried verbatim once step-up succeeds.
  const [stepUp, setStepUp] = useState<{ id: string; decision: 'approve' | 'reject' } | null>(null);

  const load = () => {
    portalListReleaseApprovals()
      .then((rows) => setItems(Array.isArray(rows) ? rows : []))
      .catch(() => { /* keep last-known; card just stays hidden if empty */ })
      .finally(() => setLoaded(true));
  };
  useEffect(() => { load(); }, []);

  const pending = items.filter((r) => r.status === 'pending');
  if (!loaded || pending.length === 0) return null;

  async function decide(id: string, decision: 'approve' | 'reject') {
    setBusyId(id);
    setError(null);
    try {
      await portalDecideReleaseApproval(id, decision);
      setItems((prev) => prev.map((r) => (r.id === id ? { ...r, status: decision === 'approve' ? 'approved' : 'rejected' } : r)));
    } catch (err) {
      if (err instanceof Error && err.message.includes('step_up_required')) {
        setStepUp({ id, decision });
      } else {
        setError(err instanceof Error ? err.message : 'Something went wrong');
      }
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="bg-hud-bg-elev rounded-2xl border border-hud-gold/40">
      <div className="flex items-center gap-2 px-6 py-4 border-b border-hud-cream">
        <Rocket className="w-4 h-4 text-hud-gold" />
        <h3 className="text-sm font-semibold text-hud-cream-soft">Ready for your review</h3>
        <span className="ml-auto text-xs text-hud-cream-dim">{pending.length} awaiting sign-off</span>
      </div>
      <div className="px-6 py-4 space-y-3">
        {error && <p className="text-xs text-hud-rust">{error}</p>}
        {pending.map((r) => {
          const open = expanded.has(r.id);
          const busy = busyId === r.id;
          return (
            <div key={r.id} className="rounded-xl border border-hud-line bg-hud-bg-mid/40 p-4">
              <div className="flex items-start gap-2">
                <div className="flex-1 min-w-0">
                  <p className="text-sm text-hud-cream-soft font-medium leading-snug">{r.title}</p>
                  <p className="text-xs text-hud-cream-dim mt-0.5 flex items-center gap-1">
                    <Clock className="w-3 h-3" />
                    {new Date(r.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
                  </p>
                </div>
                {r.changelog && (
                  <button
                    onClick={() => setExpanded((p) => { const n = new Set(p); if (n.has(r.id)) n.delete(r.id); else n.add(r.id); return n; })}
                    className="text-hud-cream-dim hover:text-hud-gold p-1"
                    aria-label="Toggle details"
                  >
                    <ChevronDown className={`w-4 h-4 transition-transform ${open ? 'rotate-180' : ''}`} />
                  </button>
                )}
              </div>
              {open && r.changelog && (
                <p className="text-xs text-hud-cream-mute leading-relaxed mt-2 whitespace-pre-line">{r.changelog}</p>
              )}
              <div className="flex items-center gap-2 mt-3">
                <button
                  onClick={() => void decide(r.id, 'approve')}
                  disabled={busy}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-hud-gold/90 hover:bg-hud-gold text-hud-bg-card text-xs font-medium transition-colors disabled:opacity-60"
                >
                  <CheckCircle2 className="w-3.5 h-3.5" />
                  {busy ? 'Working…' : 'Approve for launch'}
                </button>
                <button
                  onClick={() => void decide(r.id, 'reject')}
                  disabled={busy}
                  className="px-3 py-1.5 rounded-lg border border-hud-line text-hud-cream-dim hover:text-hud-cream-soft text-xs transition-colors disabled:opacity-60"
                >
                  Not yet
                </button>
              </div>
            </div>
          );
        })}
      </div>

      {stepUp && (
        <PortalStepUpModal
          actionLabel={stepUp.decision === 'approve' ? 'approving this build' : 'declining this build'}
          onSuccess={() => { const s = stepUp; setStepUp(null); if (s) void decide(s.id, s.decision); }}
          onCancel={() => setStepUp(null)}
        />
      )}
    </div>
  );
}
