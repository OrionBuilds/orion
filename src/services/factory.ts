/**
 * Factory module data: playbooks that run agent work on deals, projects and schedules.
 *
 * A playbook (playbooks + playbook_steps) attaches to a subject; each run (playbook_runs) queues its
 * steps stage by stage as playbook_step_runs, which the factory-runner dispatches to CLARA / FRIDAY /
 * HARVEY / JASON. autonomy_policies decides, per action_key, whether a step asks the owner first,
 * runs on its own, or is skipped. agent_roles is the role library steps borrow prompts from.
 * Migrations 20261104100000_factory_roles.sql and 20261104110000_factory_engine.sql.
 *
 * Reads: the org owner, SuperAdmins and agents. Writes (toggles, policies, retry/skip, cancel): the
 * owner only, enforced by RLS. The pure helpers below are unit-tested in factory.test.ts.
 */
import { supabase } from '../lib/supabase';
import { BRANDS, type Brand } from '../lib/brands';

export type FactoryAgent = 'clara' | 'friday' | 'harvey' | 'jason';
export type FactoryBrand = Brand;
export type SubjectType = 'opportunity' | 'project' | 'org';
export type RunStatus = 'active' | 'completed' | 'cancelled';
export type StepStatus =
  | 'queued' | 'dispatched' | 'running' | 'needs_approval' | 'done'
  | 'rejected' | 'expired' | 'failed' | 'skipped' | 'escalated';
export type AutonomyMode = 'approval' | 'auto' | 'off';
export type Deliverable = 'brief' | 'score' | 'email_draft' | 'proposal_outline' | 'doc' | 'checklist' | 'post_draft' | 'report' | 'code';

export interface GateCheck { criterion: string; met: boolean; note?: string | null }
export interface Gate { passed: boolean; checks: GateCheck[] }
export interface Evidence { source: string; ref: string }

/** One step as factory_board() reports it. */
export interface BoardStep {
  id: string;
  key: string;
  title: string;
  stage: string | null;
  agent: FactoryAgent;
  role: string | null;
  status: StepStatus;
  required: boolean;
  attempts: number;
  approval_id: string | null;
  gate: Gate | null;
  error: string | null;
  updated_at: string;
}

/** One run as factory_board() reports it (active, or finished in the last 7 days). */
export interface BoardRun {
  run_id: string;
  playbook: string;
  playbook_slug: string;
  subject_type: SubjectType;
  subject_id: string | null;
  subject: string | null;
  brand: string | null;
  status: RunStatus;
  started_at: string;
  steps: BoardStep[];
}

export interface StepRun {
  id: string;
  run_id: string;
  step_id: string;
  stage_name: string | null;
  agent: FactoryAgent;
  status: StepStatus;
  attempts: number;
  role_slug: string | null;
  role_version: number | null;
  output: string | null;
  evidence: Evidence[] | null;
  gate: Gate | null;
  draft: Record<string, unknown> | null;
  approval_id: string | null;
  agent_request_id: string | null;
  error: string | null;
  created_at: string;
  updated_at: string;
  finished_at: string | null;
}

export interface PlaybookStep {
  id: string;
  playbook_id: string;
  key: string;
  title: string;
  stage_name: string | null;
  sort_order: number;
  agent: FactoryAgent;
  role_slug: string | null;
  instructions: string;
  deliverable: Deliverable;
  action_key: string;
  required: boolean;
  acceptance_criteria: string[];
  max_attempts: number;
  enabled: boolean;
}

export interface Playbook {
  id: string;
  slug: string;
  name: string;
  description: string;
  applies_to: SubjectType;
  sales_pipeline_id: string | null;
  project_pipeline_id: string | null;
  brand: string | null;
  cadence: 'daily' | 'weekly' | 'monthly' | null;
  next_run_at: string | null;
  enabled: boolean;
  steps: PlaybookStep[];
}

export interface AutonomyPolicy {
  action_key: string;
  mode: AutonomyMode;
  note: string | null;
  decided_by: string | null;
  decided_at: string;
}

export interface AgentRole {
  id: string;
  slug: string;
  name: string;
  division: string;
  description: string;
  default_agent: FactoryAgent;
  version: number;
  enabled: boolean;
  source_repo: string | null;
  source_path: string | null;
  source_sha: string | null;
  updated_at: string;
}

const MIGRATION_HINT = 'The Factory module is not available yet: migrations 20261104100000_factory_roles.sql and 20261104110000_factory_engine.sql have not been applied to this database.';

function fail(error: { message?: string; code?: string } | null): Error {
  const msg = error?.message ?? 'Request failed';
  if (error?.code === 'PGRST205' || error?.code === 'PGRST202' || error?.code === '42P01' || error?.code === '42883'
    || /could not find the (table|function)|does not exist/i.test(msg)) return new Error(MIGRATION_HINT);
  return new Error(msg);
}

// ── board ────────────────────────────────────────────────────────────────────────────────────

export async function getBoard(limit = 100): Promise<BoardRun[]> {
  const { data, error } = await supabase.rpc('factory_board', { p_limit: limit });
  if (error) throw fail(error);
  return (Array.isArray(data) ? data : []) as BoardRun[];
}

export async function getStepRun(id: string): Promise<StepRun | null> {
  const { data, error } = await supabase
    .from('playbook_step_runs')
    .select('id,run_id,step_id,stage_name,agent,status,attempts,role_slug,role_version,output,evidence,gate,draft,approval_id,agent_request_id,error,created_at,updated_at,finished_at')
    .eq('id', id)
    .maybeSingle();
  if (error) throw fail(error);
  return (data as StepRun | null) ?? null;
}

/** Owner only: re-queue (attempts reset) or skip one step. */
export async function stepAction(stepRunId: string, action: 'retry' | 'skip'): Promise<void> {
  const { error } = await supabase.rpc('factory_step_action', { p_step_run_id: stepRunId, p_action: action });
  if (error) throw fail(error);
}

/** Owner only: stop a live run. Steps already dispatched finish, nothing new is queued. */
export async function cancelRun(runId: string): Promise<void> {
  const { error } = await supabase
    .from('playbook_runs')
    .update({ status: 'cancelled', finished_at: new Date().toISOString() })
    .eq('id', runId)
    .eq('status', 'active');
  if (error) throw fail(error);
}

// ── playbooks ────────────────────────────────────────────────────────────────────────────────

export async function listPlaybooks(orgId: string): Promise<Playbook[]> {
  const { data, error } = await supabase
    .from('playbooks')
    .select('id,slug,name,description,applies_to,sales_pipeline_id,project_pipeline_id,brand,cadence,next_run_at,enabled,'
      + 'steps:playbook_steps(id,playbook_id,key,title,stage_name,sort_order,agent,role_slug,instructions,deliverable,action_key,required,acceptance_criteria,max_attempts,enabled)')
    .eq('org_id', orgId)
    .order('name');
  if (error) throw fail(error);
  return ((data ?? []) as unknown as Playbook[]).map((p) => ({
    ...p, steps: [...(p.steps ?? [])].sort((a, b) => a.sort_order - b.sort_order),
  }));
}

export async function setPlaybookEnabled(id: string, enabled: boolean): Promise<void> {
  const { error } = await supabase.from('playbooks').update({ enabled }).eq('id', id);
  if (error) throw fail(error);
}

export async function setStepEnabled(id: string, enabled: boolean): Promise<void> {
  const { error } = await supabase.from('playbook_steps').update({ enabled }).eq('id', id);
  if (error) throw fail(error);
}

/** Names of the sales + project pipelines playbooks attach to, keyed by id. */
export async function pipelineNames(salesIds: string[], projectIds: string[]): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  const [sales, projects] = await Promise.all([
    salesIds.length ? supabase.from('pipelines').select('id,name').in('id', salesIds) : Promise.resolve({ data: [], error: null }),
    projectIds.length ? supabase.from('project_pipelines').select('id,name').in('id', projectIds) : Promise.resolve({ data: [], error: null }),
  ]);
  for (const r of [sales, projects]) {
    if (r.error) throw fail(r.error);
    for (const row of (r.data ?? []) as Array<{ id: string; name: string }>) names.set(row.id, row.name);
  }
  return names;
}

// ── autonomy ─────────────────────────────────────────────────────────────────────────────────

export async function listAutonomyPolicies(orgId: string): Promise<AutonomyPolicy[]> {
  const { data, error } = await supabase
    .from('autonomy_policies')
    .select('action_key,mode,note,decided_by,decided_at')
    .eq('org_id', orgId);
  if (error) throw fail(error);
  return (data ?? []) as AutonomyPolicy[];
}

export async function setAutonomyMode(orgId: string, userId: string, actionKey: string, mode: AutonomyMode): Promise<void> {
  const { error } = await supabase
    .from('autonomy_policies')
    .upsert({ org_id: orgId, action_key: actionKey, mode, decided_by: userId, decided_at: new Date().toISOString() }, { onConflict: 'org_id,action_key' });
  if (error) throw fail(error);
}

/** Delete the owner's row: the action falls back to the default rule. */
export async function resetAutonomyMode(orgId: string, actionKey: string): Promise<void> {
  const { error } = await supabase.from('autonomy_policies').delete().eq('org_id', orgId).eq('action_key', actionKey);
  if (error) throw fail(error);
}

export async function userNames(ids: string[]): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  if (!ids.length) return names;
  const { data, error } = await supabase.from('users').select('id,name,email').in('id', ids);
  if (error) throw fail(error);
  for (const u of (data ?? []) as Array<{ id: string; name: string | null; email: string | null }>) names.set(u.id, u.name || u.email || 'someone');
  return names;
}

// ── roles ────────────────────────────────────────────────────────────────────────────────────

/** The library without prompts (they are long); read one with getRolePrompt. */
export async function listRoles(orgId: string): Promise<AgentRole[]> {
  const { data, error } = await supabase
    .from('agent_roles')
    .select('id,slug,name,division,description,default_agent,version,enabled,source_repo,source_path,source_sha,updated_at')
    .eq('org_id', orgId)
    .order('division')
    .order('name');
  if (error) throw fail(error);
  return (data ?? []) as AgentRole[];
}

export async function getRolePrompt(id: string): Promise<string> {
  const { data, error } = await supabase.from('agent_roles').select('prompt').eq('id', id).maybeSingle();
  if (error) throw fail(error);
  return (data as { prompt: string } | null)?.prompt ?? '';
}

export async function setRoleEnabled(id: string, enabled: boolean): Promise<void> {
  const { error } = await supabase.from('agent_roles').update({ enabled }).eq('id', id);
  if (error) throw fail(error);
}

// ── pure helpers ─────────────────────────────────────────────────────────────────────────────

export const AGENTS: FactoryAgent[] = ['clara', 'friday', 'harvey', 'jason'];
export const agentLabel = (a: string) => a.toUpperCase();

export const BRAND_LABEL: Record<string, string> = Object.fromEntries(BRANDS.map((b) => [b.slug, b.name]));
export const brandLabel = (b: string | null | undefined) => (b ? BRAND_LABEL[b] ?? b : 'No brand');

/** Deliverables that leave the company. */
export const OUTWARD_DELIVERABLES: readonly string[] = ['email_draft', 'post_draft'];

/**
 * The runner's rule when the owner has not decided: anything that leaves the company (email or post
 * drafts) or touches money (action_key finance.*) asks first; internal work runs on its own.
 */
export function defaultAutonomy(step: { deliverable: string; action_key: string }): Exclude<AutonomyMode, 'off'> {
  return OUTWARD_DELIVERABLES.includes(step.deliverable) || step.action_key.startsWith('finance.') ? 'approval' : 'auto';
}

export function effectiveMode(policy: Pick<AutonomyPolicy, 'mode'> | null | undefined, fallback: AutonomyMode): AutonomyMode {
  return policy?.mode ?? fallback;
}

export interface ActionRow {
  action_key: string;
  /** 'approval' if any step using the key would ask by default (the safe reading of a shared key). */
  default: Exclude<AutonomyMode, 'off'>;
  deliverables: string[];
  steps: Array<{ playbook: string; title: string; agent: FactoryAgent }>;
}

/** One row per distinct action_key across all playbooks, sensitive (approval-by-default) first. */
export function actionRows(playbooks: Pick<Playbook, 'name' | 'steps'>[]): ActionRow[] {
  const rows = new Map<string, ActionRow>();
  for (const p of playbooks) {
    for (const s of p.steps) {
      const row = rows.get(s.action_key) ?? { action_key: s.action_key, default: 'auto', deliverables: [], steps: [] };
      if (defaultAutonomy(s) === 'approval') row.default = 'approval';
      if (!row.deliverables.includes(s.deliverable)) row.deliverables.push(s.deliverable);
      row.steps.push({ playbook: p.name, title: s.title, agent: s.agent });
      rows.set(s.action_key, row);
    }
  }
  return [...rows.values()].sort((a, b) =>
    (a.default === b.default ? 0 : a.default === 'approval' ? -1 : 1) || a.action_key.localeCompare(b.action_key));
}

export type RunKind = 'deal' | 'project' | 'scheduled';

export function runKind(run: Pick<BoardRun, 'subject_type'>): RunKind {
  return run.subject_type === 'opportunity' ? 'deal' : run.subject_type === 'project' ? 'project' : 'scheduled';
}

export function subjectLink(run: Pick<BoardRun, 'subject_type' | 'subject_id'>): string | null {
  if (!run.subject_id) return null;
  if (run.subject_type === 'opportunity') return `/opportunities/${run.subject_id}`;
  if (run.subject_type === 'project') return `/projects/${run.subject_id}`;
  return null;
}

export function filterRuns<T extends Pick<BoardRun, 'brand' | 'subject_type'>>(runs: T[], f: { brand: string; kind: string }): T[] {
  return runs.filter((r) =>
    (f.brand === 'all' || (f.brand === 'none' ? !r.brand : r.brand === f.brand))
    && (f.kind === 'all' || runKind(r) === f.kind));
}

export const IN_PROGRESS: readonly StepStatus[] = ['queued', 'dispatched', 'running'];
/** Statuses the owner can retry or skip from the drawer. */
export const ACTIONABLE: readonly StepStatus[] = ['failed', 'escalated', 'expired', 'rejected'];
export const canRetry = (status: string) => (ACTIONABLE as readonly string[]).includes(status);

export interface BoardCounts { waiting: number; escalated: number; inProgress: number; done7d: number }

export function boardCounts(runs: Pick<BoardRun, 'steps'>[], now = Date.now()): BoardCounts {
  const weekAgo = now - 7 * 24 * 3600 * 1000;
  const c: BoardCounts = { waiting: 0, escalated: 0, inProgress: 0, done7d: 0 };
  for (const r of runs) {
    for (const s of r.steps) {
      if (s.status === 'needs_approval') c.waiting++;
      else if (s.status === 'escalated') c.escalated++;
      else if ((IN_PROGRESS as readonly string[]).includes(s.status)) c.inProgress++;
      else if (s.status === 'done' && Date.parse(s.updated_at) >= weekAgo) c.done7d++;
    }
  }
  return c;
}

/** Steps grouped by stage in first-seen order (steps are already sorted by sort_order). */
export function groupByStage<T extends { stage_name?: string | null; stage?: string | null }>(steps: T[]): Array<{ stage: string; steps: T[] }> {
  const groups: Array<{ stage: string; steps: T[] }> = [];
  for (const s of steps) {
    const stage = (s.stage_name ?? s.stage) || 'Start';
    const g = groups.find((x) => x.stage.toLowerCase() === stage.toLowerCase());
    if (g) g.steps.push(s); else groups.push({ stage, steps: [s] });
  }
  return groups;
}

export function stepTone(status: string): 'ok' | 'bad' | 'warn' | 'muted' | 'info' {
  if (status === 'done') return 'ok';
  if (status === 'failed' || status === 'escalated' || status === 'rejected' || status === 'expired') return 'bad';
  if (status === 'needs_approval') return 'warn';
  if (status === 'dispatched' || status === 'running') return 'info';
  return 'muted';
}

export const statusLabel = (s: string) => s.replace(/_/g, ' ');
