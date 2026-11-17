import { useCallback, useEffect, useMemo, useState } from 'react';
import { Bar, BarChart, CartesianGrid, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { Activity, AlertTriangle, CalendarClock, Coins, Database, HeartPulse, Inbox, ListChecks, Loader2, MessagesSquare, Server } from 'lucide-react';
import {
  agentLabel, ago, fillDays, formatTokens, formatUsd, getAgentDetail, lastDays, RUN_STATUS_TONE,
  type AgentDetail, type OverviewAgent,
} from '../../services/agentOps';
import { Badge, EmptyNote, ErrorNote, Panel, RangeToggle, Stat } from './ui';
import { fmtDateTime, shortDay, HUD, tooltipStyle } from './format';
import { HeartbeatStrip, HourlyUptime } from './HeartbeatTimeline';
import { RunHistory } from './RunHistory';
import { StoppedRequests } from './StoppedRequests';

const RANGES: Array<{ value: number; label: string }> = [
  { value: 1, label: '24h' },
  { value: 7, label: '7d' },
  { value: 30, label: '30d' },
];

const CHANNEL_LABELS: Record<string, string> = {
  emails: 'Client emails triaged',
  outbound_calls: 'Outbound calls (requests)',
  thread_turns: 'Owner chat turns',
  requests: 'Requests handed to the agent',
  project_activity: 'Project activity logged',
};

function CountList({ counts }: { counts: Record<string, number> }) {
  const entries = Object.entries(counts);
  if (!entries.length) return <span className="text-sm text-hud-cream-mute">none in this window</span>;
  return (
    <div className="flex flex-wrap gap-1.5">
      {entries.sort((a, b) => b[1] - a[1]).map(([k, v]) => (
        <span key={k} className="rounded bg-hud-bg-elev px-2 py-0.5 text-xs text-hud-cream-soft">
          {k.replace(/_/g, ' ')} <span className="font-hud-mono text-hud-cream">{v}</span>
        </span>
      ))}
    </div>
  );
}

function Channels({ detail, days }: { detail: AgentDetail; days: string[] }) {
  const ch = detail.channels as Record<string, unknown>;
  const calls = Array.isArray(ch.calls_by_day) ? ch.calls_by_day as Array<{ day: string; calls: number; minutes: number }> : null;
  const metered = Array.isArray(ch.metered_by_day) ? ch.metered_by_day as Array<{ day: string; purpose: string; count: number }> : null;
  const sms = ch.sms as { inbound: number; outbound: number } | undefined;
  const meteredTotals = metered?.reduce<Record<string, number>>((m, r) => ({ ...m, [r.purpose]: (m[r.purpose] ?? 0) + r.count }), {}) ?? null;
  const callsTotal = calls?.reduce((s, r) => s + r.calls, 0) ?? 0;
  const minutesTotal = calls?.reduce((s, r) => s + Number(r.minutes), 0) ?? 0;

  return (
    <div className="space-y-4">
      {calls && (
        <div>
          <div className="mb-2 grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Stat label="Calls handled" value={callsTotal} hint={`${Math.round(minutesTotal)} min talk time`} />
            {sms && <Stat label="SMS in / out" value={`${sms.inbound} / ${sms.outbound}`} hint="Clara's numbers" />}
            {typeof ch.owner_notifications === 'number' && <Stat label="Owner notifications" value={ch.owner_notifications} />}
            {typeof ch.briefs === 'number' && <Stat label="Briefings" value={ch.briefs} />}
          </div>
          <ResponsiveContainer width="100%" height={140}>
            <BarChart data={fillDays(calls.map((c) => ({ ...c, minutes: Number(c.minutes) })), days, (day) => ({ day, calls: 0, minutes: 0 }))}>
              <CartesianGrid stroke={HUD.grid} vertical={false} />
              <XAxis dataKey="day" tickFormatter={shortDay} stroke={HUD.creamMute} fontSize={11} />
              <YAxis allowDecimals={false} stroke={HUD.creamMute} fontSize={11} width={28} />
              <Tooltip contentStyle={tooltipStyle} labelFormatter={(l) => shortDay(String(l))} />
              <Bar dataKey="calls" name="Calls" fill={HUD.gold} radius={[2, 2, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}
      {meteredTotals && (
        <div>
          <div className="mb-1 text-xs uppercase tracking-wider text-hud-cream-mute">Metered model turns (clara_usage)</div>
          <CountList counts={meteredTotals} />
        </div>
      )}
      {Object.entries(CHANNEL_LABELS).filter(([k]) => ch[k] && typeof ch[k] === 'object' && !Array.isArray(ch[k])).map(([k, label]) => (
        <div key={k}>
          <div className="mb-1 text-xs uppercase tracking-wider text-hud-cream-mute">{label}</div>
          <CountList counts={ch[k] as Record<string, number>} />
        </div>
      ))}
    </div>
  );
}

export function AgentDetailTab({ orgId, agent, now, canManageRequests, onChanged }: {
  orgId: string; agent: OverviewAgent; now: number; canManageRequests: boolean; onChanged?: () => void;
}) {
  const [range, setRange] = useState(7);
  const [detail, setDetail] = useState<AgentDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setDetail(await getAgentDetail(orgId, agent.user_id, range));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [orgId, agent.user_id, range]);

  useEffect(() => { void load(); }, [load]);

  const days = useMemo(() => lastDays(Math.max(range, 1)), [range]);
  const runsSeries = useMemo(() => detail
    ? fillDays(detail.runs_by_day, days, (day) => ({ day, ok: 0, failed: 0, expired: 0, other: 0, avg_duration_s: null }))
    : [], [detail, days]);
  const costSeries = useMemo(() => detail
    ? fillDays(detail.costs.by_day.map((d) => ({ ...d, cost_usd: Number(d.cost_usd) })), days, (day) => ({ day, cost_usd: 0, calls: 0, input_tokens: 0, output_tokens: 0 }))
    : [], [detail, days]);

  const totals = useMemo(() => {
    if (!detail) return null;
    const runs = detail.runs_by_day.reduce((s, d) => ({ ok: s.ok + d.ok, failed: s.failed + d.failed + d.expired, other: s.other + d.other }), { ok: 0, failed: 0, other: 0 });
    const total = runs.ok + runs.failed + runs.other;
    const cost = detail.costs.by_day.reduce((s, d) => s + Number(d.cost_usd), 0);
    const calls = detail.costs.by_day.reduce((s, d) => s + d.calls, 0);
    return { ...runs, total, rate: total ? Math.round((runs.ok / total) * 1000) / 10 : null, cost, calls };
  }, [detail]);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="font-hud-mono text-lg font-semibold tracking-wider text-hud-cream">{agentLabel(agent.slug)}</h2>
          <p className="text-xs text-hud-cream-mute">{agent.name} · {agent.email} · {agent.role}</p>
        </div>
        <RangeToggle value={range} options={RANGES} onChange={setRange} />
      </div>

      {error && <ErrorNote message={error} />}
      <StoppedRequests orgId={orgId} agentUserId={agent.user_id} agentSlug={agent.slug} canManage={canManageRequests}
        onChanged={() => { void load(); onChanged?.(); }} />
      {loading && !detail && <div className="flex justify-center py-10"><Loader2 className="h-6 w-6 animate-spin text-hud-gold" /></div>}

      {detail && totals && (
        <>
          <div className="grid grid-cols-2 gap-4 rounded-xl border border-hud-line-soft bg-hud-bg-card/70 p-4 sm:grid-cols-3 lg:grid-cols-6">
            <Stat label="Runs" value={totals.total} hint={`last ${range === 1 ? '24h' : `${range}d`}`} />
            <Stat label="Success rate" value={totals.rate === null ? '—' : `${totals.rate}%`} tone={totals.rate === null ? 'default' : totals.rate >= 95 ? 'ok' : 'warn'} />
            <Stat label="Failed / expired" value={totals.failed} tone={totals.failed ? 'bad' : 'default'} />
            <Stat label="Overdue schedules" value={detail.backlog.overdue_schedules} tone={detail.backlog.overdue_schedules ? 'warn' : 'default'} />
            <Stat label="AI spend" value={formatUsd(totals.cost)} hint={`${totals.calls} model calls`} />
            {agent.thread && !agent.heartbeat?.last_poll_at
              ? <Stat label="Last reply" value={ago(agent.thread.lastReplyAt, now)} hint="does not poll" />
              : <Stat label="Last heartbeat" value={ago(agent.heartbeat?.last_poll_at, now)} />}
          </div>

          <Panel title="Heartbeat" icon={<HeartPulse size={14} className="text-hud-gold" />}>
            {!agent.heartbeat?.last_poll_at && (
              <p className="mb-3 text-xs text-hud-cream-mute">
                {agent.thread
                  ? 'This agent answers from the cloud when it is spoken to, so it never polls the OS. An empty chart here is normal; its thread is what shows whether it is answering.'
                  : 'This agent has never connected to the OS.'}
              </p>
            )}
            <div className="space-y-4">
              <div>
                <div className="mb-1 text-xs text-hud-cream-mute">Last 24 hours, 10-minute windows</div>
                <HeartbeatStrip detail={detail} now={now} />
              </div>
              {range > 1 && (
                <div>
                  <div className="mb-1 text-xs text-hud-cream-mute">Hourly coverage, last {range} days</div>
                  <HourlyUptime detail={detail} now={now} />
                </div>
              )}
            </div>
          </Panel>

          <div className="grid gap-4 lg:grid-cols-2">
            <Panel title="Runs per day" icon={<Activity size={14} className="text-hud-gold" />}>
              {totals.total === 0 ? <EmptyNote>No runs in this window.</EmptyNote> : (
                <ResponsiveContainer width="100%" height={200}>
                  <BarChart data={runsSeries}>
                    <CartesianGrid stroke={HUD.grid} vertical={false} />
                    <XAxis dataKey="day" tickFormatter={shortDay} stroke={HUD.creamMute} fontSize={11} />
                    <YAxis allowDecimals={false} stroke={HUD.creamMute} fontSize={11} width={32} />
                    <Tooltip contentStyle={tooltipStyle} labelFormatter={(l) => shortDay(String(l))} />
                    <Legend wrapperStyle={{ fontSize: 11 }} />
                    <Bar dataKey="ok" name="Succeeded" stackId="r" fill={HUD.emerald} />
                    <Bar dataKey="failed" name="Failed" stackId="r" fill={HUD.plum} />
                    <Bar dataKey="expired" name="Lease expired" stackId="r" fill={HUD.rust} />
                    <Bar dataKey="other" name="Other" stackId="r" fill={HUD.creamMute} />
                  </BarChart>
                </ResponsiveContainer>
              )}
            </Panel>

            <Panel title="AI spend per day" icon={<Coins size={14} className="text-hud-gold" />}>
              {totals.calls === 0 ? (
                <EmptyNote>No model calls logged for {agentLabel(agent.slug)} in this window. {agent.slug === 'friday'
                  ? 'FRIDAY runs off-box: its spend appears once it reports through the MCP tool agent_usage_report.'
                  : 'Calls are metered from the moment the updated edge functions are deployed.'}</EmptyNote>
              ) : (
                <>
                  <ResponsiveContainer width="100%" height={160}>
                    <BarChart data={costSeries}>
                      <CartesianGrid stroke={HUD.grid} vertical={false} />
                      <XAxis dataKey="day" tickFormatter={shortDay} stroke={HUD.creamMute} fontSize={11} />
                      <YAxis stroke={HUD.creamMute} fontSize={11} width={44} tickFormatter={(v) => formatUsd(Number(v))} />
                      <Tooltip contentStyle={tooltipStyle} labelFormatter={(l) => shortDay(String(l))} formatter={(v) => formatUsd(Number(v))} />
                      <Bar dataKey="cost_usd" name="Spend" fill={HUD.gold} radius={[2, 2, 0, 0]} />
                    </BarChart>
                  </ResponsiveContainer>
                  <ul className="mt-2 space-y-1 text-xs">
                    {detail.costs.by_model.map((m) => (
                      <li key={`${m.provider}/${m.model}`} className="flex justify-between gap-2 text-hud-cream-dim">
                        <span className="truncate">{m.provider} · {m.model}</span>
                        <span className="font-hud-mono text-hud-cream">{formatUsd(Number(m.cost_usd))} · {m.calls} calls</span>
                      </li>
                    ))}
                  </ul>
                </>
              )}
            </Panel>
          </div>

          <Panel title="Tasks" icon={<ListChecks size={14} className="text-hud-gold" />}>
            {detail.by_task.length === 0 ? <EmptyNote>No runs in this window.</EmptyNote> : (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[640px] text-left text-sm">
                  <thead className="text-[11px] uppercase tracking-wider text-hud-cream-mute">
                    <tr>
                      <th className="py-1.5 pr-3 font-medium">Task</th>
                      <th className="py-1.5 pr-3 text-right font-medium">Runs</th>
                      <th className="py-1.5 pr-3 text-right font-medium">Success</th>
                      <th className="py-1.5 pr-3 text-right font-medium">Avg / max</th>
                      <th className="py-1.5 font-medium">Last</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-hud-line-soft">
                    {detail.by_task.map((t) => (
                      <tr key={t.task_key}>
                        <td className="py-1.5 pr-3"><div className="text-hud-cream">{t.title}</div><div className="font-hud-mono text-[11px] text-hud-cream-mute">{t.task_key}</div></td>
                        <td className="py-1.5 pr-3 text-right font-hud-mono text-hud-cream-dim">{t.runs}</td>
                        <td className={`py-1.5 pr-3 text-right font-hud-mono ${t.failed ? 'text-hud-rust' : 'text-hud-emerald'}`}>{t.runs ? Math.round((t.ok / t.runs) * 100) : 0}%</td>
                        <td className="py-1.5 pr-3 text-right font-hud-mono text-hud-cream-dim">{t.avg_duration_s === null ? '—' : `${t.avg_duration_s}s`} / {t.max_duration_s === null ? '—' : `${t.max_duration_s}s`}</td>
                        <td className="py-1.5"><Badge tone={RUN_STATUS_TONE[t.last_status] ?? 'muted'}>{t.last_status.replace('_', ' ')}</Badge> <span className="text-xs text-hud-cream-mute">{ago(t.last_at, now)}</span></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Panel>

          <div className="grid gap-4 lg:grid-cols-2">
            <Panel title="Schedules" icon={<CalendarClock size={14} className="text-hud-gold" />}>
              {detail.schedules.length === 0 ? <EmptyNote>No schedules.</EmptyNote> : (
                <ul className="divide-y divide-hud-line-soft text-sm">
                  {detail.schedules.map((s) => (
                    <li key={s.id} className="flex items-start justify-between gap-3 py-1.5">
                      <div className="min-w-0">
                        <div className={s.mode === 'off' ? 'text-hud-cream-mute' : 'text-hud-cream'}>{s.title}</div>
                        <div className="text-[11px] text-hud-cream-mute">{s.cadence}{s.time_of_day ? ` at ${s.time_of_day}` : ''} · {s.risk_tier.replace('_', ' ')}</div>
                      </div>
                      <div className="shrink-0 text-right text-xs">
                        <Badge tone={s.mode === 'active' ? 'ok' : s.mode === 'shadow' ? 'warn' : 'muted'}>{s.mode}</Badge>
                        {s.mode !== 'off' && (
                          <div className={`mt-0.5 ${s.overdue ? 'text-hud-plum' : 'text-hud-cream-mute'}`}>
                            {s.overdue ? `overdue since ${ago(s.next_run_at, now).replace(' ago', '')}` : `next ${ago(s.next_run_at, now)}`}
                          </div>
                        )}
                        <div className="text-hud-cream-mute">last {ago(s.last_run_at, now)}</div>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </Panel>

            <Panel title="Recent errors" icon={<AlertTriangle size={14} className="text-hud-gold" />}>
              {detail.recent_errors.length === 0 ? <EmptyNote>No failed, expired or rejected runs in this window.</EmptyNote> : (
                <ul className="max-h-80 space-y-2 overflow-y-auto pr-1 text-sm">
                  {detail.recent_errors.map((e) => (
                    <li key={e.run_id} className="rounded-lg border border-hud-line-soft p-2">
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-hud-cream">{e.title}</span>
                        <span className="shrink-0 text-xs text-hud-cream-mute">{fmtDateTime(e.at)}</span>
                      </div>
                      <div className="mt-0.5"><Badge tone={RUN_STATUS_TONE[e.status] ?? 'muted'}>{e.status.replace('_', ' ')}</Badge></div>
                      {e.error && <pre className="mt-1 whitespace-pre-wrap break-words font-hud-mono text-xs text-hud-plum">{e.error}</pre>}
                    </li>
                  ))}
                </ul>
              )}
            </Panel>
          </div>

          <div className="grid gap-4 lg:grid-cols-3">
            <Panel title="Queue & backlog" icon={<Inbox size={14} className="text-hud-gold" />}>
              <div className="grid grid-cols-3 gap-3">
                <Stat label="Open requests" value={detail.backlog.requests.length} />
                <Stat label="Awaiting approval" value={detail.backlog.awaiting_approval} tone={detail.backlog.awaiting_approval ? 'warn' : 'default'} />
                <Stat label="Chat turns open" value={detail.backlog.open_thread_turns} />
              </div>
              {detail.backlog.requests.length > 0 && (
                <ul className="mt-3 space-y-1 text-sm">
                  {detail.backlog.requests.map((r) => (
                    <li key={r.id} className="flex items-start justify-between gap-2">
                      <span className="min-w-0 break-words text-hud-cream-soft">{r.title}</span>
                      <span className="shrink-0 text-right text-xs">
                        <Badge tone={r.status === 'needs_input' ? 'warn' : 'muted'}>{r.status.replace('_', ' ')}</Badge>
                        <div className="text-hud-cream-mute">{ago(r.created_at, now)}</div>
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </Panel>

            <Panel title="Supervisor & liveness" icon={<Server size={14} className="text-hud-gold" />}>
              {detail.supervisor ? (
                <dl className="space-y-1 text-sm">
                  <div className="flex justify-between gap-2"><dt className="text-hud-cream-mute">Host</dt><dd className="text-hud-cream-soft">{detail.supervisor.host ?? '—'}</dd></div>
                  <div className="flex justify-between gap-2"><dt className="text-hud-cream-mute">Last report</dt><dd className="text-hud-cream-soft">{ago(detail.supervisor.updated_at, now)}</dd></div>
                  <div className="flex justify-between gap-2"><dt className="text-hud-cream-mute">Last success</dt><dd className="text-hud-cream-soft">{ago(detail.supervisor.last_success_at, now)}</dd></div>
                  <div className="flex justify-between gap-2"><dt className="text-hud-cream-mute">Consecutive fails</dt><dd className={detail.supervisor.consecutive_fails ? 'text-hud-plum' : 'text-hud-cream-soft'}>{detail.supervisor.consecutive_fails}</dd></div>
                  {detail.supervisor.last_error && <pre className="mt-1 whitespace-pre-wrap break-words font-hud-mono text-xs text-hud-plum">{detail.supervisor.last_error}</pre>}
                </dl>
              ) : (
                <EmptyNote>This agent's supervisor has never reported (agent-supervisor-report). Without it, an outage can only be seen as a missing heartbeat, not explained.</EmptyNote>
              )}
              {detail.liveness && (
                <dl className="mt-3 space-y-1 border-t border-hud-line-soft pt-3 text-sm">
                  <div className="flex justify-between gap-2"><dt className="text-hud-cream-mute">Liveness alarm</dt><dd className={detail.liveness.alerting ? 'text-hud-plum' : 'text-hud-emerald'}>{detail.liveness.alerting ? 'paging' : 'quiet'}</dd></div>
                  <div className="flex justify-between gap-2"><dt className="text-hud-cream-mute">Last went stale</dt><dd className="text-hud-cream-soft">{ago(detail.liveness.last_stale_at as string | null, now)}</dd></div>
                  <div className="flex justify-between gap-2"><dt className="text-hud-cream-mute">Last recovered</dt><dd className="text-hud-cream-soft">{ago(detail.liveness.last_recovery_at as string | null, now)}</dd></div>
                  <div className="flex justify-between gap-2"><dt className="text-hud-cream-mute">Schedules / tunnel alarm</dt><dd className="text-hud-cream-soft">{detail.liveness.schedules_alerting ? 'on' : 'off'} / {detail.liveness.tunnel_alerting ? 'on' : 'off'}</dd></div>
                </dl>
              )}
            </Panel>

            <Panel title="Memory vault" icon={<Database size={14} className="text-hud-gold" />}>
              {detail.vault ? (
                <dl className="space-y-1 text-sm">
                  <div className="flex justify-between gap-2"><dt className="text-hud-cream-mute">Last sync</dt><dd className="text-hud-cream-soft">{ago(detail.vault.last_synced_at, now)}</dd></div>
                  <div className="flex justify-between gap-2"><dt className="text-hud-cream-mute">Notes / links</dt><dd className="font-hud-mono text-hud-cream-soft">{detail.vault.note_count} / {detail.vault.link_count}</dd></div>
                  <div className="flex justify-between gap-2"><dt className="text-hud-cream-mute">Status</dt><dd className={detail.vault.last_error ? 'text-hud-plum' : 'text-hud-emerald'}>{detail.vault.last_error ? 'error' : 'ok'}</dd></div>
                  {detail.vault.last_error && <pre className="whitespace-pre-wrap break-words font-hud-mono text-xs text-hud-plum">{detail.vault.last_error}</pre>}
                </dl>
              ) : <EmptyNote>No vault sync recorded for this agent.</EmptyNote>}
            </Panel>
          </div>

          <Panel title="Channel activity" icon={<MessagesSquare size={14} className="text-hud-gold" />}>
            <Channels detail={detail} days={days} />
            <p className="mt-3 text-[11px] text-hud-cream-mute">Tokens this window: {formatTokens(detail.costs.by_day.reduce((s, d) => s + Number(d.input_tokens), 0))} in · {formatTokens(detail.costs.by_day.reduce((s, d) => s + Number(d.output_tokens), 0))} out.</p>
          </Panel>

          <Panel title="Run history" icon={<Activity size={14} className="text-hud-gold" />}>
            <RunHistory orgId={orgId} agentUserId={agent.user_id} />
          </Panel>
        </>
      )}
    </div>
  );
}
