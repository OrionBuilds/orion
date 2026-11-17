import { describe, it, expect } from 'vitest';
import type { UnifiedTask } from '../../services/tasksHub';
import type { DashboardAppointment } from '../../services/dashboard';
import type { OverviewAgent } from '../../services/agentOps';
import type { HarveyStatusRow } from '../../services/harvey';
import { agentLine, harveyLine, nextUpNote, nextUpRows, pickDayTasks, taskDueLabel, threadAgentLine } from './myDayData';

const now = new Date(2026, 10, 12, 9, 0); // Thu Nov 12 2026, 9:00 local
const nowMs = now.getTime();
const minsAgo = (m: number) => new Date(nowMs - m * 60_000).toISOString();

function task(id: string, dueDate: string | null, extra: Partial<UnifiedTask> = {}): UnifiedTask {
  return { id, title: id, status: 'todo', priority: 'medium', dueDate, parentType: 'personal', ...extra } as UnifiedTask;
}

describe('pickDayTasks', () => {
  it('keeps overdue, today and tomorrow, oldest first, and drops the rest', () => {
    const { rows, more } = pickDayTasks([
      task('tomorrow', '2026-11-13'),
      task('next-week', '2026-11-19'),
      task('today', '2026-11-12'),
      task('no-date', null),
      task('overdue', '2026-11-09'),
      task('done', '2026-11-12', { status: 'completed' }),
      task('dropped', '2026-11-10', { status: 'cancelled' }),
    ], now);
    expect(rows.map((r) => [r.task.id, r.bucket])).toEqual([['overdue', 'overdue'], ['today', 'today'], ['tomorrow', 'tomorrow']]);
    expect(more).toBe(0);
    expect(rows.map(taskDueLabel)).toEqual(['Overdue · Nov 9', 'Today', 'Tomorrow']);
  });

  it('reads a timestamp due date as its local day', () => {
    const lateTonight = new Date(2026, 10, 12, 23, 30).toISOString();
    const justAfterMidnight = new Date(2026, 10, 13, 0, 15).toISOString();
    const { rows } = pickDayTasks([task('b', justAfterMidnight), task('a', lateTonight)], now);
    expect(rows.map((r) => [r.task.id, r.bucket])).toEqual([['a', 'today'], ['b', 'tomorrow']]);
  });

  it('orders a day by priority then title, caps the list and counts the rest', () => {
    const tasks = [
      task('low', '2026-11-12', { priority: 'low' }),
      task('b', '2026-11-12'), task('a', '2026-11-12'),
      task('urgent', '2026-11-12', { priority: 'urgent' }),
      task('high', '2026-11-12', { priority: 'high' }),
    ];
    expect(pickDayTasks(tasks, now).rows.map((r) => r.task.id)).toEqual(['urgent', 'high', 'a', 'b', 'low']);
    const capped = pickDayTasks(tasks, now, 2);
    expect(capped.rows.map((r) => r.task.id)).toEqual(['urgent', 'high']);
    expect(capped.more).toBe(3);
  });
});

function appt(id: string, start: Date, extra: Partial<DashboardAppointment> = {}): DashboardAppointment {
  return {
    id, source: 'crm', start_at_utc: start.toISOString(), end_at_utc: new Date(start.getTime() + 30 * 60_000).toISOString(),
    status: 'scheduled', title: id, subtitle: '', appointmentId: id, googleEventId: null, htmlLink: null, ...extra,
  };
}

describe('nextUpRows', () => {
  it('labels the day, links each row and stops at seven days', () => {
    const rows = nextUpRows([
      appt('week-out', new Date(2026, 10, 19, 9, 0)),
      appt('mon', new Date(2026, 10, 16, 14, 30), { source: 'google', appointmentId: null, subtitle: 'Ana · HQ' }),
      appt('today', new Date(2026, 10, 12, 11, 0)),
      appt('tomorrow', new Date(2026, 10, 13, 8, 0)),
    ], now);
    expect(rows.map((r) => [r.day, r.time, r.title])).toEqual([
      ['Today', '11:00 AM', 'today'], ['Tomorrow', '8:00 AM', 'tomorrow'], ['Mon, Nov 16', '2:30 PM', 'mon'],
    ]);
    expect(rows[0].href).toBe('/calendars?tab=list&appointmentId=today');
    expect(rows[2]).toMatchObject({ href: '/calendars?view=agenda&date=2026-11-16', detail: 'Ana · HQ', synced: true });
  });

  it('shows what is running now, drops what has ended, and caps the list', () => {
    const rows = nextUpRows([
      appt('ended', new Date(2026, 10, 12, 7, 0)),
      appt('running', new Date(2026, 10, 12, 8, 45)),
      ...[10, 11, 12, 13, 14].map((h) => appt(`h${h}`, new Date(2026, 10, 12, h, 0))),
    ], now);
    expect(rows.map((r) => r.title)).toEqual(['running', 'h10', 'h11', 'h12', 'h13']);
    expect(rows[0]).toMatchObject({ day: 'Today', time: 'Now' });
  });

  it('puts a mirrored all-day event on the date it is for', () => {
    const allDay = (id: string, from: string, to: string | null) => appt(id, now, {
      source: 'google', appointmentId: null, allDay: true,
      start_at_utc: `${from}T00:00:00.000Z`, end_at_utc: to ? `${to}T00:00:00.000Z` : null,
    });
    const rows = nextUpRows([
      allDay('tomorrow', '2026-11-13', '2026-11-14'),
      allDay('today', '2026-11-12', null),
      allDay('yesterday', '2026-11-11', '2026-11-12'),
    ], now);
    expect(rows.map((r) => [r.title, r.day, r.time])).toEqual([['today', 'Today', 'All day'], ['tomorrow', 'Tomorrow', 'All day']]);
  });
});

describe('nextUpRows: whole-day timed events', () => {
  it('shows a midnight-to-midnight block as All day, not Now', () => {
    const rows = nextUpRows([
      appt('ooo', new Date(2026, 10, 12, 0, 0), {
        source: 'google', appointmentId: null, end_at_utc: new Date(2026, 10, 13, 0, 0).toISOString(),
      }),
      appt('running', new Date(2026, 10, 12, 8, 45), { end_at_utc: new Date(2026, 10, 12, 9, 30).toISOString() }),
    ], now);
    expect(rows.map((r) => [r.title, r.day, r.time])).toEqual([['ooo', 'Today', 'All day'], ['running', 'Today', 'Now']]);
  });
});

describe('nextUpNote', () => {
  it('says when nothing synced is behind a short list, and stays quiet otherwise', () => {
    expect(nextUpNote({ connected: false, rows: [], max: 5 })).toMatch(/^No synced calendar events: no Google or Microsoft calendar is connected/);
    expect(nextUpNote({ connected: true, rows: [{ synced: false }], max: 5 })).toMatch(/^No synced calendar events/);
    expect(nextUpNote({ connected: true, rows: [{ synced: false }, { synced: true }], max: 5 })).toBeNull();
    expect(nextUpNote({ connected: true, rows: Array(5).fill({ synced: false }), max: 5 })).toBeNull();
  });
});

function agent(extra: Partial<OverviewAgent> = {}): OverviewAgent {
  return {
    user_id: 'u', name: 'CLARA', slug: 'clara',
    heartbeat: { last_poll_at: minsAgo(1), poll_count: 1, last_due: 0, last_resolved: 0 },
    liveness: null, supervisor: null, current: [], last_run: null, last_error: null,
    ...extra,
  } as OverviewAgent;
}

describe('agentLine', () => {
  it('reports healthy, working and missing agents', () => {
    expect(agentLine(agent(), nowMs)).toEqual({ tone: 'ok', text: 'Healthy · checked in 1m ago' });
    expect(agentLine(agent({ current: [{ run_id: 'r', title: 'Weekly SEO audit', status: 'running', started_at: minsAgo(3) }] }), nowMs))
      .toEqual({ tone: 'ok', text: 'Working on: Weekly SEO audit' });
    expect(agentLine(undefined, nowMs).tone).toBe('muted');
  });

  it('reports an agent that stopped checking in', () => {
    expect(agentLine(agent({ heartbeat: { last_poll_at: minsAgo(25), poll_count: 1, last_due: 0, last_resolved: 0 } }), nowMs))
      .toEqual({ tone: 'warn', text: 'Not responding: last checked in 25m ago' });
    expect(agentLine(agent({ heartbeat: { last_poll_at: minsAgo(180), poll_count: 1, last_due: 0, last_resolved: 0 } }), nowMs))
      .toEqual({ tone: 'bad', text: 'Offline: last checked in 3h ago' });
    // Never polled: an outage for a workstation agent (it has a supervisor), otherwise just not set up.
    const supervisor = { host: 'BOX', consecutive_fails: 0, last_error: null, last_failure_at: null, last_success_at: null, updated_at: null };
    expect(agentLine(agent({ heartbeat: null, supervisor }), nowMs)).toEqual({ tone: 'bad', text: 'Offline: has never checked in' });
    expect(agentLine(agent({ heartbeat: null }), nowMs)).toEqual({ tone: 'muted', text: 'Has never connected to the OS' });
  });

  it('says what failed last', () => {
    const failed = { title: 'Send proposal', status: 'failed', error: 'boom', at: minsAgo(20) };
    expect(agentLine(agent({ last_run: { title: 'Send proposal', status: 'failed', at: minsAgo(20) }, last_error: failed }), nowMs))
      .toEqual({ tone: 'bad', text: 'Last run failed 20m ago: Send proposal' });
    // Failed earlier today but has succeeded since: still worth a glance, not an alarm.
    expect(agentLine(agent({ last_run: { title: 'Inbox triage', status: 'completed', at: minsAgo(5) }, last_error: { ...failed, at: minsAgo(300) } }), nowMs))
      .toEqual({ tone: 'warn', text: 'Running, but failed 5h ago: Send proposal' });
    // An old failure is history.
    expect(agentLine(agent({ last_run: { title: 'Inbox triage', status: 'completed', at: minsAgo(5) }, last_error: { ...failed, at: minsAgo(3 * 24 * 60) } }), nowMs).tone).toBe('ok');
  });

  it('reports a failing supervisor', () => {
    const supervisor = { host: 'ws', consecutive_fails: 3, last_error: 'port 3737 not answering', last_failure_at: minsAgo(2), last_success_at: null, updated_at: minsAgo(2) };
    expect(agentLine(agent({ supervisor }), nowMs)).toEqual({ tone: 'bad', text: 'Failing: port 3737 not answering' });
  });
});

describe('threadAgentLine', () => {
  const turn = (status: string, sentMinsAgo: number, error: string | null = null) =>
    ({ status, error, created_at: minsAgo(sentMinsAgo), updated_at: minsAgo(sentMinsAgo) }) as never;

  it('is healthy when the last message was answered', () => {
    expect(threadAgentLine({ lastReplyAt: minsAgo(120), lastTurn: turn('answered', 121) }, nowMs))
      .toEqual({ tone: 'ok', text: 'Answering · last reply 2h ago' });
    expect(threadAgentLine({ lastReplyAt: minsAgo(3), lastTurn: null }, nowMs).tone).toBe('ok');
    expect(threadAgentLine({ lastReplyAt: null, lastTurn: null }, nowMs)).toEqual({ tone: 'muted', text: 'No conversation yet' });
  });

  it('flags a failed or unanswered last message, until something is said after it', () => {
    expect(threadAgentLine({ lastReplyAt: minsAgo(60), lastTurn: turn('failed', 10, 'model timeout') }, nowMs))
      .toEqual({ tone: 'bad', text: "Couldn't answer your last message: model timeout" });
    expect(threadAgentLine({ lastReplyAt: minsAgo(60), lastTurn: turn('working', 12) }, nowMs))
      .toEqual({ tone: 'warn', text: 'No answer yet to your message from 12m ago' });
    expect(threadAgentLine({ lastReplyAt: minsAgo(60), lastTurn: turn('working', 2) }, nowMs).tone).toBe('ok');
    expect(threadAgentLine({ lastReplyAt: minsAgo(5), lastTurn: turn('failed', 10, 'model timeout') }, nowMs).tone).toBe('ok');
  });
});

describe('harveyLine', () => {
  const status = (snapshot: HarveyStatusRow['snapshot'], updatedMinsAgo = 1) =>
    ({ snapshot, updated_at: minsAgo(updatedMinsAgo) }) as HarveyStatusRow;

  it('reports healthy with what is waiting', () => {
    expect(harveyLine(status({ email: { provider: 'resend', require_approval: true, daily_cap: 20, sent_today: 4 } }), nowMs))
      .toEqual({ tone: 'ok', text: 'Healthy · 4/20 emails today' });
    expect(harveyLine(status({ pending_review: 2 }), nowMs)).toEqual({ tone: 'warn', text: 'Healthy · 2 drafts to review' });
  });

  it('reports paused, broken, silent and never-seen', () => {
    expect(harveyLine(status({ paused: true, paused_reason: 'bounce rate over 5%', paused_automatically: true }), nowMs))
      .toEqual({ tone: 'warn', text: 'Paused automatically: bounce rate over 5%' });
    expect(harveyLine(status({ paused: true }), nowMs)).toEqual({ tone: 'warn', text: 'Paused' });
    expect(harveyLine(status({ brain: { ok: false, reason: 'LM Studio not reachable' } }), nowMs))
      .toEqual({ tone: 'bad', text: 'Model unavailable: LM Studio not reachable' });
    expect(harveyLine(status({ mail_read: { ok: false, error: 'token expired' } }), nowMs).text).toBe('Cannot read mail: token expired');
    expect(harveyLine(status({}, 600), nowMs).tone).toBe('bad');
    expect(harveyLine(null, nowMs)).toEqual({ tone: 'muted', text: 'Has never reported to the OS' });
  });
});
