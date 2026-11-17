import { describe, expect, it } from 'vitest';
import {
  backlogStatus,
  cronIntervalMinutes,
  cronJobStatus,
  edgeFunctionStatus,
  failureRateStatus,
  heartbeatStatus,
  oauthTokenStatus,
  pingOutcome,
  scrubSecrets,
  summarize,
} from '../../../supabase/functions/_shared/system-health/evaluate';
import { buildGroupView, hasPendingPing, mergeResults } from './view';
import type { CheckResult } from '../../../supabase/functions/_shared/system-health/types';

const NOW = Date.parse('2026-10-29T12:00:00Z');
const minsAgo = (m: number) => new Date(NOW - m * 60_000).toISOString();

describe('cron evaluation', () => {
  it('estimates intervals from common schedules', () => {
    expect(cronIntervalMinutes('* * * * *')).toBe(1);
    expect(cronIntervalMinutes('*/5 * * * *')).toBe(5);
    expect(cronIntervalMinutes('4-59/5 * * * *')).toBe(5);
    expect(cronIntervalMinutes('17 * * * *')).toBe(60);
    expect(cronIntervalMinutes('0 2 * * *')).toBe(1440);
    expect(cronIntervalMinutes('17 */6 * * *')).toBe(360);
    expect(cronIntervalMinutes('0 3 * * 0')).toBe(10080);
    expect(cronIntervalMinutes('nonsense')).toBeNull();
  });

  const row = (over: Partial<Parameters<typeof cronJobStatus>[0]>) => ({
    jobname: 'j', schedule: '*/5 * * * *', active: true, last_start: minsAgo(3), last_status: 'succeeded',
    last_message: '1 row', runs_24h: 288, failures_24h: 0, ...over,
  });

  it('passes a job that ran on time', () => expect(cronJobStatus(row({}), NOW).status).toBe('pass'));
  it('skips a paused job', () => expect(cronJobStatus(row({ active: false }), NOW).status).toBe('skip'));
  it('fails when the last run failed', () => expect(cronJobStatus(row({ last_status: 'failed' }), NOW).status).toBe('fail'));
  it('fails an overdue job', () => expect(cronJobStatus(row({ last_start: minsAgo(30) }), NOW).status).toBe('fail'));
  it('warns on earlier failures', () => expect(cronJobStatus(row({ failures_24h: 2 }), NOW).status).toBe('warn'));
  it('warns with no recent history', () => expect(cronJobStatus(row({ last_start: null }), NOW).status).toBe('warn'));
});

describe('agent + queue thresholds', () => {
  it('grades heartbeat age', () => {
    expect(heartbeatStatus(minsAgo(1), NOW)).toBe('pass');
    expect(heartbeatStatus(minsAgo(8), NOW)).toBe('warn');
    expect(heartbeatStatus(minsAgo(25), NOW)).toBe('fail');
    expect(heartbeatStatus(null, NOW)).toBe('fail');
  });

  it('grades backlog by oldest age then count', () => {
    const t = { warnAgeMin: 5, failAgeMin: 30 };
    expect(backlogStatus(0, null, t)).toBe('pass');
    expect(backlogStatus(3, 2, t)).toBe('pass');
    expect(backlogStatus(3, 10, t)).toBe('warn');
    expect(backlogStatus(3, 45, t)).toBe('fail');
    expect(backlogStatus(500, 1, { ...t, failCount: 100 })).toBe('fail');
  });

  it('never fails on failure rate with a tiny sample', () => {
    expect(failureRateStatus(0, 0)).toBe('pass');
    expect(failureRateStatus(2, 3)).toBe('warn');
    expect(failureRateStatus(4, 10)).toBe('fail');
    expect(failureRateStatus(1, 50)).toBe('pass');
  });

  it('reports ping pickup, pending and timeout', () => {
    expect(pingOutcome({ createdAt: minsAgo(2), claimedAt: minsAgo(1), nowMs: NOW, timeoutMin: 10 }))
      .toMatchObject({ status: 'pass', latencySec: 60 });
    expect(pingOutcome({ createdAt: minsAgo(2), claimedAt: null, nowMs: NOW, timeoutMin: 10 }).status).toBe('pending');
    expect(pingOutcome({ createdAt: minsAgo(11), claimedAt: null, nowMs: NOW, timeoutMin: 10 }).status).toBe('fail');
  });
});

describe('integration evaluation', () => {
  it('grades OAuth state without refreshing anything', () => {
    expect(oauthTokenStatus({ expiresAt: minsAgo(-30), nowMs: NOW }).status).toBe('pass');
    expect(oauthTokenStatus({ expiresAt: minsAgo(120), nowMs: NOW }).status).toBe('fail');
    expect(oauthTokenStatus({ expiresAt: minsAgo(-30), needsReauth: true, nowMs: NOW }).status).toBe('fail');
    expect(oauthTokenStatus({ expiresAt: minsAgo(-30), refreshFailCount: 1, nowMs: NOW }).status).toBe('warn');
    expect(oauthTokenStatus({ expiresAt: minsAgo(-30), refreshFailCount: 3, nowMs: NOW }).status).toBe('fail');
  });

  it('classifies edge function preflights', () => {
    expect(edgeFunctionStatus(200).status).toBe('pass');
    expect(edgeFunctionStatus(401).status).toBe('pass');
    expect(edgeFunctionStatus(404).status).toBe('fail');
    expect(edgeFunctionStatus(503).status).toBe('fail');
    expect(edgeFunctionStatus(null).status).toBe('fail');
  });

  it('scrubs key-shaped strings from provider errors', () => {
    const out = scrubSecrets('Incorrect API key provided: sk-proj-abcdefghijklmnop1234 and AIzaSyA1234567890abcdefghijklmnop');
    expect(out).not.toMatch(/sk-proj|AIza/);
    expect(out).toContain('[redacted]');
  });
});

describe('summaries and view merging', () => {
  const r = (id: string, group: CheckResult['group'], status: CheckResult['status'], details?: Record<string, unknown>): CheckResult =>
    ({ id, group, name: id, status, durationMs: 1, summary: '', details });

  it('rolls up a run', () => {
    expect(summarize([r('a', 'data', 'pass'), r('b', 'data', 'warn')])).toEqual({
      summary: { pass: 1, warn: 1, fail: 0, skip: 0 }, status: 'warn',
    });
  });

  it('replaces a whole group on a full run but only the returned ids on a partial run', () => {
    const prev = [r('infra.cron.old', 'infrastructure', 'fail'), r('crud.contacts', 'data', 'fail'), r('crud.forms', 'data', 'pass')];
    const full = mergeResults(prev, [r('infra.cron.new', 'infrastructure', 'pass')], ['infrastructure']);
    expect(full.map((x) => x.id).sort()).toEqual(['crud.contacts', 'crud.forms', 'infra.cron.new']);
    const partial = mergeResults(prev, [r('crud.contacts', 'data', 'pass')], []);
    expect(partial.find((x) => x.id === 'crud.contacts')!.status).toBe('pass');
    expect(partial.find((x) => x.id === 'crud.forms')).toBeDefined();
  });

  it('nests dynamic results under their catalogue entry and rolls up the worst child', () => {
    const cat = [{ id: 'integrations.google', group: 'integrations' as const, name: 'Google', description: '' }];
    const rows = buildGroupView(cat, [
      r('integrations.google.b@x.com', 'integrations', 'pass'),
      r('integrations.google.a@x.com', 'integrations', 'fail'),
      r('integrations.unknown', 'integrations', 'warn'),
    ], 'integrations');
    expect(rows.map((x) => x.id)).toEqual(['integrations.google', 'integrations.google.a@x.com', 'integrations.google.b@x.com', 'integrations.unknown']);
    expect(rows[0].status).toBe('fail');
    expect(rows[1].child).toBe(true);
  });

  it('detects a pending agent ping', () => {
    expect(hasPendingPing([r('agents.friday.ping', 'agents', 'warn', { pending: true })])).toBe(true);
    expect(hasPendingPing([r('agents.friday.ping', 'agents', 'pass', { latencySec: 30 })])).toBe(false);
  });
});
