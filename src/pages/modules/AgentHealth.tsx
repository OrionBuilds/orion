import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Activity, Loader2, RefreshCw } from 'lucide-react';
import { useAuth } from '../../contexts/AuthContext';
import { PageHeader } from '../../components/layouts';
import {
  agentAlerts, agentLabel, agentStatus, buildRoster, getCosts, getOverviewWithThreads, getProviderUsage,
  type Costs, type Overview, type ProviderUsage, type StatusLevel,
} from '../../services/agentOps';
import { OverviewTab } from '../../components/agent-health/OverviewTab';
import { AgentDetailTab } from '../../components/agent-health/AgentDetailTab';
import { CostsTab } from '../../components/agent-health/CostsTab';
import { ProvidersTab } from '../../components/agent-health/ProvidersTab';
import { PilotsTab } from '../../components/agent-health/PilotsTab';
import { getPilotStatus, type PilotRow } from '../../services/agentPilot';
import { ErrorNote } from '../../components/agent-health/ui';
import { reportBackgroundError } from '../../lib/errors';

const OVERVIEW_REFRESH_MS = 60_000;

/**
 * Agent operations dashboard: live status, uptime, runs, schedules, backlog, channel activity,
 * supervisor/vault health, AI spend, and provider subscriptions/keys for the OS's agents.
 * Tabs: overview · one per agent · costs · subscriptions & keys (?tab=overview|<user id>|costs|providers).
 */
export function AgentHealth() {
  const { user, hasPermission } = useAuth();
  const orgId = user?.organization_id;
  const canSeeProviders = hasPermission('ai_agents.manage');
  const canManagePilots = hasPermission('agent_tasks.manage');
  // The same gate as the Factory page's step actions; the RPC itself only lets the owner through.
  const canManageRequests = hasPermission('factory.manage');
  const [params, setParams] = useSearchParams();
  const tab = params.get('tab') ?? 'overview';

  const [now, setNow] = useState(() => Date.now());
  const [overview, setOverview] = useState<Overview | null>(null);
  const [overviewError, setOverviewError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const [costRange, setCostRange] = useState(30);
  const [costs, setCosts] = useState<Costs | null>(null);
  const [costsError, setCostsError] = useState<string | null>(null);

  const [pilotDays, setPilotDays] = useState(30);
  const [pilots, setPilots] = useState<PilotRow[] | null>(null);
  const [pilotsFor, setPilotsFor] = useState<string | null>(null);
  const [pilotsError, setPilotsError] = useState<string | null>(null);
  const pilotReq = useRef(0);

  const [providers, setProviders] = useState<ProviderUsage | null>(null);
  const [providersError, setProvidersError] = useState<string | null>(null);
  const [providersLoading, setProvidersLoading] = useState(false);

  const loadOverview = useCallback(async (quiet = false) => {
    if (!orgId) return;
    if (!quiet) setLoading(true);
    try {
      setOverview(await getOverviewWithThreads(orgId));
      setOverviewError(null);
    } catch (e) {
      setOverviewError((e as Error).message);
    } finally {
      setNow(Date.now());
      setLoading(false);
    }
  }, [orgId]);

  const loadCosts = useCallback(async () => {
    if (!orgId) return;
    try {
      setCosts(await getCosts(orgId, costRange));
      setCostsError(null);
    } catch (e) {
      setCostsError((e as Error).message);
    }
  }, [orgId, costRange]);

  const loadProviders = useCallback(async (refresh = false) => {
    if (!canSeeProviders) return;
    setProvidersLoading(true);
    try {
      setProviders(await getProviderUsage(refresh));
      setProvidersError(null);
    } catch (e) {
      setProvidersError((e as Error).message);
    } finally {
      setProvidersLoading(false);
    }
  }, [canSeeProviders]);

  const loadPilots = useCallback(async () => {
    if (!orgId) return;
    // Tie each response to the org+window it was requested for, and drop any that a newer
    // request has superseded — otherwise a slow older request can overwrite the correct rows.
    const reqId = ++pilotReq.current;
    const key = `${orgId}:${pilotDays}`;
    try {
      const rows = await getPilotStatus(orgId, pilotDays);
      if (pilotReq.current !== reqId) return;
      setPilots(rows);
      setPilotsFor(key);
      setPilotsError(null);
    } catch (e) {
      if (pilotReq.current !== reqId) return;
      setPilotsError((e as Error).message);
    }
  }, [orgId, pilotDays]);

  useEffect(() => { void loadOverview(); }, [loadOverview]);
  useEffect(() => { if (tab === 'pilots') void loadPilots(); }, [tab, loadPilots]);

  // Quiet refresh while the page is visible: status is only useful if it is current.
  useEffect(() => {
    const id = window.setInterval(() => {
      if (document.visibilityState === 'visible') loadOverview(true).catch(reportBackgroundError('agent-health: overview refresh'));
    }, OVERVIEW_REFRESH_MS);
    return () => window.clearInterval(id);
  }, [loadOverview]);

  useEffect(() => {
    if (tab === 'costs' || tab === 'providers') void loadCosts();
  }, [tab, loadCosts]);

  useEffect(() => {
    if (tab === 'providers' && !providers && !providersLoading && !providersError) void loadProviders(false);
  }, [tab, providers, providersLoading, providersError, loadProviders]);

  const setTab = (t: string) => {
    const next = new URLSearchParams(params);
    if (t === 'overview') next.delete('tab'); else next.set('tab', t);
    setParams(next, { replace: true });
  };

  const agents = useMemo(() => overview?.agents ?? [], [overview]);
  const selectedAgent = agents.find((a) => a.user_id === tab) ?? null;

  const tabs = [
    { id: 'overview', label: 'Overview', dot: null as null | StatusLevel },
    ...agents.map((a) => ({ id: a.user_id, label: agentLabel(a.slug), dot: agentStatus(a, now).level })),
    { id: 'pilots', label: 'Pilots', dot: null },
    { id: 'costs', label: 'Costs', dot: null },
    { id: 'providers', label: 'Subscriptions & keys', dot: null },
  ];

  const alertCount = agents.reduce((n, a) => n + agentAlerts(a, now).filter((x) => x.severity !== 'info').length, 0);
  const liveCount = agents.filter((a) => agentStatus(a, now).level === 'live').length;
  const idleCount = agents.filter((a) => agentStatus(a, now).level === 'idle').length;
  const unprovisioned = overview ? buildRoster(overview).filter((e) => e.kind === 'unprovisioned').length : 0;

  const refresh = () => {
    void loadOverview();
    if (tab === 'costs' || tab === 'providers') void loadCosts();
    if (tab === 'providers') void loadProviders(true);
    if (tab === 'pilots') void loadPilots();
  };

  return (
    <div className="flex h-full flex-col p-6">
      <PageHeader
        title="Agent Health"
        subtitle={overview
          ? `${liveCount}/${agents.length - idleCount} agents live${idleCount ? ` · ${idleCount} idle` : ''}${unprovisioned ? ` · ${unprovisioned} not provisioned` : ''} · ${alertCount} open alert${alertCount === 1 ? '' : 's'} · updated ${new Date(overview.generated_at).toLocaleTimeString()}`
          : 'Status, runs, schedules, costs and AI subscriptions for the OS agents'}
        icon={Activity}
        primaryAction={{ label: 'Refresh', icon: RefreshCw, onClick: refresh }}
      />

      <nav className="mt-4 flex gap-1 overflow-x-auto border-b border-hud-line-soft" aria-label="Agent health sections">
        {tabs.map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => setTab(t.id)}
            className={`-mb-px inline-flex shrink-0 items-center gap-1.5 border-b-2 px-3 py-2 text-sm ${
              tab === t.id ? 'border-hud-gold text-hud-cream' : 'border-transparent text-hud-cream-dim hover:text-hud-cream'
            }`}
          >
            {t.dot && (
              <span className={`h-2 w-2 rounded-full ${t.dot === 'live' ? 'bg-hud-emerald' : t.dot === 'idle' ? 'bg-hud-cream-mute/50' : t.dot === 'stale' ? 'bg-hud-rust' : 'bg-hud-plum'}`} aria-label={t.dot} />
            )}
            {t.label}
          </button>
        ))}
      </nav>

      <div className="mt-4 flex-1 overflow-y-auto pb-6">
        {loading && !overview ? (
          <div className="flex h-40 items-center justify-center"><Loader2 className="h-8 w-8 animate-spin text-hud-gold" /></div>
        ) : overviewError && !overview ? (
          <ErrorNote message={overviewError} />
        ) : (
          <>
            {overviewError && <div className="mb-3"><ErrorNote message={`Refresh failed: ${overviewError}`} /></div>}
            {tab === 'overview' && overview && <OverviewTab overview={overview} now={now} onOpenAgent={setTab} />}
            {selectedAgent && orgId && (
              <AgentDetailTab key={selectedAgent.user_id} orgId={orgId} agent={selectedAgent} now={now}
                canManageRequests={canManageRequests} onChanged={() => { loadOverview(true).catch(reportBackgroundError('agent-health: overview refresh')); }} />
            )}
            {tab === 'pilots' && (() => {
              // Only treat rows as current when they were loaded for the selected org+window.
              const current = pilots !== null && pilotsFor === `${orgId ?? ''}:${pilotDays}`;
              return pilotsError ? <ErrorNote message={pilotsError} /> : (
                <PilotsTab orgId={orgId ?? ''} canManage={canManagePilots} pilots={current ? pilots : null} days={pilotDays} onDays={setPilotDays} loading={!current} onChanged={() => void loadPilots()} />
              );
            })()}
            {tab === 'costs' && (costsError ? <ErrorNote message={costsError} /> : costs
              ? <CostsTab costs={costs} range={costRange} onRange={setCostRange} />
              : <div className="flex h-40 items-center justify-center"><Loader2 className="h-6 w-6 animate-spin text-hud-gold" /></div>)}
            {tab === 'providers' && (
              <ProvidersTab
                usage={providers}
                costs={costs}
                loading={providersLoading}
                error={providersError}
                canView={canSeeProviders}
                onRefresh={() => void loadProviders(true)}
              />
            )}
            {!['overview', 'pilots', 'costs', 'providers'].includes(tab) && !selectedAgent && overview && (
              <ErrorNote message="That agent is not active (it may have been retired). Pick a tab above." />
            )}
          </>
        )}
      </div>
    </div>
  );
}

export default AgentHealth;
