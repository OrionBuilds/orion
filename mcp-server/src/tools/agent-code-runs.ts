import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { restGet, restRpc } from '../helpers/rest-client.js';
import { toolResult, toolError } from '../helpers/tool-utils.js';

/**
 * Agent code runs (FRIDAY contract §1). One row per code run an agent performs (build, fix, qa,
 * review, deploy …), so the OS sees the real work, PR links and errors. Upserted through the
 * agent_code_run_report RPC, which binds the row to the caller (auth.uid()) and its org and is
 * idempotent on (org, agent, external_id). On an update, omitted fields keep their stored value.
 */

const STATUS = ['running', 'succeeded', 'failed', 'cancelled'] as const;

export function registerAgentCodeRunsTools(server: McpServer): void {
  server.tool(
    'agent_code_runs_report',
    'Report (create or update) one of MY code runs. Idempotent on external_id (your own run id): call it when the run starts (status "running") and again when it ends (succeeded|failed|cancelled with finished_at, summary/error, pr_url). Returns { id }.',
    {
      external_id: z.string().min(1).max(200).describe('Your run id (stable idempotency key)'),
      project_id: z.string().uuid().optional(),
      project_task_id: z.string().uuid().optional(),
      request_ref: z.string().max(300).optional().describe('agent_request id, ticket/CR ref, or other origin'),
      kind: z.string().min(1).max(40).describe('build | fix | qa | review | deploy | ...'),
      status: z.enum(STATUS),
      started_at: z.string().describe('ISO 8601'),
      finished_at: z.string().optional().describe('ISO 8601'),
      summary: z.string().max(4000).optional(),
      error: z.string().max(4000).optional(),
      pr_url: z.string().url().optional(),
      engine: z.string().max(80).optional(),
    },
    async (p) => {
      try {
        const res = await restRpc('agent_code_run_report', {
          p_external_id: p.external_id,
          p_kind: p.kind,
          p_status: p.status,
          p_started_at: p.started_at,
          p_finished_at: p.finished_at ?? null,
          p_project_id: p.project_id ?? null,
          p_project_task_id: p.project_task_id ?? null,
          p_request_ref: p.request_ref ?? null,
          p_summary: p.summary ?? null,
          p_error: p.error ?? null,
          p_pr_url: p.pr_url ?? null,
          p_engine: p.engine ?? null,
        });
        return toolResult(res);
      } catch (e) {
        return toolError(e);
      }
    },
  );

  server.tool(
    'agent_code_runs_list',
    'List agent code runs in my org, newest first. Filter by project, task, status, start time, or agent (friday|clara).',
    {
      project_id: z.string().uuid().optional(),
      project_task_id: z.string().uuid().optional(),
      status: z.enum(STATUS).optional(),
      since: z.string().optional().describe('ISO 8601: runs started at/after this time'),
      agent: z.enum(['friday', 'clara']).optional(),
      limit: z.number().int().min(1).max(100).optional().describe('Default 25'),
    },
    async (p) => {
      try {
        const filters: Record<string, string> = {};
        if (p.project_id) filters.project_id = `eq.${p.project_id}`;
        if (p.project_task_id) filters.project_task_id = `eq.${p.project_task_id}`;
        if (p.status) filters.status = `eq.${p.status}`;
        if (p.since) filters.started_at = `gte.${p.since}`;
        if (p.agent) filters['agent.email'] = `ilike.${p.agent}@*`;
        const rows = await restGet('agent_code_runs', {
          select: `*,agent:users${p.agent ? '!inner' : ''}(id,name,email),project:projects(id,name)`,
          filters,
          order: 'started_at.desc',
          limit: p.limit ?? 25,
        });
        return toolResult(rows);
      } catch (e) {
        return toolError(e);
      }
    },
  );
}
