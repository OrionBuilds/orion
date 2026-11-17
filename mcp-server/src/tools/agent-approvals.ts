import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { restGet, restPost, restPatch } from '../helpers/rest-client.js';
import { toolResult, toolError } from '../helpers/tool-utils.js';
import { whoami } from '../helpers/whoami.js';

/**
 * Agent approvals: the OS approval queue is the ONE authoritative store (FRIDAY fix contract §3;
 * decision recorded in friday-fix-contract-changes.md §D). An agent raises an ask by creating a
 * `workflow_approval_queue` row (source='agent_approval', idempotent on agent_slug + external_ref)
 * and the ask counts as raised only once that row exists. It keeps no local approval store.
 * Deliverables parked by agent_run_report.request_approval (source='agent_run') live in the same table.
 *
 * The OS, not the agent, handles the rest (DB triggers, migration 20261029200200):
 *   - ONE owner notification per ask (to draft_content.principal_user_id when set, else the org
 *     owner). Agents must not notify separately (no agent_notify_owner for an ask).
 *   - ONE expiry: requested_at + 48h, whatever the caller sends.
 *   - An expired ask becomes status 'expired' = no decision. It is NEVER a reject.
 *
 * Lifecycle:
 *   agent_approval_mirror          -> pending_approval row (+ the one notification, by trigger)
 *   agent_approval_get / _list     -> read status
 *   [owner decides in the hub, or it expires]
 *   agent_approval_pull_decisions  -> approved | rejected | expired rows not yet acked
 *   agent_approval_ack             -> the agent applied the outcome (acked_at)
 *   agent_approval_close           -> the decision happened elsewhere: superseded
 * All calls run under the calling agent's JWT (RLS is the authorization gate).
 */

const AGENT_SLUGS = ['friday', 'clara', 'harvey', 'jason'] as const;

const APPROVAL_COLUMNS =
  'id,agent_slug,external_ref,status,title,description,action_type,draft_content,requested_at,expires_at,resolved_at,resolved_by_user_id,resolution_note,acked_at';

interface WaqRow {
  id: string;
  status: string;
  agent_slug: string | null;
  external_ref: string | null;
  acked_at: string | null;
  [key: string]: unknown;
}

async function findMirrorRow(agentSlug: string, externalRef: string, select = '*'): Promise<WaqRow | null> {
  const rows = (await restGet('workflow_approval_queue', {
    select,
    filters: {
      source: 'eq.agent_approval',
      agent_slug: `eq.${agentSlug}`,
      external_ref: `eq.${externalRef}`,
    },
    limit: 1,
  })) as WaqRow[];
  return rows?.[0] ?? null;
}

export function registerAgentApprovalsTools(server: McpServer): void {
  // --- mirror: idempotent upsert of a pending hub row + one owner notification ---------------
  server.tool(
    'agent_approval_mirror',
    'Raise an approval ask in the OS approval queue (the ONE authoritative store). Idempotent on (agent_slug, external_ref): re-calling returns the existing row. The ask is raised only once this returns approval.id - retry on error. The OS sends the ONE owner notification itself (do not notify separately) and expires the ask after 48h as status "expired" (no decision, never a reject).',
    {
      agent_slug: z.enum(AGENT_SLUGS),
      external_ref: z.string().min(1).describe('The agent-local approval id (stable idempotency key)'),
      title: z.string().min(1),
      description: z.string().optional(),
      risk: z.string().optional().describe('Agent-side risk tier label (e.g. low|medium|high|critical)'),
      action_type: z.string().optional().describe('Label for the queue, default "agent_approval"'),
      facts: z.record(z.unknown()).optional().describe('Structured context for the reviewer (client, amounts, draft preview)'),
      expires_at: z.string().optional().describe('IGNORED: the OS forces one expiry, requested_at + 48h'),
      principal_user_id: z.string().optional().describe('G3: OS user id of the principal this approval belongs to. When set, the notification goes to THIS user instead of the org owner.'),
    },
    async (p) => {
      try {
        const who = await whoami();
        const now = new Date().toISOString();

        // Idempotency: (agent_slug, external_ref) has a partial unique index.
        const existing = await findMirrorRow(p.agent_slug, p.external_ref);
        if (existing) {
          return toolResult({ approval: existing, created: false, notified: false });
        }

        let approval: WaqRow | null = null;
        try {
          const rows = (await restPost(
            'workflow_approval_queue',
            {
              org_id: who.organization_id,
              source: 'agent_approval',
              agent_slug: p.agent_slug,
              external_ref: p.external_ref,
              action_type: p.action_type ?? 'agent_approval',
              title: p.title,
              description: p.description ?? null,
              status: 'pending_approval',
              // expires_at is set by the OS (48h) - the caller's value is not authoritative.
              draft_content: {
                risk: p.risk ?? null,
                facts: p.facts ?? {},
                mirrored_by: who.email ?? p.agent_slug,
                ...(p.principal_user_id ? { principal_user_id: p.principal_user_id } : {}),
              },
              requested_at: now,
            },
            'return=representation',
          )) as WaqRow[];
          approval = rows?.[0] ?? null;
        } catch (e) {
          // Lost a race on the unique index: another heartbeat mirrored it first.
          const msg = e instanceof Error ? e.message : String(e);
          if (/duplicate|23505|unique/i.test(msg)) {
            const row = await findMirrorRow(p.agent_slug, p.external_ref);
            if (row) return toolResult({ approval: row, created: false, notified: false });
          }
          throw e;
        }
        if (!approval) throw new Error('insert returned no row');

        // The ONE owner notification is inserted by the OS (AFTER INSERT trigger on the queue).
        return toolResult({ approval, created: true, notified_by: 'os' });
      } catch (e) {
        return toolError(e);
      }
    },
  );

  // --- get / list: read the authoritative state ---------------------------------------------
  server.tool(
    'agent_approval_get',
    'Read ONE approval ask by (agent_slug, external_ref): its status (pending_approval | approved | rejected | expired | superseded), expires_at, resolution, acked_at. Returns null when no such ask was raised.',
    {
      agent_slug: z.enum(AGENT_SLUGS),
      external_ref: z.string().min(1),
    },
    async ({ agent_slug, external_ref }) => {
      try {
        return toolResult(await findMirrorRow(agent_slug, external_ref, APPROVAL_COLUMNS));
      } catch (e) {
        return toolError(e);
      }
    },
  );

  server.tool(
    'agent_approvals_list',
    'List agent approval asks in the OS queue (source=agent_approval), newest first. Filter by agent_slug and status.',
    {
      agent_slug: z.enum(AGENT_SLUGS).optional(),
      status: z.enum(['pending_approval', 'approved', 'rejected', 'expired', 'superseded']).optional(),
      limit: z.number().int().min(1).max(200).optional().describe('Default 50'),
    },
    async ({ agent_slug, status, limit }) => {
      try {
        const filters: Record<string, string> = { source: 'eq.agent_approval' };
        if (agent_slug) filters.agent_slug = `eq.${agent_slug}`;
        if (status) filters.status = `eq.${status}`;
        return toolResult(await restGet('workflow_approval_queue', {
          select: APPROVAL_COLUMNS,
          filters,
          order: 'requested_at.desc',
          limit: limit ?? 50,
        }));
      } catch (e) {
        return toolError(e);
      }
    },
  );

  // --- pull: decided-but-unacked rows for this agent ----------------------------------------
  server.tool(
    'agent_approval_pull_decisions',
    'Fetch outcomes this agent has not yet applied: source=agent_approval rows for agent_slug with status in (approved, rejected, expired) and acked_at IS NULL, oldest first. "expired" means NO decision was made in 48h: never treat it as a reject (ask again or drop it). Apply each, then agent_approval_ack the ids.',
    {
      agent_slug: z.enum(AGENT_SLUGS),
      limit: z.number().int().min(1).max(100).optional().describe('Default 50'),
    },
    async ({ agent_slug, limit }) => {
      try {
        const rows = await restGet('workflow_approval_queue', {
          select:
            'id,agent_slug,external_ref,status,title,description,action_type,draft_content,resolved_at,resolved_by_user_id,resolution_note,requested_at,expires_at,acked_at',
          filters: {
            source: 'eq.agent_approval',
            agent_slug: `eq.${agent_slug}`,
            status: 'in.(approved,rejected,expired)',
            acked_at: 'is.null',
          },
          order: 'resolved_at.asc.nullsfirst',
          limit: limit ?? 50,
        });
        return toolResult(rows);
      } catch (e) {
        return toolError(e);
      }
    },
  );

  // --- ack: the agent has applied these decisions locally -----------------------------------
  server.tool(
    'agent_approval_ack',
    'Acknowledge pulled decisions: sets acked_at=now() on the given hub rows. Scoped to the CALLING agent\'s own source=agent_approval rows (agent_slug from the JWT via agent_whoami) - ids belonging to other agents or sources are ignored. Returns the rows actually acked.',
    {
      ids: z.array(z.string().uuid()).min(1).max(100),
    },
    async ({ ids }) => {
      try {
        const who = await whoami();
        if (!who.agent_slug) throw new Error('caller has no agent_slug - only agent users can ack agent_approval rows');
        const now = new Date().toISOString();
        const rows = (await restPatch(
          'workflow_approval_queue',
          {
            id: `in.(${ids.join(',')})`,
            source: 'eq.agent_approval',
            agent_slug: `eq.${who.agent_slug}`,
            acked_at: 'is.null',
          },
          { acked_at: now, updated_at: now },
          'return=representation',
        )) as WaqRow[];
        return toolResult({ acked: (rows ?? []).map((r) => r.id), acked_count: rows?.length ?? 0 });
      } catch (e) {
        return toolError(e);
      }
    },
  );

  // --- close: local decision happened first -> hub row is superseded ------------------------
  server.tool(
    'agent_approval_close',
    'Close a mirror row because the decision already happened locally (SMS, email thread, CLARA proxy): sets status=superseded + acked_at, recording the local outcome in resolution_note. Only transitions rows still pending_approval - if the hub decided first, returns superseded:false with the current row so the agent pulls and applies the hub decision instead. Best-effort marks the linked owner notification read (RLS may leave it untouched).',
    {
      agent_slug: z.enum(AGENT_SLUGS),
      external_ref: z.string().min(1),
      outcome: z.string().min(1).describe('The local decision, e.g. "approved", "rejected", "expired", or free text'),
    },
    async ({ agent_slug, external_ref, outcome }) => {
      try {
        const now = new Date().toISOString();
        const rows = (await restPatch(
          'workflow_approval_queue',
          {
            source: 'eq.agent_approval',
            agent_slug: `eq.${agent_slug}`,
            external_ref: `eq.${external_ref}`,
            status: 'eq.pending_approval',
          },
          {
            status: 'superseded',
            resolution_note: `superseded: decided locally (${outcome})`,
            resolved_at: now,
            acked_at: now,
            updated_at: now,
          },
          'return=representation',
        )) as WaqRow[];

        if (!rows || rows.length === 0) {
          // Nothing pending: either never mirrored, or the hub decided first.
          const current = await findMirrorRow(agent_slug, external_ref, 'id,status,resolution_note,resolved_at,acked_at');
          return toolResult({ superseded: false, approval: current, reason: current ? `row is ${current.status}` : 'no mirror row found' });
        }

        // Best-effort: mark the owner's notification read so the bell clears.
        // (Under agent RLS this may match 0 rows - the notification belongs to
        // the owner - which is acceptable; the queue row is the source of truth.)
        let notificationsMarkedRead = 0;
        try {
          const notifs = (await restPatch(
            'notifications',
            {
              type: 'eq.agent_approval',
              'metadata->>agent_slug': `eq.${agent_slug}`,
              'metadata->>external_ref': `eq.${external_ref}`,
            },
            { is_read: true },
            'return=representation',
          )) as Array<{ id: string }>;
          notificationsMarkedRead = notifs?.length ?? 0;
        } catch {
          // non-fatal
        }

        return toolResult({ superseded: true, approval: rows[0], notifications_marked_read: notificationsMarkedRead });
      } catch (e) {
        return toolError(e);
      }
    },
  );

  // --- generic queue access (all sources), moved here from the retired workflows module ------
  // Names are kept for existing callers; the table is the agent approval hub.
  server.tool(
    'workflow_approval_queue_list',
    'List approval-queue items (all sources: agent asks, agent runs, legacy workflow rows). Filter by status, e.g. eq.pending_approval.',
    { status: z.string().optional(), limit: z.number().optional() },
    async ({ status, limit }) => {
      try {
        const filters: Record<string, string> = {};
        if (status) filters['status'] = status;
        const data = await restGet('workflow_approval_queue', {
          filters,
          order: 'created_at.desc',
          limit: limit || 50,
        });
        return toolResult(data);
      } catch (e) {
        return toolError(e);
      }
    },
  );

  server.tool(
    'workflow_approval_queue_update',
    'Approve or reject an approval-queue item',
    {
      id: z.string(),
      status: z.string().describe('approved or rejected'),
      notes: z.string().optional().describe('Stored as resolution_note'),
    },
    async ({ id, status, notes }) => {
      try {
        // `notes` is not a column; it maps onto resolution_note (PostgREST rejected the old body).
        const body: Record<string, unknown> = { status };
        if (notes !== undefined) body.resolution_note = notes;
        const data = await restPatch('workflow_approval_queue', { id: `eq.${id}` }, body, 'return=representation');
        return toolResult(data);
      } catch (e) {
        return toolError(e);
      }
    },
  );
}
