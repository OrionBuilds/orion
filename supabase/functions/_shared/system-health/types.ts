/**
 * System Health shared types.
 *
 * Pure TypeScript with no runtime imports, so the same file is used by the `system-health` edge
 * function (Deno) and by the React page + vitest (Vite). Keep it that way: no `npm:` / `jsr:`
 * specifiers and no Deno globals anywhere under _shared/system-health.
 */

export type CheckStatus = 'pass' | 'warn' | 'fail' | 'skip';
export type CheckGroup = 'data' | 'integrations' | 'infrastructure' | 'agents';
export type RunMode = 'service' | 'rls';

export const CHECK_GROUPS: CheckGroup[] = ['data', 'integrations', 'infrastructure', 'agents'];

export type StepName = 'create' | 'read' | 'update' | 'delete' | 'archive' | 'audit' | 'cleanup' | 'list';

export interface StepResult {
  step: StepName;
  status: CheckStatus;
  durationMs: number;
  message?: string;
}

export interface CheckResult {
  /** Stable id, e.g. "crud.contacts", "integrations.twilio", "agents.friday.heartbeat". */
  id: string;
  group: CheckGroup;
  name: string;
  status: CheckStatus;
  durationMs: number;
  /** One line for the row. */
  summary: string;
  /** Error text when status is fail/warn. Never contains a secret. */
  error?: string;
  /** Free-form diagnostic values (counts, ages, http status). Never contains a secret. */
  details?: Record<string, unknown>;
  steps?: StepResult[];
}

export interface RunSummary {
  pass: number;
  warn: number;
  fail: number;
  skip: number;
}

export interface HealthRunReport {
  runId: string;
  orgId: string;
  mode: RunMode;
  groups: CheckGroup[];
  status: 'pass' | 'warn' | 'fail';
  summary: RunSummary;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  results: CheckResult[];
  /** False when system_health_runs is missing (migration not applied) or the insert failed. */
  historySaved: boolean;
}

/** Catalogue entry the UI renders before anything has run. */
export interface CheckCatalogueEntry {
  id: string;
  group: CheckGroup;
  name: string;
  description: string;
}

export interface RunRequest {
  action: 'run';
  mode?: RunMode;
  groups?: CheckGroup[];
  /** Restrict to these check ids (e.g. a single "crud.contacts"). */
  checks?: string[];
}

export interface AgentPingRequest {
  action: 'agent_ping';
  /** Agent slugs to ping; defaults to every configured agent. */
  agents?: string[];
}

export type SystemHealthRequest = RunRequest | AgentPingRequest | { action: 'catalogue' };
