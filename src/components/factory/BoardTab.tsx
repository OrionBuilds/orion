import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Ban, Loader2 } from 'lucide-react';
import { Badge, EmptyNote, ErrorNote, Panel, Stat } from '../agent-health/ui';
import {
  agentLabel, BRAND_LABEL, boardCounts, brandLabel, cancelRun, filterRuns, getBoard, groupByStage, runKind, statusLabel,
  stepTone, subjectLink, type BoardRun, type BoardStep,
} from '../../services/factory';
import { reportBackgroundError } from '../../lib/errors';
import { StepDrawer } from './StepDrawer';
import { selectCls, when } from './format';

const REFRESH_MS = 30_000;
const KINDS = [
  { id: 'all', label: 'All types' },
  { id: 'deal', label: 'Deals' },
  { id: 'project', label: 'Projects' },
  { id: 'scheduled', label: 'Scheduled' },
];

/** Live runs from factory_board(): what each agent is doing on which deal / project, and what waits on the owner. */
export function BoardTab({ canManage, refreshKey }: { canManage: boolean; refreshKey: number }) {
  const [runs, setRuns] = useState<BoardRun[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [brand, setBrand] = useState('all');
  const [kind, setKind] = useState('all');
  const [selected, setSelected] = useState<{ runId: string; stepId: string } | null>(null);
  const [now, setNow] = useState(() => Date.now());

  const load = useCallback(async (quiet = false) => {
    if (!quiet) setLoading(true);
    try {
      setRuns(await getBoard(100));
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setNow(Date.now());
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load, refreshKey]);

  // Poll only while the tab is visible.
  useEffect(() => {
    const timer = setInterval(() => { if (document.visibilityState === 'visible') void load(true); }, REFRESH_MS);
    const onVisible = () => { if (document.visibilityState === 'visible') void load(true); };
    document.addEventListener('visibilitychange', onVisible);
    return () => { clearInterval(timer); document.removeEventListener('visibilitychange', onVisible); };
  }, [load]);

  const counts = useMemo(() => boardCounts(runs, now), [runs, now]);
  const brands = useMemo(() => [...new Set(runs.map((r) => r.brand ?? 'none'))], [runs]);
  const shown = filterRuns(runs, { brand, kind });
  const selRun = selected ? runs.find((r) => r.run_id === selected.runId) : undefined;
  const selStep = selRun?.steps.find((s) => s.id === selected?.stepId) ?? null;

  const cancel = async (run: BoardRun) => {
    if (!window.confirm(`Cancel "${run.playbook}" on ${run.subject ?? 'this subject'}? Nothing new is queued; steps already with an agent may still finish.`)) return;
    try {
      await cancelRun(run.run_id);
      await load(true);
    } catch (err) {
      reportBackgroundError('factory.cancelRun')(err);
      setError((err as Error).message);
    }
  };

  if (loading && !runs.length) return <div className="flex h-40 items-center justify-center"><Loader2 className="h-8 w-8 animate-spin text-hud-gold" /></div>;

  return (
    <>
      {error && <ErrorNote message={error} />}

      <Panel>
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
          <Stat label="Waiting on you" value={counts.waiting} tone={counts.waiting ? 'warn' : 'default'}
            hint={counts.waiting ? <Link to="/automation/approvals" className="text-hud-gold hover:underline">Open Approvals</Link> : 'needs approval'} />
          <Stat label="Escalated" value={counts.escalated} tone={counts.escalated ? 'bad' : 'default'} hint="agent gave up, needs a look" />
          <Stat label="In progress" value={counts.inProgress} hint="queued or with an agent" />
          <Stat label="Done (7d)" value={counts.done7d} tone={counts.done7d ? 'ok' : 'default'} />
        </div>
      </Panel>

      <Panel title={`Runs (${shown.length})`}
        actions={
          <div className="flex items-center gap-2">
            <select value={kind} onChange={(e) => setKind(e.target.value)} className={selectCls} aria-label="Filter by type">
              {KINDS.map((k) => <option key={k.id} value={k.id}>{k.label}</option>)}
            </select>
            <select value={brand} onChange={(e) => setBrand(e.target.value)} className={selectCls} aria-label="Filter by brand">
              <option value="all">All brands</option>
              {brands.map((b) => <option key={b} value={b}>{b === 'none' ? 'No brand' : BRAND_LABEL[b] ?? b}</option>)}
            </select>
          </div>}>
        {shown.length === 0 ? (
          <EmptyNote>{runs.length ? 'No runs match these filters.' : 'No playbook runs yet. They start when a deal or project enters a pipeline with a playbook, or when a scheduled playbook comes due.'}</EmptyNote>
        ) : (
          <div className="grid gap-3 lg:grid-cols-2">
            {shown.map((r) => <RunCard key={r.run_id} run={r} canManage={canManage}
              onStep={(s) => setSelected({ runId: r.run_id, stepId: s.id })} onCancel={() => void cancel(r)} />)}
          </div>
        )}
      </Panel>

      <StepDrawer step={selStep} runLabel={selRun ? `${selRun.playbook} · ${selRun.subject ?? ''}` : ''} canManage={canManage}
        onClose={() => setSelected(null)} onChanged={() => void load(true)} />
    </>
  );
}

function RunCard({ run, canManage, onStep, onCancel }: {
  run: BoardRun; canManage: boolean; onStep: (s: BoardStep) => void; onCancel: () => void;
}) {
  const link = subjectLink(run);
  const kind = runKind(run);
  const done = run.steps.filter((s) => s.status === 'done' || s.status === 'skipped').length;
  return (
    <article className="rounded-lg border border-hud-line-soft p-3">
      <header className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="truncate text-sm text-hud-cream">{run.playbook}</div>
          <div className="truncate text-xs text-hud-cream-dim">
            {link ? <Link to={link} className="text-hud-gold hover:underline">{run.subject ?? 'Open'}</Link> : (run.subject ?? '—')}
          </div>
        </div>
        <div className="flex shrink-0 flex-wrap items-center justify-end gap-1">
          <Badge tone="info">{kind === 'deal' ? 'Deal' : kind === 'project' ? 'Project' : 'Scheduled'}</Badge>
          <Badge>{brandLabel(run.brand)}</Badge>
          {run.status !== 'active' && <Badge tone={run.status === 'completed' ? 'ok' : 'muted'}>{run.status}</Badge>}
        </div>
      </header>

      <div className="mt-2 space-y-2">
        {groupByStage(run.steps).map((g) => (
          <div key={g.stage}>
            <div className="text-[10px] uppercase tracking-wider text-hud-cream-mute">{g.stage}</div>
            <ul className="mt-0.5 divide-y divide-hud-line-soft">
              {g.steps.map((s) => (
                <li key={s.id}>
                  <button type="button" onClick={() => onStep(s)}
                    className="flex w-full items-center justify-between gap-2 rounded px-1 py-1.5 text-left text-sm hover:bg-hud-bg-elev">
                    <span className="min-w-0 truncate text-hud-cream-soft">{s.title}{!s.required && <span className="text-hud-cream-mute"> (optional)</span>}</span>
                    <span className="flex min-w-0 max-w-[55%] items-center gap-2 text-xs text-hud-cream-mute">
                      <span className="min-w-0 truncate">{agentLabel(s.agent)}{s.role ? ` · ${s.role}` : ''}</span>
                      <Badge tone={stepTone(s.status)}>{statusLabel(s.status)}</Badge>
                    </span>
                  </button>
                </li>))}
            </ul>
          </div>))}
        {run.steps.length === 0 && <p className="text-xs text-hud-cream-mute">No steps queued yet.</p>}
      </div>

      <footer className="mt-2 flex items-center justify-between text-xs text-hud-cream-mute">
        <span>{done}/{run.steps.length} done · started {when(run.started_at)}</span>
        {canManage && run.status === 'active' && (
          <button type="button" onClick={onCancel} className="inline-flex items-center gap-1 text-hud-cream-dim hover:text-hud-plum"><Ban size={12} /> Cancel run</button>
        )}
      </footer>
    </article>
  );
}
