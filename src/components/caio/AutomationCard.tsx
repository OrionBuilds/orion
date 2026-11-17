/** Automatic drafting switch for one engagement, with queue health and a profile-readiness line (Settings and Overview). */
import { useCallback, useEffect, useState } from 'react';
import { Panel } from '../agent-health/ui';
import { Switch } from '../factory/ui';
import { getErrorMessage } from '../../lib/errors';
import type { Engagement } from '../../services/caio';
import {
  getAutomationEnabled, getProcessPersonalData, listActiveJobs, listFactDefs, listFacts, setAutomationEnabled, setProcessPersonalData, type GenerationJob,
} from '../../services/caioAutomation';
import { ErrorBox } from './ui';
import { btnGhost, linkCls } from './styles';
import { profileReadiness, summarizeJobs, type AnyNavigate } from './automationLogic';

export interface AutomationCardProps { engagement: Engagement; canManage: boolean; onNavigate?: AnyNavigate }

interface State {
  enabled: boolean;
  jobs: GenerationJob[];
  ready: { total: number; confirmed: number; ready: boolean };
  personalData: boolean;
}

export function AutomationCard({ engagement, canManage, onNavigate }: AutomationCardProps) {
  const [state, setState] = useState<State | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const [enabled, jobs, defs, facts, personalData] = await Promise.all([
        getAutomationEnabled(engagement.id), listActiveJobs(engagement.id), listFactDefs(), listFacts(engagement.id), getProcessPersonalData(engagement.id),
      ]);
      setState({ enabled, jobs, ready: profileReadiness(defs, facts), personalData });
      setError(null);
    } catch (e) {
      setError(getErrorMessage(e, 'Could not load the automation status'));
    }
  }, [engagement.id]);
  useEffect(() => { void load(); }, [load]);

  const toggle = async (on: boolean) => {
    setBusy(true);
    setError(null);
    try {
      await setAutomationEnabled(engagement.id, on);
      setState((s) => (s ? { ...s, enabled: on } : s));
    } catch (e) {
      setError(getErrorMessage(e, 'Could not change the automation switch'));
    } finally {
      setBusy(false);
    }
  };

  const togglePersonal = async (on: boolean) => {
    setBusy(true);
    setError(null);
    try {
      await setProcessPersonalData(engagement.id, on);
      setState((s) => (s ? { ...s, personalData: on } : s));
    } catch (e) {
      setError(getErrorMessage(e, 'Could not change the personal data setting'));
    } finally {
      setBusy(false);
    }
  };

  const summary = state ? summarizeJobs(state.jobs) : null;

  return (
    <Panel title="Automatic drafting">
      <div className="space-y-3">
        <div className="flex items-start justify-between gap-4">
          <p className="text-sm text-hud-cream-soft">
            When on, drafts are prepared automatically before each gate and on schedule. Nothing is approved or shown to the client without you.
          </p>
          <Switch checked={state?.enabled ?? false} disabled={!canManage || busy || !state} label="Automatic drafting" onChange={(on) => void toggle(on)} />
        </div>

        <div className="flex items-start justify-between gap-4 border-t border-hud-line-soft pt-3">
          <p className="text-sm text-hud-cream-soft">
            Process sources that contain personal data (Social Security-, account- or card-style numbers) without holding them for review.
            Their text is sent to the AI model for reading, and numbers like these are never copied into registers or documents. Passwords and keys are always held.
          </p>
          <Switch checked={state?.personalData ?? false} disabled={!canManage || busy || !state} label="Process sources with personal data" onChange={(on) => void togglePersonal(on)} />
        </div>

        {error && <ErrorBox message={error} />}
        {!state && !error && <p className="text-xs text-hud-cream-mute" role="status">Loading the automation status...</p>}

        {state && summary && (
          <>
            <p className="text-sm text-hud-cream-soft" role="status">
              {state.enabled ? 'Automatic drafting is on.' : 'Automatic drafting is off.'}{' '}
              Jobs: <span className="font-hud-mono">{summary.queued}</span> queued, <span className="font-hud-mono">{summary.running}</span> running,{' '}
              <span className={`font-hud-mono ${summary.failed ? 'text-hud-plum' : ''}`}>{summary.failed}</span> failed.
            </p>
            {summary.lastError && <p className="text-xs text-hud-plum">Last error: {summary.lastError}</p>}
            <p className="text-sm text-hud-cream-dim">
              {state.ready.ready
                ? 'Company profile is ready: all minimum facts are confirmed.'
                : `Company profile: ${state.ready.confirmed} of ${state.ready.total} minimum facts confirmed. The Days 1-30 set drafts automatically once all are confirmed.`}
              {onNavigate && <> <button type="button" className={linkCls} onClick={() => onNavigate('profile')}>Open the company profile</button></>}
            </p>
            {canManage && state.enabled && (
              <button type="button" className={btnGhost} disabled={busy} onClick={() => void toggle(false)}>Pause all</button>
            )}
          </>
        )}
      </div>
    </Panel>
  );
}

export default AutomationCard;
