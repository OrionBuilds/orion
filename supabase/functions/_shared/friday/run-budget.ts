/**
 * Wall-clock budget for cron-only edge functions. pg_net cuts a cron call at 60 s and the platform
 * kills the run with it, so every job works to ~40 s: check `canStart(estimateMs)` before each unit
 * of work and stop cleanly (the cursor / marker rows make the next tick resume where this one stopped).
 */
export const DEFAULT_BUDGET_MS = 40_000;

export interface Budget {
  /** Milliseconds left before the soft deadline (never negative). */
  left(): number;
  /** True when a unit expected to take `estimateMs` still fits. */
  canStart(estimateMs?: number): boolean;
  /** A timeout for one outbound call: min(wanted, what's left), floor 1 s. */
  timeout(wantedMs: number): number;
}

export function makeBudget(totalMs = DEFAULT_BUDGET_MS, now: () => number = Date.now): Budget {
  const end = now() + totalMs;
  const left = () => Math.max(0, end - now());
  return {
    left,
    canStart: (estimateMs = 0) => left() > estimateMs,
    timeout: (wantedMs) => Math.max(1000, Math.min(wantedMs, left())),
  };
}
