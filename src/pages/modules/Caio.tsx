import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { Plus, RefreshCw, ShieldCheck } from 'lucide-react';
import { usePermission } from '../../hooks/usePermission';
import { PageHeader } from '../../components/layouts';
import { Panel, Stat } from '../../components/agent-health/ui';
import { Table, THead, TBody, TR, TH, TD } from '../../components/ui/Table';
import { Badge } from '../../components/ui/Badge';
import { supabase } from '../../lib/supabase';
import { getErrorMessage } from '../../lib/errors';
import { getPortfolio, type PortfolioRow } from '../../services/caio';
import { DueBadge, ErrorBox } from '../../components/caio/ui';
import { TemplatesAdmin } from '../../components/caio/TemplatesAdmin';
import { StartFromContactDrawer } from '../../components/caio/StartFromContactDrawer';
import { filterPortfolio, portfolioCounters, sortPortfolio, type StatusFilter } from '../../components/caio/portfolioView';
import { btnGhost, btnPrimary, inputCls, linkCls } from '../../components/caio/styles';

const TABS = [
  { id: 'portfolio', label: 'Portfolio' },
  { id: 'templates', label: 'Templates' },
];

/** A count cell: nothing when zero, a toned badge otherwise. */
function Num({ n, tone }: { n: number; tone: 'warn' | 'bad' | 'accent' }) {
  return n > 0 ? <Badge tone={tone}>{n}</Badge> : <span className="text-hud-cream-mute">0</span>;
}

/**
 * CAIO Delivery: every Fractional CAIO engagement at a glance (next gate, what is overdue), and the template
 * library behind the 40 deliverable documents. An engagement itself lives on its project (CAIO tab).
 * Writes need caio.manage (and the database enforces it).
 */
export function Caio() {
  const canManage = usePermission('caio.manage');
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const tab = TABS.some((t) => t.id === params.get('tab')) ? params.get('tab')! : 'portfolio';
  const [rows, setRows] = useState<PortfolioRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<StatusFilter>('all');
  const [starting, setStarting] = useState(false);

  const setTab = (t: string) => {
    const next = new URLSearchParams(params);
    if (t === 'portfolio') next.delete('tab'); else next.set('tab', t);
    setParams(next, { replace: true });
  };

  const load = useCallback(async () => {
    try {
      setRows(await getPortfolio());
      setError(null);
    } catch (e) {
      setError(getErrorMessage(e, 'Could not load the CAIO portfolio'));
    }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const visible = useMemo(() => (rows ? sortPortfolio(filterPortfolio(rows, filter)) : []), [rows, filter]);
  const counters = useMemo(() => portfolioCounters(rows ?? []), [rows]);

  // The new engagement id -> its project, then straight to that project's CAIO tab.
  const onStarted = async (engagementId: string) => {
    const { data } = await supabase.from('caio_engagements').select('project_id').eq('id', engagementId).maybeSingle();
    setStarting(false);
    const projectId = (data as { project_id?: string } | null)?.project_id;
    if (projectId) navigate(`/projects/${projectId}?tab=caio`);
    else void load();
  };

  return (
    <div className="flex h-full flex-col p-6">
      <PageHeader
        title="CAIO Delivery"
        subtitle={canManage ? 'Fractional CAIO engagements: registers, documents and gates' : 'Fractional CAIO engagements · view only'}
        icon={ShieldCheck}
        primaryAction={{ label: 'Refresh', icon: RefreshCw, onClick: () => void load() }}
      />

      <nav className="mt-4 flex gap-1 overflow-x-auto border-b border-hud-line-soft" aria-label="CAIO sections">
        {TABS.map((t) => (
          <button key={t.id} type="button" onClick={() => setTab(t.id)} aria-current={tab === t.id ? 'page' : undefined}
            className={`-mb-px shrink-0 border-b-2 px-3 py-2 text-sm ${tab === t.id ? 'border-hud-gold text-hud-cream' : 'border-transparent text-hud-cream-dim hover:text-hud-cream'}`}>
            {t.label}
          </button>
        ))}
      </nav>

      <div className="mt-4 flex-1 space-y-4 overflow-y-auto pb-6">
        {tab === 'templates' && <TemplatesAdmin canManage={canManage} />}

        {tab === 'portfolio' && (
          <>
            {error && <ErrorBox message={error} />}
            {!rows && !error && <p className="text-sm text-hud-cream-mute" role="status">Loading the portfolio...</p>}

            {rows && rows.length === 0 && (
              <Panel>
                <div className="space-y-3 py-4 text-center">
                  <p className="text-sm text-hud-cream-soft">No CAIO engagements yet</p>
                  <p className="text-xs text-hud-cream-mute">An engagement tracks one client&apos;s governance registers, deliverable documents and delivery gates.</p>
                  {canManage && <button type="button" onClick={() => setStarting(true)} className={btnPrimary}><Plus className="h-4 w-4" /> Start engagement from a contact</button>}
                </div>
              </Panel>
            )}

            {rows && rows.length > 0 && (
              <>
                <Panel>
                  <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
                    <Stat label="Active engagements" value={counters.active} />
                    <Stat label="Gates due in 14 days" value={counters.gatesDue14} tone={counters.gatesDue14 ? 'warn' : 'default'} />
                    <Stat label="Overdue actions" value={counters.overdueActions} tone={counters.overdueActions ? 'bad' : 'default'} />
                    <Stat label="Open incidents" value={counters.openIncidents} tone={counters.openIncidents ? 'warn' : 'default'} />
                  </div>
                </Panel>

                <div className="flex flex-wrap items-center gap-2">
                  <label htmlFor="caio-status" className="sr-only">Filter by status</label>
                  <select id="caio-status" value={filter} onChange={(e) => setFilter(e.target.value as StatusFilter)} className={`${inputCls} w-auto`}>
                    <option value="all">All statuses</option>
                    <option value="active">Active</option>
                    <option value="paused">Paused</option>
                    <option value="completed">Completed</option>
                  </select>
                  {canManage && <button type="button" onClick={() => setStarting(true)} className={`${btnGhost} ml-auto`}><Plus className="h-4 w-4" /> Start engagement from a contact</button>}
                </div>

                <Panel className="p-0">
                  <Table>
                    <THead>
                      <TH>Client</TH><TH>Next gate</TH><TH align="right">Overdue actions</TH><TH align="right">Exceptions</TH><TH align="right">Open incidents</TH>
                      <TH align="right">Reviews overdue</TH><TH align="right">Docs in progress</TH><TH align="right">Doc reviews overdue</TH><TH align="right">Systems</TH>
                    </THead>
                    <TBody>
                      {visible.length === 0 && <tr><td colSpan={9} className="px-4 py-8 text-center text-sm text-hud-cream-mute">No engagements with that status.</td></tr>}
                      {visible.map((r) => (
                        <TR key={r.engagement_id}>
                          <TD>
                            <Link to={`/projects/${r.project_id}?tab=caio`} className={`${linkCls} font-medium`}>{r.client_legal_name}</Link>
                            <div className="font-hud-mono text-xs text-hud-cream-mute">{r.engagement_code}{r.status !== 'active' ? ` · ${r.status}` : ''}</div>
                          </TD>
                          <TD>
                            {r.next_gate ? (
                              <div className="flex flex-wrap items-center gap-2">
                                <span>{r.next_gate.label}</span>
                                <DueBadge date={r.next_gate.due_date} />
                                <span className="text-xs text-hud-cream-mute">{r.next_gate.met}/{r.next_gate.total} met</span>
                              </div>
                            ) : <span className="text-hud-cream-mute">No open gate</span>}
                          </TD>
                          <TD align="right"><Num n={r.overdue_actions} tone="bad" /></TD>
                          <TD align="right">
                            <span className="inline-flex items-center gap-1">
                              <Num n={r.exceptions_expiring_30d} tone="warn" />
                              {r.exceptions_expired > 0 && <Badge tone="bad" title="Approved exceptions past their expiry">{r.exceptions_expired} expired</Badge>}
                            </span>
                          </TD>
                          <TD align="right"><Num n={r.open_incidents} tone="warn" /></TD>
                          <TD align="right"><Num n={r.reviews_overdue} tone="bad" /></TD>
                          <TD align="right"><Num n={r.documents_in_progress} tone="accent" /></TD>
                          <TD align="right"><Num n={r.documents_review_overdue} tone="bad" /></TD>
                          <TD align="right">{r.systems}</TD>
                        </TR>
                      ))}
                    </TBody>
                  </Table>
                </Panel>
                <EmptyNoteHint />
              </>
            )}
          </>
        )}
      </div>

      <StartFromContactDrawer isOpen={starting} onClose={() => setStarting(false)} onStarted={(id) => void onStarted(id)} />
    </div>
  );
}

/** Sorting note under the table. */
function EmptyNoteHint() {
  return <p className="text-xs text-hud-cream-mute">Sorted by the next gate date. Exceptions show those expiring in 30 days, and approved ones already expired.</p>;
}

export default Caio;
