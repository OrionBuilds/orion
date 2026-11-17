import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { restGet, restPost, restPatch, restRpc } from '../helpers/rest-client.js';
import { callEdgeFunction } from '../helpers/edge-client.js';
import { toolResult, toolError } from '../helpers/tool-utils.js';

/**
 * Agent task scheduling (pull model). The OS is the source of truth for WHAT runs and WHEN;
 * agents pull due work on their own heartbeat and report results back. All calls run under the
 * calling agent's JWT, so RLS + the agent's role permissions are the only authorization gate
 * (the MCP layer adds none). See migration 20260730045337_agent_task_scheduling_backbone.sql.
 *
 * Typical loop, once per agent heartbeat:
 *   1. agent_tasks_poll()            -> { due:[...], resolved:[...] }
 *   2. for each `due` run: do the work, then agent_run_report(run_id, ...)
 *      - autonomous/owner_briefing output: report status='completed' with a result
 *      - client_visible output: report with request_approval -> parks in the OS approval queue
 *   3. for each `resolved` run (approval came back): deliver, then agent_run_deliver_confirm()
 */

/**
 * PostgREST answers a PATCH that matched zero rows with 200 and `[]`, not an error.
 *
 * So an update filtered out by RLS -- wrong identity, run already lease-swept, stale
 * run_id -- looked to the agent like a successful report. The run stayed `claimed` and
 * silently rotted to `expired_lease`, and nothing anywhere recorded that the agent had
 * tried. Treat "matched nothing" as the failure it is.
 */
function assertPatched<T>(rows: T, runId: string): T {
  if (!Array.isArray(rows) || rows.length === 0) {
    throw new Error(
      `agent_task_runs update for run ${runId} matched no rows — the run is not claimable by this identity (RLS), or the id is stale. Reported state was NOT persisted.`,
    );
  }
  return rows;
}

export function registerAgentTasksTools(server: McpServer): void {
  // --- whoami: self-discover identity so the poller never hardcodes ids ----------------------
  server.tool(
    'agent_whoami',
    'Return the calling agent\'s own OS identity from its JWT: { user_id, organization_id, email, name, role, agent_slug }. Call once at startup and cache - agent_run_report and team_message_send need org_id/sender_id.',
    {},
    async () => {
      try {
        return toolResult(await restRpc('agent_whoami'));
      } catch (e) {
        return toolError(e);
      }
    },
  );

  // --- poll: materialize + claim my due work, and learn of resolved approvals ---------------
  server.tool(
    'agent_tasks_poll',
    'Claim this agent\'s due scheduled work and learn which parked approvals have resolved. Call once per heartbeat. Atomically expires the agent\'s own stale leases, materializes+claims due schedules, advances their next_run_at, and returns { due:[runs to execute now], resolved:[runs whose approval came back, ready to deliver], server_time }. Bound to the caller\'s auth.uid() - an agent only ever sees its own work.',
    {
      limit: z.number().int().min(1).max(10).optional().describe('Max runs to claim this poll (1-10, default 5)'),
    },
    async ({ limit }) => {
      try {
        const data = await restRpc('claim_due_agent_task_runs', { p_limit: limit ?? 5 });

        // Stamp liveness here rather than in each agent's loop, so it cannot be forgotten.
        // A poll happens every heartbeat whether or not work is due, and a run row only
        // exists when work IS due — so without this, an agent whose OS auth has expired is
        // indistinguishable from one that simply has nothing to do. Absence of a heartbeat
        // is the only reliable evidence. Best-effort: never fail a poll over bookkeeping.
        const d = data as { due?: unknown[]; resolved?: unknown[] } | null;
        await restRpc('record_agent_heartbeat', {
          p_due: Array.isArray(d?.due) ? d!.due!.length : null,
          p_resolved: Array.isArray(d?.resolved) ? d!.resolved!.length : null,
        }).catch(() => {});

        return toolResult(data);
      } catch (e) {
        return toolError(e);
      }
    },
  );

  // --- report: finish a run, optionally parking client-visible output for approval ----------
  server.tool(
    'agent_run_report',
    'Report the outcome of a claimed run. For autonomous or owner-facing output, pass status="completed" (or "failed") with a result_summary. For CLIENT-VISIBLE output, additionally pass request_approval - this parks the deliverable in the OS approval queue (source=agent_run) and sets the run to awaiting_approval; a later agent_tasks_poll will surface it in `resolved` once a human approves. In shadow mode, request_approval is recorded into result but no approval row is created.',
    {
      run_id: z.string().uuid(),
      org_id: z.string().uuid().describe('The run\'s org (for the approval row when request_approval is set)'),
      status: z.enum(['completed', 'failed']),
      result_summary: z.string().max(500).optional(),
      result: z.record(z.unknown()).optional().describe('Structured output (report data, draft, links)'),
      error: z.string().optional(),
      shadow: z.boolean().optional().describe('If true, do not create an approval row even when request_approval is set (shadow-mode dry run). Default false.'),
      request_approval: z
        .object({
          title: z.string(),
          description: z.string().optional(),
          draft_content: z.record(z.unknown()).describe('The artifact to review: report html/markdown, proposed email, file ref'),
          expires_hours: z.number().int().min(1).max(720).optional().describe('IGNORED: the OS forces one expiry (48h); an expired approval is status "expired" (no decision), never a reject'),
          approver_user_ids: z.array(z.string().uuid()).optional(),
          action_type: z.string().optional().describe('Label for the queue, default "agent_deliverable"'),
        })
        .optional(),
    },
    async (p) => {
      try {
        const now = new Date().toISOString();

        if (p.request_approval && p.status === 'completed' && !p.shadow) {
          // Ordering + idempotency (codex finding #13). The old flow created the
          // approval row FIRST and patched the run afterward — so a stale run id,
          // RLS refusal, or a retry after a timeout left actionable approval rows
          // with no run pointing at them: duplicate human decisions and
          // permanently orphaned queue items. Now:
          //   1. reuse any pending approval already attached to this run (retry-safe),
          //   2. park the RUN first — assertPatched proves the run is claimable by
          //      this identity before any approval row can exist,
          //   3. create the approval, and on failure revert the run and error out.

          const existingApprovals = (await restGet('workflow_approval_queue', {
            select: 'id,status',
            filters: { agent_run_id: `eq.${p.run_id}`, status: 'eq.pending_approval' },
            limit: 1,
          })) as Array<{ id: string }>;
          let approvalId: string | null = existingApprovals?.[0]?.id ?? null;

          // Remember where the run was so a failed approval insert can put it back.
          const priorRows = (await restGet('agent_task_runs', {
            select: 'id,status',
            filters: { id: `eq.${p.run_id}` },
          })) as Array<{ id: string; status: string }>;
          const priorStatus = priorRows?.[0]?.status ?? 'claimed';

          const run = assertPatched(
            await restPatch(
              'agent_task_runs',
              { id: `eq.${p.run_id}` },
              {
                status: 'awaiting_approval',
                result_summary: p.result_summary ?? null,
                result: p.result ?? {},
                // Stamped immediately when reusing; otherwise right after creation below.
                ...(approvalId ? { approval_id: approvalId } : {}),
                finished_at: now,
                updated_at: now,
              },
              'return=representation',
            ),
            p.run_id,
          );

          if (!approvalId) {
            const exp = new Date(Date.now() + (p.request_approval.expires_hours ?? 72) * 3600_000).toISOString();
            try {
              const approvalRows = (await restPost(
                'workflow_approval_queue',
                {
                  org_id: p.org_id,
                  source: 'agent_run',
                  agent_run_id: p.run_id,
                  action_type: p.request_approval.action_type ?? 'agent_deliverable',
                  title: p.request_approval.title,
                  description: p.request_approval.description ?? null,
                  draft_content: p.request_approval.draft_content,
                  // NOT 'pending'. workflow_approval_queue_status_check allows only
                  // pending_approval|approved|rejected|expired|escalated|superseded, so
                  // 'pending' 400s -- which surfaced as the run being recorded `failed` and
                  // the deliverable dropped, with no approval row ever created. That in turn
                  // made the deliver: handlers unreachable (they only fire from `resolved`),
                  // which is why delivered_at was null on every run. See agent-approvals.ts,
                  // which had it right.
                  status: 'pending_approval',
                  expires_at: exp,
                  // Omit rather than send null. approver_user_ids is NOT NULL with a default of
                  // ARRAY[]::uuid[], and an explicit null OVERRIDES the default instead of falling
                  // back to it -- so every approval insert 400'd on the not-null constraint. The
                  // sibling in agent-approvals.ts never hit this because it simply doesn't send the
                  // key. Caught by forcing a real run end to end; the earlier status-literal fix was
                  // necessary but not sufficient, and this would have failed identically on Aug 3.
                  ...(p.request_approval.approver_user_ids?.length
                    ? { approver_user_ids: p.request_approval.approver_user_ids }
                    : {}),
                  requested_at: now,
                },
                'return=representation',
              )) as Array<{ id: string }>;
              approvalId = approvalRows?.[0]?.id ?? null;
              if (!approvalId) throw new Error('approval insert returned no row (RLS or constraint)');
            } catch (approvalErr) {
              // Un-park the run — awaiting_approval with no approval_id strands it
              // permanently (nothing can resolve it and the lease sweeper ignores it).
              await restPatch(
                'agent_task_runs',
                { id: `eq.${p.run_id}` },
                { status: priorStatus, approval_id: null, finished_at: null, updated_at: new Date().toISOString() },
              ).catch((revertErr) => {
                console.error(`[agent_run_report] failed to revert run ${p.run_id} to ${priorStatus} after approval failure:`, revertErr);
              });
              throw new Error(
                `approval row could not be created for run ${p.run_id}: ${approvalErr instanceof Error ? approvalErr.message : String(approvalErr)}. ` +
                `The run was reverted to '${priorStatus}' — retry the report.`,
              );
            }

            assertPatched(
              await restPatch(
                'agent_task_runs',
                { id: `eq.${p.run_id}` },
                { approval_id: approvalId, updated_at: new Date().toISOString() },
                'return=representation',
              ),
              p.run_id,
            );
          }

          return toolResult({
            run,
            approval_id: approvalId,
            parked: true,
            reused_existing_approval: !!existingApprovals?.[0],
          });
        }

        // No approval needed (or shadow / failed): terminal report.
        const result = p.shadow && p.request_approval
          ? { ...(p.result ?? {}), _shadow_would_request_approval: p.request_approval }
          : p.result ?? {};
        const run = assertPatched(
          await restPatch(
            'agent_task_runs',
            { id: `eq.${p.run_id}` },
            {
              status: p.status,
              result_summary: p.result_summary ?? null,
              result,
              error: p.error ?? null,
              finished_at: now,
              updated_at: now,
            },
            'return=representation',
          ),
          p.run_id,
        );
        return toolResult({ run, parked: false });
      } catch (e) {
        return toolError(e);
      }
    },
  );

  // --- deliver confirm: idempotent "I sent the approved output" -----------------------------
  server.tool(
    'agent_run_deliver_confirm',
    'Mark an approved run as delivered after the agent has sent the client-visible output. Idempotent: a no-op if already delivered (the duplicate-send guard for agent restarts between approval and send). Sets delivered_at and moves the run to completed.',
    {
      run_id: z.string().uuid(),
      delivery: z.record(z.unknown()).optional().describe('Delivery detail: channel, recipient, message id, portal url'),
    },
    async ({ run_id, delivery }) => {
      try {
        const existing = (await restGet('agent_task_runs', {
          select: 'id,delivered_at,result',
          filters: { id: `eq.${run_id}` },
        })) as Array<{ id: string; delivered_at: string | null; result: Record<string, unknown> }>;
        if (!existing?.[0]) throw new Error('run not found');
        if (existing[0].delivered_at) {
          return toolResult({ run_id, already_delivered: true });
        }
        const now = new Date().toISOString();
        const run = await restPatch(
          'agent_task_runs',
          { id: `eq.${run_id}` },
          {
            delivered_at: now,
            status: 'completed',
            result: { ...(existing[0].result ?? {}), delivery: delivery ?? null },
            updated_at: now,
          },
          'return=representation',
        );
        return toolResult({ run, delivered: true });
      } catch (e) {
        return toolError(e);
      }
    },
  );

  // --- extend lease: for long-running builds ------------------------------------------------
  server.tool(
    'agent_run_extend_lease',
    'Extend the lease on a claimed/running run so it is not swept as expired during a long build (e.g. rendering a report). Adds `minutes` from now.',
    {
      run_id: z.string().uuid(),
      minutes: z.number().int().min(1).max(60),
    },
    async ({ run_id, minutes }) => {
      try {
        const lease = new Date(Date.now() + minutes * 60_000).toISOString();
        const run = await restPatch(
          'agent_task_runs',
          { id: `eq.${run_id}` },
          { lease_expires_at: lease, status: 'running', started_at: new Date().toISOString(), updated_at: new Date().toISOString() },
          'return=representation',
        );
        return toolResult(run);
      } catch (e) {
        return toolError(e);
      }
    },
  );

  // --- read: schedules + run history (monitoring / FRIDAY orchestration) --------------------
  server.tool(
    'agent_task_schedules_list',
    'List agent task schedules (read-only). Filter by agent_slug. For monitoring and FRIDAY\'s cross-agent orchestration.',
    {
      agent_slug: z.enum(['clara', 'friday']).optional(),
      include_off: z.boolean().optional().describe('Include mode=off schedules. Default false.'),
      limit: z.number().int().optional(),
    },
    async ({ agent_slug, include_off, limit }) => {
      try {
        const filters: Record<string, string> = {};
        if (agent_slug) filters.agent_slug = `eq.${agent_slug}`;
        if (!include_off) filters.mode = `neq.off`;
        const rows = await restGet('agent_task_schedules', {
          select: '*',
          filters,
          order: 'next_run_at.asc',
          limit: limit ?? 100,
        });
        return toolResult(rows);
      } catch (e) {
        return toolError(e);
      }
    },
  );

  server.tool(
    'agent_task_runs_list',
    'List agent task run history (read-only), newest first. Filter by schedule_id, agent_slug (via join not supported here - use schedule_id), or status.',
    {
      schedule_id: z.string().uuid().optional(),
      status: z.string().optional(),
      limit: z.number().int().optional(),
    },
    async ({ schedule_id, status, limit }) => {
      try {
        const filters: Record<string, string> = {};
        if (schedule_id) filters.schedule_id = `eq.${schedule_id}`;
        if (status) filters.status = `eq.${status}`;
        const rows = await restGet('agent_task_runs', {
          select: '*',
          filters,
          order: 'created_at.desc',
          limit: limit ?? 100,
        });
        return toolResult(rows);
      } catch (e) {
        return toolError(e);
      }
    },
  );

  // --- team_message_send: the owner-facing delivery rail (Conversations > Team) --
  server.tool(
    'team_message_send',
    'Post a message to an internal team channel as this agent. This is the primary way an agent surfaces owner-facing output (briefings, digests, alerts): it appears in Conversations (Team tab, or the agent pinned thread when posted into its direct channel with the owner), and mentions/notifications light up for free. The agent must be a member of the target channel (RLS). Use team_channels_list to discover channels.',
    {
      channel_id: z.string().uuid(),
      organization_id: z.string().uuid(),
      sender_id: z.string().uuid().describe('This agent\'s own user id'),
      content: z.string(),
      mentions: z.array(z.record(z.unknown())).optional().describe('Optional @[Name](payload) mention tokens'),
    },
    async ({ channel_id, organization_id, sender_id, content, mentions }) => {
      try {
        const data = await restPost(
          'team_messages',
          {
            channel_id,
            organization_id,
            sender_id,
            content,
            mentions: mentions ?? [],
          },
          'return=representation',
        );
        return toolResult(data);
      } catch (e) {
        return toolError(e);
      }
    },
  );

  // --- deliverable_publish: render + send an approved client deliverable ---------------------
  server.tool(
    'deliverable_publish',
    'Publish a client deliverable: renders a branded portal page from html_content, emails the recipient a branded message with a deep link, and marks it delivered. Use from an agent AFTER a client-visible run is approved (agent_run flow) or for a manual send. Returns { id, portal_url, emailed }. The public page reads through a token-verified edge path only (no anon table access).',
    {
      org_id: z.string().uuid(),
      title: z.string(),
      html_content: z.string().describe('The branded portal-page body (report HTML/markdown-rendered)'),
      summary: z.string().optional(),
      recipient_email: z.string().optional().describe('Client email; if omitted, portal-only (no send)'),
      recipient_name: z.string().optional(),
      contact_id: z.string().uuid().optional(),
      project_id: z.string().uuid().optional(),
      source: z.enum(['report_run', 'ai_report', 'agent_task_run', 'manual']).optional(),
      source_ref: z.string().uuid().optional().describe('The agent_task_run id (or report id) this came from'),
      send: z.boolean().optional().describe('Set false to publish without emailing. Default true.'),
    },
    async (p) => {
      try {
        return toolResult(await callEdgeFunction('deliverable-publish', { action: 'create_and_send', ...p }));
      } catch (e) {
        return toolError(e);
      }
    },
  );

  server.tool(
    'team_channels_list',
    'List internal team channels this agent can see (RLS-scoped to channels it is a member of). Use to find the channel_id to post an owner briefing to.',
    {
      organization_id: z.string().uuid(),
      limit: z.number().int().optional(),
    },
    async ({ organization_id, limit }) => {
      try {
        const rows = await restGet('team_channels', {
          select: 'id,name,type,description,is_archived',
          filters: { organization_id: `eq.${organization_id}`, is_archived: 'eq.false' },
          order: 'name.asc',
          limit: limit ?? 100,
        });
        return toolResult(rows);
      } catch (e) {
        return toolError(e);
      }
    },
  );
}
