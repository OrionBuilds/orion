/**
 * Delivery gates: acceptance checklist per gate (met, evidence link, note), the required templates, and the
 * decision (Accept / Needs remediation / Stop / Re-open). Saving writes the full conditions array; the database
 * enforces that unmet conditions need a written decision, and its message is shown as is.
 */
import { useEffect, useState } from 'react';
import { ChevronDown, ChevronRight, Loader2 } from 'lucide-react';
import { Panel } from '../agent-health/ui';
import { getErrorMessage } from '../../lib/errors';
import {
  gateAcceptBlockers, gateProgress, gateTone, listGateDefs, listGates, updateGate,
  type Engagement, type Gate, type GateCondition, type GateDef, type GateStatus,
} from '../../services/caio';
import { DueBadge, ErrorBox, ToneBadge, formatDate } from './ui';
import { btnDanger, btnGhost, btnPrimary, inputCls, labelCls, linkCls, type CaioNavigate } from './styles';

export interface GatesPanelProps { engagement: Engagement; canManage: boolean; onNavigate: CaioNavigate }

const STATUS_LABEL: Record<GateStatus, string> = { open: 'Open', accepted: 'Accepted', remediation: 'Needs remediation', stopped: 'Stopped' };

export function GatesPanel({ engagement, canManage, onNavigate }: GatesPanelProps) {
  const [gates, setGates] = useState<Gate[] | null>(null);
  const [defs, setDefs] = useState<GateDef[]>([]);
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    try {
      const [g, d] = await Promise.all([listGates(engagement.id), listGateDefs()]);
      setGates(g);
      setDefs(d);
      setError(null);
    } catch (e) {
      setError(getErrorMessage(e, 'Could not load the gates'));
    }
  };
  // eslint-disable-next-line react-hooks/exhaustive-deps -- reload only when the engagement changes
  useEffect(() => { void load(); }, [engagement.id]);

  if (error && !gates) return <ErrorBox message={error} />;
  if (!gates) return <p className="text-sm text-hud-cream-mute" role="status">Loading the gates...</p>;
  if (gates.length === 0) return <p className="rounded-lg border border-dashed border-hud-line-soft px-3 py-4 text-sm text-hud-cream-mute">No gates on this engagement.</p>;

  return (
    <div className="space-y-3">
      {!canManage && <p className="text-xs text-hud-cream-mute">View only: you need CAIO manage access to change gates.</p>}
      {gates.map((g) => (
        <GateCard key={g.id} gate={g} def={defs.find((d) => d.gate_key === g.gate_key)} canManage={canManage} onNavigate={onNavigate}
          defaultOpen={g.status === 'open' || g.status === 'remediation'} onSaved={load} />
      ))}
    </div>
  );
}

function GateCard({ gate, def, canManage, onNavigate, defaultOpen, onSaved }: {
  gate: Gate; def?: GateDef; canManage: boolean; onNavigate: CaioNavigate; defaultOpen: boolean; onSaved: () => Promise<void>;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const [conditions, setConditions] = useState<GateCondition[]>(gate.conditions);
  const [decidedBy, setDecidedBy] = useState(gate.decided_by ?? '');
  const [note, setNote] = useState(gate.decision_note ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  // Take the saved values again after a save/reload.
  useEffect(() => {
    setConditions(gate.conditions);
    setDecidedBy(gate.decided_by ?? '');
    setNote(gate.decision_note ?? '');
  }, [gate]);

  const draft = { ...gate, conditions, decided_by: decidedBy, decision_note: note };
  const { met, total } = gateProgress(draft);
  const blockers = gateAcceptBlockers(draft);
  const dirty = JSON.stringify(conditions) !== JSON.stringify(gate.conditions);
  const label = def?.label ?? gate.gate_key;
  const editable = canManage && !busy;

  const run = async (fn: () => Promise<void>, done: string) => {
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      await fn();
      await onSaved();
      setMessage(done);
    } catch (e) {
      setError(getErrorMessage(e, 'That did not save'));
    } finally {
      setBusy(false);
    }
  };

  const patchCondition = (i: number, p: Partial<GateCondition>) => setConditions((cs) => cs.map((c, j) => (j === i ? { ...c, ...p } : c)));
  const saveChecklist = () => run(() => updateGate(gate.id, { conditions }), 'Checklist saved.');
  const decide = (status: GateStatus, done: string) => run(
    () => updateGate(gate.id, { conditions, status, decided_by: decidedBy.trim() || null, decision_note: note.trim() || null }), done);
  const stop = () => {
    if (window.confirm(`Stop the ${label} gate? This records that the engagement does not proceed past it. You can re-open it later.`)) void decide('stopped', 'Gate stopped.');
  };

  return (
    <Panel>
      <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open} className="flex w-full flex-wrap items-center gap-2 text-left">
        {open ? <ChevronDown className="h-4 w-4 text-hud-cream-dim" /> : <ChevronRight className="h-4 w-4 text-hud-cream-dim" />}
        <span className="text-sm font-semibold text-white">{label}</span>
        <DueBadge date={gate.due_date} />
        <ToneBadge tone={gateTone(gate)}>{STATUS_LABEL[gate.status]}</ToneBadge>
        <span className="text-xs text-hud-cream-mute">{met}/{total} met</span>
      </button>

      {open && (
        <div className="mt-4 space-y-4">
          {def?.objective && <p className="text-sm text-hud-cream-soft"><span className="text-hud-cream-dim">Objective: </span>{def.objective}</p>}

          <section aria-label={`${label} acceptance conditions`}>
            <h4 className="mb-2 text-xs font-semibold uppercase tracking-wider text-hud-cream-dim">Acceptance conditions</h4>
            <ul className="space-y-3">
              {conditions.map((c, i) => (
                <li key={i} className="rounded-lg bg-hud-bg-card/60 p-3">
                  <label className="flex items-start gap-2 text-sm text-hud-cream-soft">
                    <input type="checkbox" checked={c.met} disabled={!editable} onChange={(e) => patchCondition(i, { met: e.target.checked })} className="mt-0.5 h-4 w-4 accent-hud-gold" />
                    <span>{c.text}</span>
                  </label>
                  {canManage ? (
                    <div className="mt-2 grid gap-2 sm:grid-cols-2">
                      <input aria-label={`Evidence link for condition ${i + 1}`} placeholder="Evidence link" value={c.evidence_link} disabled={!editable}
                        onChange={(e) => patchCondition(i, { evidence_link: e.target.value })} className={inputCls} />
                      <input aria-label={`Note for condition ${i + 1}`} placeholder="Note" value={c.note} disabled={!editable}
                        onChange={(e) => patchCondition(i, { note: e.target.value })} className={inputCls} />
                    </div>
                  ) : (c.evidence_link || c.note) && (
                    <p className="mt-1 pl-6 text-xs text-hud-cream-dim">
                      {c.evidence_link && /^https?:\/\//i.test(c.evidence_link)
                        ? <a href={c.evidence_link} target="_blank" rel="noopener noreferrer" className={linkCls}>Evidence</a>
                        : c.evidence_link}
                      {c.evidence_link && c.note ? ' · ' : ''}{c.note}
                    </p>
                  )}
                </li>
              ))}
            </ul>
            {canManage && (
              <button type="button" onClick={saveChecklist} disabled={!dirty || busy} className={`${btnGhost} mt-2`}>
                {busy && <Loader2 className="h-4 w-4 animate-spin" />} Save checklist
              </button>
            )}
          </section>

          {def && def.required_templates.length > 0 && (
            <section aria-label={`${label} required templates`}>
              <h4 className="mb-1 text-xs font-semibold uppercase tracking-wider text-hud-cream-dim">Required templates</h4>
              <div className="flex flex-wrap gap-1.5">
                {def.required_templates.map((n) => (
                  <button key={n} type="button" onClick={() => onNavigate('documents')} title="Open the documents"
                    className="rounded-full border border-hud-line-soft px-2 py-0.5 font-hud-mono text-xs text-hud-cream-soft hover:bg-hud-bg-elev">
                    {String(n).padStart(2, '0')}
                  </button>
                ))}
              </div>
            </section>
          )}

          {def?.deliverables && <p className="text-sm text-hud-cream-soft"><span className="text-hud-cream-dim">Deliverables: </span>{def.deliverables}</p>}

          <section aria-label={`${label} decision`} className="space-y-3 border-t border-hud-line-soft pt-3">
            <h4 className="text-xs font-semibold uppercase tracking-wider text-hud-cream-dim">Decision</h4>
            {gate.decided_at && gate.status !== 'open' && (
              <p className="text-xs text-hud-cream-mute">Decided {formatDate(gate.decided_at)}{gate.decided_by ? ` by ${gate.decided_by}` : ''}.</p>
            )}
            <div className="grid gap-3 sm:grid-cols-2">
              <div>
                <label htmlFor={`by-${gate.id}`} className={labelCls}>Decided by</label>
                <input id={`by-${gate.id}`} value={decidedBy} disabled={!editable} onChange={(e) => setDecidedBy(e.target.value)} className={inputCls} />
              </div>
              <div className="sm:col-span-2">
                <label htmlFor={`note-${gate.id}`} className={labelCls}>Decision note{met < total ? ' (required to accept with unmet conditions)' : ''}</label>
                <textarea id={`note-${gate.id}`} rows={3} value={note} disabled={!editable} onChange={(e) => setNote(e.target.value)} className={inputCls} />
              </div>
            </div>
            {canManage && gate.status === 'open' && blockers.length > 0 && (
              <p className="text-xs text-hud-rust">To accept, add: {blockers.join('; ')}.</p>
            )}
            {error && <ErrorBox message={error} />}
            {message && <p className="text-xs text-hud-emerald" role="status">{message}</p>}
            {canManage && (
              <div className="flex flex-wrap gap-2">
                {gate.status === 'open' || gate.status === 'remediation' ? (
                  <>
                    <button type="button" disabled={busy || blockers.length > 0} onClick={() => decide('accepted', 'Gate accepted.')} className={btnPrimary}>Accept</button>
                    {gate.status === 'open' && <button type="button" disabled={busy} onClick={() => decide('remediation', 'Marked as needing remediation.')} className={btnGhost}>Needs remediation</button>}
                    <button type="button" disabled={busy} onClick={stop} className={btnDanger}>Stop</button>
                  </>
                ) : (
                  <button type="button" disabled={busy} onClick={() => decide('open', 'Gate re-opened.')} className={btnGhost}>Re-open</button>
                )}
              </div>
            )}
          </section>
        </div>
      )}
    </Panel>
  );
}

export default GatesPanel;
