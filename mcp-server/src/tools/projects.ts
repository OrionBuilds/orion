import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { restGet, restPost, restPatch, restDelete } from '../helpers/rest-client.js';
import { callEdgeFunction } from '../helpers/edge-client.js';
import { toolResult, toolError } from '../helpers/tool-utils.js';
import {
  resolveCaller,
  isAgent,
  decideOwnership,
  getOwnedPipeline,
  getPipelineById,
  assertPipelineOwnership,
  assertStageInPipeline,
  logStageChange,
  sortStages,
  type PipelineRef,
} from '../helpers/pipelineGuard.js';

const AGENT_SLUG_ENUM = z.enum(['friday', 'clara']);

function callerLabel(c: { agent_slug: string | null; email: string | null; user_id: string }): string {
  return c.agent_slug ? `${c.agent_slug.toUpperCase()} (${c.agent_slug})` : (c.email ?? c.user_id);
}

/** Optional project URL: http(s) URL, or null/'' to clear. */
const projectUrl = z
  .union([z.string().url().refine((v) => /^https?:\/\//i.test(v), 'must be an http(s) URL'), z.literal(''), z.null()])
  .optional()
  .transform((v) => (v === '' ? null : v));

/** Map a project_tasks write to real columns: assigned_to is a deprecated alias of assigned_user_id;
 *  completed_at follows status (set on completed, cleared on any other status). Pure. */
export function projectTaskBody(
  p: Record<string, unknown> & { assigned_to?: string; assigned_user_id?: string | null; status?: string },
  now: string = new Date().toISOString(),
): Record<string, unknown> {
  const { assigned_to, ...rest } = p;
  const body: Record<string, unknown> = { ...rest };
  if (assigned_to !== undefined && rest.assigned_user_id === undefined) body.assigned_user_id = assigned_to;
  if (typeof rest.status === 'string') body.completed_at = rest.status === 'completed' ? now : null;
  return body;
}

export function registerProjectsTools(server: McpServer): void {
  server.tool(
    'projects_list',
    'List projects with contact and manager (rows include the connections fields: repo_urls, netlify_site_url, staging_url, supabase_project_ref, files_*). Filter by status, pipeline_id, stage_id, contact_id. ' +
      'Agents: filter by YOUR OWN pipeline — the project_pipelines row whose owner_agent is your agent slug ' +
      '(project_pipelines_list { owner_agent: "<slug>" } or project_pipelines_get) — and stage_id must be a stage of that pipeline. ' +
      'pipeline_stage_id is a legacy alias of stage_id.',
    {
      status: z.string().optional(),
      pipeline_id: z.string().optional().describe('Filter to one pipeline (agents: your owned pipeline)'),
      stage_id: z.string().optional().describe('Filter to one stage; must belong to pipeline_id when both are given'),
      pipeline_stage_id: z.string().optional().describe('Legacy alias of stage_id'),
      contact_id: z.string().optional(),
      order: z.string().optional(),
      limit: z.number().optional(),
    },
    async (params) => {
      try {
        const filters: Record<string, string> = {};
        const stageId = params.stage_id ?? params.pipeline_stage_id;
        if (params.status) filters['status'] = params.status;
        if (params.pipeline_id) filters['pipeline_id'] = `eq.${params.pipeline_id}`;
        if (stageId) filters['stage_id'] = `eq.${stageId}`;
        if (params.contact_id) filters['contact_id'] = `eq.${params.contact_id}`;
        const data = await restGet('projects', {
          select: '*,contact:contacts(id,first_name,last_name,email,company),manager:users!assigned_user_id(id,name)',
          filters,
          order: params.order || 'created_at.desc',
          limit: params.limit || 50,
        });
        return toolResult(data);
      } catch (e) {
        return toolError(e);
      }
    },
  );

  server.tool(
    'projects_get',
    'Get project detail (incl. connections: repo_urls, netlify_site_url, staging_url) with tasks and notes',
    { id: z.string() },
    async ({ id }) => {
      try {
        const data = await restGet('projects', {
          select: '*,contact:contacts(*),manager:users!assigned_user_id(id,name),tasks:project_tasks(*),notes:project_notes(*)',
          filters: { id: `eq.${id}` },
          accept: 'application/vnd.pgrst.object+json',
        });
        return toolResult(data);
      } catch (e) {
        return toolError(e);
      }
    },
  );

  server.tool(
    'projects_create',
    'Create a project. Agents (friday/clara) always create in the pipeline they own (project_pipelines.owner_agent); ' +
      'pass no pipeline_id or your own. Humans: pipeline_id optional — defaults to the org pipeline with the lowest sort_order. ' +
      'stage_id optional — must belong to the pipeline; defaults to its first stage (lowest sort_order).',
    {
      org_id: z.string().optional(),
      name: z.string(),
      pipeline_id: z.string().optional(),
      stage_id: z.string().optional(),
      contact_id: z.string().optional(),
      opportunity_id: z.string().optional(),
      description: z.string().optional(),
      budget_amount: z.number().optional(),
      start_date: z.string().optional(),
      target_end_date: z.string().optional(),
      assigned_user_id: z.string().optional(),
      status: z.string().optional(),
      staging_url: projectUrl.describe('Staging / preview URL'),
    },
    async (params) => {
      try {
        // org_id and created_by are NOT NULL with no defaults — every call that
        // omitted them failed the constraint (which is why projectsBridge's
        // create path never worked). Resolve both from the caller's own JWT.
        // created_by always comes from the caller's identity; org_id only when omitted.
        const caller = await resolveCaller();
        const orgId = params.org_id ?? caller.organization_id;
        const createdBy = caller.user_id;
        let { pipeline_id, stage_id } = params;

        // Pipeline: agents are pinned to the pipeline they own; humans pick any
        // (by id) or fall back to the org's first pipeline by sort_order.
        let pipeline: PipelineRef | null = null;
        if (isAgent(caller)) {
          const owned = await getOwnedPipeline(caller);
          if (!owned) {
            return toolError(new Error(
              `No project pipeline is owned by agent "${caller.agent_slug}" — an admin must set the owner in Projects › Pipelines`,
            ));
          }
          if (pipeline_id && pipeline_id !== owned.id) {
            const requested = await getPipelineById(pipeline_id);
            const decision = requested
              ? decideOwnership(caller, requested)
              : { ok: false as const, reason: `pipeline ${pipeline_id} not found (or not visible to the caller)` };
            if (!decision.ok) {
              return toolError(new Error(
                `Refused: ${decision.reason}. ${callerLabel(caller)} owns pipeline "${owned.name}" (${owned.id}) — omit pipeline_id to use it.`,
              ));
            }
            pipeline = requested;
          } else {
            pipeline = owned;
          }
        } else if (pipeline_id) {
          pipeline = await getPipelineById(pipeline_id);
          if (!pipeline) return toolError(new Error(`Pipeline ${pipeline_id} not found (or not visible to the caller)`));
        } else {
          const rows = (await restGet('project_pipelines', {
            select: 'id,name,owner_agent,stages:project_stages(id,name,sort_order)',
            filters: { org_id: `eq.${orgId}` },
            order: 'sort_order.asc,created_at.asc',
            limit: 1,
          })) as PipelineRef[] | null;
          pipeline = rows?.[0] ?? null;
          if (!pipeline) return toolError(new Error('No project pipeline exists; create one first.'));
        }
        if (!pipeline) return toolError(new Error('Could not resolve a project pipeline for this call'));
        pipeline_id = pipeline.id;

        // Stage: validate a supplied one against the pipeline (the DB's composite
        // FK would reject a foreign stage anyway, but with an opaque 23503);
        // otherwise default to the pipeline's first stage.
        if (stage_id) {
          await assertStageInPipeline(pipeline_id, stage_id);
        } else {
          const first = sortStages(pipeline.stages)[0];
          if (!first) return toolError(new Error(`Pipeline "${pipeline.name}" (${pipeline.id}) has no stages.`));
          stage_id = first.id;
        }
        const body = { ...params, org_id: orgId, created_by: createdBy, pipeline_id, stage_id, stage_changed_at: new Date().toISOString() };
        const data = await restPost('projects', body, 'return=representation');
        return toolResult(data);
      } catch (e) {
        return toolError(e);
      }
    },
  );

  server.tool(
    'projects_update',
    'Update a project. Agents may only update projects in the pipeline they own (project_pipelines.owner_agent) and cannot change pipeline_id ' +
      '(cross-pipeline moves are admin-only). stage_id must belong to the project\'s pipeline. Stage/status changes are logged to the project timeline.',
    {
      id: z.string(),
      name: z.string().optional(),
      description: z.string().optional(),
      status: z.string().optional(),
      start_date: z.string().optional(),
      target_end_date: z.string().optional(),
      budget_amount: z.number().optional(),
      assigned_user_id: z.string().optional(),
      contact_id: z.string().optional(),
      pipeline_id: z.string().optional(),
      stage_id: z.string().optional(),
      // The portal renders progress_percent on the project card; without it here
      // no agent could ever move the bar the client actually sees.
      progress_percent: z.number().int().min(0).max(100).optional(),
      priority: z.string().optional(),
      risk_level: z.string().optional(),
      // Connections (edited on the project detail card; FRIDAY syncs them). Pass null to clear.
      repo_urls: z.array(z.string().regex(/^https:\/\/github\.com\/[^/]+\/[^/]+$/)).optional()
        .describe('GitHub repos as https://github.com/<owner>/<repo>; replaces the whole list'),
      supabase_project_ref: z.string().regex(/^[a-z]{20}$/).nullable().optional(),
      netlify_site_url: z.string().url().nullable().optional(),
      files_provider: z.enum(['google', 'microsoft']).nullable().optional(),
      files_drive_id: z.string().nullable().optional(),
      files_folder_id: z.string().nullable().optional(),
      files_folder_name: z.string().nullable().optional(),
      files_folder_url: z.string().nullable().optional(),
      staging_url: projectUrl.describe('Staging / preview URL; null or "" clears it (a plain additive field of the connections group)'),
      connections_updated_at: z.string().datetime({ offset: true }).optional()
        .describe('When the connections were last changed by the caller (last writer wins); defaults to now'),
    },
    async ({ id, ...body }) => {
      try {
        const touchesConnections = (
          ['repo_urls', 'supabase_project_ref', 'netlify_site_url', 'files_provider', 'files_drive_id',
            'files_folder_id', 'files_folder_name', 'files_folder_url', 'staging_url'] as const
        ).some((k) => body[k] !== undefined);
        if (touchesConnections && !body.connections_updated_at) body.connections_updated_at = new Date().toISOString();
        // Stage/status moves must land in project_activity_log the same way the
        // human UI's moves do — the OS project timeline AND the client portal
        // Updates feed read from it, and agent-driven changes (projectsBridge,
        // triage handlers) all arrive through this tool. Progress writes are
        // deliberately NOT logged: the bridge rewrites progress every few
        // minutes and that would drown the feed.
        //
        // Ownership guard first: one round trip loads the project with its stage
        // and pipeline, and refuses agents that do not own that pipeline.
        const g = await assertPipelineOwnership({ projectId: id });
        const project = g.project!;
        const pipelineChanging = Boolean(body.pipeline_id && body.pipeline_id !== project.pipeline_id);
        if (pipelineChanging && isAgent(g.caller)) {
          return toolError(new Error(
            `${callerLabel(g.caller)} may not move project ${id} out of pipeline "${g.pipeline.name}": cross-pipeline moves are admin-only.`,
          ));
        }
        if (pipelineChanging && !body.stage_id) {
          return toolError(new Error(
            'Changing pipeline_id requires a stage_id from the new pipeline (projects.stage_id must belong to projects.pipeline_id).',
          ));
        }
        const targetPipelineId = body.pipeline_id ?? project.pipeline_id;
        let newStage: { id: string; name: string } | null = null;
        if (body.stage_id) {
          newStage = await assertStageInPipeline(targetPipelineId, body.stage_id);
        }
        const stageChanged = Boolean(newStage && body.stage_id !== project.stage_id);
        if (stageChanged) {
          (body as Record<string, unknown>)['stage_changed_at'] = new Date().toISOString();
        }
        const data = await restPatch('projects', { id: `eq.${id}` }, body, 'return=representation');
        if (stageChanged && newStage) {
          await logStageChange({
            org_id: project.org_id,
            project_id: id,
            from: project.stage,
            to: newStage,
            actor_user_id: g.caller.user_id,
          });
        }
        if (body.status && body.status !== project.status) {
          // Best-effort: a failed log line must not fail the update itself.
          await restPost('project_activity_log', {
            org_id: project.org_id, project_id: id, event_type: 'status_changed',
            summary: `Status changed from "${project.status ?? '—'}" to "${body.status}"`,
            payload: { source: 'mcp', from: project.status, to: body.status },
            actor_user_id: g.caller.user_id,
          }).catch(() => {});
        }
        return toolResult(data);
      } catch (e) {
        return toolError(e);
      }
    },
  );

  server.tool(
    'projects_delete',
    'Delete a project',
    { id: z.string() },
    async ({ id }) => {
      try {
        await restDelete('projects', { id: `eq.${id}` });
        return toolResult({ success: true });
      } catch (e) {
        return toolError(e);
      }
    },
  );

  server.tool(
    'project_tasks_list',
    'List tasks for a project',
    { project_id: z.string(), status: z.string().optional(), limit: z.number().optional() },
    async ({ project_id, status, limit }) => {
      try {
        const filters: Record<string, string> = { project_id: `eq.${project_id}` };
        if (status) filters['status'] = status;
        const data = await restGet('project_tasks', {
          filters,
          order: 'sort_order.asc',
          limit: limit || 100,
        });
        return toolResult(data);
      } catch (e) {
        return toolError(e);
      }
    },
  );

  server.tool(
    'project_tasks_create',
    'Create a project task',
    {
      project_id: z.string(),
      title: z.string(),
      description: z.string().optional(),
      assigned_user_id: z.string().uuid().optional().describe('OS user the task is assigned to'),
      assigned_to: z.string().uuid().optional().describe('Deprecated alias of assigned_user_id'),
      due_date: z.string().optional(),
      status: z.enum(['todo', 'in_progress', 'in_review', 'completed', 'cancelled']).optional(),
      priority: z.enum(['low', 'medium', 'high', 'urgent']).optional(),
      sort_order: z.number().optional(),
    },
    async (params) => {
      try {
        // org_id and created_by are NOT NULL — resolve both from the parent project
        // (this tool previously omitted them and every insert failed).
        const project = (await restGet('projects', {
          select: 'id,org_id,created_by',
          filters: { id: `eq.${params.project_id}` },
          accept: 'application/vnd.pgrst.object+json',
        })) as { org_id: string; created_by: string };
        const data = await restPost('project_tasks', {
          ...projectTaskBody(params),
          org_id: project.org_id,
          created_by: project.created_by,
          sort_order: params.sort_order ?? 0,
        }, 'return=representation');
        return toolResult(data);
      } catch (e) {
        return toolError(e);
      }
    },
  );

  server.tool(
    'project_tasks_update',
    'Update a project task',
    {
      id: z.string(),
      title: z.string().optional(),
      description: z.string().optional(),
      status: z.enum(['todo', 'in_progress', 'in_review', 'completed', 'cancelled']).optional()
        .describe('completed stamps completed_at; any other status clears it'),
      priority: z.enum(['low', 'medium', 'high', 'urgent']).optional(),
      assigned_user_id: z.string().uuid().nullable().optional(),
      assigned_to: z.string().uuid().optional().describe('Deprecated alias of assigned_user_id'),
      due_date: z.string().optional(),
      sort_order: z.number().optional(),
    },
    async ({ id, ...params }) => {
      try {
        // A task crossing into "completed" is a project-timeline event (portal
        // Updates feed + OS activity tab). Only the transition logs — repeated
        // completed→completed upserts from the FRIDAY task mirror stay silent.
        const body = projectTaskBody(params) as typeof params & Record<string, unknown>;
        type TaskBefore = { org_id: string; project_id: string; status: string | null; title: string };
        let before: TaskBefore | null = null;
        if (body.status === 'completed') {
          before = (await restGet('project_tasks', {
            select: 'org_id,project_id,status,title',
            filters: { id: `eq.${id}` },
            accept: 'application/vnd.pgrst.object+json',
          })) as TaskBefore | null;
        }
        // A repeated completed->completed write keeps the original completion time.
        if (before && before.status === 'completed') delete body.completed_at;
        const data = await restPatch('project_tasks', { id: `eq.${id}` }, body, 'return=representation');
        if (before && before.status !== 'completed') {
          await restPost('project_activity_log', {
            org_id: before.org_id, project_id: before.project_id, event_type: 'task_completed',
            summary: `Task "${(body.title ?? before.title ?? '').slice(0, 180)}" completed`,
            payload: { source: 'mcp', task_id: id },
          }).catch(() => {});
        }
        return toolResult(data);
      } catch (e) {
        return toolError(e);
      }
    },
  );

  server.tool(
    'project_tasks_delete',
    'Delete a project task',
    { id: z.string() },
    async ({ id }) => {
      try {
        await restDelete('project_tasks', { id: `eq.${id}` });
        return toolResult({ success: true });
      } catch (e) {
        return toolError(e);
      }
    },
  );

  // Legal status transitions, mirrored from ChangeRequestDrawer.tsx so an agent
  // can never move a change request along an edge the human UI forbids.
  const CR_TRANSITIONS: Record<string, string[]> = {
    submitted: ['under_review', 'needs_more_info', 'rejected', 'cancelled'],
    under_review: ['needs_more_info', 'quoted_awaiting_approval', 'rejected', 'cancelled'],
    needs_more_info: ['under_review', 'rejected', 'cancelled'],
    quoted_awaiting_approval: ['approved', 'rejected', 'cancelled'],
    approved: ['scheduled', 'in_progress', 'cancelled'],
    scheduled: ['in_progress', 'cancelled'],
    in_progress: ['completed', 'cancelled'],
    rejected: [],
    completed: [],
    cancelled: ['submitted'],
  };

  server.tool(
    'project_change_requests_list',
    'List change requests. project_id optional — omit for an org-wide sweep (agent triage polls every project in one call). Filter by status list and/or created-since.',
    {
      project_id: z.string().optional(),
      status: z.array(z.string()).optional().describe('e.g. ["submitted","under_review"]'),
      since: z.string().optional().describe('ISO timestamp; only rows created at/after this'),
      limit: z.number().optional(),
    },
    async ({ project_id, status, since, limit }) => {
      try {
        const filters: Record<string, string> = {};
        if (project_id) filters['project_id'] = `eq.${project_id}`;
        if (status?.length) filters['status'] = `in.(${status.join(',')})`;
        if (since) filters['created_at'] = `gte.${since}`;
        const data = await restGet('project_change_requests', {
          filters,
          order: 'created_at.desc',
          limit: limit || 100,
        });
        return toolResult(data);
      } catch (e) {
        return toolError(e);
      }
    },
  );

  server.tool(
    'project_change_requests_create',
    'Submit a change request for a project. Columns match the real table (the previous version sent impact_summary/schedule_impact_days, which do not exist, and 400d on every call).',
    {
      project_id: z.string(),
      org_id: z.string().optional(),
      title: z.string(),
      description: z.string(),
      request_type: z.enum(['scope', 'timeline', 'design', 'feature', 'bugfix', 'support', 'other']).optional(),
      priority: z.enum(['low', 'medium', 'high', 'critical']).optional(),
      scope_impact: z.string().optional(),
      timeline_impact_days: z.number().optional(),
      cost_impact: z.number().optional(),
      internal_summary: z.string().optional(),
      client_name: z.string().optional(),
      client_email: z.string().optional(),
      client_phone: z.string().optional(),
      status: z.enum(['submitted', 'under_review', 'in_progress']).optional()
        .describe('Initial status. Agents mirroring a request they already triaged and are working (email/SMS/meeting intake) pass in_progress so the portal shows it without re-running review.'),
    },
    async (params) => {
      try {
        // RLS requires org_id = the caller's org and the column has no default — an omitted org_id
        // 403'd every call. Take it from the project when the caller didn't pass one.
        let orgId = params.org_id;
        if (!orgId) {
          const project = (await restGet('projects', {
            select: 'id,org_id',
            filters: { id: `eq.${params.project_id}` },
            accept: 'application/vnd.pgrst.object+json',
          })) as { id: string; org_id: string } | null;
          if (!project) return toolError(new Error('Project not found'));
          orgId = project.org_id;
        }
        const data = await restPost('project_change_requests', { ...params, org_id: orgId, source: 'ai' }, 'return=representation');
        return toolResult(data);
      } catch (e) {
        return toolError(e);
      }
    },
  );

  server.tool(
    'project_change_requests_update',
    'Update a change request. Status moves are validated against the same transition table the OS drawer enforces, and timestamps/audit rows are written the way the human path writes them.',
    {
      id: z.string(),
      status: z.string().optional().describe('Must be a legal transition from the current status'),
      internal_summary: z.string().optional(),
      client_summary: z.string().optional(),
      scope_impact: z.string().optional(),
      timeline_impact_days: z.number().optional(),
      cost_impact: z.number().optional(),
      priority: z.enum(['low', 'medium', 'high', 'critical']).optional(),
      actor_name: z.string().optional().describe('Recorded on the audit event; e.g. "FRIDAY"'),
    },
    async ({ id, status, actor_name, ...body }) => {
      try {
        const current = (await restGet('project_change_requests', {
          select: 'id,org_id,status',
          filters: { id: `eq.${id}` },
          accept: 'application/vnd.pgrst.object+json',
        })) as { id: string; org_id: string; status: string };
        if (!current) return toolError(new Error('Change request not found'));

        const patch: Record<string, unknown> = { ...body, updated_at: new Date().toISOString() };
        if (status) {
          const allowed = CR_TRANSITIONS[current.status] ?? [];
          if (!allowed.includes(status)) {
            return toolError(new Error(
              `Illegal transition ${current.status} -> ${status}. Allowed: ${allowed.join(', ') || '(none — terminal)'}`,
            ));
          }
          patch['status'] = status;
          const now = new Date().toISOString();
          if (status === 'under_review') patch['reviewed_at'] = now;
          if (status === 'approved') patch['approved_at'] = now;
          if (status === 'rejected') patch['rejected_at'] = now;
          if (status === 'completed') patch['completed_at'] = now;
        }
        const data = await restPatch('project_change_requests', { id: `eq.${id}` }, patch, 'return=representation');
        if (status) {
          await restPost('project_change_request_audit', {
            org_id: current.org_id,
            change_request_id: id,
            event_type: `status_changed_to_${status}`,
            actor_type: 'system',
            actor_name: actor_name ?? 'agent',
            metadata: { from: current.status, to: status },
          });
        }
        return toolResult(data);
      } catch (e) {
        return toolError(e);
      }
    },
  );

  server.tool(
    'project_change_request_comments_list',
    'Read the comment thread on a change request, including internal notes.',
    { change_request_id: z.string(), limit: z.number().optional() },
    async ({ change_request_id, limit }) => {
      try {
        const data = await restGet('project_change_request_comments', {
          filters: { change_request_id: `eq.${change_request_id}` },
          order: 'created_at.asc',
          limit: limit || 200,
        });
        return toolResult(data);
      } catch (e) {
        return toolError(e);
      }
    },
  );

  server.tool(
    'project_change_request_comments_create',
    'Comment on a change request. client_visible=false + is_internal=true for staff notes; client_visible=true posts into the portal thread.',
    {
      change_request_id: z.string(),
      org_id: z.string().optional(),
      body: z.string(),
      is_internal: z.boolean().optional().describe('Default true (staff-only). Set false with client_visible true to address the client.'),
      client_visible: z.boolean().optional(),
      author_name: z.string().optional(),
    },
    async (params) => {
      try {
        const internal = params.is_internal ?? true;
        let orgId = params.org_id;
        if (!orgId) {
          const parent = (await restGet('project_change_requests', {
            select: 'org_id',
            filters: { id: `eq.${params.change_request_id}` },
            accept: 'application/vnd.pgrst.object+json',
          })) as { org_id: string } | null;
          if (!parent) return toolError(new Error('Change request not found'));
          orgId = parent.org_id;
        }
        const data = await restPost('project_change_request_comments', {
          change_request_id: params.change_request_id,
          org_id: orgId,
          body: params.body,
          is_internal: internal,
          client_visible: params.client_visible ?? !internal,
          portal_reply: false,
          author_type: 'system',
          author_name: params.author_name ?? 'agent',
        }, 'return=representation');
        return toolResult(data);
      } catch (e) {
        return toolError(e);
      }
    },
  );

  // The former support_tickets_list/create/update tools were removed here: they
  // targeted a `support_tickets` table that has never existed in any migration,
  // so every call failed. The client-portal ticket system is
  // project_support_tickets / project_support_ticket_comments below.

  server.tool(
    'change_request_notify',
    'Send notification about a change request',
    { change_request_id: z.string() },
    async (params) => {
      try {
        const data = await callEdgeFunction('change-request-notify', params);
        return toolResult(data);
      } catch (e) {
        return toolError(e);
      }
    },
  );

  server.tool(
    'support_ticket_notify',
    'Send notification about a support ticket',
    { ticket_id: z.string() },
    async (params) => {
      try {
        const data = await callEdgeFunction('support-ticket-notify', params);
        return toolResult(data);
      } catch (e) {
        return toolError(e);
      }
    },
  );

  // Autonomy Spec v0.1, item #11: the client-portal-facing ticket system —
  // project_support_tickets / project_support_ticket_comments — had no MCP surface at all before
  // this. NOT the same table as support_tickets_list/create/update above, which is an unrelated,
  // older concept; these two are what the actual client portal (ClientPortalSupportTicketDetail
  // Page.tsx) reads and writes.
  server.tool(
    'project_support_tickets_list',
    'List client-portal support tickets. project_id optional — omit for an org-wide sweep so agent triage covers every project in one call. Filter by status list and/or created-since.',
    {
      project_id: z.string().optional(),
      status: z.array(z.string()).optional().describe('e.g. ["new","in_review"]'),
      since: z.string().optional().describe('ISO timestamp; only rows created at/after this'),
      limit: z.number().optional(),
    },
    async ({ project_id, status, since, limit }) => {
      try {
        const filters: Record<string, string> = {};
        if (project_id) filters['project_id'] = `eq.${project_id}`;
        if (status?.length) filters['status'] = `in.(${status.join(',')})`;
        if (since) filters['created_at'] = `gte.${since}`;
        const data = await restGet('project_support_tickets', {
          filters,
          order: 'created_at.desc',
          limit: limit || 100,
        });
        return toolResult(data);
      } catch (e) {
        return toolError(e);
      }
    },
  );

  server.tool(
    'project_support_tickets_create',
    'Create a support ticket on a project — the same row the client portal shows. For agents mirroring a client issue that arrived outside the portal (email, SMS, call, meeting) so it is visible in the OS Support Tickets tab and the client portal.',
    {
      project_id: z.string(),
      title: z.string(),
      description: z.string(),
      request_type: z.enum([
        'bug_report', 'bug_issue', 'system_error', 'access_login', 'access_permissions', 'feature_request',
        'change_request', 'integration_issue', 'performance_issue', 'security_concern', 'configuration_change',
        'training_docs', 'general_inquiry', 'general_support',
      ]).optional(),
      priority: z.enum(['low', 'medium', 'high', 'critical']).optional(),
      client_name: z.string().optional(),
      client_email: z.string().optional(),
      client_phone: z.string().optional(),
      source: z.enum(['internal', 'email']).optional().describe('internal (default) for agent-created; email when the client emailed it in'),
      status: z.enum(['new', 'in_review', 'in_progress']).optional(),
    },
    async (params) => {
      try {
        // org_id is NOT NULL with no default — take it from the project, which is always right.
        const project = (await restGet('projects', {
          select: 'id,org_id',
          filters: { id: `eq.${params.project_id}` },
          accept: 'application/vnd.pgrst.object+json',
        })) as { id: string; org_id: string } | null;
        if (!project) return toolError(new Error('Project not found'));
        const data = await restPost('project_support_tickets', {
          org_id: project.org_id,
          project_id: params.project_id,
          title: params.title,
          subject: params.title,
          description: params.description,
          request_type: params.request_type ?? 'bug_report',
          priority: params.priority ?? 'medium',
          client_name: params.client_name ?? '',
          client_email: params.client_email ?? null,
          client_phone: params.client_phone ?? null,
          source: params.source ?? 'internal',
          status: params.status ?? 'new',
        }, 'return=representation');
        return toolResult(data);
      } catch (e) {
        return toolError(e);
      }
    },
  );

  server.tool(
    'project_support_tickets_get',
    'Get one client-portal support ticket by id.',
    { id: z.string() },
    async ({ id }) => {
      try {
        const data = await restGet('project_support_tickets', {
          filters: { id: `eq.${id}` },
          accept: 'application/vnd.pgrst.object+json',
        });
        return toolResult(data);
      } catch (e) {
        return toolError(e);
      }
    },
  );

  server.tool(
    'project_support_ticket_comments_list',
    'Read the full comment thread on a support ticket, internal notes included.',
    { ticket_id: z.string(), limit: z.number().optional() },
    async ({ ticket_id, limit }) => {
      try {
        const data = await restGet('project_support_ticket_comments', {
          filters: { ticket_id: `eq.${ticket_id}` },
          order: 'created_at.asc',
          limit: limit || 200,
        });
        return toolResult(data);
      } catch (e) {
        return toolError(e);
      }
    },
  );

  server.tool(
    'project_support_tickets_update',
    'Update a client-portal support ticket: status, assignment, severity. Writes the audit event the human path writes.',
    {
      id: z.string(),
      status: z.enum(['new', 'in_review', 'in_progress', 'waiting_on_client', 'resolved', 'closed']).optional(),
      assigned_user_id: z.string().optional(),
      severity_score: z.number().optional(),
      actor_name: z.string().optional().describe('Recorded on the audit event; e.g. "FRIDAY"'),
    },
    async ({ id, actor_name, ...body }) => {
      try {
        const current = (await restGet('project_support_tickets', {
          select: 'id,org_id,status',
          filters: { id: `eq.${id}` },
          accept: 'application/vnd.pgrst.object+json',
        })) as { id: string; org_id: string; status: string };
        if (!current) return toolError(new Error('Ticket not found'));
        const data = await restPatch('project_support_tickets', { id: `eq.${id}` },
          { ...body, updated_at: new Date().toISOString() }, 'return=representation');
        if (body.status && body.status !== current.status) {
          await restPost('project_support_ticket_audit', {
            org_id: current.org_id,
            ticket_id: id,
            event_type: `status_changed_to_${body.status}`,
            actor_type: 'system',
            actor_name: actor_name ?? 'agent',
            metadata: { from: current.status, to: body.status },
          });
        }
        return toolResult(data);
      } catch (e) {
        return toolError(e);
      }
    },
  );

  server.tool(
    'project_ticket_comment_create',
    'Post a message into a client-portal support ticket thread — client-visible by default. This is how an agent actually communicates with a client through the portal.',
    {
      ticket_id: z.string(),
      org_id: z.string().optional().describe('Omit to let the row default to the caller\'s own org, same as opportunities.created_by.'),
      body: z.string(),
      is_internal: z.boolean().optional().describe('true = staff-only note, never shown to the client. Default false (client-visible).'),
      author_name: z.string().optional(),
    },
    async (params) => {
      try {
        // org_id is NOT NULL on the comments table and there is no column default —
        // the previous "omit to let the row default" behavior meant every omitted
        // call failed. Derive it from the parent ticket, which is always right.
        let orgId = params.org_id;
        if (!orgId) {
          const parent = (await restGet('project_support_tickets', {
            select: 'org_id',
            filters: { id: `eq.${params.ticket_id}` },
            accept: 'application/vnd.pgrst.object+json',
          })) as { org_id: string } | null;
          if (!parent) return toolError(new Error('Ticket not found'));
          orgId = parent.org_id;
        }
        const data = await restPost('project_support_ticket_comments', {
          ticket_id: params.ticket_id,
          org_id: orgId,
          body: params.body,
          is_internal: params.is_internal ?? false,
          author_type: 'system',
          author_name: params.author_name,
        }, 'return=representation');
        return toolResult(data);
      } catch (e) {
        return toolError(e);
      }
    },
  );

  server.tool(
    'project_contacts_list',
    'List the contacts (POCs) with portal access to a project. The primary contact is mirrored in automatically; additional POCs let several people at one company see the same project.',
    { project_id: z.string() },
    async ({ project_id }) => {
      try {
        const data = await restGet('project_contacts', {
          select: '*,contact:contacts(id,first_name,last_name,email,company)',
          filters: { project_id: `eq.${project_id}` },
          order: 'created_at.asc',
        });
        return toolResult(data);
      } catch (e) {
        return toolError(e);
      }
    },
  );

  server.tool(
    'project_contacts_add',
    'Grant a contact portal access to a project (additional POC). They sign in with their own email and see the project alongside the primary contact.',
    {
      project_id: z.string(),
      contact_id: z.string(),
      org_id: z.string().optional(),
      role: z.enum(['poc', 'billing', 'technical']).optional(),
    },
    async (params) => {
      try {
        const data = await restPost('project_contacts', {
          project_id: params.project_id,
          contact_id: params.contact_id,
          ...(params.org_id ? { org_id: params.org_id } : {}),
          role: params.role ?? 'poc',
        }, 'return=representation');
        return toolResult(data);
      } catch (e) {
        return toolError(e);
      }
    },
  );

  server.tool(
    'project_contacts_remove',
    'Revoke an additional POC\'s portal access to a project. The primary contact cannot be removed this way — change projects.contact_id instead.',
    { project_id: z.string(), contact_id: z.string() },
    async ({ project_id, contact_id }) => {
      try {
        const existing = (await restGet('project_contacts', {
          select: 'id,role',
          filters: { project_id: `eq.${project_id}`, contact_id: `eq.${contact_id}` },
          accept: 'application/vnd.pgrst.object+json',
        })) as { id: string; role: string } | null;
        if (!existing) return toolError(new Error('Not a member of this project'));
        if (existing.role === 'primary') {
          return toolError(new Error('Refusing to remove the primary contact; reassign projects.contact_id instead.'));
        }
        await restDelete('project_contacts', { id: `eq.${existing.id}` });
        return toolResult({ success: true });
      } catch (e) {
        return toolError(e);
      }
    },
  );

  server.tool(
    'contract_scope_index_get',
    'Read the extracted contract scope (deliverables, exclusions, SLA terms) for a project or contract — the structured record of what was actually promised, for grounding change-request impact analysis.',
    { project_id: z.string().optional(), contract_id: z.string().optional() },
    async ({ project_id, contract_id }) => {
      try {
        if (!project_id && !contract_id) return toolError(new Error('project_id or contract_id required'));
        // contract_scope_index keys on contract_id only. Given a project, resolve
        // through the project's contact to their contracts — contracts carry
        // contact_id, not project_id.
        let contractIds: string[] = contract_id ? [contract_id] : [];
        if (!contractIds.length && project_id) {
          const project = (await restGet('projects', {
            select: 'id,contact_id',
            filters: { id: `eq.${project_id}` },
            accept: 'application/vnd.pgrst.object+json',
          })) as { id: string; contact_id: string | null } | null;
          if (!project?.contact_id) return toolResult([]);
          const contracts = (await restGet('contracts', {
            select: 'id',
            filters: { contact_id: `eq.${project.contact_id}` },
          })) as Array<{ id: string }>;
          contractIds = (contracts ?? []).map((c) => c.id);
          if (!contractIds.length) return toolResult([]);
        }
        const data = await restGet('contract_scope_index', {
          filters: { contract_id: `in.(${contractIds.join(',')})` },
          order: 'created_at.desc',
        });
        return toolResult(data);
      } catch (e) {
        return toolError(e);
      }
    },
  );

  server.tool(
    'project_pipelines_list',
    'List project pipelines with their stages (stages sorted by sort_order). Each pipeline carries owner_agent ' +
      '(friday | clara | null) — the agent allowed to create/update/move projects in it. ' +
      'Agents: call with owner_agent = your slug to find the one pipeline you may act on. Optionally filter by org_id.',
    {
      org_id: z.string().optional(),
      owner_agent: AGENT_SLUG_ENUM.optional().describe('Only pipelines owned by this agent'),
    },
    async ({ org_id, owner_agent }) => {
      try {
        const filters: Record<string, string> = {};
        if (org_id) filters['org_id'] = `eq.${org_id}`;
        if (owner_agent) filters['owner_agent'] = `eq.${owner_agent}`;
        const data = (await restGet('project_pipelines', {
          select: '*,stages:project_stages(*)',
          filters,
          order: 'sort_order.asc',
        })) as Array<Record<string, unknown> & { stages?: Array<{ sort_order: number }> }> | null;
        const sorted = (data ?? []).map((p) => ({
          ...p,
          stages: [...(p.stages ?? [])].sort((a, b) => a.sort_order - b.sort_order),
        }));
        return toolResult(sorted);
      } catch (e) {
        return toolError(e);
      }
    },
  );

  server.tool(
    'project_pipelines_get',
    'Get ONE project pipeline (by id, or case-insensitive name match) with its stages ordered by sort_order and its owner_agent. ' +
      'Use this to look up valid stage ids before projects_create / projects_update / project_move_stage.',
    {
      id: z.string().optional(),
      name: z.string().optional().describe('Case-insensitive name; exact match preferred, else substring'),
    },
    async ({ id, name }) => {
      try {
        if (!id && !name) return toolError(new Error('Provide id or name'));
        type Row = Record<string, unknown> & { id: string; name: string; stages?: Array<{ sort_order: number }> };
        const filters: Record<string, string> = {};
        if (id) filters['id'] = `eq.${id}`;
        else if (name) filters['name'] = `ilike.*${name.replace(/[%*]/g, '')}*`;
        const rows = (await restGet('project_pipelines', {
          select: '*,stages:project_stages(*)',
          filters,
          order: 'sort_order.asc',
        })) as Row[] | null;
        let match: Row | undefined;
        if (rows && rows.length > 0) {
          match = rows.length === 1
            ? rows[0]
            : rows.find((r) => r.name.toLowerCase() === (name ?? '').toLowerCase());
          if (!match) {
            return toolError(new Error(
              `Pipeline name "${name}" is ambiguous: ${rows.map((r) => `"${r.name}" (${r.id})`).join(', ')}. Pass id instead.`,
            ));
          }
        }
        if (!match) return toolError(new Error(`Pipeline ${id ? id : `"${name}"`} not found (or not visible to the caller)`));
        return toolResult({
          ...match,
          stages: [...(match.stages ?? [])].sort((a, b) => a.sort_order - b.sort_order),
        });
      } catch (e) {
        return toolError(e);
      }
    },
  );

  server.tool(
    'project_stages_list',
    'List stages for a project pipeline',
    { pipeline_id: z.string() },
    async ({ pipeline_id }) => {
      try {
        const data = await restGet('project_stages', {
          filters: { pipeline_id: `eq.${pipeline_id}` },
          order: 'sort_order.asc',
        });
        return toolResult(data);
      } catch (e) {
        return toolError(e);
      }
    },
  );

  server.tool(
    'project_move_stage',
    'Move a project to a new stage within its pipeline (updates stage_changed_at and logs a stage_changed timeline event). ' +
      'Agents may only move projects in the pipeline they own; stage_id must belong to the project\'s pipeline ' +
      '(see project_pipelines_get). Returns { unchanged: true } if the project is already in that stage.',
    { id: z.string(), stage_id: z.string() },
    async ({ id, stage_id }) => {
      try {
        const g = await assertPipelineOwnership({ projectId: id });
        const project = g.project!;
        const to = await assertStageInPipeline(project.pipeline_id, stage_id);
        const pipeline = { id: g.pipeline.id, name: g.pipeline.name, owner_agent: g.pipeline.owner_agent };
        if (project.stage_id === stage_id) {
          return toolResult({ unchanged: true, project_id: id, pipeline, stage: to });
        }
        const rows = (await restPatch(
          'projects',
          { id: `eq.${id}` },
          { stage_id, stage_changed_at: new Date().toISOString() },
          'return=representation',
        )) as Array<Record<string, unknown>> | null;
        await logStageChange({
          org_id: project.org_id,
          project_id: id,
          from: project.stage,
          to,
          actor_user_id: g.caller.user_id,
        });
        // Same representation array as before, each row annotated with the move.
        const data = (rows ?? []).map((r) => ({ ...r, moved: true, pipeline, from_stage: project.stage, to_stage: to }));
        return toolResult(data);
      } catch (e) {
        return toolError(e);
      }
    },
  );

  server.tool(
    'convert_opportunity_to_project',
    'Create a project from an opportunity and lock the opportunity financials. Requires pipeline_id and stage_id ' +
      '(stage must belong to the pipeline). Agents may only target the pipeline they own (project_pipelines.owner_agent).',
    {
      opportunity_id: z.string(),
      org_id: z.string(),
      contact_id: z.string(),
      pipeline_id: z.string(),
      stage_id: z.string(),
      name: z.string(),
      description: z.string().optional(),
      assigned_user_id: z.string().optional(),
      budget_amount: z.number().optional(),
      start_date: z.string().optional(),
      target_end_date: z.string().optional(),
      created_by: z.string().optional(),
    },
    async ({ opportunity_id, ...rest }) => {
      try {
        const g = await assertPipelineOwnership({ pipelineId: rest.pipeline_id });
        await assertStageInPipeline(rest.pipeline_id, rest.stage_id);
        // created_by is NOT NULL; default it to the caller like projects_create does.
        const created_by = rest.created_by ?? g.caller.user_id;
        const project = await restPost(
          'projects',
          { ...rest, created_by, opportunity_id, stage_changed_at: new Date().toISOString() },
          'return=representation',
        );
        await restPatch('opportunities', { id: `eq.${opportunity_id}` }, { financial_locked: true });
        return toolResult(project);
      } catch (e) {
        return toolError(e);
      }
    },
  );

  server.tool(
    'project_costs_list',
    'List costs for a project',
    { project_id: z.string() },
    async ({ project_id }) => {
      try {
        const data = await restGet('project_costs', {
          filters: { project_id: `eq.${project_id}` },
          order: 'date.desc',
        });
        return toolResult(data);
      } catch (e) {
        return toolError(e);
      }
    },
  );

  server.tool(
    'project_costs_create',
    'Add a cost to a project',
    {
      org_id: z.string(),
      project_id: z.string(),
      description: z.string(),
      amount: z.number(),
      currency: z.string().optional(),
      category: z.string().optional(),
      date: z.string().optional(),
      created_by: z.string().optional(),
    },
    async (params) => {
      try {
        const data = await restPost('project_costs', params, 'return=representation');
        return toolResult(data);
      } catch (e) {
        return toolError(e);
      }
    },
  );

  server.tool(
    'project_costs_update',
    'Update a project cost',
    {
      id: z.string(),
      description: z.string().optional(),
      amount: z.number().optional(),
      currency: z.string().optional(),
      category: z.string().optional(),
      date: z.string().optional(),
    },
    async ({ id, ...body }) => {
      try {
        const data = await restPatch('project_costs', { id: `eq.${id}` }, body, 'return=representation');
        return toolResult(data);
      } catch (e) {
        return toolError(e);
      }
    },
  );

  server.tool(
    'project_costs_delete',
    'Delete a project cost',
    { id: z.string() },
    async ({ id }) => {
      try {
        await restDelete('project_costs', { id: `eq.${id}` });
        return toolResult({ success: true });
      } catch (e) {
        return toolError(e);
      }
    },
  );

  server.tool(
    'project_notes_create',
    'Add a note to a project',
    {
      org_id: z.string(),
      project_id: z.string(),
      body: z.string(),
      created_by: z.string().optional(),
    },
    async (params) => {
      try {
        const data = await restPost('project_notes', params, 'return=representation');
        return toolResult(data);
      } catch (e) {
        return toolError(e);
      }
    },
  );

  server.tool(
    'project_notes_update',
    'Update a project note',
    { id: z.string(), body: z.string() },
    async ({ id, ...body }) => {
      try {
        const data = await restPatch('project_notes', { id: `eq.${id}` }, body, 'return=representation');
        return toolResult(data);
      } catch (e) {
        return toolError(e);
      }
    },
  );

  server.tool(
    'project_notes_delete',
    'Soft-delete a project note (sets deleted_at)',
    { id: z.string() },
    async ({ id }) => {
      try {
        await restPatch('project_notes', { id: `eq.${id}` }, { deleted_at: new Date().toISOString() });
        return toolResult({ success: true });
      } catch (e) {
        return toolError(e);
      }
    },
  );

  server.tool(
    'project_activity_list',
    'List activity log events for a project',
    { project_id: z.string(), limit: z.number().optional() },
    async ({ project_id, limit }) => {
      try {
        const data = await restGet('project_activity_log', {
          filters: { project_id: `eq.${project_id}` },
          order: 'created_at.desc',
          limit: limit || 100,
        });
        return toolResult(data);
      } catch (e) {
        return toolError(e);
      }
    },
  );

  server.tool(
    'project_activity_create',
    'Post a client-visible narrative update ("milestone") to a project\'s timeline. ' +
      'This surfaces on the client portal\'s Project Updates feed: title is the headline, ' +
      'detail is the expandable what-and-why body. Write in first-person team voice for the client. ' +
      'Prefer passing `sections` (what took place / what we did / how it affects your software / ' +
      "what's live now / what to check) — the portal renders them as labelled sections; `detail` " +
      'should then be the plain-text concatenation for older readers.',
    {
      project_id: z.string(),
      title: z.string().max(200).describe('Plain-English headline of what shipped'),
      detail: z.string().max(4000).describe('Plain-text body (2-5 sentences, or the concatenated sections)'),
      occurred_at: z.string().optional().describe('ISO timestamp of when the work landed (defaults to now)'),
      source_ref: z.string().optional().describe('Stable dedupe key, e.g. "pr#41" or "commits-2026-08-27"'),
      actor_user_id: z.string().optional(),
      sections: z
        .object({
          context: z.string().max(500).describe('What took place — why this work happened / what was asked'),
          changes: z.string().max(800).describe('What we did, in product terms'),
          impact: z.string().max(800).describe('How it affects your software — what the client will notice, by screen/feature'),
          live_now: z.string().max(300).describe("What's live now — explicit live / not-yet-live statement"),
          check: z.array(z.string().max(160)).max(5).optional().describe('What to check — 0-5 short things to try'),
        })
        .optional()
        .describe('Client-facing structured body; the portal renders it as labelled sections'),
      is_live: z.boolean().optional().describe('True when the change is on the default branch / production'),
      kind: z.enum(['feature', 'fix', 'content']).optional(),
      shas: z.array(z.string().max(40)).max(100).optional().describe('Internal: commit shas covered, for dedup. Never shown to clients.'),
    },
    async ({ project_id, title, detail, occurred_at, source_ref, actor_user_id, sections, is_live, kind, shas }) => {
      try {
        // org_id comes from the project row, never from the caller.
        const projects = (await restGet('projects', {
          filters: { id: `eq.${project_id}` },
          limit: 1,
        })) as Array<{ id: string; org_id: string }>;
        const project = projects?.[0];
        if (!project) return toolError(new Error('Project not found'));

        // Idempotent on source_ref so a re-run scheduler tick can't double-post.
        if (source_ref) {
          const existing = (await restGet('project_activity_log', {
            filters: {
              project_id: `eq.${project_id}`,
              event_type: 'eq.milestone',
              'payload->>source_ref': `eq.${source_ref}`,
            },
            limit: 1,
          })) as Array<{ id: string }>;
          if (existing?.length) return toolResult({ success: true, deduped: true, id: existing[0].id });
        }

        const row: Record<string, unknown> = {
          org_id: project.org_id,
          project_id,
          event_type: 'milestone',
          summary: title,
          payload: {
            source: 'mcp-agent',
            title,
            detail,
            ...(source_ref ? { source_ref } : {}),
            // sections.v1: structured client-facing body. `format` marks new-style rows so the
            // portal can tell them from legacy title+detail entries.
            ...(sections ? { format: 'sections.v1', sections, is_live: is_live ?? true } : {}),
            ...(!sections && typeof is_live === 'boolean' ? { is_live } : {}),
            ...(kind ? { kind } : {}),
            ...(shas?.length ? { shas } : {}),
          },
          ...(actor_user_id ? { actor_user_id } : {}),
          ...(occurred_at ? { created_at: occurred_at } : {}),
        };
        const data = await restPost('project_activity_log', row, 'return=representation');
        return toolResult(data);
      } catch (e) {
        return toolError(e);
      }
    },
  );

  server.tool(
    'project_release_approval_create',
    'File a per-build client sign-off tied to a specific PR. Surfaces on the client portal as ' +
      '"Ready for your review" and in the office merge panel. Idempotent on (project_id, pr_url).',
    {
      project_id: z.string(),
      pr_url: z.string(),
      title: z.string().max(200).describe('Client-facing headline of what this build ships'),
      changelog: z.string().max(4000).optional().describe('Plain-English what-changed, client voice'),
      pr_repo: z.string().optional(),
      pr_number: z.number().optional(),
      created_by: z.string().optional(),
    },
    async ({ project_id, pr_url, title, changelog, pr_repo, pr_number, created_by }) => {
      try {
        const projects = (await restGet('projects', {
          filters: { id: `eq.${project_id}` },
          limit: 1,
        })) as Array<{ id: string; org_id: string }>;
        const project = projects?.[0];
        if (!project) return toolError(new Error('Project not found'));

        const existing = (await restGet('project_release_approvals', {
          filters: { project_id: `eq.${project_id}`, pr_url: `eq.${pr_url}` },
          limit: 1,
        })) as Array<{ id: string; status: string }>;
        if (existing?.length) return toolResult({ success: true, deduped: true, id: existing[0].id, status: existing[0].status });

        const row: Record<string, unknown> = {
          org_id: project.org_id,
          project_id,
          pr_url,
          title,
          ...(changelog ? { changelog } : {}),
          ...(pr_repo ? { pr_repo } : {}),
          ...(typeof pr_number === 'number' ? { pr_number } : {}),
          ...(created_by ? { created_by } : {}),
        };
        const data = await restPost('project_release_approvals', row, 'return=representation');
        return toolResult(data);
      } catch (e) {
        return toolError(e);
      }
    },
  );

  server.tool(
    'project_release_approval_update',
    'Update a release approval (e.g. mark merged after the office merge+deploy). Keyed by project_id + pr_url.',
    {
      project_id: z.string(),
      pr_url: z.string(),
      status: z.enum(['pending', 'approved', 'rejected', 'merged']).optional(),
      deploy_status: z.string().optional(),
      merged: z.boolean().optional().describe('When true, stamps merged_at = now'),
    },
    async ({ project_id, pr_url, status, deploy_status, merged }) => {
      try {
        const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
        if (status) patch['status'] = status;
        if (deploy_status) patch['deploy_status'] = deploy_status;
        if (merged) patch['merged_at'] = new Date().toISOString();
        const data = await restPatch(
          'project_release_approvals',
          { project_id: `eq.${project_id}`, pr_url: `eq.${pr_url}` },
          patch,
          'return=representation',
        );
        return toolResult(data);
      } catch (e) {
        return toolError(e);
      }
    },
  );

  server.tool(
    'project_release_approval_list',
    'List per-build client sign-offs for a project (optionally filtered by status).',
    { project_id: z.string(), status: z.string().optional() },
    async ({ project_id, status }) => {
      try {
        const filters: Record<string, string> = { project_id: `eq.${project_id}` };
        if (status) filters['status'] = `eq.${status}`;
        const data = await restGet('project_release_approvals', {
          filters,
          order: 'created_at.desc',
          limit: 100,
        });
        return toolResult(data);
      } catch (e) {
        return toolError(e);
      }
    },
  );

  // project_client_portals_* were removed: that table was dropped (client portal access now
  // lives in client_portal_accounts, managed from the app).

  // ── Agent-specific project metadata (M2) ──────────────────────────────────
  // FRIDAY's dev fields (repo urls, deploy url, supabase ref, drive folder) live in
  // project_agent_meta, keyed back to the agent's legacy local project id.

  server.tool(
    'project_agent_meta_get',
    "Get agent-specific metadata rows from project_agent_meta (repo urls, deploy url, supabase ref, legacy local project id). Filter by project_id and/or agent; pass local_project_id to map one of the agent's legacy project ids to its OS project.",
    {
      project_id: z.string().optional(),
      agent: z.enum(['friday', 'clara']).optional(),
      local_project_id: z.string().optional(),
    },
    async (params) => {
      try {
        const filters: Record<string, string> = {};
        if (params.project_id) filters['project_id'] = `eq.${params.project_id}`;
        if (params.agent) filters['agent'] = `eq.${params.agent}`;
        if (params.local_project_id) filters['local_project_id'] = `eq.${params.local_project_id}`;
        const data = await restGet('project_agent_meta', {
          select: '*,project:projects(id,name,status,contact_id)',
          filters,
          order: 'updated_at.desc',
          limit: 200,
        });
        return toolResult(data);
      } catch (e) {
        return toolError(e);
      }
    },
  );

  server.tool(
    'project_agent_meta_set',
    'Create or update the agent-specific metadata row for a project. `meta` keys are shallow-merged into the existing meta object.',
    {
      project_id: z.string(),
      agent: z.enum(['friday', 'clara']),
      local_project_id: z.string().optional(),
      meta: z.record(z.unknown()),
    },
    async ({ project_id, agent, local_project_id, meta }) => {
      try {
        const existing = (await restGet('project_agent_meta', {
          filters: { project_id: `eq.${project_id}`, agent: `eq.${agent}` },
        })) as Array<{ id: string; meta: Record<string, unknown> }>;
        if (existing.length > 0) {
          const patch: Record<string, unknown> = {
            meta: { ...existing[0].meta, ...meta },
            updated_at: new Date().toISOString(),
          };
          if (local_project_id) patch['local_project_id'] = local_project_id;
          const data = await restPatch('project_agent_meta', { id: `eq.${existing[0].id}` }, patch, 'return=representation');
          return toolResult(data);
        }
        const project = (await restGet('projects', {
          select: 'id,org_id',
          filters: { id: `eq.${project_id}` },
          accept: 'application/vnd.pgrst.object+json',
        })) as { id: string; org_id: string };
        const data = await restPost('project_agent_meta',
          { org_id: project.org_id, project_id, agent, local_project_id, meta },
          'return=representation');
        return toolResult(data);
      } catch (e) {
        return toolError(e);
      }
    },
  );
}
