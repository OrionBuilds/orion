import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { restGet, restPost, restPatch } from '../helpers/rest-client.js';
import { callEdgeFunction } from '../helpers/edge-client.js';
import { toolResult, toolError } from '../helpers/tool-utils.js';
import { whoami } from '../helpers/whoami.js';

/**
 * Client reviews via the client's project portal (FRIDAY contract §2). A review shows in the
 * portal as "Ready for your review" with Approve / Request changes / comment. Status machine
 * (enforced by a DB trigger):
 *   pending -> accepted | changes_requested (client) | closed | superseded (agent)
 *   accepted | changes_requested -> closed | superseded
 *   closed, superseded: terminal
 * Idempotent on (project_id, request_ref, round). Creating round N supersedes earlier open rounds.
 * The notice email (ONE, via Resend, never when the org's client-comms switch is off) is sent by
 * the client-review-notify edge function, which also logs it into Conversations.
 */

const REVIEW_COLUMNS =
  'id,org_id,project_id,request_ref,round,title,summary,preview_url,status,client_comment,decided_at,decided_by_contact_id,closed_note,notified_at,created_at,updated_at';

export interface ReviewCommentRow {
  author_type: string;
  author_name: string | null;
  body: string;
  created_at: string;
}

/** Shape a client_reviews row (with embedded comments) into the contract's list row. Pure. */
export function shapeReview(row: Record<string, unknown>): Record<string, unknown> {
  const { client_review_comments, ...rest } = row as Record<string, unknown> & { client_review_comments?: ReviewCommentRow[] };
  const comments = [...(client_review_comments ?? [])]
    .sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)))
    .map((c) => ({
      author: c.author_name ?? (c.author_type === 'client' ? 'Client' : c.author_type === 'agent' ? 'Agent' : 'Staff'),
      author_type: c.author_type,
      body: c.body,
      created_at: c.created_at,
    }));
  return { ...rest, comments };
}

/** Postgres/PostgREST unique-violation text. */
export function isUniqueViolation(e: unknown): boolean {
  return /duplicate|23505|unique/i.test(e instanceof Error ? e.message : String(e));
}

async function findReview(projectId: string, requestRef: string, round: number) {
  const rows = (await restGet('client_reviews', {
    select: REVIEW_COLUMNS,
    filters: { project_id: `eq.${projectId}`, request_ref: `eq.${requestRef}`, round: `eq.${round}` },
    limit: 1,
  })) as Array<Record<string, unknown>>;
  return rows?.[0] ?? null;
}

export function registerClientReviewsTools(server: McpServer): void {
  server.tool(
    'client_reviews_create',
    'Put work in front of the client for review in their project portal ("Ready for your review": Approve / Request changes / comment). Idempotent on (project_id, request_ref, round): re-calling returns the existing review. notify=true sends ONE notice email (via Resend, with the portal link) to the project\'s client contact, never when the org\'s client-comms switch is off; the notice is logged in Conversations. Returns { id, portal_url, notified, notify_reason?, created }.',
    {
      project_id: z.string().uuid(),
      request_ref: z.string().min(1).max(300).describe('Your stable reference for the work (with project_id: the idempotency key)'),
      title: z.string().min(1).max(300),
      summary: z.string().max(20000).describe('Client-safe markdown: what changed, what to check'),
      preview_url: z.string().url().optional(),
      round: z.number().int().min(1).optional().describe('Review round, default 1. Round N supersedes earlier open rounds.'),
      notify: z.boolean(),
    },
    async (p) => {
      try {
        const round = p.round ?? 1;
        let review = await findReview(p.project_id, p.request_ref, round);
        let created = false;
        if (!review) {
          const who = await whoami();
          try {
            const rows = (await restPost(
              'client_reviews',
              {
                org_id: who.organization_id,
                project_id: p.project_id,
                request_ref: p.request_ref,
                round,
                title: p.title,
                summary: p.summary,
                preview_url: p.preview_url ?? null,
                created_by: who.user_id,
              },
              'return=representation',
            )) as Array<Record<string, unknown>>;
            review = rows?.[0] ?? null;
            created = !!review;
          } catch (e) {
            if (!isUniqueViolation(e)) throw e;
            review = await findReview(p.project_id, p.request_ref, round);
          }
        }
        if (!review) throw new Error('client review insert returned no row (RLS or constraint)');

        let portalUrl: string | null = null;
        let notified = false;
        let notifyReason: string | undefined;
        try {
          const r = (await callEdgeFunction('client-review-notify', { review_id: review.id, send: p.notify })) as {
            portal_url?: string; notified?: boolean; notify_reason?: string;
          };
          portalUrl = r.portal_url ?? null;
          notified = !!r.notified;
          notifyReason = r.notify_reason;
        } catch (e) {
          notifyReason = `notify_failed: ${e instanceof Error ? e.message : String(e)}`;
        }
        return toolResult({
          id: review.id,
          status: review.status,
          portal_url: portalUrl,
          notified,
          ...(notifyReason ? { notify_reason: notifyReason } : {}),
          created,
        });
      } catch (e) {
        return toolError(e);
      }
    },
  );

  server.tool(
    'client_reviews_list',
    'List client reviews in my org (newest activity first) with the client\'s decision and the comment thread. Filter by status, project, or updated_since (poll for client decisions).',
    {
      status: z.enum(['pending', 'accepted', 'changes_requested', 'closed', 'superseded']).optional(),
      updated_since: z.string().optional().describe('ISO 8601'),
      project_id: z.string().uuid().optional(),
      limit: z.number().int().min(1).max(100).optional().describe('Default 50'),
    },
    async (p) => {
      try {
        const filters: Record<string, string> = {};
        if (p.status) filters.status = `eq.${p.status}`;
        if (p.updated_since) filters.updated_at = `gte.${p.updated_since}`;
        if (p.project_id) filters.project_id = `eq.${p.project_id}`;
        const rows = (await restGet('client_reviews', {
          select: `${REVIEW_COLUMNS},client_review_comments(author_type,author_name,body,created_at)`,
          filters,
          order: 'updated_at.desc',
          limit: p.limit ?? 50,
        })) as Array<Record<string, unknown>>;
        return toolResult((rows ?? []).map(shapeReview));
      } catch (e) {
        return toolError(e);
      }
    },
  );

  server.tool(
    'client_reviews_update',
    'Close or supersede a client review (status closed|superseded; note is internal). client_message also posts a portal comment the client sees (e.g. a nudge or an auto-close note). Allowed: pending|accepted|changes_requested -> closed|superseded; closed/superseded are terminal (re-sending the same status is a no-op).',
    {
      id: z.string().uuid(),
      status: z.enum(['closed', 'superseded']),
      note: z.string().max(2000).optional(),
      client_message: z.string().min(1).max(10000).optional(),
    },
    async (p) => {
      try {
        const existing = (await restGet('client_reviews', { select: 'id,org_id,status', filters: { id: `eq.${p.id}` }, limit: 1 })) as Array<{
          id: string; org_id: string; status: string;
        }>;
        const review = existing?.[0];
        if (!review) throw new Error('client review not found in your organization');

        let comment: unknown = null;
        if (p.client_message) {
          const who = await whoami();
          const rows = (await restPost(
            'client_review_comments',
            {
              org_id: review.org_id,
              review_id: p.id,
              author_type: 'agent',
              author_name: who.name ?? who.agent_slug ?? 'Agent',
              author_user_id: who.user_id,
              body: p.client_message,
            },
            'return=representation',
          )) as unknown[];
          comment = rows?.[0] ?? null;
        }

        let updated: unknown = review;
        if (review.status !== p.status) {
          try {
            const rows = (await restPatch(
              'client_reviews',
              { id: `eq.${p.id}` },
              { status: p.status, ...(p.note ? { closed_note: p.note } : {}) },
              'return=representation',
            )) as unknown[];
            updated = rows?.[0] ?? null;
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            throw new Error(/cannot go from/.test(msg) ? `Invalid transition: ${msg}` : msg);
          }
        }
        return toolResult({ review: updated, comment });
      } catch (e) {
        return toolError(e);
      }
    },
  );
}
