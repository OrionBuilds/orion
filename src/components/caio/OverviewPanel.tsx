/** Engagement overview: header facts, the five-gate timeline, governance coverage, register counts and what needs attention. */
import { useEffect, useState, type ReactNode } from 'react';
import { AlertTriangle } from 'lucide-react';
import { Panel, Stat, EmptyNote } from '../agent-health/ui';
import { getErrorMessage } from '../../lib/errors';
import {
  getCoverage, gateProgress, gateTone, listDocuments, listGateDefs, listGates, listRecords, listRegisterDefs,
  type CaioDocumentRow, type CaioRecord, type Coverage, type Engagement, type Gate, type GateDef, type RegisterDef,
} from '../../services/caio';
import { DueBadge, ErrorBox, ToneBadge, formatDate } from './ui';
import { attentionTotal, buildAttention, daysSince } from './portfolioView';
import { AutomationCard } from './AutomationCard';
import type { AnyNavigate } from './automationLogic';

export interface OverviewPanelProps { engagement: Engagement; onNavigate: AnyNavigate; canManage?: boolean }

interface Loaded {
  gates: Gate[]; defs: GateDef[]; coverage: Coverage; records: CaioRecord[]; docs: CaioDocumentRow[]; registers: RegisterDef[];
}

const GATE_STATUS_LABEL: Record<Gate['status'], string> = { open: 'Open', accepted: 'Accepted', remediation: 'Needs remediation', stopped: 'Stopped' };

export function OverviewPanel({ engagement, onNavigate, canManage = false }: OverviewPanelProps) {
  const [data, setData] = useState<Loaded | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    setData(null);
    Promise.all([
      listGates(engagement.id), listGateDefs(), getCoverage(engagement.id), listRecords(engagement.id), listDocuments(engagement.id), listRegisterDefs(),
    ]).then(([gates, defs, coverage, records, docs, registers]) => {
      if (live) { setData({ gates, defs, coverage, records, docs, registers }); setError(null); }
    }).catch((e) => { if (live) setError(getErrorMessage(e, 'Could not load the overview')); });
    return () => { live = false; };
  }, [engagement.id]);

  return (
    <div className="space-y-4">
      <Panel title={`Engagement ${engagement.engagement_code}`}>
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-5">
          <Stat label="Client" value={<span title={engagement.client_legal_name}>{engagement.client_legal_name}</span>} hint={engagement.status} />
          <Stat label="Executive sponsor" value={engagement.executive_sponsor || '–'} />
          <Stat label="Register owner" value={engagement.register_owner || '–'} />
          <Stat label="Kickoff" value={formatDate(engagement.kickoff_date)} />
          <Stat label="Days since kickoff" value={Math.max(0, daysSince(engagement.kickoff_date))} />
        </div>
      </Panel>

      <AutomationCard engagement={engagement} canManage={canManage} onNavigate={onNavigate} />

      {error && <ErrorBox message={error} />}
      {!data && !error && <p className="text-sm text-hud-cream-mute" role="status">Loading the overview...</p>}
      {data && <OverviewBody data={data} onNavigate={onNavigate} />}
    </div>
  );
}

function OverviewBody({ data, onNavigate }: { data: Loaded; onNavigate: AnyNavigate }) {
  const { gates, defs, coverage, records, docs, registers } = data;
  const label = (key: string) => defs.find((d) => d.gate_key === key)?.label ?? key;
  const regTitle = (key: string) => registers.find((r) => r.register_key === key)?.title ?? key;
  const counts: Record<string, number> = {};
  for (const r of records) counts[r.register_key] = (counts[r.register_key] ?? 0) + 1;
  const attention = buildAttention(records, docs);

  const recordItems = (list: CaioRecord[], extra?: (r: CaioRecord) => ReactNode) => list.map((r) => (
    <Item key={r.id} onClick={() => onNavigate('registers', { register: r.register_key })} title={`${r.record_key} · ${regTitle(r.register_key)}`}
      right={<>{r.status && <ToneBadge tone="muted">{r.status}</ToneBadge>}{extra ? extra(r) : <DueBadge date={r.due_date} />}</>} />
  ));
  const docItems = (list: CaioDocumentRow[], review: boolean) => list.map((d) => (
    <Item key={d.id} onClick={() => onNavigate('documents')} title={d.title}
      right={review ? <DueBadge date={d.next_review} label="review" /> : <ToneBadge tone="muted">{d.status === 'in_review' ? 'awaiting review' : 'draft'}</ToneBadge>} />
  ));

  return (
    <>
      <Panel title="Delivery gates">
        {gates.length === 0 ? <EmptyNote>No gates on this engagement.</EmptyNote> : (
          <ol className="grid gap-2 sm:grid-cols-2 lg:grid-cols-5">
            {gates.map((g) => {
              const { met, total } = gateProgress(g);
              return (
                <li key={g.id}>
                  <button type="button" onClick={() => onNavigate('gates')}
                    className="flex h-full w-full flex-col gap-2 rounded-lg border border-hud-line-soft bg-hud-bg-card/60 p-3 text-left hover:bg-hud-bg-elev">
                    <span className="text-sm font-medium text-white">{label(g.gate_key)}</span>
                    <DueBadge date={g.due_date} />
                    <span className="flex flex-wrap items-center gap-2">
                      <ToneBadge tone={gateTone(g)}>{GATE_STATUS_LABEL[g.status]}</ToneBadge>
                      <span className="text-xs text-hud-cream-mute">{met}/{total} met</span>
                    </span>
                  </button>
                </li>
              );
            })}
          </ol>
        )}
      </Panel>

      <Panel title="Governance coverage">
        {coverage.inventoried === 0 ? (
          <p className="text-sm text-hud-cream-dim">No systems inventoried yet. Add them in the AI Systems register to see coverage.</p>
        ) : (
          <p className="text-sm text-hud-cream-soft">
            <span className="font-hud-mono text-lg text-white">{coverage.covered} of {coverage.inventoried}</span> AI systems fully covered
            {coverage.pct !== null && <span className="text-hud-cream-dim"> ({coverage.pct}%)</span>}
          </p>
        )}
        {coverage.gaps.length > 0 && (
          <div className="mt-3">
            <h4 className="mb-1 flex items-center gap-1 text-xs font-semibold uppercase tracking-wider text-hud-rust"><AlertTriangle className="h-3.5 w-3.5" /> Coverage gaps</h4>
            <ul className="space-y-1">
              {coverage.gaps.map((g) => (
                <li key={g.system} className="rounded-lg bg-hud-bg-card/60 px-3 py-2 text-sm text-hud-cream-soft">
                  <span className="font-medium text-white">{g.system}{g.name ? ` · ${g.name}` : ''}</span>
                  <span className="text-hud-cream-dim"> is missing: {g.missing.join(', ')}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </Panel>

      <Panel title="Registers">
        <div className="flex flex-wrap gap-2">
          {registers.map((r) => {
            const n = counts[r.register_key] ?? 0;
            return (
              <button key={r.register_key} type="button" onClick={() => onNavigate('registers', { register: r.register_key })}
                className={`rounded-full border px-3 py-1 text-xs hover:bg-hud-bg-elev ${n ? 'border-hud-gold/40 text-hud-cream' : 'border-hud-line-soft text-hud-cream-mute'}`}>
                {r.title} <span className="font-hud-mono">{n}</span>
              </button>
            );
          })}
        </div>
      </Panel>

      <Panel title={`Needs attention (${attentionTotal(attention)})`}>
        {attentionTotal(attention) === 0 ? <EmptyNote>Nothing needs attention right now.</EmptyNote> : (
          <div className="space-y-4">
            <Group title="Overdue actions" items={recordItems(attention.overdueActions)} />
            <Group title="Exceptions expiring in 30 days or expired" items={recordItems(attention.exceptions)} />
            <Group title="Open incidents" items={recordItems(attention.openIncidents, (r) => (r.due_date ? <DueBadge date={r.due_date} /> : null))} />
            <Group title="Reviews overdue" items={recordItems(attention.reviewsOverdue)} />
            <Group title="Documents in progress" items={docItems(attention.docsInProgress, false)} />
            <Group title="Document reviews overdue" items={docItems(attention.docsReviewOverdue, true)} />
          </div>
        )}
      </Panel>
    </>
  );
}

function Group({ title, items }: { title: string; items: ReactNode[] }) {
  if (items.length === 0) return null;
  return (
    <section>
      <h4 className="mb-1 text-xs font-semibold uppercase tracking-wider text-hud-cream-dim">{title} ({items.length})</h4>
      <ul className="space-y-1">{items}</ul>
    </section>
  );
}

function Item({ title, right, onClick }: { title: string; right: ReactNode; onClick: () => void }) {
  return (
    <li>
      <button type="button" onClick={onClick}
        className="flex w-full flex-wrap items-center justify-between gap-2 rounded-lg bg-hud-bg-card/60 px-3 py-2 text-left text-sm text-hud-cream-soft hover:bg-hud-bg-elev">
        <span className="min-w-0 truncate">{title}</span>
        <span className="flex shrink-0 items-center gap-2">{right}</span>
      </button>
    </li>
  );
}

export default OverviewPanel;
