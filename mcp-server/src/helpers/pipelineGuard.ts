import { restGet, restPost, restRpc } from './rest-client.js';
import { getRequestMemo } from './auth-context.js';

/**
 * Pipeline ownership guard for the projects tools.
 *
 * Each external agent (FRIDAY / CLARA) is allowed to act on exactly one
 * project pipeline — the one whose `project_pipelines.owner_agent` matches its
 * `agent_slug` (Engineering = friday). Humans are never restricted here; RLS
 * remains the authorization gate for them. A caller whose agent_whoami slug is
 * not an active agent (a retired agent) is refused outright, never treated as
 * a human.
 *
 * The DB also enforces a composite FK `projects(pipeline_id, stage_id) ->
 * project_stages(pipeline_id, id)`, so a stage from another pipeline fails with
 * a 23503. The helpers below catch both problems earlier with a message an
 * agent can act on ("you own Marketing, this project is in Engineering").
 *
 * `decideOwnership` is pure (unit-tested in pipelineGuard.test.ts); the rest
 * are thin PostgREST wrappers that run under the caller's JWT.
 */

export type AgentSlug = 'friday' | 'clara';

const AGENT_SLUGS: readonly AgentSlug[] = ['friday', 'clara'];

export interface Caller {
  user_id: string;
  organization_id: string;
  email: string | null;
  role: string | null;
  agent_slug: AgentSlug | null;
}

export interface PipelineStageRef {
  id: string;
  name: string;
  sort_order: number;
}

export interface PipelineRef {
  id: string;
  name: string;
  owner_agent: AgentSlug | null;
  stages?: PipelineStageRef[];
}

export interface GuardedProject {
  id: string;
  org_id: string;
  pipeline_id: string;
  stage_id: string | null;
  status: string | null;
  stage: { id: string; name: string } | null;
}

export type OwnershipDecision = { ok: true } | { ok: false; reason: string };

const CALLER_MEMO_KEY = 'caller';

/**
 * PURE. The caller's agent slug from agent_whoami: null for humans (no slug), the slug for an active
 * agent, and an Error for any other slug. A retired agent keeps its role (and so its slug) for
 * history; mapping it to null would hand it the unrestricted human path, so it fails closed instead.
 */
export function normaliseCallerSlug(raw: unknown): AgentSlug | null {
  if (raw === null || raw === undefined) return null;
  const slug = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  if (!slug) return null;
  if ((AGENT_SLUGS as readonly string[]).includes(slug)) return slug as AgentSlug;
  throw new Error(`Refused: agent "${slug}" is not an active agent of this OS`);
}

function describeCaller(caller: Caller): string {
  if (caller.agent_slug) return `${caller.agent_slug.toUpperCase()} (${caller.agent_slug})`;
  return caller.email ?? caller.user_id;
}

function describePipeline(p: PipelineRef): string {
  return `"${p.name}" (owner ${p.owner_agent ?? 'none'})`;
}

/**
 * Resolve the caller via the `agent_whoami` RPC, memoised per request so a tool
 * that needs the identity twice (ownership check + created_by) pays once.
 */
export async function resolveCaller(): Promise<Caller> {
  const memo = getRequestMemo();
  const cached = memo?.get(CALLER_MEMO_KEY) as Caller | undefined;
  if (cached) return cached;

  const raw = await restRpc('agent_whoami');
  const w = (Array.isArray(raw) ? raw[0] : raw) as
    | { user_id?: string; organization_id?: string; email?: string | null; role?: string | null; agent_slug?: string | null }
    | null
    | undefined;
  if (!w || !w.user_id || !w.organization_id) {
    throw new Error('agent_whoami failed: could not resolve caller identity');
  }
  const caller: Caller = {
    user_id: w.user_id,
    organization_id: w.organization_id,
    email: w.email ?? null,
    role: w.role ?? null,
    agent_slug: normaliseCallerSlug(w.agent_slug),
  };
  memo?.set(CALLER_MEMO_KEY, caller);
  return caller;
}

export function isAgent(c: Caller): c is Caller & { agent_slug: AgentSlug } {
  return c.agent_slug !== null;
}

/**
 * PURE. Humans may act on any pipeline; an agent only on the pipeline whose
 * owner_agent is its own slug. A pipeline with no owner refuses every agent —
 * the fix is administrative, and the message says where.
 */
export function decideOwnership(caller: Caller, pipeline: PipelineRef): OwnershipDecision {
  if (!isAgent(caller)) return { ok: true };
  if (pipeline.owner_agent === null || pipeline.owner_agent === undefined) {
    return {
      ok: false,
      reason:
        `pipeline "${pipeline.name}" has no owner agent; an admin must assign one in Projects › Pipelines ` +
        `before ${describeCaller(caller)} can act on it`,
    };
  }
  if (pipeline.owner_agent === caller.agent_slug) return { ok: true };
  return {
    ok: false,
    reason:
      `${describeCaller(caller)} may only act on pipelines it owns; ` +
      `pipeline ${describePipeline(pipeline)} belongs to ${pipeline.owner_agent}`,
  };
}

/** The single pipeline owned by this agent in its org, or null (humans: null). */
export async function getOwnedPipeline(caller: Caller): Promise<PipelineRef | null> {
  if (!isAgent(caller)) return null;
  const rows = (await restGet('project_pipelines', {
    select: 'id,name,owner_agent,stages:project_stages(id,name,sort_order)',
    filters: {
      org_id: `eq.${caller.organization_id}`,
      owner_agent: `eq.${caller.agent_slug}`,
    },
    order: 'sort_order.asc',
    limit: 1,
  })) as PipelineRef[] | null;
  const p = rows?.[0];
  if (!p) return null;
  return { ...p, stages: sortStages(p.stages) };
}

export function sortStages(stages: PipelineStageRef[] | undefined): PipelineStageRef[] {
  return [...(stages ?? [])].sort((a, b) => a.sort_order - b.sort_order);
}

export async function getPipelineById(pipelineId: string): Promise<PipelineRef | null> {
  const p = (await restGet('project_pipelines', {
    select: 'id,name,owner_agent,stages:project_stages(id,name,sort_order)',
    filters: { id: `eq.${pipelineId}` },
    accept: 'application/vnd.pgrst.object+json',
  }).catch(() => null)) as PipelineRef | null;
  if (!p) return null;
  return { ...p, stages: sortStages(p.stages) };
}

export type OwnershipRef = { pipelineId: string } | { projectId: string };

export interface OwnershipResult {
  caller: Caller;
  pipeline: PipelineRef;
  project?: GuardedProject;
}

/**
 * Resolve caller + pipeline (+ project) and throw an agent-legible Error when
 * the caller is an agent that does not own that pipeline. The project branch
 * is one round trip: the project row embeds its stage and pipeline.
 */
export async function assertPipelineOwnership(ref: OwnershipRef): Promise<OwnershipResult> {
  const caller = await resolveCaller();

  if ('projectId' in ref) {
    type Row = GuardedProject & { pipeline: PipelineRef | null };
    const row = (await restGet('projects', {
      select:
        'id,org_id,pipeline_id,stage_id,status,stage:project_stages(id,name),pipeline:project_pipelines(id,name,owner_agent)',
      filters: { id: `eq.${ref.projectId}` },
      accept: 'application/vnd.pgrst.object+json',
    }).catch(() => null)) as Row | null;
    if (!row) throw new Error(`Project ${ref.projectId} not found (or not visible to the caller)`);
    if (!row.pipeline) {
      throw new Error(`Project ${ref.projectId} references pipeline ${row.pipeline_id}, which could not be loaded`);
    }
    const { pipeline, ...project } = row;
    const decision = decideOwnership(caller, pipeline);
    if (!decision.ok) {
      if (isAgent(caller) && pipeline.owner_agent) {
        const owned = await getOwnedPipeline(caller);
        const ownedLabel = owned ? `pipeline "${owned.name}"` : 'no pipeline (none is assigned to it)';
        throw new Error(
          `${describeCaller(caller)} may only act on ${ownedLabel}; ` +
          `project ${project.id} is in "${pipeline.name}" (owner ${pipeline.owner_agent}).`,
        );
      }
      throw new Error(`Refused: ${decision.reason}`);
    }
    return { caller, pipeline, project };
  }

  const pipeline = await getPipelineById(ref.pipelineId);
  if (!pipeline) throw new Error(`Pipeline ${ref.pipelineId} not found (or not visible to the caller)`);
  const decision = decideOwnership(caller, pipeline);
  if (!decision.ok) {
    if (isAgent(caller) && pipeline.owner_agent) {
      const owned = await getOwnedPipeline(caller);
      const ownedLabel = owned ? `pipeline "${owned.name}"` : 'no pipeline (none is assigned to it)';
      throw new Error(
        `${describeCaller(caller)} may only act on ${ownedLabel}; ` +
        `pipeline "${pipeline.name}" is owned by ${pipeline.owner_agent}.`,
      );
    }
    throw new Error(`Refused: ${decision.reason}`);
  }
  return { caller, pipeline };
}

/**
 * Verify that `stageId` is a stage of `pipelineId`. Returns the stage so the
 * caller can log its name without a second lookup.
 */
export async function assertStageInPipeline(
  pipelineId: string,
  stageId: string,
): Promise<{ id: string; name: string }> {
  const rows = (await restGet('project_stages', {
    select: 'id,name,pipeline_id',
    filters: { id: `eq.${stageId}`, pipeline_id: `eq.${pipelineId}` },
    limit: 1,
  })) as Array<{ id: string; name: string }> | null;
  const stage = rows?.[0];
  if (stage) return { id: stage.id, name: stage.name };

  const pipeline = (await restGet('project_pipelines', {
    select: 'id,name',
    filters: { id: `eq.${pipelineId}` },
    accept: 'application/vnd.pgrst.object+json',
  }).catch(() => null)) as { id: string; name: string } | null;
  const label = pipeline ? `"${pipeline.name}"` : pipelineId;
  throw new Error(
    `Stage ${stageId} does not belong to pipeline ${label}. Use project_pipelines_get to list valid stage ids.`,
  );
}

export interface StageChangeLog {
  org_id: string;
  project_id: string;
  from: { id: string; name: string } | null;
  to: { id: string; name: string };
  actor_user_id?: string | null;
}

/**
 * Mirror the `stage_changed` activity row the human UI / projects_update write,
 * so the OS project timeline and the client-portal Updates feed render agent
 * moves identically. Best-effort: never throws.
 */
export async function logStageChange(entry: StageChangeLog): Promise<void> {
  const fromName = entry.from?.name ?? null;
  const toName = entry.to.name;
  const row: Record<string, unknown> = {
    org_id: entry.org_id,
    project_id: entry.project_id,
    event_type: 'stage_changed',
    summary: `Stage changed from "${fromName ?? '—'}" to "${toName ?? '—'}"`,
    payload: { source: 'mcp', from: fromName, to: toName },
  };
  if (entry.actor_user_id) row['actor_user_id'] = entry.actor_user_id;
  await restPost('project_activity_log', row).catch(() => {});
}
