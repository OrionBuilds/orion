import { useState, useEffect, useCallback, useMemo } from 'react';
import {
  CalendarClock, Loader2, AlertCircle, AlertTriangle, Bot, Clock, ShieldCheck, History,
  Plus, Pencil, Play, Pause, WifiOff,
} from 'lucide-react';
import { useAuth } from '../../contexts/AuthContext';
import { PageHeader, EmptyState } from '../../components/layouts';
import { ScheduleEditorModal } from '../../components/agent-tasks/ScheduleEditorModal';
import { AGENT_DIRECTORY } from '../../components/agent-tasks/shared';
import {
  listAllSchedules,
  setScheduleMode,
  runNow,
  listRuns,
  subscribeToRuns,
  getRecentAgentAlerts,
  type AgentTaskSchedule,
  type AgentTaskRun,
  type ScheduleMode,
  type AgentAlert,
} from '../../services/agentTasks';
import { reportBackgroundError } from '../../lib/errors';

const AGENTS = AGENT_DIRECTORY;

const MODE_STYLE: Record<ScheduleMode, string> = {
  off: 'text-hud-cream-mute',
  shadow: 'text-hud-rust',
  active: 'text-hud-emerald',
};

const RISK_STYLE: Record<string, string> = {
  autonomous: 'bg-hud-bg-elev text-hud-cream-soft',
  owner_review: 'bg-hud-rust/15 text-hud-rust/40',
  client_visible: 'bg-hud-gold/15 text-hud-gold-soft',
};

const RUN_STATUS_STYLE: Record<string, string> = {
  claimed: 'text-hud-cream-dim',
  running: 'text-blue-400',
  awaiting_approval: 'text-hud-rust',
  approved: 'text-hud-emerald',
  rejected: 'text-hud-plum',
  completed: 'text-hud-emerald',
  failed: 'text-hud-plum',
  expired_lease: 'text-hud-plum',
};

const RUN_CHIP_STYLE: Record<string, string> = {
  claimed: 'bg-hud-bg-card text-hud-cream-dim',
  running: 'bg-blue-500/15 text-blue-300',
  awaiting_approval: 'bg-hud-rust/15 text-hud-rust/40',
  approved: 'bg-hud-emerald/15 text-hud-emerald/40',
  rejected: 'bg-hud-plum/15 text-hud-plum/40',
  completed: 'bg-hud-emerald/15 text-hud-emerald/40',
  failed: 'bg-hud-plum/15 text-hud-plum/40',
  expired_lease: 'bg-hud-plum/15 text-hud-plum/40',
};

const STALE_AFTER_MS = 15 * 60 * 1000;

function cadenceLabel(s: AgentTaskSchedule): string {
  const t = s.time_of_day ?? '';
  if (s.cadence === 'hourly') return `Hourly at :${(t.split(':')[1] ?? '00')}`;
  if (s.cadence === 'daily') return `Daily ${t}`;
  if (s.cadence === 'weekly') {
    const dow = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    const days = (s.days_of_week ?? []).map((d) => dow[d]).join(', ');
    return `Weekly ${days} ${t}`;
  }
  if (s.cadence === 'monthly') return `Monthly day ${s.day_of_month} ${t}`;
  return s.custom_cron ?? 'custom';
}

function relativeTime(iso: string): string {
  const diffMs = Date.now() - new Date(iso).getTime();
  const mins = Math.round(Math.abs(diffMs) / 60000);
  const label = mins < 60 ? `${mins}m` : mins < 60 * 24 ? `${Math.round(mins / 60)}h` : `${Math.round(mins / (60 * 24))}d`;
  return diffMs >= 0 ? `${label} ago` : `in ${label}`;
}

/** mode ≠ off and the fire time is >15min in the past → the agent isn't polling. */
function isStale(s: AgentTaskSchedule): boolean {
  return s.mode !== 'off' && new Date(s.next_run_at).getTime() < Date.now() - STALE_AFTER_MS;
}

export function AgentTasks() {
  const { user, hasPermission } = useAuth();
  const orgId = user?.organization_id;
  const canManage = hasPermission('agent_tasks.manage');

  const [schedules, setSchedules] = useState<AgentTaskSchedule[]>([]);
  const [runs, setRuns] = useState<AgentTaskRun[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [savingId, setSavingId] = useState<string | null>(null);
  const [editorTarget, setEditorTarget] = useState<AgentTaskSchedule | null>(null);
  const [editorOpen, setEditorOpen] = useState(false);
  const [alerts, setAlerts] = useState<AgentAlert[]>([]);

  const load = useCallback(async () => {
    try {
      setError(null);
      const [s, r, a] = await Promise.all([
        listAllSchedules(),
        listRuns({ limit: 50 }),
        orgId ? getRecentAgentAlerts(orgId).catch(() => [] as AgentAlert[]) : Promise.resolve([] as AgentAlert[]),
      ]);
      setSchedules(s);
      setRuns(r);
      setAlerts(a);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load agent schedules');
    } finally {
      setLoading(false);
    }
  }, [orgId]);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    if (!orgId) return;
    const sub = subscribeToRuns(orgId, () => { listRuns({ limit: 50 }).then(setRuns).catch(reportBackgroundError('AgentTasks.listRuns')); });
    return () => { sub.unsubscribe(); };
  }, [orgId]);

  /** Latest run per schedule, from the (created_at DESC) runs feed. */
  const lastRunBySchedule = useMemo(() => {
    const map = new Map<string, AgentTaskRun>();
    for (const r of runs) {
      if (!map.has(r.schedule_id)) map.set(r.schedule_id, r);
    }
    return map;
  }, [runs]);

  const cycleMode = async (s: AgentTaskSchedule) => {
    if (!canManage) return;
    const next: ScheduleMode = s.mode === 'off' ? 'shadow' : s.mode === 'shadow' ? 'active' : 'off';
    await applyMode(s, next);
  };

  const applyMode = async (s: AgentTaskSchedule, next: ScheduleMode) => {
    if (!canManage) return;
    setSavingId(s.id);
    try {
      await setScheduleMode(s.id, next);
      setSchedules((prev) => prev.map((x) => (x.id === s.id ? { ...x, mode: next } : x)));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to change mode');
    } finally {
      setSavingId(null);
    }
  };

  const handleRunNow = async (s: AgentTaskSchedule) => {
    if (!canManage) return;
    if (!window.confirm(`Run "${s.title}" now? The agent claims it on its next poll (≤60s) and the cadence resumes automatically.`)) return;
    const prevNext = s.next_run_at;
    const nowIso = new Date().toISOString();
    setSavingId(s.id);
    setSchedules((prev) => prev.map((x) => (x.id === s.id ? { ...x, next_run_at: nowIso } : x)));
    try {
      await runNow(s.id);
    } catch (err) {
      setSchedules((prev) => prev.map((x) => (x.id === s.id ? { ...x, next_run_at: prevNext } : x)));
      setError(err instanceof Error ? err.message : 'Failed to trigger run');
    } finally {
      setSavingId(null);
    }
  };

  const openCreate = () => { setEditorTarget(null); setEditorOpen(true); };
  const openEdit = (s: AgentTaskSchedule) => { setEditorTarget(s); setEditorOpen(true); };

  const handleSaved = (saved: AgentTaskSchedule) => {
    setSchedules((prev) => {
      const exists = prev.some((x) => x.id === saved.id);
      return exists ? prev.map((x) => (x.id === saved.id ? saved : x)) : [...prev, saved];
    });
  };

  const handleDeleted = (id: string) => {
    setSchedules((prev) => prev.filter((x) => x.id !== id));
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64 text-hud-cream-dim">
        <Loader2 className="w-6 h-6 animate-spin mr-2" /> Loading agent schedules…
      </div>
    );
  }

  return (
    <div className="p-6 space-y-6">
      <PageHeader
        title="Agent Schedules"
        subtitle="Recurring autonomous work for CLARA and FRIDAY. The OS defines what runs and when; agents pull due work and report results back."
        icon={CalendarClock}
        primaryAction={canManage ? { label: 'New schedule', icon: Plus, onClick: openCreate } : undefined}
      />

      {error && (
        <div className="flex items-center gap-2 bg-hud-plum/10 border border-hud-plum/30 text-hud-plum/40 rounded-lg px-4 py-3 text-sm">
          <AlertCircle className="w-4 h-4" /> {error}
        </div>
      )}

      {/* Agents raise operational warnings inside a completed run's result.alerts[] — the run
          still reports success, so status alone never surfaces them. Without this panel the
          only place a broken agent showed up was an SMS-style digest buried in Conversations. */}
      {alerts.length > 0 && (
        <section className="bg-hud-rust/5 border border-hud-rust/30 rounded-xl overflow-hidden">
          <div className="flex items-center gap-2 px-5 py-3 border-b border-hud-rust/20">
            <AlertTriangle className="w-4 h-4 text-hud-rust" />
            <h2 className="text-sm font-semibold text-hud-rust/25">
              Agent health — {alerts.length} open {alerts.length === 1 ? 'alert' : 'alerts'}
            </h2>
          </div>
          <ul className="divide-y divide-hud-rust/10">
            {alerts.slice(0, 12).map((a, i) => (
              <li key={a.dedupeKey || `${a.kind}-${i}`} className="px-5 py-3 flex items-start gap-3">
                <span className={`mt-0.5 px-1.5 py-0.5 rounded text-[10px] font-medium whitespace-nowrap ${
                  a.priority === 'high'
                    ? 'bg-hud-plum/20 text-hud-plum/40'
                    : 'bg-hud-rust/20 text-hud-rust/40'
                }`}>
                  {a.kind}
                </span>
                <div className="min-w-0 flex-1">
                  <p className="text-sm text-hud-cream-soft">{a.text}</p>
                  {a.runFinishedAt && (
                    <p className="text-xs text-hud-cream-mute mt-0.5">
                      {new Date(a.runFinishedAt).toLocaleString()}
                    </p>
                  )}
                </div>
              </li>
            ))}
          </ul>
          {alerts.length > 12 && (
            <p className="px-5 py-2 text-xs text-hud-cream-mute border-t border-hud-rust/10">
              +{alerts.length - 12} more
            </p>
          )}
        </section>
      )}

      {schedules.length === 0 ? (
        <EmptyState icon={CalendarClock} title="No agent schedules yet"
          description="Seed the task catalog or create a schedule to get started." />
      ) : (
        AGENTS.map((agent) => {
          const rows = schedules.filter((s) => s.agent_slug === agent.slug);
          if (rows.length === 0) return null;
          const nonOff = rows.filter((s) => s.mode !== 'off');
          const agentOffline = nonOff.length > 0 && nonOff.every(isStale);
          return (
            <section key={agent.slug} className="bg-hud-bg-mid border border-hud-bg-card rounded-xl overflow-hidden">
              <div className="flex items-center gap-3 px-5 py-3 border-b border-hud-bg-card">
                <Bot className="w-5 h-5 text-hud-gold-soft" />
                <div>
                  <h2 className="text-sm font-semibold text-white">{agent.label}</h2>
                  <p className="text-xs text-hud-cream-mute">{agent.blurb}</p>
                </div>
              </div>
              {agentOffline && (
                <div className="flex items-center gap-2 px-5 py-2.5 bg-hud-rust/10 border-b border-hud-rust/20 text-hud-rust/40 text-xs">
                  <WifiOff className="w-3.5 h-3.5 shrink-0" />
                  {agent.label} looks offline — every enabled schedule is overdue by 15+ minutes. Check the agent&apos;s poller.
                </div>
              )}
              <div className="divide-y divide-hud-bg-card">
                {rows.map((s) => {
                  const lastRun = lastRunBySchedule.get(s.id);
                  const stale = isStale(s);
                  return (
                    <div key={s.id} className="flex items-center gap-4 px-5 py-3 hover:bg-hud-bg-card/40 group">
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="text-sm text-white truncate">{s.title}</span>
                          <span className={`text-[10px] px-1.5 py-0.5 rounded ${RISK_STYLE[s.risk_tier] ?? ''}`}>
                            {s.risk_tier.replace('_', ' ')}
                          </span>
                          {s.approval_required && (
                            <ShieldCheck className="w-3.5 h-3.5 text-hud-gold-soft" aria-label="approval required" />
                          )}
                          {stale && (
                            <span className="flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded bg-hud-rust/15 text-hud-rust/40"
                              title={`next_run_at is ${relativeTime(s.next_run_at)} but no agent has claimed it`}>
                              <WifiOff className="w-3 h-3" /> agent not polling
                            </span>
                          )}
                        </div>
                        <div className="flex items-center gap-3 text-xs text-hud-cream-mute mt-0.5">
                          <span className="flex items-center gap-1"><Clock className="w-3 h-3" /> {cadenceLabel(s)}</span>
                          <span className="text-hud-cream-mute">·</span>
                          <span>next {new Date(s.next_run_at).toLocaleString()}</span>
                          {lastRun && (
                            <>
                              <span className="text-hud-cream-mute">·</span>
                              <span className={`px-1.5 py-0.5 rounded text-[10px] font-medium ${RUN_CHIP_STYLE[lastRun.status] ?? 'bg-hud-bg-card text-hud-cream-dim'}`}
                                title={lastRun.result_summary ?? undefined}>
                                last: {lastRun.status.replace('_', ' ')} {relativeTime(lastRun.created_at)}
                              </span>
                            </>
                          )}
                        </div>
                      </div>

                      {canManage && (
                        <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 reveal-on-touch transition-opacity">
                          <button
                            onClick={() => handleRunNow(s)}
                            disabled={savingId === s.id || s.mode === 'off'}
                            title={s.mode === 'off' ? 'Schedule is off — enable it to run' : 'Run now (agent claims within ~60s)'}
                            className="p-1.5 rounded-lg text-hud-cream-dim hover:text-hud-emerald/40 hover:bg-hud-bg-card transition-colors disabled:opacity-40 disabled:hover:text-hud-cream-dim"
                          >
                            <Play className="w-4 h-4" />
                          </button>
                          {s.mode !== 'off' && (
                            <button
                              onClick={() => applyMode(s, 'off')}
                              disabled={savingId === s.id}
                              title="Pause (set mode to off)"
                              className="p-1.5 rounded-lg text-hud-cream-dim hover:text-hud-rust/40 hover:bg-hud-bg-card transition-colors"
                            >
                              <Pause className="w-4 h-4" />
                            </button>
                          )}
                          <button
                            onClick={() => openEdit(s)}
                            disabled={savingId === s.id}
                            title="Edit schedule"
                            className="p-1.5 rounded-lg text-hud-cream-dim hover:text-hud-gold-soft hover:bg-hud-bg-card transition-colors"
                          >
                            <Pencil className="w-4 h-4" />
                          </button>
                        </div>
                      )}

                      <button
                        onClick={() => cycleMode(s)}
                        disabled={!canManage || savingId === s.id}
                        title={canManage ? 'Click to cycle off → shadow → active' : 'Requires agent_tasks.manage'}
                        className={`text-xs font-semibold uppercase tracking-wide px-3 py-1.5 rounded-lg border border-hud-bg-elev bg-hud-bg-card ${MODE_STYLE[s.mode]} ${canManage ? 'hover:border-hud-cream-mute cursor-pointer' : 'cursor-default opacity-70'}`}
                      >
                        {savingId === s.id ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : s.mode}
                      </button>
                    </div>
                  );
                })}
              </div>
            </section>
          );
        })
      )}

      <section className="bg-hud-bg-mid border border-hud-bg-card rounded-xl overflow-hidden">
        <div className="flex items-center gap-2 px-5 py-3 border-b border-hud-bg-card">
          <History className="w-4 h-4 text-hud-cream-dim" />
          <h2 className="text-sm font-semibold text-white">Recent runs</h2>
          <span className="text-xs text-hud-cream-mute">(live)</span>
        </div>
        {runs.length === 0 ? (
          <p className="px-5 py-6 text-sm text-hud-cream-mute">No runs yet. Runs appear here once a schedule is shadow/active and an agent polls.</p>
        ) : (
          <div className="divide-y divide-hud-bg-card">
            {runs.map((r) => {
              const sched = schedules.find((s) => s.id === r.schedule_id);
              return (
                <div key={r.id} className="flex items-center gap-4 px-5 py-2.5 text-sm">
                  <span className={`w-32 shrink-0 text-xs font-medium ${RUN_STATUS_STYLE[r.status] ?? 'text-hud-cream-dim'}`}>
                    {r.status.replace('_', ' ')}
                  </span>
                  <span className="flex-1 min-w-0 truncate text-hud-cream-soft">
                    {sched?.title ?? r.schedule_id}
                    {r.result_summary && <span className="text-hud-cream-mute"> — {r.result_summary}</span>}
                  </span>
                  <span className="text-[11px] text-hud-cream-mute shrink-0">
                    {r.mode_at_run} · {new Date(r.created_at).toLocaleString()}
                  </span>
                </div>
              );
            })}
          </div>
        )}
      </section>

      {editorOpen && orgId && user && (
        <ScheduleEditorModal
          schedule={editorTarget}
          schedules={schedules}
          orgId={orgId}
          currentUserId={user.id}
          onClose={() => setEditorOpen(false)}
          onSaved={handleSaved}
          onDeleted={handleDeleted}
        />
      )}
    </div>
  );
}
