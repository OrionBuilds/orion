/** Needs your input: what is missing, ranked by how many documents it blocks, with a quick way to supply it. */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Panel } from '../agent-health/ui';
import { getErrorMessage } from '../../lib/errors';
import { listTemplates, type CaioTemplateRow, type Engagement } from '../../services/caio';
import {
  dismissInputRequest, listFactDefs, listOpenInputRequests, resolveInputRequest, saveFact, type FactDef, type InputRequest,
} from '../../services/caioAutomation';
import { ErrorBox } from './ui';
import { btnGhost, btnPrimary, inputCls } from './styles';
import { blockedDocuments, rankInputRequests, type AnyNavigate } from './automationLogic';

export interface NeedsInputPanelProps { engagement: Engagement; canManage: boolean; onNavigate: AnyNavigate }

export function NeedsInputPanel({ engagement, canManage, onNavigate }: NeedsInputPanelProps) {
  const [requests, setRequests] = useState<InputRequest[] | null>(null);
  const [defs, setDefs] = useState<FactDef[]>([]);
  const [templates, setTemplates] = useState<CaioTemplateRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [values, setValues] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [r, d, t] = await Promise.all([listOpenInputRequests(engagement.id), listFactDefs(), listTemplates()]);
      setRequests(r); setDefs(d); setTemplates(t); setError(null);
    } catch (e) {
      setError(getErrorMessage(e, 'Could not load what needs your input'));
      setRequests((cur) => cur ?? []);
    }
  }, [engagement.id]);
  useEffect(() => { void load(); }, [load]);

  const ranked = useMemo(() => rankInputRequests(requests ?? []), [requests]);

  const act = async (id: string, fn: () => Promise<void>) => {
    setBusy(id); setError(null);
    try { await fn(); await load(); } catch (e) { setError(getErrorMessage(e, 'Could not save')); } finally { setBusy(null); }
  };

  return (
    <div className="space-y-4">
      {error && <ErrorBox message={error} />}
      {requests === null && <p className="text-sm text-hud-cream-mute" role="status">Loading...</p>}
      {requests !== null && ranked.length === 0 && !error && (
        <div className="rounded-xl border border-dashed border-hud-line-soft py-10 text-center text-sm text-hud-cream-mute">
          Nothing is waiting on you. Items appear here when a draft cannot be completed from what is already known.
        </div>
      )}
      <ul className="space-y-3">
        {ranked.map((r) => {
          const docs = blockedDocuments(r.blocks_templates, templates);
          const def = defs.find((d) => d.fact_key === r.key);
          const value = values[r.id] ?? '';
          return (
            <li key={r.id}>
              <Panel title={r.label}>
                <div className="space-y-2">
                  {r.why && <p className="text-sm text-hud-cream-soft">{r.why}</p>}
                  <p className="text-xs text-hud-cream-mute">Blocks {docs.length} document{docs.length === 1 ? '' : 's'}{docs.length ? ':' : '.'}</p>
                  {docs.length > 0 && (
                    <ul className="list-disc pl-5 text-xs text-hud-cream-dim">
                      {docs.map((d) => <li key={d.number}><span className="font-hud-mono">{String(d.number).padStart(2, '0')}</span> {d.title}</li>)}
                    </ul>
                  )}
                  {canManage && (
                    <div className="flex flex-wrap items-end gap-2 pt-1">
                      {r.kind === 'fact' ? (
                        <form className="flex flex-1 flex-wrap items-end gap-2" onSubmit={(e) => {
                          e.preventDefault();
                          if (value.trim()) void act(r.id, async () => { await saveFact(engagement.org_id, engagement.id, r.key, value); await resolveInputRequest(r.id); setValues((v) => ({ ...v, [r.id]: '' })); });
                        }}>
                          <div className="min-w-[14rem] flex-1">
                            {def?.help && <label htmlFor={`need-${r.id}`} className="mb-1 block text-xs text-hud-cream-dim">{def.help}</label>}
                            {def?.type === 'longtext'
                              ? <textarea id={`need-${r.id}`} rows={2} className={inputCls} aria-label={`Value for ${r.label}`} value={value} onChange={(e) => setValues({ ...values, [r.id]: e.target.value })} />
                              : <input id={`need-${r.id}`} className={inputCls} aria-label={`Value for ${r.label}`} type={def?.type === 'number' ? 'number' : def?.type === 'date' ? 'date' : 'text'}
                                value={value} onChange={(e) => setValues({ ...values, [r.id]: e.target.value })} />}
                          </div>
                          <button type="submit" className={btnPrimary} disabled={busy === r.id || !value.trim()}>Save as confirmed</button>
                        </form>
                      ) : (
                        <button type="button" className={btnPrimary} onClick={() => onNavigate('registers', { register: r.key })}>Open the {r.label} register</button>
                      )}
                      <button type="button" className={btnGhost} disabled={busy === r.id} onClick={() => void act(r.id, () => dismissInputRequest(r.id))}>Dismiss</button>
                    </div>
                  )}
                </div>
              </Panel>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

export default NeedsInputPanel;
