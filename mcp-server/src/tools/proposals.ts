import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { restGet, restPost, restPatch, restDelete } from '../helpers/rest-client.js';
import { callEdgeFunction } from '../helpers/edge-client.js';
import { toolResult, toolError } from '../helpers/tool-utils.js';

export function registerProposalsTools(server: McpServer): void {
  server.tool(
    'proposals_list',
    'List proposals with contact info. Filter by status.',
    {
      status: z.string().optional().describe('eq.draft, eq.sent, eq.accepted, eq.declined'),
      contact_id: z.string().optional(),
      order: z.string().optional(),
      limit: z.number().optional(),
    },
    async (params) => {
      try {
        const filters: Record<string, string> = {};
        if (params.status) filters['status'] = params.status;
        if (params.contact_id) filters['contact_id'] = `eq.${params.contact_id}`;
        const data = await restGet('proposals', {
          select: '*,contact:contacts(id,first_name,last_name,email,company)',
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
    'proposals_get',
    'Get proposal detail with sections, line items, activities',
    { id: z.string() },
    async ({ id }) => {
      try {
        const data = await restGet('proposals', {
          select: '*,contact:contacts(*),sections:proposal_sections(*),line_items:proposal_line_items(*),activities:proposal_activities(*)',
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
    'proposals_create',
    'Create a proposal',
    {
      title: z.string(),
      contact_id: z.string(),
      status: z.string().optional(),
      valid_until: z.string().optional(),
      organization_id: z.string().optional(),
    },
    async (params) => {
      try {
        const data = await restPost('proposals', params, 'return=representation');
        return toolResult(data);
      } catch (e) {
        return toolError(e);
      }
    },
  );

  server.tool(
    'proposals_update',
    'Update a proposal',
    {
      id: z.string(),
      title: z.string().optional(),
      status: z.string().optional(),
      valid_until: z.string().optional(),
    },
    async ({ id, ...body }) => {
      try {
        const data = await restPatch('proposals', { id: `eq.${id}` }, body, 'return=representation');
        return toolResult(data);
      } catch (e) {
        return toolError(e);
      }
    },
  );

  server.tool(
    'proposals_delete',
    'Delete a proposal',
    { id: z.string() },
    async ({ id }) => {
      try {
        await restDelete('proposals', { id: `eq.${id}` });
        return toolResult({ success: true });
      } catch (e) {
        return toolError(e);
      }
    },
  );

  server.tool(
    'contracts_list',
    'List contracts. Filter by status.',
    {
      status: z.string().optional(),
      contact_id: z.string().optional(),
      limit: z.number().optional(),
    },
    async (params) => {
      try {
        const filters: Record<string, string> = {};
        if (params.status) filters['status'] = params.status;
        if (params.contact_id) filters['contact_id'] = `eq.${params.contact_id}`;
        const data = await restGet('contracts', {
          select: '*,contact:contacts(id,first_name,last_name,email,company)',
          filters,
          order: 'created_at.desc',
          limit: params.limit || 50,
        });
        return toolResult(data);
      } catch (e) {
        return toolError(e);
      }
    },
  );

  server.tool(
    'contracts_get',
    'Get contract detail',
    { id: z.string() },
    async ({ id }) => {
      try {
        const data = await restGet('contracts', {
          select: '*,contact:contacts(*),sections:contract_sections(*)',
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
    'contracts_create',
    'Create a contract',
    {
      title: z.string(),
      contact_id: z.string(),
      proposal_id: z.string().optional(),
      status: z.string().optional(),
      organization_id: z.string().optional(),
    },
    async (params) => {
      try {
        const data = await restPost('contracts', params, 'return=representation');
        return toolResult(data);
      } catch (e) {
        return toolError(e);
      }
    },
  );

  server.tool(
    'contracts_update',
    'Update a contract',
    {
      id: z.string(),
      title: z.string().optional(),
      status: z.string().optional(),
      party_a_name: z.string().optional(),
      party_a_email: z.string().optional(),
      party_b_name: z.string().optional(),
      party_b_email: z.string().optional(),
      effective_date: z.string().optional(),
      governing_law_state: z.string().optional(),
      content: z.string().optional(),
      total_value: z.number().optional(),
      currency: z.string().optional(),
    },
    async ({ id, ...body }) => {
      try {
        const data = await restPatch('contracts', { id: `eq.${id}` }, body, 'return=representation');
        return toolResult(data);
      } catch (e) {
        return toolError(e);
      }
    },
  );

  server.tool(
    'contracts_delete',
    'Delete a contract',
    { id: z.string() },
    async ({ id }) => {
      try {
        await restDelete('contracts', { id: `eq.${id}` });
        return toolResult({ success: true });
      } catch (e) {
        return toolError(e);
      }
    },
  );

  server.tool(
    'proposal_ai_generate',
    'Generate AI-powered proposal content',
    {
      proposal_id: z.string().optional(),
      contact_id: z.string().optional(),
      instructions: z.string().optional(),
    },
    async (params) => {
      try {
        const data = await callEdgeFunction('proposal-ai-generate', params);
        return toolResult(data);
      } catch (e) {
        return toolError(e);
      }
    },
  );

  server.tool(
    'contract_ai_generate',
    'Generate AI-powered contract content',
    {
      contract_id: z.string().optional(),
      proposal_id: z.string().optional(),
      instructions: z.string().optional(),
    },
    async (params) => {
      try {
        const data = await callEdgeFunction('contract-ai-generate', params);
        return toolResult(data);
      } catch (e) {
        return toolError(e);
      }
    },
  );

  server.tool(
    'proposal_signed_pdf',
    'Generate a signed PDF for a proposal',
    { proposal_id: z.string() },
    async (params) => {
      try {
        const data = await callEdgeFunction('proposal-signed-pdf', params);
        return toolResult(data);
      } catch (e) {
        return toolError(e);
      }
    },
  );

  // ---------------------------------------------------------------------------
  // Proposal line items
  // ---------------------------------------------------------------------------

  server.tool(
    'proposal_line_items_list',
    'List line items for a proposal',
    { proposal_id: z.string(), order: z.string().optional() },
    async ({ proposal_id, order }) => {
      try {
        const data = await restGet('proposal_line_items', {
          select: '*,product:products(*)',
          filters: { proposal_id: `eq.${proposal_id}` },
          order: order || 'sort_order.asc',
        });
        return toolResult(data);
      } catch (e) {
        return toolError(e);
      }
    },
  );

  server.tool(
    'proposal_line_items_create',
    'Add a line item to a proposal',
    {
      org_id: z.string(),
      proposal_id: z.string(),
      name: z.string(),
      unit_price: z.number(),
      product_id: z.string().optional(),
      description: z.string().optional(),
      quantity: z.number().optional(),
      unit_price_max: z.number().optional(),
      discount_percent: z.number().optional(),
      sort_order: z.number().optional(),
    },
    async (params) => {
      try {
        const data = await restPost('proposal_line_items', params, 'return=representation');
        return toolResult(data);
      } catch (e) {
        return toolError(e);
      }
    },
  );

  server.tool(
    'proposal_line_items_update',
    'Update a proposal line item',
    {
      id: z.string(),
      name: z.string().optional(),
      description: z.string().optional(),
      quantity: z.number().optional(),
      unit_price: z.number().optional(),
      unit_price_max: z.number().optional(),
      discount_percent: z.number().optional(),
      sort_order: z.number().optional(),
    },
    async ({ id, ...body }) => {
      try {
        const data = await restPatch('proposal_line_items', { id: `eq.${id}` }, body, 'return=representation');
        return toolResult(data);
      } catch (e) {
        return toolError(e);
      }
    },
  );

  server.tool(
    'proposal_line_items_delete',
    'Delete a proposal line item',
    { id: z.string() },
    async ({ id }) => {
      try {
        await restDelete('proposal_line_items', { id: `eq.${id}` });
        return toolResult({ success: true });
      } catch (e) {
        return toolError(e);
      }
    },
  );

  // ---------------------------------------------------------------------------
  // Proposal sections
  // ---------------------------------------------------------------------------

  server.tool(
    'proposal_sections_list',
    'List sections for a proposal',
    { proposal_id: z.string(), order: z.string().optional() },
    async ({ proposal_id, order }) => {
      try {
        const data = await restGet('proposal_sections', {
          select: '*',
          filters: { proposal_id: `eq.${proposal_id}` },
          order: order || 'sort_order.asc',
        });
        return toolResult(data);
      } catch (e) {
        return toolError(e);
      }
    },
  );

  server.tool(
    'proposal_sections_create',
    'Add a section to a proposal',
    {
      org_id: z.string(),
      proposal_id: z.string(),
      title: z.string(),
      content: z.string(),
      section_type: z.string(),
      sort_order: z.number().optional(),
      ai_generated: z.boolean().optional(),
    },
    async (params) => {
      try {
        const data = await restPost('proposal_sections', params, 'return=representation');
        return toolResult(data);
      } catch (e) {
        return toolError(e);
      }
    },
  );

  server.tool(
    'proposal_sections_update',
    'Update a proposal section',
    {
      id: z.string(),
      title: z.string().optional(),
      content: z.string().optional(),
      section_type: z.string().optional(),
      sort_order: z.number().optional(),
      ai_generated: z.boolean().optional(),
    },
    async ({ id, ...body }) => {
      try {
        const data = await restPatch('proposal_sections', { id: `eq.${id}` }, body, 'return=representation');
        return toolResult(data);
      } catch (e) {
        return toolError(e);
      }
    },
  );

  server.tool(
    'proposal_sections_delete',
    'Delete a proposal section',
    { id: z.string() },
    async ({ id }) => {
      try {
        await restDelete('proposal_sections', { id: `eq.${id}` });
        return toolResult({ success: true });
      } catch (e) {
        return toolError(e);
      }
    },
  );

  // ---------------------------------------------------------------------------
  // Proposal duplicate / archive
  // ---------------------------------------------------------------------------

  server.tool(
    'proposal_duplicate',
    'Duplicate a proposal along with its sections, line items, and meeting contexts. Creates a "Copy of ..." draft.',
    { id: z.string() },
    async ({ id }) => {
      try {
        const original = (await restGet('proposals', {
          select: '*,sections:proposal_sections(*),line_items:proposal_line_items(*),meeting_contexts:proposal_meeting_contexts(*)',
          filters: { id: `eq.${id}` },
          accept: 'application/vnd.pgrst.object+json',
        })) as any;

        if (!original) throw new Error('Proposal not found');

        const created = (await restPost(
          'proposals',
          {
            org_id: original.org_id,
            contact_id: original.contact_id,
            opportunity_id: original.opportunity_id ?? null,
            title: `Copy of ${original.title}`,
            content: original.content ?? '',
            summary: original.summary ?? null,
            total_value: original.total_value ?? 0,
            currency: original.currency ?? 'USD',
            valid_until: null,
            created_by: original.created_by ?? null,
            assigned_user_id: original.assigned_user_id ?? null,
            template_id: original.template_id ?? null,
            ai_context: original.ai_context ?? {},
            status: 'draft',
          },
          'return=representation',
        )) as any[];

        const newProposal = Array.isArray(created) ? created[0] : created;
        const newId = newProposal.id;

        if (Array.isArray(original.sections) && original.sections.length > 0) {
          await restPost(
            'proposal_sections',
            original.sections.map((s: any) => ({
              org_id: original.org_id,
              proposal_id: newId,
              title: s.title,
              content: s.content,
              section_type: s.section_type,
              sort_order: s.sort_order,
              ai_generated: s.ai_generated,
            })),
          );
        }

        if (Array.isArray(original.line_items) && original.line_items.length > 0) {
          await restPost(
            'proposal_line_items',
            original.line_items.map((li: any) => ({
              org_id: original.org_id,
              proposal_id: newId,
              product_id: li.product_id ?? null,
              name: li.name,
              description: li.description ?? null,
              quantity: li.quantity,
              unit_price: li.unit_price,
              unit_price_max: li.unit_price_max ?? null,
              discount_percent: li.discount_percent,
              sort_order: li.sort_order,
            })),
          );
        }

        if (Array.isArray(original.meeting_contexts) && original.meeting_contexts.length > 0) {
          await restPost(
            'proposal_meeting_contexts',
            original.meeting_contexts.map((mc: any) => ({
              org_id: original.org_id,
              proposal_id: newId,
              meeting_transcription_id: mc.meeting_transcription_id,
              included_in_generation: mc.included_in_generation,
            })),
          );
        }

        return toolResult(newProposal);
      } catch (e) {
        return toolError(e);
      }
    },
  );

  server.tool(
    'proposal_archive',
    'Soft-archive a proposal (sets archived_at). Preferred over proposals_delete, which hard-deletes.',
    { id: z.string() },
    async ({ id }) => {
      try {
        const data = await restPatch(
          'proposals',
          { id: `eq.${id}` },
          { archived_at: new Date().toISOString() },
          'return=representation',
        );
        return toolResult(data);
      } catch (e) {
        return toolError(e);
      }
    },
  );

  server.tool(
    'proposal_unarchive',
    'Un-archive a proposal (clears archived_at)',
    { id: z.string() },
    async ({ id }) => {
      try {
        const data = await restPatch(
          'proposals',
          { id: `eq.${id}` },
          { archived_at: null },
          'return=representation',
        );
        return toolResult(data);
      } catch (e) {
        return toolError(e);
      }
    },
  );

  // ---------------------------------------------------------------------------
  // Proposal meeting contexts
  // ---------------------------------------------------------------------------

  server.tool(
    'proposal_link_meeting',
    'Link a meeting transcription to a proposal as generation context',
    {
      org_id: z.string(),
      proposal_id: z.string(),
      meeting_transcription_id: z.string(),
      included_in_generation: z.boolean().optional(),
    },
    async (params) => {
      try {
        const data = await restPost('proposal_meeting_contexts', params, 'return=representation');
        return toolResult(data);
      } catch (e) {
        return toolError(e);
      }
    },
  );

  server.tool(
    'proposal_unlink_meeting',
    'Unlink a meeting transcription from a proposal',
    { proposal_id: z.string(), meeting_transcription_id: z.string() },
    async ({ proposal_id, meeting_transcription_id }) => {
      try {
        await restDelete('proposal_meeting_contexts', {
          proposal_id: `eq.${proposal_id}`,
          meeting_transcription_id: `eq.${meeting_transcription_id}`,
        });
        return toolResult({ success: true });
      } catch (e) {
        return toolError(e);
      }
    },
  );

  // ---------------------------------------------------------------------------
  // Proposal templates
  // ---------------------------------------------------------------------------

  server.tool(
    'proposal_templates_list',
    'List proposal templates. Filter by category.',
    { category: z.string().optional(), order: z.string().optional() },
    async ({ category, order }) => {
      try {
        const filters: Record<string, string> = {};
        if (category) filters['category'] = `eq.${category}`;
        const data = await restGet('proposal_templates', {
          select: '*',
          filters,
          order: order || 'name.asc',
        });
        return toolResult(data);
      } catch (e) {
        return toolError(e);
      }
    },
  );

  server.tool(
    'proposal_templates_get',
    'Get a proposal template by id',
    { id: z.string() },
    async ({ id }) => {
      try {
        const data = await restGet('proposal_templates', {
          select: '*',
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
    'proposal_templates_create',
    'Create a proposal template',
    {
      org_id: z.string(),
      name: z.string(),
      content: z.string(),
      description: z.string().optional(),
      category: z.string().optional(),
      is_default: z.boolean().optional(),
      variables: z.array(z.unknown()).optional(),
      created_by: z.string().optional(),
    },
    async (params) => {
      try {
        const data = await restPost('proposal_templates', params, 'return=representation');
        return toolResult(data);
      } catch (e) {
        return toolError(e);
      }
    },
  );

  server.tool(
    'proposal_templates_update',
    'Update a proposal template',
    {
      id: z.string(),
      name: z.string().optional(),
      description: z.string().optional(),
      content: z.string().optional(),
      category: z.string().optional(),
      is_default: z.boolean().optional(),
      variables: z.array(z.unknown()).optional(),
    },
    async ({ id, ...body }) => {
      try {
        const data = await restPatch('proposal_templates', { id: `eq.${id}` }, body, 'return=representation');
        return toolResult(data);
      } catch (e) {
        return toolError(e);
      }
    },
  );

  server.tool(
    'proposal_templates_delete',
    'Delete a proposal template',
    { id: z.string() },
    async ({ id }) => {
      try {
        await restDelete('proposal_templates', { id: `eq.${id}` });
        return toolResult({ success: true });
      } catch (e) {
        return toolError(e);
      }
    },
  );

  // ---------------------------------------------------------------------------
  // Proposal signature status + comments
  // ---------------------------------------------------------------------------

  server.tool(
    'proposal_signature_status_get',
    'Get signature requests for a proposal, most recent first',
    { proposal_id: z.string() },
    async ({ proposal_id }) => {
      try {
        const data = await restGet('proposal_signature_requests', {
          select: '*',
          filters: { proposal_id: `eq.${proposal_id}` },
          order: 'created_at.desc',
        });
        return toolResult(data);
      } catch (e) {
        return toolError(e);
      }
    },
  );

  server.tool(
    'proposal_comments_list',
    'List comments for a proposal',
    { proposal_id: z.string(), order: z.string().optional() },
    async ({ proposal_id, order }) => {
      try {
        const data = await restGet('proposal_comments', {
          select: '*,user:users(*)',
          filters: { proposal_id: `eq.${proposal_id}` },
          order: order || 'created_at.asc',
        });
        return toolResult(data);
      } catch (e) {
        return toolError(e);
      }
    },
  );

  server.tool(
    'proposal_comments_create',
    'Add a comment to a proposal',
    {
      org_id: z.string(),
      proposal_id: z.string(),
      content: z.string(),
      user_id: z.string().optional(),
      is_client_comment: z.boolean().optional(),
      client_name: z.string().optional(),
    },
    async (params) => {
      try {
        const data = await restPost('proposal_comments', params, 'return=representation');
        return toolResult(data);
      } catch (e) {
        return toolError(e);
      }
    },
  );

  // ===========================================================================
  // Contracts
  // ===========================================================================

  // ---------------------------------------------------------------------------
  // Contract sections
  // ---------------------------------------------------------------------------

  server.tool(
    'contract_sections_list',
    'List sections for a contract',
    { contract_id: z.string(), order: z.string().optional() },
    async ({ contract_id, order }) => {
      try {
        const data = await restGet('contract_sections', {
          select: '*',
          filters: { contract_id: `eq.${contract_id}` },
          order: order || 'sort_order.asc',
        });
        return toolResult(data);
      } catch (e) {
        return toolError(e);
      }
    },
  );

  server.tool(
    'contract_sections_create',
    'Add a section to a contract',
    {
      org_id: z.string(),
      contract_id: z.string(),
      title: z.string(),
      content: z.string(),
      section_type: z.string(),
      sort_order: z.number().optional(),
      annotation: z.string().optional(),
      ai_generated: z.boolean().optional(),
    },
    async (params) => {
      try {
        const data = await restPost('contract_sections', params, 'return=representation');
        return toolResult(data);
      } catch (e) {
        return toolError(e);
      }
    },
  );

  server.tool(
    'contract_sections_update',
    'Update a contract section',
    {
      id: z.string(),
      title: z.string().optional(),
      content: z.string().optional(),
      section_type: z.string().optional(),
      sort_order: z.number().optional(),
      annotation: z.string().optional(),
      ai_generated: z.boolean().optional(),
    },
    async ({ id, ...body }) => {
      try {
        const data = await restPatch('contract_sections', { id: `eq.${id}` }, body, 'return=representation');
        return toolResult(data);
      } catch (e) {
        return toolError(e);
      }
    },
  );

  server.tool(
    'contract_sections_delete',
    'Delete a contract section',
    { id: z.string() },
    async ({ id }) => {
      try {
        await restDelete('contract_sections', { id: `eq.${id}` });
        return toolResult({ success: true });
      } catch (e) {
        return toolError(e);
      }
    },
  );

  // ---------------------------------------------------------------------------
  // Contract meeting contexts
  // ---------------------------------------------------------------------------

  server.tool(
    'contract_link_meeting',
    'Link a meeting transcription to a contract (idempotent; ignores duplicates)',
    {
      org_id: z.string(),
      contract_id: z.string(),
      meeting_transcription_id: z.string(),
    },
    async (params) => {
      try {
        const data = await restPost('contract_meeting_contexts', params, 'return=representation');
        return toolResult(data);
      } catch (e) {
        // 23505 = already linked; treat as idempotent success.
        const msg = e instanceof Error ? e.message : String(e);
        if (msg.includes('23505') || msg.includes('duplicate')) {
          return toolResult({ success: true, already_linked: true });
        }
        return toolError(e);
      }
    },
  );

  server.tool(
    'contract_unlink_meeting',
    'Unlink a meeting transcription from a contract',
    { contract_id: z.string(), meeting_transcription_id: z.string() },
    async ({ contract_id, meeting_transcription_id }) => {
      try {
        await restDelete('contract_meeting_contexts', {
          contract_id: `eq.${contract_id}`,
          meeting_transcription_id: `eq.${meeting_transcription_id}`,
        });
        return toolResult({ success: true });
      } catch (e) {
        return toolError(e);
      }
    },
  );

  // ---------------------------------------------------------------------------
  // Contract archive / signature status / comments
  // ---------------------------------------------------------------------------

  server.tool(
    'contract_archive',
    'Soft-archive a contract (sets archived_at)',
    { id: z.string() },
    async ({ id }) => {
      try {
        const data = await restPatch(
          'contracts',
          { id: `eq.${id}` },
          { archived_at: new Date().toISOString() },
          'return=representation',
        );
        return toolResult(data);
      } catch (e) {
        return toolError(e);
      }
    },
  );

  server.tool(
    'contract_unarchive',
    'Un-archive a contract (clears archived_at)',
    { id: z.string() },
    async ({ id }) => {
      try {
        const data = await restPatch(
          'contracts',
          { id: `eq.${id}` },
          { archived_at: null },
          'return=representation',
        );
        return toolResult(data);
      } catch (e) {
        return toolError(e);
      }
    },
  );

  server.tool(
    'contract_signature_status_get',
    'Get signature requests for a contract, most recent first',
    { contract_id: z.string() },
    async ({ contract_id }) => {
      try {
        const data = await restGet('contract_signature_requests', {
          select: '*',
          filters: { contract_id: `eq.${contract_id}` },
          order: 'created_at.desc',
        });
        return toolResult(data);
      } catch (e) {
        return toolError(e);
      }
    },
  );

  server.tool(
    'contract_comments_list',
    'List comments for a contract',
    { contract_id: z.string(), order: z.string().optional() },
    async ({ contract_id, order }) => {
      try {
        const data = await restGet('contract_comments', {
          select: '*,user:users(*)',
          filters: { contract_id: `eq.${contract_id}` },
          order: order || 'created_at.asc',
        });
        return toolResult(data);
      } catch (e) {
        return toolError(e);
      }
    },
  );

  server.tool(
    'contract_comments_create',
    'Add a comment to a contract',
    {
      org_id: z.string(),
      contract_id: z.string(),
      content: z.string(),
      user_id: z.string().optional(),
      is_client_comment: z.boolean().optional(),
      client_name: z.string().optional(),
    },
    async (params) => {
      try {
        const data = await restPost('contract_comments', params, 'return=representation');
        return toolResult(data);
      } catch (e) {
        return toolError(e);
      }
    },
  );

  // ── E-signature (signature-send edge function) ──────────────────────────
  server.tool(
    'proposal_send_for_signature',
    'Freeze a proposal and email it to a signer for e-signature. Sets status sent / signature_status pending_signature and returns the signing URL.',
    {
      document_id: z.string().describe('Proposal UUID'),
      signer_name: z.string().optional(),
      signer_email: z.string().describe('Signer email address'),
      expires_in_days: z.number().optional().describe('Default 14'),
    },
    async (params) => {
      try {
        const data = await callEdgeFunction('signature-send', { document_type: 'proposal', ...params });
        return toolResult(data);
      } catch (e) {
        return toolError(e);
      }
    },
  );

  server.tool(
    'proposal_signature_resend',
    'Regenerate the token and re-email the current proposal signature request.',
    { document_id: z.string() },
    async ({ document_id }) => {
      try {
        const data = await callEdgeFunction('signature-send', { document_type: 'proposal', document_id, mode: 'resend' });
        return toolResult(data);
      } catch (e) {
        return toolError(e);
      }
    },
  );

  server.tool(
    'proposal_signature_void',
    'Void the active proposal signature request (unlocks the proposal for edits).',
    { document_id: z.string() },
    async ({ document_id }) => {
      try {
        const data = await callEdgeFunction('signature-send', { document_type: 'proposal', document_id, mode: 'void' });
        return toolResult(data);
      } catch (e) {
        return toolError(e);
      }
    },
  );

  server.tool(
    'contract_send_for_signature',
    'Freeze a contract and email it to a signer for e-signature. Sets signature_status pending_signature and returns the signing URL.',
    {
      document_id: z.string().describe('Contract UUID'),
      signer_name: z.string().optional(),
      signer_email: z.string().describe('Signer email address'),
      expires_in_days: z.number().optional().describe('Default 14'),
    },
    async (params) => {
      try {
        const data = await callEdgeFunction('signature-send', { document_type: 'contract', ...params });
        return toolResult(data);
      } catch (e) {
        return toolError(e);
      }
    },
  );

  server.tool(
    'contract_signature_resend',
    'Regenerate the token and re-email the current contract signature request.',
    { document_id: z.string() },
    async ({ document_id }) => {
      try {
        const data = await callEdgeFunction('signature-send', { document_type: 'contract', document_id, mode: 'resend' });
        return toolResult(data);
      } catch (e) {
        return toolError(e);
      }
    },
  );

  server.tool(
    'contract_signature_void',
    'Void the active contract signature request (unlocks the contract for edits).',
    { document_id: z.string() },
    async ({ document_id }) => {
      try {
        const data = await callEdgeFunction('signature-send', { document_type: 'contract', document_id, mode: 'void' });
        return toolResult(data);
      } catch (e) {
        return toolError(e);
      }
    },
  );
}
