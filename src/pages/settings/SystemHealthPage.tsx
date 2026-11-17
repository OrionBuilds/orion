import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Bot,
  Database,
  Download,
  HeartPulse,
  Plug,
  Radar,
  RefreshCw,
  Server,
  ShieldAlert,
} from 'lucide-react';
import { useAuth } from '../../contexts/AuthContext';
import { GroupPanel } from '../../components/systemHealth/GroupPanel';
import { RunHistory } from '../../components/systemHealth/RunHistory';
import { StatusBadge } from '../../components/systemHealth/StatusBadge';
import { buildGroupView, hasPendingPing, mergeResults, worst } from '../../lib/systemHealth/view';
import {
  downloadJson,
  getHealthRunResults,
  listHealthRuns,
  pingAgents,
  runHealthChecks,
  type CheckGroup,
  type CheckResult,
  type HealthRunReport,
  type HealthRunRow,
  type RunMode,
} from '../../services/systemHealth';
import { buildCatalogue } from '../../../supabase/functions/_shared/system-health/catalogue';
import { CHECK_GROUPS } from '../../../supabase/functions/_shared/system-health/types';

const GROUP_META: Record<CheckGroup, { title: string; subtitle: string; icon: typeof Database }> = {
  data: { title: 'Data', subtitle: 'CRUD on every module with tagged test rows, always cleaned up', icon: Database },
  integrations: { title: 'Integrations', subtitle: 'Google, Microsoft, Twilio, Resend, AI providers — read-only key checks', icon: Plug },
  infrastructure: { title: 'Infrastructure', subtitle: 'Database, edge functions, cron, storage, queues, meeting backlog', icon: Server },
  agents: { title: 'Agents', subtitle: 'CLARA / FRIDAY heartbeat, schedules, runs, sessions, approvals, active ping', icon: Bot },
};

const PING_POLL_MS = 30_000;
const PING_MAX_POLLS = 24;

export function SystemHealthPage() {
  const { isSuperAdmin } = useAuth();
  const catalogue = useMemo(() => buildCatalogue(), []);
  const [mode, setMode] = useState<RunMode>('service');
  const [results, setResults] = useState<CheckResult[]>([]);
  const [lastReport, setLastReport] = useState<HealthRunReport | null>(null);
  const [running, setRunning] = useState<Set<CheckGroup>>(new Set());
  const [pinging, setPinging] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [history, setHistory] = useState<HealthRunRow[]>([]);
  const [historyUnavailable, setHistoryUnavailable] = useState(false);
  const [selectedRun, setSelectedRun] = useState<string | null>(null);
  const pingPolls = useRef(0);
  const busy = running.size > 0 || pinging;

  const loadHistory = useCallback(async () => {
    const { rows, unavailable } = await listHealthRuns(25);
    setHistory(rows);
    setHistoryUnavailable(unavailable);
  }, []);

  useEffect(() => {
    if (isSuperAdmin) void loadHistory();
  }, [isSuperAdmin, loadHistory]);

  const run = useCallback(async (groups: CheckGroup[], checks?: string[]) => {
    setError(null);
    setSelectedRun(null);
    setRunning(new Set(groups));
    try {
      const report = await runHealthChecks({ mode, groups, checks });
      setLastReport(report);
      setResults((prev) => mergeResults(prev, report.results, checks?.length ? [] : report.groups));
      void loadHistory();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setRunning(new Set());
    }
  }, [mode, loadHistory]);

  const sendPing = async () => {
    setError(null);
    setPinging(true);
    try {
      const pingResults = await pingAgents();
      pingPolls.current = 0;
      setResults((prev) => mergeResults(prev, pingResults, []));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setPinging(false);
    }
  };

  // While a ping waits for pickup, re-run the Agents group every 30s (stops after ~12 min).
  useEffect(() => {
    if (busy || !hasPendingPing(results) || pingPolls.current >= PING_MAX_POLLS) return;
    const t = setTimeout(() => {
      pingPolls.current += 1;
      void run(['agents']);
    }, PING_POLL_MS);
    return () => clearTimeout(t);
  }, [results, busy, run]);

  const selectRun = async (id: string) => {
    setError(null);
    try {
      const r = await getHealthRunResults(id);
      setSelectedRun(id);
      setResults(r);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const exportRun = async (id: string) => {
    try {
      const r = await getHealthRunResults(id);
      const meta = history.find((h) => h.id === id);
      downloadJson(`system-health-${id.slice(0, 8)}.json`, { run: meta, results: r });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const exportCurrent = () => {
    downloadJson(`system-health-${new Date().toISOString().replace(/[:.]/g, '-')}.json`, {
      exportedAt: new Date().toISOString(),
      lastRun: lastReport && { ...lastReport, results: undefined },
      results,
    });
  };

  if (!isSuperAdmin) {
    return (
      <div className="rounded-xl border border-hud-bg-elev bg-hud-bg-card/50 p-6">
        <div className="flex items-start gap-3">
          <ShieldAlert className="h-6 w-6 text-hud-rust" aria-hidden />
          <div>
            <h2 className="text-lg font-semibold text-white">System Health</h2>
            <p className="mt-1 text-sm text-hud-cream-dim">Health checks write test data and read integration state, so they are restricted to SuperAdmins.</p>
          </div>
        </div>
      </div>
    );
  }

  const overall = results.length ? worst(results.map((r) => r.status)) : null;
  const counts = { pass: 0, warn: 0, fail: 0, skip: 0 };
  for (const r of results) counts[r.status]++;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex items-center gap-3">
          <div className="rounded-lg border border-rose-500/20 bg-gradient-to-br from-rose-500/10 to-orange-500/10 p-2">
            <HeartPulse className="h-6 w-6 text-rose-400" aria-hidden />
          </div>
          <div>
            <h2 className="text-xl font-semibold text-white">System Health</h2>
            <p className="mt-0.5 text-sm text-hud-cream-dim">CRUD and health checks across data, integrations, infrastructure and agents</p>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={exportCurrent}
            disabled={!results.length}
            className="inline-flex items-center gap-1.5 rounded-lg border border-hud-bg-elev px-3 py-2 text-sm text-white hover:bg-hud-bg-elev disabled:opacity-40"
          >
            <Download className="h-4 w-4" /> Export JSON
          </button>
          <button
            type="button"
            onClick={() => run(CHECK_GROUPS)}
            disabled={busy}
            className="inline-flex items-center gap-2 rounded-lg bg-gradient-to-r from-hud-gold to-hud-teal px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
          >
            <RefreshCw className={`h-4 w-4 ${running.size === CHECK_GROUPS.length ? 'animate-spin' : ''}`} />
            Run all
          </button>
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-[1fr_auto]">
        <fieldset className="rounded-xl border border-hud-bg-elev bg-hud-bg-card/50 p-4">
          <legend className="px-1 text-xs font-medium uppercase tracking-wide text-hud-cream-dim">CRUD mode</legend>
          <div className="flex flex-col gap-2 sm:flex-row sm:gap-6">
            <label className="flex cursor-pointer items-start gap-2 text-sm text-white">
              <input type="radio" name="sh-mode" checked={mode === 'service'} onChange={() => setMode('service')} disabled={busy} className="mt-1" />
              <span>Service role<span className="block text-xs text-hud-cream-dim">Schema, constraints and triggers, bypassing RLS.</span></span>
            </label>
            <label className="flex cursor-pointer items-start gap-2 text-sm text-white">
              <input type="radio" name="sh-mode" checked={mode === 'rls'} onChange={() => setMode('rls')} disabled={busy} className="mt-1" />
              <span>As my user (RLS)<span className="block text-xs text-hud-cream-dim">Same writes through your own session; cleanup still uses the service role.</span></span>
            </label>
          </div>
          <p className="mt-3 text-xs text-hud-cream-dim">
            Test rows are tagged <code>[healthcheck] &lt;run&gt;</code>, inert (drafts, inactive, mode off, dated 2099) and removed after every run, even on failure.
            Workflow events and outgoing webhooks for them are suppressed. Real records are never updated or deleted.
          </p>
        </fieldset>
        <div className="grid grid-cols-4 gap-2 rounded-xl border border-hud-bg-elev bg-hud-bg-card/50 p-4 text-center lg:w-80">
          <div className="col-span-4 flex items-center justify-center gap-2 text-sm text-hud-cream-dim">
            Overall {overall ? <StatusBadge status={overall} /> : <StatusBadge status="not_run" />}
          </div>
          {(['pass', 'warn', 'fail', 'skip'] as const).map((k) => (
            <div key={k}>
              <div className={`text-lg font-semibold tabular-nums ${k === 'pass' ? 'text-hud-emerald' : k === 'warn' ? 'text-amber-300' : k === 'fail' ? 'text-rose-300' : 'text-slate-400'}`}>
                {counts[k]}
              </div>
              <div className="text-xs capitalize text-hud-cream-dim">{k}</div>
            </div>
          ))}
          {lastReport && !selectedRun && (
            <p className="col-span-4 text-xs text-hud-cream-dim">
              Last run {new Date(lastReport.finishedAt).toLocaleTimeString()} · {(lastReport.durationMs / 1000).toFixed(1)} s
              {!lastReport.historySaved && ' · not saved to history'}
            </p>
          )}
          {selectedRun && <p className="col-span-4 text-xs text-hud-cream-dim">Showing a saved run from history</p>}
        </div>
      </div>

      {error && (
        <div className="rounded-lg border border-rose-500/30 bg-rose-500/10 px-4 py-3 text-sm text-rose-200" role="alert">{error}</div>
      )}

      <div className="grid gap-4 xl:grid-cols-2">
        {CHECK_GROUPS.map((g) => {
          const meta = GROUP_META[g];
          return (
            <GroupPanel
              key={g}
              title={meta.title}
              subtitle={meta.subtitle}
              icon={meta.icon}
              rows={buildGroupView(catalogue, results, g)}
              running={running.has(g)}
              busy={busy}
              onRun={() => run([g])}
              onRunOne={g === 'data' ? (id) => run(['data'], [id]) : undefined}
              actions={g === 'agents' ? (
                <button
                  type="button"
                  onClick={sendPing}
                  disabled={busy}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-hud-bg-elev px-3 py-1.5 text-xs font-medium text-white hover:bg-hud-bg-elev disabled:opacity-50"
                  title="Enqueue a tagged no-op task each agent should claim on its next poll"
                >
                  <Radar className={`h-3.5 w-3.5 ${pinging ? 'animate-pulse' : ''}`} /> Ping agents
                </button>
              ) : undefined}
            />
          );
        })}
      </div>

      <RunHistory
        rows={history}
        unavailable={historyUnavailable}
        selectedId={selectedRun}
        onSelect={selectRun}
        onExport={exportRun}
      />
    </div>
  );
}
