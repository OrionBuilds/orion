/** Engagement settings: names, kickoff, status, notes and the client portal switch. */
import { useEffect, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { Loader2 } from 'lucide-react';
import { Panel } from '../agent-health/ui';
import { Switch } from '../factory/ui';
import { getErrorMessage } from '../../lib/errors';
import { updateEngagement, type Engagement, type EngagementPatch, type EngagementStatus } from '../../services/caio';
import { ErrorBox } from './ui';
import { AutomationCard } from './AutomationCard';
import { btnPrimary, inputCls, labelCls, linkCls } from './styles';

export interface SettingsPanelProps { engagement: Engagement; canManage: boolean; onSaved: (e: Engagement) => void }

export function SettingsPanel({ engagement, canManage, onSaved }: SettingsPanelProps) {
  const [client, setClient] = useState(engagement.client_legal_name);
  const [sponsor, setSponsor] = useState(engagement.executive_sponsor);
  const [owner, setOwner] = useState(engagement.register_owner);
  const [kickoff, setKickoff] = useState(engagement.kickoff_date.slice(0, 10));
  const [status, setStatus] = useState<EngagementStatus>(engagement.status);
  const [notes, setNotes] = useState(engagement.notes ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    setClient(engagement.client_legal_name);
    setSponsor(engagement.executive_sponsor);
    setOwner(engagement.register_owner);
    setKickoff(engagement.kickoff_date.slice(0, 10));
    setStatus(engagement.status);
    setNotes(engagement.notes ?? '');
  }, [engagement]);

  const save = async (patch: EngagementPatch, done: string) => {
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      await updateEngagement(engagement.id, patch);
      onSaved({ ...engagement, ...patch });
      setMessage(done);
    } catch (e) {
      setError(getErrorMessage(e, 'Could not save the settings'));
    } finally {
      setBusy(false);
    }
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!client.trim() || !kickoff) { setError('Client legal name and kickoff date are required.'); return; }
    void save({
      client_legal_name: client.trim(), executive_sponsor: sponsor.trim(), register_owner: owner.trim(), kickoff_date: kickoff, status, notes,
    }, 'Settings saved.');
  };

  const kickoffChanged = kickoff !== engagement.kickoff_date.slice(0, 10);
  const off = !canManage || busy;

  return (
    <div className="space-y-4">
      <Panel title="Engagement">
        <form onSubmit={submit} className="space-y-3">
          <p className="text-xs text-hud-cream-mute">
            Code <span className="font-hud-mono text-hud-cream-soft">{engagement.engagement_code}</span> · id <span className="font-hud-mono">{engagement.id}</span> ·{' '}
            <Link to={`/projects/${engagement.project_id}?tab=overview`} className={linkCls}>Open the project</Link>
          </p>
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <label htmlFor="set-client" className={labelCls}>Client legal name</label>
              <input id="set-client" value={client} disabled={off} onChange={(e) => setClient(e.target.value)} className={inputCls} />
            </div>
            <div>
              <label htmlFor="set-status" className={labelCls}>Status</label>
              <select id="set-status" value={status} disabled={off} onChange={(e) => setStatus(e.target.value as EngagementStatus)} className={inputCls}>
                <option value="active">Active</option>
                <option value="paused">Paused</option>
                <option value="completed">Completed</option>
              </select>
            </div>
            <div>
              <label htmlFor="set-sponsor" className={labelCls}>Executive sponsor</label>
              <input id="set-sponsor" value={sponsor} disabled={off} onChange={(e) => setSponsor(e.target.value)} className={inputCls} />
            </div>
            <div>
              <label htmlFor="set-owner" className={labelCls}>Register owner</label>
              <input id="set-owner" value={owner} disabled={off} onChange={(e) => setOwner(e.target.value)} className={inputCls} />
            </div>
            <div>
              <label htmlFor="set-kickoff" className={labelCls}>Kickoff date</label>
              <input id="set-kickoff" type="date" value={kickoff} disabled={off} onChange={(e) => setKickoff(e.target.value)} className={inputCls} />
              {kickoffChanged && <p className="mt-1 text-xs text-hud-rust">Changing the kickoff date does not move gates that are already dated. Edit those on the Gates tab if needed.</p>}
            </div>
          </div>
          <div>
            <label htmlFor="set-notes" className={labelCls}>Notes</label>
            <textarea id="set-notes" rows={4} value={notes} disabled={off} onChange={(e) => setNotes(e.target.value)} className={inputCls} />
          </div>
          {error && <ErrorBox message={error} />}
          {message && <p className="text-xs text-hud-emerald" role="status">{message}</p>}
          {canManage
            ? <button type="submit" disabled={busy} className={btnPrimary}>{busy && <Loader2 className="h-4 w-4 animate-spin" />} Save settings</button>
            : <p className="text-xs text-hud-cream-mute">View only: you need CAIO manage access to change settings.</p>}
        </form>
      </Panel>

      <AutomationCard engagement={engagement} canManage={canManage} />

      <Panel title="Client portal">
        <div className="flex items-start justify-between gap-4">
          <div className="space-y-2 text-sm text-hud-cream-soft">
            <p>
              When on, the client can see this engagement in their portal: the <strong>approved documents</strong> and the <strong>register rows you
              marked visible</strong>, plus gate dates and status only (never the acceptance notes or decisions).
            </p>
            <p className="text-hud-cream-dim">
              Turning it on shares nothing by itself. Each document and register row stays hidden from the client until you publish it individually.
            </p>
          </div>
          <Switch checked={engagement.portal_enabled} disabled={off} label="Client portal"
            onChange={(next) => void save({ portal_enabled: next }, next ? 'Client portal turned on.' : 'Client portal turned off.')} />
        </div>
      </Panel>
    </div>
  );
}

export default SettingsPanel;
