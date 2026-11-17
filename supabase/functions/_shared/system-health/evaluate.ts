/**
 * Pure pass/warn/fail rules for the read-only probes. Kept separate from the I/O so thresholds
 * are unit-tested (src/lib/systemHealth/*.test.ts) and identical wherever they are used.
 */

import type { CheckResult, CheckStatus, RunSummary } from './types.ts';

const MIN = 60_000;

export function summarize(results: Pick<CheckResult, 'status'>[]): { summary: RunSummary; status: 'pass' | 'warn' | 'fail' } {
  const summary: RunSummary = { pass: 0, warn: 0, fail: 0, skip: 0 };
  for (const r of results) summary[r.status]++;
  const status = summary.fail > 0 ? 'fail' : summary.warn > 0 ? 'warn' : 'pass';
  return { summary, status };
}

export function ageMinutes(iso: string | null | undefined, nowMs: number): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  return Math.max(0, Math.round((nowMs - t) / MIN));
}

/** Agents poll every ~1-2 min; the liveness alarm pages at 20. */
export function heartbeatStatus(lastPollIso: string | null | undefined, nowMs: number, warnMin = 5, failMin = 20): CheckStatus {
  const age = ageMinutes(lastPollIso, nowMs);
  if (age === null) return 'fail';
  if (age >= failMin) return 'fail';
  if (age >= warnMin) return 'warn';
  return 'pass';
}

/**
 * Rough expected interval of a 5-field cron expression, in minutes. Only needs to be good enough
 * to say "this job should have run by now": handles `*`, `*\/N`, single values and lists in the
 * minute/hour fields and treats a restricted day-of-week/day-of-month as weekly/monthly.
 */
export function cronIntervalMinutes(schedule: string): number | null {
  const parts = schedule.trim().split(/\s+/);
  if (parts.length !== 5) return null;
  const [min, hour, dom, , dow] = parts;
  const count = (field: string, span: number): number | null => {
    if (field === '*') return span;
    const step = field.match(/^(?:\*|\d+-\d+)\/(\d+)$/);
    if (step) return Math.max(1, Math.floor(span / Number(step[1])));
    if (/^\d+(,\d+)*$/.test(field)) return field.split(',').length;
    if (/^\d+-\d+$/.test(field)) {
      const [a, b] = field.split('-').map(Number);
      return Math.max(1, b - a + 1);
    }
    return null;
  };
  if (dow !== '*') return 7 * 24 * 60;
  if (dom !== '*') return 31 * 24 * 60;
  const perHour = count(min, 60);
  const hoursPerDay = count(hour, 24);
  if (perHour === null || hoursPerDay === null) return null;
  return Math.max(1, Math.round((24 * 60) / (perHour * hoursPerDay)));
}

export interface CronRow {
  jobname: string;
  schedule: string;
  active: boolean;
  last_start: string | null;
  last_status: string | null;
  last_message: string | null;
  runs_24h: number;
  failures_24h: number;
}

export function cronJobStatus(row: CronRow, nowMs: number): { status: CheckStatus; reason: string } {
  if (!row.active) return { status: 'skip', reason: 'paused (active = false)' };
  if (row.last_status === 'failed') return { status: 'fail', reason: `last run failed: ${row.last_message ?? 'no message'}` };
  const interval = cronIntervalMinutes(row.schedule);
  const age = ageMinutes(row.last_start, nowMs);
  if (age === null) return { status: 'warn', reason: 'no run in recent history' };
  if (interval !== null && age > interval * 2 + 5) {
    return { status: 'fail', reason: `last ran ${age} min ago; expected every ~${interval} min` };
  }
  if (row.failures_24h > 0) return { status: 'warn', reason: `${row.failures_24h} failed run(s) in 24h` };
  return { status: 'pass', reason: `ran ${age} min ago, ${row.runs_24h} run(s) in 24h` };
}

/** Queue / backlog: pending count plus how long the oldest has waited. */
export function backlogStatus(
  pending: number,
  oldestAgeMin: number | null,
  t: { warnAgeMin: number; failAgeMin: number; warnCount?: number; failCount?: number },
): CheckStatus {
  if (pending === 0) return 'pass';
  if (oldestAgeMin !== null && oldestAgeMin >= t.failAgeMin) return 'fail';
  if (t.failCount !== undefined && pending >= t.failCount) return 'fail';
  if (oldestAgeMin !== null && oldestAgeMin >= t.warnAgeMin) return 'warn';
  if (t.warnCount !== undefined && pending >= t.warnCount) return 'warn';
  return 'pass';
}

/**
 * OAuth connection health from stored state only (the probe never refreshes a token: Microsoft
 * refresh tokens rotate, so a health check that refreshes could strand a connection).
 * Token refresh crons run every 5 min, so an access token that expired long ago means refresh is failing.
 */
export function oauthTokenStatus(opts: {
  expiresAt: string | null;
  refreshFailCount?: number | null;
  needsReauth?: boolean;
  lastRefreshError?: string | null;
  nowMs: number;
}): { status: CheckStatus; reason: string } {
  if (opts.needsReauth) return { status: 'fail', reason: 'needs re-authorization' };
  if ((opts.refreshFailCount ?? 0) >= 3) return { status: 'fail', reason: `${opts.refreshFailCount} consecutive refresh failures` };
  if (!opts.expiresAt) return { status: 'warn', reason: 'no token expiry recorded' };
  const expiredMin = ageMinutes(opts.expiresAt, opts.nowMs);
  const inFuture = Date.parse(opts.expiresAt) > opts.nowMs;
  if (!inFuture && expiredMin !== null && expiredMin > 60) {
    return { status: 'fail', reason: `access token expired ${expiredMin} min ago (refresh cron not keeping up)` };
  }
  if ((opts.refreshFailCount ?? 0) > 0 || opts.lastRefreshError) {
    return { status: 'warn', reason: `last refresh error: ${opts.lastRefreshError ?? `${opts.refreshFailCount} failure(s)`}` };
  }
  return { status: 'pass', reason: inFuture ? 'access token valid' : 'expired recently; refresh due' };
}

/** Reachability of an edge function from an OPTIONS preflight. */
export function edgeFunctionStatus(httpStatus: number | null): { status: CheckStatus; reason: string } {
  if (httpStatus === null) return { status: 'fail', reason: 'no response (timeout or network error)' };
  if (httpStatus === 404) return { status: 'fail', reason: 'not deployed (404)' };
  if (httpStatus >= 500) return { status: 'fail', reason: `server error ${httpStatus}` };
  if (httpStatus === 401 || httpStatus === 403) return { status: 'pass', reason: `reachable, auth-gated (${httpStatus})` };
  return { status: 'pass', reason: `reachable (${httpStatus})` };
}

/** Outcome of an active agent ping (a tagged schedule the agent should claim on its next poll). */
export function pingOutcome(opts: {
  createdAt: string;
  claimedAt: string | null;
  nowMs: number;
  timeoutMin: number;
}): { status: CheckStatus | 'pending'; latencySec: number | null; reason: string } {
  const created = Date.parse(opts.createdAt);
  if (opts.claimedAt) {
    const latencySec = Math.max(0, Math.round((Date.parse(opts.claimedAt) - created) / 1000));
    const status: CheckStatus = latencySec > opts.timeoutMin * 60 ? 'warn' : 'pass';
    return { status, latencySec, reason: `picked up after ${latencySec}s` };
  }
  const waitedMin = Math.round((opts.nowMs - created) / MIN);
  if (waitedMin >= opts.timeoutMin) {
    return { status: 'fail', latencySec: null, reason: `not picked up within ${opts.timeoutMin} min` };
  }
  return { status: 'pending', latencySec: null, reason: `waiting for pickup (${waitedMin} of ${opts.timeoutMin} min)` };
}

/** Failure rate over a window; small samples never fail on rate alone. */
export function failureRateStatus(failed: number, total: number, warnRate = 0.1, failRate = 0.3, minSample = 5): CheckStatus {
  if (total === 0) return 'pass';
  const rate = failed / total;
  if (total >= minSample && rate >= failRate) return 'fail';
  if (rate >= warnRate && failed > 0) return 'warn';
  return 'pass';
}

/**
 * Strip anything key-shaped from a provider error before it is stored or shown. Provider errors
 * occasionally echo the credential ("Incorrect API key provided: sk-...").
 */
export function scrubSecrets(text: string | null | undefined): string {
  if (!text) return '';
  return text
    .replace(/\b(sk|rk|pk|re|xi|AC|SK)[-_][A-Za-z0-9_-]{8,}/g, '[redacted]')
    .replace(/\bAIza[0-9A-Za-z_-]{20,}/g, '[redacted]')
    .replace(/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}/g, '[redacted]')
    .replace(/\b[a-f0-9]{32,}\b/gi, '[redacted]')
    .slice(0, 400);
}
