import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { restGet, restPost, restRpc } from '../helpers/rest-client.js';
import { toolResult, toolError } from '../helpers/tool-utils.js';

/**
 * One-off agent work requests (pull model). Where agent_tasks_* is cadence-driven, this is for
 * free-form asks one agent makes of another ("FRIDAY: fix this bug, run QA on that"). The
 * receiving agent claims with a lease on its heartbeat and reports an outcome; the requester (e.g.
 * Clara) is told by the clara-request-results cron. All calls run under the caller's JWT; the
 * claim/report RPCs are bound to auth.uid(), so an agent only ever sees and settles its own work.
 * See migration 20261016020000_agent_requests_owner_thread.sql.
 *
 * Typical loop, once per heartbeat:
 *   1. agent_requests_poll()                    -> [requests claimed for me]
 *   2. do the work, then agent_request_report() -> completed | failed | needs_input
 *      needs_input: put the question in `summary`; the owner's answer arrives as a NEW request
 *      (payload.in_reply_to = the old id, the old one cancelled). payload.history carries the
 *      recent thread turns for thread-originated requests.
 */
export function registerAgentRequestsTools(server: McpServer): void {
  server.tool(
    'agent_request_create',
    'Hand a free-form piece of work to another agent (by their OS user id). Returns the queued request. Use agent_requests_list to see status.',
    {
      to_user_id: z.string().uuid(),
      org_id: z.string().uuid(),
      from_user_id: z.string().uuid().describe('Your own user id (agent_whoami.user_id)'),
      kind: z.enum(['task', 'code', 'bug', 'qa', 'research', 'content', 'other']).optional(),
      title: z.string().min(1).max(300),
      body: z.string().max(20000).describe('A complete brief: what, where, and what done looks like'),
    },
    async ({ to_user_id, org_id, from_user_id, kind, title, body }) => {
      try {
        return toolResult(await restPost('agent_requests', { to_user_id, org_id, from_user_id, kind: kind ?? 'task', title, body }));
      } catch (e) {
        return toolError(e);
      }
    },
  );

  server.tool(
    'agent_requests_poll',
    'Claim up to `limit` of MY queued requests (or ones whose lease lapsed, max 3 attempts). Atomic. Call once per heartbeat; do the work, then agent_request_report.',
    { limit: z.number().int().min(1).max(10).optional(), lease_minutes: z.number().int().min(1).max(240).optional() },
    async ({ limit, lease_minutes }) => {
      try {
        return toolResult(await restRpc('agent_requests_claim', { p_limit: limit ?? 3, p_lease_minutes: lease_minutes ?? 30 }));
      } catch (e) {
        return toolError(e);
      }
    },
  );

  server.tool(
    'agent_request_report',
    'Settle a request I hold. status: completed (summary = what was done, with links/PR numbers; ALSO for plain answers and informational replies), failed (error = why), or needs_input ONLY when you genuinely need an answer before you can act (summary = the ONE question). The owner\'s answer arrives as a NEW request with payload.in_reply_to = this id (this one is closed as cancelled). Raises if the request is not claimed by this identity, so a stale report never looks like success.',
    {
      request_id: z.string().uuid(),
      status: z.enum(['completed', 'failed', 'needs_input']),
      summary: z.string().max(1000).optional(),
      result: z.record(z.unknown()).optional(),
      error: z.string().max(1000).optional(),
    },
    async ({ request_id, status, summary, result, error }) => {
      try {
        return toolResult(await restRpc('agent_request_report', { p_id: request_id, p_status: status, p_summary: summary ?? null, p_result: result ?? null, p_error: error ?? null }));
      } catch (e) {
        return toolError(e);
      }
    },
  );

  server.tool(
    'agent_request_extend_lease',
    'Extend the lease on a request I hold while the work is still running (max 240 minutes per call). Call it on each heartbeat for long jobs so the request is not reclaimed.',
    { request_id: z.string().uuid(), minutes: z.number().int().min(1).max(240).optional() },
    async ({ request_id, minutes }) => {
      try {
        return toolResult(await restRpc('agent_request_extend_lease', { p_id: request_id, p_minutes: minutes ?? 60 }));
      } catch (e) {
        return toolError(e);
      }
    },
  );

  server.tool(
    'agent_requests_list',
    'List recent requests in my org (newest first), optionally filtered by status. Rows include payload (history, in_reply_to).',
    { status: z.enum(['queued', 'claimed', 'completed', 'failed', 'needs_input', 'cancelled']).optional(), limit: z.number().int().min(1).max(50).optional() },
    async ({ status, limit }) => {
      try {
        const params: Record<string, string> = { select: '*', order: 'created_at.desc', limit: String(limit ?? 20) };
        if (status) params.status = `eq.${status}`;
        return toolResult(await restGet('agent_requests', params));
      } catch (e) {
        return toolError(e);
      }
    },
  );

  server.tool(
    'agent_request_ask_by_phone',
    'Have Clara phone a CRM contact to get an answer you need for a request you currently hold (claimed). Parks the request as needs_input; when the call completes, the answer is appended to the request and it is re-queued for you. Only works for your own claimed request and a contact in your org with a phone number. If the call cannot get the answer, the owner is told.',
    {
      request_id: z.string().uuid(),
      contact_id: z.string().uuid(),
      question: z.string().min(3).max(600).describe('One clear question, phrased to be spoken aloud'),
      must_confirm: z.array(z.string()).max(5).optional().describe('Specific facts the call must come back with'),
    },
    async ({ request_id, contact_id, question, must_confirm }) => {
      try {
        return toolResult(await restRpc('agent_request_ask_by_phone', { p_request_id: request_id, p_contact_id: contact_id, p_question: question, p_must_confirm: must_confirm ?? [] }));
      } catch (e) {
        return toolError(e);
      }
    },
  );

  server.tool(
    'agent_notify_owner',
    'Reach the owner through Clara. priority "critical" with a category (revenue|production|security|family) texts him; critical without one emails him; "normal"/"low" wait for his morning brief. Idempotent on dedupe_key (one event notifies once). Write for a phone screen: what happened, why it matters, what you need. No emoji.',
    {
      kind: z.string().min(1).max(120).describe('Short tag, e.g. uptime.down, run.done, approval.needed'),
      priority: z.enum(['critical', 'normal', 'low']),
      text: z.string().min(1).max(4000),
      category: z.enum(['revenue', 'production', 'security', 'family']).optional(),
      dedupe_key: z.string().max(200).optional(),
    },
    async ({ kind, priority, text, category, dedupe_key }) => {
      try {
        return toolResult(await restRpc('agent_notify_owner', { p_kind: kind, p_priority: priority, p_text: text, p_category: category ?? null, p_dedupe_key: dedupe_key ?? null }));
      } catch (e) {
        return toolError(e);
      }
    },
  );

  server.tool(
    'agent_draft_client_email',
    'Draft an email to a client contact for the OWNER\'S APPROVAL. Nothing is sent: the draft appears in his approval queue and Clara sends it from her mailbox only after he approves. Idempotent on external_ref (use a stable key such as weekly:<contactId>:<isoWeek>). The contact must be active in your org and have an email address. Write plain, warm, client-safe text: no internal jargon, no prices or commitments.',
    {
      contact_id: z.string().uuid(),
      subject: z.string().min(1).max(200),
      body: z.string().min(10).max(20000),
      external_ref: z.string().min(1).max(200),
      summary: z.string().max(500).optional().describe('One line for the approval card: why this email'),
    },
    async ({ contact_id, subject, body, external_ref, summary }) => {
      try {
        return toolResult(await restRpc('agent_draft_client_email', { p_contact_id: contact_id, p_subject: subject, p_body: body, p_external_ref: external_ref, p_summary: summary ?? null }));
      } catch (e) {
        return toolError(e);
      }
    },
  );
}
