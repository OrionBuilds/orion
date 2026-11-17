import { Activity, AlertTriangle, ChevronRight, Cpu, Server, UserX } from 'lucide-react';
import {
  agentAlerts, agentLabel, agentStatus, ago, buildRoster, formatUsd, uptimePct, type Overview, type OverviewAgent, type RosterEntry,
} from '../../services/agentOps';
import { AlertRow, Badge, EmptyNote, Panel, SplitBar, Stat, StatusPill } from './ui';
import { fmtDateTime, HUD } from './format';

function uptimeLabel(a: OverviewAgent, which: 'uptime_24h' | 'uptime_7d'): { value: string; hint?: string } {
  const pct = uptimePct(a[which]);
  if (pct === null) return { value: '—', hint: a.heartbeat?.last_poll_at ? 'collecting history' : 'no heartbeat to measure' };
  return { value: `${pct}%`, hint: `since ${fmtDateTime(a[which]!.since)}` };
}

function AgentCard({ a, now, onOpen }: { a: OverviewAgent; now: number; onOpen: () => void }) {
  const status = agentStatus(a, now);
  const alerts = agentAlerts(a, now);
  const u24 = uptimeLabel(a, 'uptime_24h');
  const u7 = uptimeLabel(a, 'uptime_7d');
  const r = a.runs_24h;
  const activity = a.current.length
    ? `Running: ${a.current.map((c) => c.title).join(', ')}`
    : a.last_run
      ? `Idle — last ran ${a.last_run.title} ${ago(a.last_run.at, now)} (${a.last_run.status.replace('_', ' ')})`
      : 'Idle — no runs recorded';

  return (
    <article className="flex flex-col rounded-xl border border-hud-line-soft bg-hud-bg-card/70 p-4">
      <header className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h3 className="font-hud-mono text-base font-semibold tracking-wider text-hud-cream">{agentLabel(a.slug)}</h3>
            <StatusPill level={status.level} />
          </div>
          <p className="mt-0.5 truncate text-xs text-hud-cream-mute">{a.name} · {a.email}</p>
        </div>
        <button
          type="button"
          onClick={onOpen}
          className="inline-flex shrink-0 items-center gap-1 rounded-md border border-hud-line-soft px-2 py-1 text-xs text-hud-cream-dim hover:border-hud-line hover:text-hud-cream"
        >
          Details <ChevronRight size={12} />
        </button>
      </header>

      <p className={`mt-2 text-sm ${status.level === 'live' ? 'text-hud-cream-dim' : status.level === 'idle' ? 'text-hud-cream-mute' : status.level === 'stale' ? 'text-hud-rust' : 'text-hud-plum'}`}>
        {status.reason}
      </p>

      <div className="mt-4 grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-4">
        {a.thread && !a.heartbeat?.last_poll_at
          ? <Stat label="Last reply" value={ago(a.thread.lastReplyAt, now)} hint="does not poll" />
          : <Stat label="Last heartbeat" value={ago(a.heartbeat?.last_poll_at, now)} hint={a.heartbeat ? `${a.heartbeat.poll_count.toLocaleString()} polls` : undefined} />}
        <Stat label="Uptime 24h" value={u24.value} hint={u24.hint} tone={uptimePct(a.uptime_24h) === null ? 'default' : (uptimePct(a.uptime_24h) ?? 0) >= 99 ? 'ok' : 'warn'} />
        <Stat label="Uptime 7d" value={u7.value} hint={u7.hint} />
        <Stat label="AI spend MTD" value={formatUsd(a.cost_mtd.cost_usd)} hint={`${a.cost_mtd.calls} calls${a.cost_mtd.unpriced_calls ? ` · ${a.cost_mtd.unpriced_calls} unpriced` : ''}`} />
      </div>

      <div className="mt-4 space-y-1.5">
        <div className="flex items-center justify-between text-xs text-hud-cream-mute">
          <span>Runs (24h)</span>
          <span className="font-hud-mono">
            <span className="text-hud-emerald">{r.ok} ok</span>
            {' · '}<span className="text-hud-plum">{r.failed + r.expired} failed</span>
            {' · '}<span>{r.running} running</span>
            {r.awaiting_approval ? <> · <span className="text-hud-rust">{r.awaiting_approval} awaiting</span></> : null}
          </span>
        </div>
        <SplitBar parts={[
          { value: r.ok, color: HUD.emerald, label: 'ok' },
          { value: r.failed + r.expired, color: HUD.plum, label: 'failed' },
          { value: r.rejected + r.awaiting_approval, color: HUD.rust, label: 'rejected/awaiting' },
          { value: r.running, color: HUD.gold, label: 'running' },
        ]} />
        <p className="text-xs text-hud-cream-mute">
          7d: {a.runs_7d.total} runs, {a.runs_7d.total ? Math.round((a.runs_7d.ok / a.runs_7d.total) * 100) : 0}% ok
          {a.runs_7d.avg_duration_s !== null ? ` · avg ${a.runs_7d.avg_duration_s}s` : ''}
        </p>
      </div>

      <dl className="mt-4 grid grid-cols-1 gap-1.5 text-xs sm:grid-cols-2">
        <div className="flex items-center gap-1.5 text-hud-cream-dim"><Activity size={12} className="text-hud-gold" /><span className="truncate" title={activity}>{activity}</span></div>
        <div className="flex items-center gap-1.5 text-hud-cream-dim">
          <Server size={12} className="text-hud-gold" />
          <span className="truncate">
            Host: {a.supervisor?.host ?? 'not reported'}
            {a.supervisor?.updated_at ? ` · supervisor ${ago(a.supervisor.updated_at, now)}` : ''}
          </span>
        </div>
        <div className="flex items-center gap-1.5 text-hud-cream-dim">
          <Cpu size={12} className="text-hud-gold" />
          <span>Version: not reported</span>
        </div>
        <div className="text-hud-cream-dim">
          Schedules: {a.schedules.active} active{a.schedules.shadow ? `, ${a.schedules.shadow} shadow` : ''}, {a.schedules.off} off
          {a.schedules.next_run_at ? ` · next ${ago(a.schedules.next_run_at, now)}` : ''}
        </div>
        <div className="text-hud-cream-dim">
          Backlog: {a.backlog.open_requests} request{a.backlog.open_requests === 1 ? '' : 's'}, {a.backlog.open_thread_turns} chat turn{a.backlog.open_thread_turns === 1 ? '' : 's'}
          {a.schedules.overdue ? `, ${a.schedules.overdue} overdue` : ''}
        </div>
        <div className="text-hud-cream-dim">
          Memory vault: {a.vault ? `${a.vault.note_count} notes · synced ${ago(a.vault.last_synced_at, now)}` : 'no sync recorded'}
        </div>
      </dl>

      <div className="mt-4 border-t border-hud-line-soft pt-3">
        <div className="mb-1.5 flex items-center gap-2 text-xs uppercase tracking-wider text-hud-cream-mute">
          Open alerts {alerts.length ? <Badge tone={alerts.some((x) => x.severity === 'critical') ? 'bad' : 'warn'}>{alerts.length}</Badge> : <Badge tone="ok">none</Badge>}
        </div>
        {alerts.length > 0 && <ul className="space-y-1">{alerts.map((al, i) => <AlertRow key={i} alert={al} />)}</ul>}
      </div>
    </article>
  );
}

/** An expected agent with no OS user holding its role (deleted, or not created yet). */
function UnprovisionedCard({ entry, now }: { entry: Extract<RosterEntry, { kind: 'unprovisioned' }>; now: number }) {
  const { known, supervisor, vault, cost_mtd } = entry;
  return (
    <article className="flex flex-col rounded-xl border border-dashed border-hud-line-soft bg-hud-bg-card/40 p-4">
      <header className="flex items-center gap-2">
        <h3 className="font-hud-mono text-base font-semibold tracking-wider text-hud-cream-dim">{known.label}</h3>
        <span className="inline-flex items-center gap-1 rounded-full border border-hud-line-soft bg-hud-bg-elev px-2 py-0.5 text-xs text-hud-cream-dim">
          <UserX size={12} /> not provisioned
        </span>
      </header>
      <p className="mt-1 text-xs text-hud-cream-mute">{known.purpose}</p>
      <p className="mt-3 text-sm text-hud-cream-dim">
        No OS user holds the {known.role} role, so there is no heartbeat, schedule or run history to show. Create the
        agent's user with that role (Settings › Staff) and point its service at the new account; it appears here on its first poll.
      </p>
      <dl className="mt-3 grid grid-cols-1 gap-1.5 text-xs text-hud-cream-mute sm:grid-cols-3">
        <div>Supervisor: {supervisor ? `${supervisor.host ?? 'host unknown'} · reported ${ago(supervisor.updated_at, now)}` : 'never reported'}</div>
        <div>Memory vault: {vault ? `${vault.note_count} notes · synced ${ago(vault.last_synced_at, now)}` : 'no sync recorded'}</div>
        <div>AI spend MTD: {cost_mtd ? `${formatUsd(Number(cost_mtd.cost_usd))} · ${cost_mtd.calls} calls` : formatUsd(0)}</div>
      </dl>
    </article>
  );
}

export function OverviewTab({ overview, now, onOpenAgent }: { overview: Overview; now: number; onOpenAgent: (userId: string) => void }) {
  const downServices = overview.services.filter((s) => s.down_until && Date.parse(s.down_until) > now);
  const roster = buildRoster(overview);
  return (
    <div className="space-y-4">
      {roster.length === 0 ? (
        <EmptyNote>No agents. An agent appears here as soon as an OS user holds an agent role (e.g. FridayAgent).</EmptyNote>
      ) : (
        <div className="grid gap-4 xl:grid-cols-2">
          {roster.map((e) => e.kind === 'agent'
            ? <AgentCard key={e.agent.user_id} a={e.agent} now={now} onOpen={() => onOpenAgent(e.agent.user_id)} />
            : <UnprovisionedCard key={`unprovisioned-${e.known.slug}`} entry={e} now={now} />)}
        </div>
      )}

      <Panel title="Clara voice & messaging services" icon={<AlertTriangle size={14} className="text-hud-gold" />}>
        {overview.services.length === 0 ? (
          <p className="text-sm text-hud-cream-mute">No service outages recorded (clara_service_health is empty — text-to-speech has never been marked down).</p>
        ) : (
          <ul className="space-y-1 text-sm">
            {overview.services.map((s) => {
              const down = downServices.includes(s);
              return (
                <li key={s.service} className="flex flex-wrap items-center gap-2">
                  <span className="font-hud-mono text-hud-cream">{s.service}</span>
                  <Badge tone={down ? 'bad' : 'ok'}>{down ? `down until ${fmtDateTime(s.down_until)}` : 'up'}</Badge>
                  {s.last_error && <span className="text-xs text-hud-cream-mute">last error: {s.last_error}</span>}
                </li>
              );
            })}
          </ul>
        )}
      </Panel>
    </div>
  );
}
