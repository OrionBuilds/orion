/** Company profile: the fact catalog grouped, with status, source, evidence and inline edit/confirm. */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Check, Pencil } from 'lucide-react';
import { Panel } from '../agent-health/ui';
import { getErrorMessage } from '../../lib/errors';
import type { Engagement } from '../../services/caio';
import { confirmFact, listFactDefs, listFacts, saveFact, type Fact, type FactDef } from '../../services/caioAutomation';
import { ErrorBox, ToneBadge } from './ui';
import { btnGhost, btnPrimary, inputCls } from './styles';
import { groupBy, profileReadiness } from './automationLogic';

export interface CompanyProfilePanelProps { engagement: Engagement; canManage: boolean }

const GROUP_LABEL: Record<string, string> = {
  company: 'Company', data_classes: 'Data classes', finance: 'Finance', leadership: 'Leadership', operations: 'Operations', rules: 'Rules and obligations', stack: 'Technology stack',
};
const groupLabel = (g: string) => GROUP_LABEL[g] ?? g.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());

const SOURCE_LABEL: Record<string, string> = {
  user: 'entered by you', interview: 'from an interview or document', public_research: 'from public web, unverified', crm: 'from the CRM', computed: 'computed',
};

export function CompanyProfilePanel({ engagement, canManage }: CompanyProfilePanelProps) {
  const [defs, setDefs] = useState<FactDef[] | null>(null);
  const [facts, setFacts] = useState<Fact[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [d, f] = await Promise.all([listFactDefs(), listFacts(engagement.id)]);
      setDefs(d); setFacts(f); setError(null);
    } catch (e) {
      setError(getErrorMessage(e, 'Could not load the company profile'));
      setDefs((cur) => cur ?? []);
    }
  }, [engagement.id]);
  useEffect(() => { void load(); }, [load]);

  const byKey = useMemo(() => new Map(facts.map((f) => [f.fact_key, f])), [facts]);
  const groups = useMemo(() => groupBy(defs ?? [], (d) => d.grp), [defs]);
  const ready = useMemo(() => profileReadiness(defs ?? [], facts), [defs, facts]);

  const act = async (key: string, fn: () => Promise<void>) => {
    setBusy(key); setError(null);
    try { await fn(); setEditing(null); await load(); } catch (e) { setError(getErrorMessage(e, 'Could not save')); } finally { setBusy(null); }
  };

  const startEdit = (def: FactDef, fact?: Fact) => { setEditing(def.fact_key); setDraft(fact?.value ?? ''); };
  const pct = ready.total ? Math.round((ready.confirmed / ready.total) * 100) : 0;

  return (
    <div className="space-y-4">
      <Panel title="Profile progress">
        {defs === null ? <p className="text-sm text-hud-cream-mute" role="status">Loading the company profile...</p> : (
          <div className="space-y-2">
            <p className="text-sm text-hud-cream-soft">
              <span className="font-hud-mono text-lg text-white">{ready.confirmed} of {ready.total}</span> minimum facts confirmed
              {ready.ready ? ': the Days 1-30 set is ready to draft.' : ': the Days 1-30 set drafts automatically once all are confirmed.'}
            </p>
            <div role="progressbar" aria-label="Minimum facts confirmed" aria-valuemin={0} aria-valuemax={ready.total} aria-valuenow={ready.confirmed}
              className="h-2 w-full overflow-hidden rounded-full bg-hud-bg-elev">
              <div className="h-full bg-hud-gold transition-all" style={{ width: `${pct}%` }} />
            </div>
          </div>
        )}
      </Panel>

      {error && <ErrorBox message={error} />}

      {defs !== null && defs.length === 0 && !error && (
        <div className="rounded-xl border border-dashed border-hud-line-soft py-10 text-center text-sm text-hud-cream-mute">The fact catalog is empty.</div>
      )}

      {groups.map((g) => (
        <Panel key={g.key} title={groupLabel(g.key)}>
          <ul className="divide-y divide-hud-line-soft">
            {g.items.map((def) => {
              const fact = byKey.get(def.fact_key);
              const isEditing = editing === def.fact_key;
              const unverified = fact?.source === 'public_research' && fact.status !== 'confirmed';
              const rowBusy = busy === def.fact_key;
              return (
                <li key={def.fact_key} className="space-y-1.5 py-3">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="text-sm font-medium text-white">
                        {def.label}{def.profile_minimum && <span className="ml-2 text-[11px] font-normal text-hud-cream-mute">minimum</span>}
                      </div>
                      {def.help && <div className="text-xs text-hud-cream-mute">{def.help}</div>}
                    </div>
                    <div className="flex items-center gap-2">
                      {!fact && <ToneBadge tone="muted">not set</ToneBadge>}
                      {fact?.status === 'confirmed' && <ToneBadge tone="good">confirmed</ToneBadge>}
                      {fact?.status === 'proposed' && <ToneBadge tone="warn">proposed</ToneBadge>}
                      {fact?.status === 'stale' && <ToneBadge tone="warn">stale</ToneBadge>}
                      {unverified && <ToneBadge tone="bad">unverified public research</ToneBadge>}
                    </div>
                  </div>

                  {isEditing ? (
                    <form className="space-y-2" onSubmit={(e) => { e.preventDefault(); if (draft.trim()) void act(def.fact_key, () => saveFact(engagement.org_id, engagement.id, def.fact_key, draft)); }}>
                      {def.type === 'longtext'
                        ? <textarea className={inputCls} rows={3} aria-label={def.label} value={draft} onChange={(e) => setDraft(e.target.value)} />
                        : <input className={inputCls} aria-label={def.label} type={def.type === 'number' ? 'number' : def.type === 'date' ? 'date' : 'text'} value={draft} onChange={(e) => setDraft(e.target.value)} />}
                      <div className="flex gap-2">
                        <button type="submit" className={btnPrimary} disabled={rowBusy || !draft.trim()}>{rowBusy ? 'Saving...' : 'Save as confirmed'}</button>
                        <button type="button" className={btnGhost} disabled={rowBusy} onClick={() => setEditing(null)}>Cancel</button>
                      </div>
                    </form>
                  ) : fact ? (
                    <div className="space-y-1">
                      <p className="whitespace-pre-wrap break-words text-sm text-hud-cream-soft">{fact.value}</p>
                      <p className="text-xs text-hud-cream-mute">Source: {SOURCE_LABEL[fact.source] ?? fact.source}{unverified ? '. Confirm only after checking it yourself.' : ''}</p>
                      {fact.evidence_quote && <blockquote className="border-l-2 border-hud-gold/50 pl-3 text-xs italic text-hud-cream-dim">{fact.evidence_quote}</blockquote>}
                    </div>
                  ) : null}

                  {canManage && !isEditing && (
                    <div className="flex flex-wrap gap-2">
                      {fact?.status === 'proposed' && (
                        <button type="button" className={btnPrimary} disabled={rowBusy} aria-label={`Confirm ${def.label}`}
                          onClick={() => void act(def.fact_key, () => confirmFact(fact.id))}><Check className="h-4 w-4" />Confirm</button>
                      )}
                      <button type="button" className={btnGhost} aria-label={`${fact ? 'Edit' : 'Set'} ${def.label}`} onClick={() => startEdit(def, fact)}>
                        <Pencil className="h-4 w-4" />{fact ? 'Edit' : 'Set value'}
                      </button>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        </Panel>
      ))}
    </div>
  );
}

export default CompanyProfilePanel;
