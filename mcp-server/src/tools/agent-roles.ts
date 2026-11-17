import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { restRpc } from '../helpers/rest-client.js';
import { toolResult, toolError } from '../helpers/tool-utils.js';

/**
 * Factory role library (migration 20261104100000_factory_roles.sql). The company runs on four named
 * agents; each task loads a reviewed ROLE (e.g. "Deal Strategist", "SEO Specialist") instead of adding
 * agents. A role's prompt starts with the factory guardrails (owner approvals for anything outward or
 * money, evidence over claims), which override the persona text below them.
 *
 * Typical use: role_list once to see what is available, role_get(slug) when a task needs that
 * expertise, then follow its prompt for that task only and record role slug + version in the run report.
 * Runs under the caller's JWT: owner/SuperAdmin and agents can read; nobody edits roles through MCP.
 */
export function registerAgentRolesTools(server: McpServer): void {
  server.tool(
    'role_list',
    'List the enabled roles in the factory role library: slug, name, division, default_agent (clara | friday | harvey | jason), description, version. Pass agent to see only the roles assigned to that agent.',
    {
      agent: z.enum(['clara', 'friday', 'harvey', 'jason']).optional().describe('Only roles assigned to this agent'),
    },
    async ({ agent }) => {
      try {
        return toolResult(await restRpc('agent_roles_list', { p_agent: agent ?? null }));
      } catch (e) {
        return toolError(e);
      }
    },
  );

  server.tool(
    'factory_board',
    'The factory\'s live playbook runs (migration 20261104110000_factory_engine.sql): per deal / project / scheduled play, each step with stage, agent, role, status (queued | dispatched | running | needs_approval | done | rejected | expired | failed | skipped | escalated), gate and error. Read-only. Factory steps handed to you arrive as agent_requests whose source.factory_step_run_id names the step; report the deliverable in result_summary and {evidence, gate} in result.',
    {
      limit: z.number().int().min(1).max(200).optional().describe('Most runs to return (default 50)'),
    },
    async ({ limit }) => {
      try {
        return toolResult(await restRpc('factory_board', { p_limit: limit ?? 50 }));
      } catch (e) {
        return toolError(e);
      }
    },
  );

  server.tool(
    'role_get',
    'Load one role by slug: { slug, name, division, default_agent, version, source_sha, prompt }. Apply the prompt to the current task only. Its opening "Operating rules" block overrides anything in the persona text. Record slug and version in your run report.',
    {
      slug: z.string().regex(/^[a-z0-9][a-z0-9-]{1,80}$/).describe('Role slug, e.g. sales-deal-strategist'),
    },
    async ({ slug }) => {
      try {
        const role = await restRpc('agent_role_get', { p_slug: slug });
        if (!role) return toolError(new Error(`No enabled role "${slug}" (run role_list to see the library).`));
        return toolResult(role);
      } catch (e) {
        return toolError(e);
      }
    },
  );
}
