// Compliance tools — suppressions, consents and tracked-link slugs.
//
// Split out of the retired prospects.ts (Prospect Intelligence Engine, phase-1 retirement):
// these stay because every outbound email/SMS path depends on them, not just prospecting.
// `suppressions` / `contact_consents` back the unsubscribe + bounce/complaint flows
// (email-unsubscribe, resend-webhook); `tracked_links` predates the prospecting engine.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { randomBytes } from 'node:crypto';
import { restGet, restPost, restDelete, restRpc } from '../helpers/rest-client.js';
import { toolResult, toolError } from '../helpers/tool-utils.js';
import { resolveCaller } from '../helpers/pipelineGuard.js';

// ── Shared bits ───────────────────────────────────────────────────────────────────────────

const jsonb = z.record(z.unknown());
const uuid = z.string().uuid();

async function callerOrg(explicit?: string): Promise<string> {
  if (explicit) return explicit;
  const caller = await resolveCaller();
  return caller.organization_id;
}

function one<T = Record<string, unknown>>(data: unknown): T | null {
  if (Array.isArray(data)) return (data[0] as T) ?? null;
  return (data as T) ?? null;
}

function eq(v: string): string {
  return `eq.${v}`;
}

// ── Registration ──────────────────────────────────────────────────────────────────────────

export function registerComplianceTools(server: McpServer): void {
  // ── Suppressions & consents ─────────────────────────────────────────────────────────────
  server.tool(
    'suppressions_check',
    'Is this recipient suppressed on this channel? Unions suppressions, dnc_numbers and contacts.dnc. Call before every send.',
    { channel: z.enum(['email', 'sms', 'voice', 'all']).optional(), email: z.string().optional(), phone: z.string().optional(), domain: z.string().optional(), company_id: uuid.optional(), contact_id: uuid.optional() },
    async (p) => {
      try {
        return toolResult(await restRpc('suppression_check', {
          p_channel: p.channel ?? 'all', p_email: p.email ?? null, p_phone: p.phone ?? null, p_domain: p.domain ?? null,
          p_company_id: p.company_id ?? null, p_contact_id: p.contact_id ?? null,
        }));
      } catch (e) {
        return toolError(e);
      }
    },
  );

  server.tool(
    'suppressions_add',
    'Add a suppression (email, phone, domain, company or contact) with a reason; phones also land in dnc_numbers',
    {
      kind: z.enum(['email', 'phone', 'domain', 'company', 'contact']), value: z.string(),
      channel: z.enum(['email', 'sms', 'voice', 'all']).optional(),
      reason: z.enum(['unsubscribe', 'stop_keyword', 'bounce_hard', 'complaint', 'manual', 'dnc_import', 'legal', 'customer', 'competitor', 'partner', 'mega_domain', 'role_address']),
      source: z.enum(['office', 'clara', 'twilio', 'resend', 'import', 'dnc_numbers', 'reply', 'link', 'system']).optional(),
      company_id: uuid.optional(), evidence: jsonb.optional(), expires_at: z.string().optional(), notes: z.string().optional(), organization_id: z.string().optional(),
    },
    async (p) => {
      try {
        const org = await callerOrg(p.organization_id);
        const caller = await resolveCaller();
        const { organization_id: _o, channel, source, ...body } = p;
        const data = await restPost('suppressions', {
          org_id: org, ...body, channel: channel ?? 'all', source: source ?? (caller.agent_slug ? 'clara' : 'office'), created_by: caller.user_id,
        }, 'return=representation,resolution=ignore-duplicates');
        return toolResult({ suppression: one(data), action: Array.isArray(data) && data.length ? 'inserted' : 'exists' });
      } catch (e) {
        return toolError(e);
      }
    },
  );

  server.tool(
    'suppressions_list',
    'List suppressions (filter by kind, channel, reason, or search the value)',
    { kind: z.string().optional(), channel: z.string().optional(), reason: z.string().optional(), q: z.string().optional(), limit: z.number().int().min(1).max(1000).optional(), offset: z.number().int().min(0).optional(), organization_id: z.string().optional() },
    async ({ kind, channel, reason, q, limit, offset, organization_id }) => {
      try {
        const org = await callerOrg(organization_id);
        const filters: Record<string, string> = { org_id: eq(org) };
        if (kind) filters.kind = eq(kind);
        if (channel) filters.channel = eq(channel);
        if (reason) filters.reason = eq(reason);
        if (q) filters.value = `ilike.*${q}*`;
        return toolResult(await restGet('suppressions', { filters, order: 'created_at.desc', limit: limit ?? 100, offset }));
      } catch (e) {
        return toolError(e);
      }
    },
  );

  server.tool(
    'suppressions_remove',
    'Remove a suppression by id (owner action; Clara is not allowed this tool)',
    { id: uuid },
    async ({ id }) => {
      try {
        await restDelete('suppressions', { id: eq(id) });
        return toolResult({ removed: id });
      } catch (e) {
        return toolError(e);
      }
    },
  );

  server.tool(
    'consents_add',
    'Record consent for SMS / voice / email with its basis and evidence (§38). SMS and calls require express_written, express_oral or inbound_contact.',
    {
      channel: z.enum(['sms', 'voice', 'email']), basis: z.enum(['express_written', 'express_oral', 'inbound_contact', 'ebr', 'b2b_email']),
      source: z.enum(['form', 'inbound_sms', 'inbound_call', 'call_transcript', 'office_ui', 'import']),
      contact_id: uuid.optional(), person_id: uuid.optional(), company_id: uuid.optional(), phone: z.string().optional(),
      evidence: jsonb.optional(), captured_at: z.string().optional(), expires_at: z.string().optional(), organization_id: z.string().optional(),
    },
    async (p) => {
      try {
        if (!p.contact_id && !p.person_id && !p.phone) return toolError(new Error('contact_id, person_id or phone required'));
        const org = await callerOrg(p.organization_id);
        const { organization_id: _o, phone, ...body } = p;
        const phone_key = phone ? phone.replace(/\D/g, '').replace(/^1(\d{10})$/, '$1') : undefined;
        return toolResult(one(await restPost('contact_consents', { org_id: org, ...body, phone_key }, 'return=representation')));
      } catch (e) {
        return toolError(e);
      }
    },
  );

  server.tool(
    'consents_list',
    'Active consents for a contact, person or phone (SMS/voice sends require one with a sufficient basis)',
    { contact_id: uuid.optional(), person_id: uuid.optional(), phone: z.string().optional(), channel: z.enum(['sms', 'voice', 'email']).optional(), organization_id: z.string().optional() },
    async ({ contact_id, person_id, phone, channel, organization_id }) => {
      try {
        const org = await callerOrg(organization_id);
        const filters: Record<string, string> = { org_id: eq(org), revoked_at: 'is.null' };
        const ors: string[] = [];
        if (contact_id) ors.push(`contact_id.eq.${contact_id}`);
        if (person_id) ors.push(`person_id.eq.${person_id}`);
        if (phone) ors.push(`phone_key.eq.${phone.replace(/\D/g, '').replace(/^1(\d{10})$/, '$1')}`);
        if (!ors.length) return toolError(new Error('contact_id, person_id or phone required'));
        filters.or = `(${ors.join(',')})`;
        if (channel) filters.channel = eq(channel);
        const rows = ((await restGet('contact_consents', { filters, order: 'captured_at.desc' })) ?? []) as Array<{ channel: string; basis: string; expires_at: string | null }>;
        const now = Date.now();
        const live = rows.filter((r) => !r.expires_at || Date.parse(r.expires_at) > now);
        const sufficient = (c: string) => live.some((r) => r.channel === c && (c === 'email' || ['express_written', 'express_oral', 'inbound_contact'].includes(r.basis)));
        return toolResult({ consents: live, sms_ok: sufficient('sms'), voice_ok: sufficient('voice'), email_ok: sufficient('email') });
      } catch (e) {
        return toolError(e);
      }
    },
  );

  // ── Tracked links (PR 13 — per-step unsubscribe slugs) ─────────────────────────────────────
  // `tracked_links` predates the prospecting engine (the `trigger_link_clicked` workflow trigger —
  // see its own migration's doc comment); this is the first WRITER of it exposed as an MCP tool.
  // The sequence runner (PR 14) mints one row per enrollment×step whose destination is the step's
  // real link (a booking page, say) OR — for the unsubscribe footer link specifically — an opaque
  // slug with no real destination_url at all: `metadata.kind:"unsubscribe"` carries the
  // enrollment_id/company_id/email the NEW email-unsubscribe edge fn needs, and that fn is hit
  // directly (never through link-redirect's generic 302), so destination_url is set to a harmless
  // same-site anchor (link-redirect's own `is_active`/`expires_at` contract still applies if
  // anything else ever lists this row, but nothing should ever actually 302 through it).
  server.tool(
    'tracked_links_create',
    'Mint a short tracked-link slug (crypto-random, 12 hex chars). destination_url is required by the table even for an unsubscribe-only link (pass the org\'s own site as a harmless placeholder) — the unsubscribe flow is served by a SEPARATE edge fn (email-unsubscribe) hit directly by slug, not by link-redirect.',
    {
      destination_url: z.string(), name: z.string().optional(), contact_id: uuid.optional(),
      metadata: jsonb.optional(), expires_at: z.string().optional(), organization_id: z.string().optional(),
    },
    async (p) => {
      try {
        const org = await callerOrg(p.organization_id);
        const caller = await resolveCaller();
        const slug = randomBytes(6).toString('hex');
        const { organization_id: _o, ...body } = p;
        const data = one(await restPost('tracked_links', { org_id: org, ...body, slug, created_by: caller.user_id }, 'return=representation'));
        return toolResult({ link: data, slug });
      } catch (e) {
        return toolError(e);
      }
    },
  );
}
