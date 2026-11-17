import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { restPost, restRpc } from '../helpers/rest-client.js';
import { toolResult, toolError } from '../helpers/tool-utils.js';
import { normaliseCallerSlug } from '../helpers/pipelineGuard.js';

/**
 * agent_usage_report — how an off-box agent (FRIDAY) gets its model-call ledger into the OS, so the
 * Agent Health dashboard can show its tokens and cost next to the calls the OS meters itself.
 *
 * Rows land in public.ai_call_usage under the caller's JWT. RLS only lets an active agent user insert
 * rows for itself, under its own slug; `external_id` (the agent's own ledger id) is unique per agent,
 * so re-sending a batch is a no-op. Cost is whatever the agent knows: the engine-reported figure, an
 * estimate, or nothing (null) — never invented here.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const usageCallSchema = z.object({
  id: z.string().min(1).max(200).describe("The agent's own ledger id for this model call (dedupe key)"),
  ts: z.string().describe('ISO timestamp of the call'),
  provider: z.string().min(1).max(40).describe('anthropic | openai | google | lmstudio | ...'),
  model: z.string().max(120).optional(),
  auth_type: z.enum(['api_key', 'subscription', 'local', 'unknown']).describe('subscription = Claude Max / ChatGPT plan via a CLI; local = self-hosted model'),
  engine: z.string().max(80).optional().describe('claude-cli | codex | lmstudio | ... (stored as source)'),
  purpose: z.string().max(120).optional(),
  input_tokens: z.number().int().min(0).optional(),
  output_tokens: z.number().int().min(0).optional(),
  cache_read_tokens: z.number().int().min(0).optional(),
  cache_write_tokens: z.number().int().min(0).optional(),
  cost_usd: z.number().min(0).nullable().optional().describe('Known cost in USD; omit or null when unknown. For subscriptions, the API-equivalent value the CLI reports.'),
  cost_source: z.enum(['reported', 'estimated']).optional(),
  run_id: z.string().optional().describe('OS agent_task_runs id when the call served a scheduled run'),
  task_ref: z.string().max(200).optional().describe("The agent's own task/run id"),
  status: z.enum(['ok', 'error']).optional(),
  duration_ms: z.number().int().min(0).optional(),
});

export type UsageCall = z.infer<typeof usageCallSchema>;

export interface UsageCaller { user_id: string; organization_id: string; agent_slug: string }

/** PURE. Map reported calls to ai_call_usage rows; drops (and reports) calls with an unusable timestamp. */
export function buildUsageRows(caller: UsageCaller, calls: UsageCall[], now = new Date()): { rows: Record<string, unknown>[]; rejected: string[] } {
  const rows: Record<string, unknown>[] = [];
  const rejected: string[] = [];
  const latest = now.getTime() + 5 * 60_000;
  for (const c of calls) {
    const t = Date.parse(c.ts);
    if (!Number.isFinite(t) || t > latest) {
      rejected.push(c.id);
      continue;
    }
    const cost = typeof c.cost_usd === 'number' ? c.cost_usd : null;
    rows.push({
      org_id: caller.organization_id,
      agent: caller.agent_slug,
      agent_user_id: caller.user_id,
      provider: c.provider.toLowerCase(),
      model: c.model?.trim() || 'unknown',
      auth_type: c.auth_type,
      source: c.engine ?? null,
      purpose: c.purpose ?? null,
      input_tokens: c.input_tokens ?? 0,
      output_tokens: c.output_tokens ?? 0,
      cache_read_tokens: c.cache_read_tokens ?? 0,
      cache_write_tokens: c.cache_write_tokens ?? 0,
      cost_usd: cost,
      cost_source: cost === null ? 'unknown' : (c.cost_source ?? 'reported'),
      run_id: c.run_id && UUID.test(c.run_id) ? c.run_id : null,
      task_ref: c.task_ref ?? null,
      status: c.status ?? 'ok',
      duration_ms: c.duration_ms ?? null,
      external_id: c.id,
      created_at: new Date(t).toISOString(),
    });
  }
  return { rows, rejected };
}

export function registerAgentUsageTools(server: McpServer): void {
  server.tool(
    'agent_usage_report',
    'Report this agent\'s model calls (tokens, cost, engine, auth type) to the OS so the Agent Health dashboard can show its usage and spend. ' +
      'Send batches of up to 500 calls; each needs your own ledger id (re-sending the same id is ignored). Agents only — rows are filed under the caller\'s own identity. ' +
      'Use auth_type "subscription" for calls through a flat-rate plan (Claude Code / Codex CLI signed in with a subscription) and pass the CLI\'s reported cost as cost_usd; it is shown as API-equivalent value, not billed spend.',
    {
      calls: z.array(usageCallSchema).min(1).max(500),
    },
    async ({ calls }) => {
      try {
        const raw = await restRpc('agent_whoami');
        const w = (Array.isArray(raw) ? raw[0] : raw) as { user_id?: string; organization_id?: string; agent_slug?: string | null } | null;
        if (!w?.user_id || !w.organization_id) throw new Error('agent_whoami failed: could not resolve caller identity');
        const slug = normaliseCallerSlug(w.agent_slug);
        if (!slug) throw new Error('agent_usage_report is for agent identities only');

        const { rows, rejected } = buildUsageRows({ user_id: w.user_id, organization_id: w.organization_id, agent_slug: slug }, calls);
        if (rows.length) {
          await restPost('ai_call_usage?on_conflict=org_id,agent,external_id', rows, 'resolution=ignore-duplicates,return=minimal');
        }
        return toolResult({ accepted: rows.length, rejected });
      } catch (e) {
        return toolError(e);
      }
    },
  );
}
