import { describe, expect, it } from 'vitest';
import {
  agentAlerts, agentStatus, ago, buildRoster, fillDays, formatTokens, formatUsd, lastDays, pctChange, pivotCostByDay, uptimePct,
  type OverviewAgent,
} from './agentOps';

const NOW = Date.parse('2026-10-29T12:00:00Z');
const minsAgo = (m: number) => new Date(NOW - m * 60_000).toISOString();

function agent(over: Partial<OverviewAgent> = {}): OverviewAgent {
  return {
    user_id: 'u1', name: 'Friday Daily', email: 'friday@x', role: 'FridayAgent', slug: 'friday',
    heartbeat: { last_poll_at: minsAgo(1), poll_count: 10, last_due: 0, last_resolved: 0 },
    liveness: null, supervisor: null, uptime_24h: null, uptime_7d: null,
    runs_24h: { total: 0, ok: 0, failed: 0, expired: 0, rejected: 0, running: 0, awaiting_approval: 0 },
    runs_7d: { total: 0, ok: 0, failed: 0, avg_duration_s: null },
    current: [], last_run: null, last_error: null,
    schedules: { active: 1, shadow: 0, off: 0, overdue: 0, next_run_at: null },
    backlog: { open_requests: 0, needs_input: 0, open_thread_turns: 0, awaiting_approval: 0 },
    vault: null, cost_mtd: { cost_usd: 0, calls: 0, unpriced_calls: 0 },
    ...over,
  };
}

describe('agentStatus', () => {
  it('is live inside 10 minutes', () => {
    expect(agentStatus(agent(), NOW).level).toBe('live');
  });
  it('is offline when a workstation agent (it has a supervisor) never polled', () => {
    const supervisor = { host: 'BOX', consecutive_fails: 0, last_error: null, last_failure_at: null, last_success_at: null, updated_at: null };
    expect(agentStatus(agent({ heartbeat: null, supervisor }), NOW)).toEqual({ level: 'offline', reason: 'Has never polled the OS for work' });
  });
  it('is idle, not an outage, when an agent has never connected at all', () => {
    const a = agent({ heartbeat: null });
    expect(agentStatus(a, NOW)).toEqual({ level: 'idle', reason: 'Not set up: has never connected to the OS' });
    expect(agentAlerts(a, NOW)).toEqual([]);
  });
  it('judges an agent that answers from the cloud by its thread', () => {
    const turn = (status: 'answered' | 'failed' | 'working', mins: number, error: string | null = null) => ({ status, error, created_at: minsAgo(mins), updated_at: minsAgo(mins) });
    const st = (thread: OverviewAgent['thread']) => agentStatus(agent({ heartbeat: null, thread }), NOW);
    expect(st({ lastReplyAt: minsAgo(3), lastTurn: turn('answered', 4) })).toEqual({ level: 'live', reason: 'Answers from the cloud (does not poll) — last reply 3m ago' });
    expect(st({ lastReplyAt: null, lastTurn: null }).level).toBe('idle');
    // A failed or unanswered message counts only while nothing has been said since.
    expect(st({ lastReplyAt: minsAgo(30), lastTurn: turn('failed', 8, 'model  overloaded') })).toEqual({ level: 'stale', reason: "Couldn't answer your message from 8m ago: model overloaded" });
    expect(st({ lastReplyAt: minsAgo(2), lastTurn: turn('failed', 8) }).level).toBe('live');
    expect(st({ lastReplyAt: minsAgo(30), lastTurn: turn('working', 7) })).toEqual({ level: 'stale', reason: 'No answer yet to your message from 7m ago' });
    expect(st({ lastReplyAt: minsAgo(30), lastTurn: turn('working', 2) }).level).toBe('live');
    // A supervisor row does not make it a workstation agent once it has answered in its thread.
    const supervisor = { host: 'BOX', consecutive_fails: 0, last_error: null, last_failure_at: null, last_success_at: null, updated_at: null };
    expect(agentStatus(agent({ heartbeat: null, supervisor, thread: { lastReplyAt: minsAgo(3), lastTurn: null } }), NOW).level).toBe('live');
    expect(agentStatus(agent({ heartbeat: null, supervisor, thread: { lastReplyAt: null, lastTurn: null } }), NOW).level).toBe('offline');
    // The warning is an alert; idle and live are not.
    expect(agentAlerts(agent({ heartbeat: null, thread: { lastReplyAt: minsAgo(30), lastTurn: turn('working', 7) } }), NOW).map((x) => x.severity)).toEqual(['warning']);
  });
  it('is stale between 10 and 60 minutes', () => {
    const s = agentStatus(agent({ heartbeat: { last_poll_at: minsAgo(25), poll_count: 1, last_due: null, last_resolved: null } }), NOW);
    expect(s.level).toBe('stale');
    expect(s.reason).toContain('No poll for 25m');
  });
  it('quotes the supervisor error when it is failing', () => {
    const s = agentStatus(agent({
      heartbeat: { last_poll_at: minsAgo(6 * 24 * 60), poll_count: 1, last_due: null, last_resolved: null },
      supervisor: { host: 'BOX', consecutive_fails: 3, last_error: 'no .next build', last_failure_at: minsAgo(1), last_success_at: null, updated_at: null },
    }), NOW);
    expect(s.level).toBe('offline');
    expect(s.reason).toContain('No poll for 6d');
    expect(s.reason).toContain('supervisor on BOX reports: no .next build');
  });
});

describe('agentAlerts', () => {
  it('warns about requests the agent could not finish', () => {
    expect(agentAlerts(agent({ stopped: 43 }), NOW)).toEqual([{ severity: 'warning', text: "43 requests it couldn't finish: retry or dismiss them" }]);
    expect(agentAlerts(agent({ stopped: 1 }), NOW)[0].text).toBe("1 request it couldn't finish: retry or dismiss it");
  });

  it('is empty for a healthy agent', () => {
    expect(agentAlerts(agent(), NOW)).toEqual([]);
  });
  it('collects liveness, overdue, failures, input and vault problems', () => {
    const alerts = agentAlerts(agent({
      liveness: { alerting: true, last_alert_at: minsAgo(30), last_stale_at: null, last_recovery_at: null, schedules_alerting: false, schedules_alert_at: null, tunnel_alerting: false, tunnel_alert_at: null },
      schedules: { active: 2, shadow: 0, off: 0, overdue: 2, next_run_at: null },
      runs_24h: { total: 5, ok: 3, failed: 1, expired: 1, rejected: 0, running: 0, awaiting_approval: 0 },
      backlog: { open_requests: 1, needs_input: 1, open_thread_turns: 0, awaiting_approval: 0 },
      vault: { last_synced_at: minsAgo(3 * 24 * 60), note_count: 1, link_count: 0, last_error: null },
    }), NOW);
    expect(alerts.map((a) => a.severity)).toEqual(['critical', 'warning', 'warning', 'info', 'warning']);
    expect(alerts[1].text).toBe('2 schedules overdue');
    expect(alerts[2].text).toBe('2 failed/expired runs in 24h');
  });
});

describe('formatting', () => {
  it('formats money honestly', () => {
    expect(formatUsd(null)).toBe('—');
    expect(formatUsd(0)).toBe('$0.00');
    expect(formatUsd(0.004)).toBe('<$0.01');
    expect(formatUsd(12.345)).toBe('$12.35');
    expect(formatUsd(1234.5)).toBe('$1,235');
  });
  it('formats tokens', () => {
    expect(formatTokens(0)).toBe('0');
    expect(formatTokens(950)).toBe('950');
    expect(formatTokens(12_300)).toBe('12.3k');
    expect(formatTokens(4_560_000)).toBe('4.6M');
  });
  it('formats relative time both ways', () => {
    expect(ago(null, NOW)).toBe('never');
    expect(ago(minsAgo(90), NOW)).toBe('1h ago');
    expect(ago(new Date(NOW + 30 * 60_000).toISOString(), NOW)).toBe('in 30m');
  });
  it('computes uptime and change', () => {
    expect(uptimePct(null)).toBeNull();
    expect(uptimePct({ since: '', up_buckets: 135, expected_buckets: 144 })).toBe(93.8);
    expect(pctChange(15, 10)).toBe(50);
    expect(pctChange(5, 0)).toBeNull();
  });
});

describe('buildRoster', () => {
  const overview = (agents: OverviewAgent[]) => ({
    generated_at: '', agents, services: [],
    supervisors: { clara: { host: 'BOX', consecutive_fails: 0, last_error: null, last_failure_at: null, last_success_at: null, updated_at: null } },
    vaults: { clara: { last_synced_at: null, note_count: 673, link_count: 0, last_error: null } },
    cost_mtd_by_agent: {},
  });

  it('shows an expected agent with no user as not provisioned, keeping its per-slug state', () => {
    const r = buildRoster(overview([agent()]));
    expect(r.map((e) => (e.kind === 'agent' ? e.agent.slug : `${e.known.slug}:unprovisioned`))).toEqual(['clara:unprovisioned', 'friday', 'harvey:unprovisioned']);
    const clara = r[0];
    if (clara.kind !== 'unprovisioned') throw new Error('expected a placeholder');
    expect(clara.supervisor?.host).toBe('BOX');
    expect(clara.vault?.note_count).toBe(673);
    expect(clara.cost_mtd).toBeNull();
  });

  it('finds agents by role slug whatever their user id, and keeps unknown agent roles', () => {
    const newClara = agent({ user_id: 'brand-new-id', slug: 'clara', name: 'Clara', email: 'clara2@x', role: 'ClaraAgent' });
    const other = agent({ user_id: 'u9', slug: 'scout', role: 'ScoutAgent' });
    const r = buildRoster(overview([other, agent(), newClara]));
    expect(r.map((e) => (e.kind === 'agent' ? e.agent.user_id : 'x'))).toEqual(['brand-new-id', 'u1', 'x', 'u9']);   // 'x' = Harvey, expected but not provisioned
  });
});

describe('series helpers', () => {
  it('lastDays ends today and is ordered', () => {
    const d = lastDays(3, new Date(2026, 9, 29, 15));
    expect(d).toEqual(['2026-10-27', '2026-10-28', '2026-10-29']);
  });
  it('pivotCostByDay zero-fills days and agents', () => {
    const days = ['2026-10-27', '2026-10-28'];
    const { data, agents } = pivotCostByDay([
      { day: '2026-10-28', agent: 'clara', cost_usd: 1.25, calls: 3, input_tokens: 0, output_tokens: 0 },
      { day: '2026-10-28', agent: 'friday', cost_usd: 0.5, calls: 1, input_tokens: 0, output_tokens: 0 },
      { day: '2026-10-01', agent: 'friday', cost_usd: 9, calls: 1, input_tokens: 0, output_tokens: 0 },
    ], days);
    expect(agents).toEqual(['clara', 'friday']);
    expect(data).toEqual([
      { day: '2026-10-27', clara: 0, friday: 0 },
      { day: '2026-10-28', clara: 1.25, friday: 0.5 },
    ]);
  });
  it('fillDays keeps existing rows and fills the gaps', () => {
    const out = fillDays([{ day: 'b', n: 2 }], ['a', 'b'], (day) => ({ day, n: 0 }));
    expect(out).toEqual([{ day: 'a', n: 0 }, { day: 'b', n: 2 }]);
  });
});
