/** Start a CAIO engagement on a project: kickoff date, client name, sponsor and register owner. */
import { useState, type FormEvent } from 'react';
import { Loader2, Play } from 'lucide-react';
import { startEngagement, todayIso } from '../../services/caio';
import { getErrorMessage } from '../../lib/errors';
import { ErrorBox } from './ui';
import { btnPrimary, inputCls, labelCls } from './styles';

export interface StartEngagementProps {
  projectId: string;
  /** Prefill for the client's legal name (the project contact's company). */
  defaultClientName?: string;
  canManage: boolean;
  onStarted: () => void;
}

export function StartEngagement({ projectId, defaultClientName = '', canManage, onStarted }: StartEngagementProps) {
  const [kickoff, setKickoff] = useState(todayIso());
  const [client, setClient] = useState(defaultClientName);
  const [sponsor, setSponsor] = useState('');
  const [owner, setOwner] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await startEngagement(projectId, {
        kickoff, clientLegalName: client.trim() || undefined, executiveSponsor: sponsor.trim() || undefined, registerOwner: owner.trim() || undefined,
      });
      onStarted();
    } catch (err) {
      setError(getErrorMessage(err, 'Could not start the engagement'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="max-w-2xl space-y-4 p-6">
      <div>
        <h3 className="text-base font-semibold text-white">No CAIO engagement on this project yet</h3>
        <p className="mt-1 text-sm text-hud-cream-dim">
          An engagement is the Fractional CAIO delivery for one client: their 17 governance registers, the 40 deliverable documents and
          five delivery gates (Day 30, 60, 90, Month 6 and Month 12) with an acceptance checklist each. Starting one gives it an engagement
          code and dates the gates from the kickoff date.
        </p>
      </div>
      {!canManage ? (
        <p className="rounded-lg border border-dashed border-hud-line-soft px-3 py-4 text-sm text-hud-cream-mute">Only someone who can manage CAIO delivery can start an engagement.</p>
      ) : (
        <form onSubmit={submit} className="space-y-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <label htmlFor="caio-kickoff" className={labelCls}>Kickoff date</label>
              <input id="caio-kickoff" type="date" required value={kickoff} onChange={(e) => setKickoff(e.target.value)} className={inputCls} />
            </div>
            <div>
              <label htmlFor="caio-client" className={labelCls}>Client legal name</label>
              <input id="caio-client" value={client} onChange={(e) => setClient(e.target.value)} placeholder="Defaults to the contact" className={inputCls} />
            </div>
            <div>
              <label htmlFor="caio-sponsor" className={labelCls}>Executive sponsor</label>
              <input id="caio-sponsor" value={sponsor} onChange={(e) => setSponsor(e.target.value)} className={inputCls} />
            </div>
            <div>
              <label htmlFor="caio-owner" className={labelCls}>Register owner</label>
              <input id="caio-owner" value={owner} onChange={(e) => setOwner(e.target.value)} className={inputCls} />
            </div>
          </div>
          {error && <ErrorBox message={error} />}
          <button type="submit" disabled={busy || !kickoff} className={btnPrimary}>
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />} Start CAIO engagement
          </button>
        </form>
      )}
    </div>
  );
}

export default StartEngagement;
