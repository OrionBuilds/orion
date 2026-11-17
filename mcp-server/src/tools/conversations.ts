import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { restGet, restPost, restPatch, restDelete, restRpc } from '../helpers/rest-client.js';
import { callEdgeFunction } from '../helpers/edge-client.js';
import { toolResult, toolError } from '../helpers/tool-utils.js';
import { whoami } from '../helpers/whoami.js';

export function registerConversationsTools(server: McpServer): void {
  server.tool(
    'conversations_list',
    'List conversations with contact and assigned user. Filter by status, channel (sms, email, voice, webchat), assigned_to (a user id).',
    {
      status: z.string().optional().describe('e.g. eq.open, eq.closed'),
      channel: z.string().optional().describe('e.g. eq.email, eq.sms, eq.voice, eq.webchat'),
      assigned_to: z.string().optional(),
      order: z.string().optional(),
      limit: z.number().optional(),
      offset: z.number().optional(),
    },
    async (params) => {
      try {
        const filters: Record<string, string> = {};
        if (params.status) filters['status'] = params.status;
        if (params.channel) filters['channel'] = params.channel;
        // The column is assigned_user_id; `assigned_to` is kept as the tool's parameter name.
        if (params.assigned_to) filters['assigned_user_id'] = `eq.${params.assigned_to}`;
        const data = await restGet('conversations', {
          select: '*,contact:contacts(id,first_name,last_name,email),assigned_user:users!assigned_user_id(id,name)',
          filters,
          order: params.order || 'last_message_at.desc.nullslast',
          limit: params.limit || 50,
          offset: params.offset,
        });
        return toolResult(data);
      } catch (e) {
        return toolError(e);
      }
    },
  );

  server.tool(
    'conversations_get',
    'Get a conversation by ID with messages',
    { id: z.string() },
    async ({ id }) => {
      try {
        const data = await restGet('conversations', {
          select: '*,contact:contacts(*),messages(*)',
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
    'conversations_create',
    'Create a new conversation',
    {
      contact_id: z.string().optional(),
      channel: z.enum(['email', 'sms', 'voice', 'webchat', 'phone', 'internal', 'google_chat']).describe("'phone' is accepted as an alias for 'voice'"),
      subject: z.string().optional(),
      status: z.string().optional(),
      assigned_to: z.string().optional(),
      organization_id: z.string().optional(),
    },
    async ({ assigned_to, channel, subject: _subject, ...rest }) => {
      try {
        // Real columns: assigned_user_id (not assigned_to); there is no `subject` column.
        // organization_id and contact_id are NOT NULL: default the org from the caller.
        if (!rest.contact_id) throw new Error('contact_id is required (a conversation belongs to a contact)');
        const organization_id = rest.organization_id ?? (await whoami()).organization_id;
        const data = await restPost('conversations', {
          ...rest,
          organization_id,
          channel: channel === 'phone' ? 'voice' : channel,
          ...(assigned_to ? { assigned_user_id: assigned_to } : {}),
        }, 'return=representation');
        return toolResult(data);
      } catch (e) {
        return toolError(e);
      }
    },
  );

  server.tool(
    'conversations_update',
    'Update conversation status, assignment, or subject',
    {
      id: z.string(),
      status: z.string().optional(),
      assigned_to: z.string().optional(),
      subject: z.string().optional(),
    },
    async ({ id, assigned_to, subject: _subject, ...rest }) => {
      try {
        const body = { ...rest, ...(assigned_to ? { assigned_user_id: assigned_to } : {}) };
        const data = await restPatch('conversations', { id: `eq.${id}` }, body, 'return=representation');
        return toolResult(data);
      } catch (e) {
        return toolError(e);
      }
    },
  );

  server.tool(
    'conversations_delete',
    'Delete a conversation',
    { id: z.string() },
    async ({ id }) => {
      try {
        await restDelete('conversations', { id: `eq.${id}` });
        return toolResult({ success: true });
      } catch (e) {
        return toolError(e);
      }
    },
  );

  server.tool(
    'messages_list',
    'List messages in a conversation',
    {
      conversation_id: z.string(),
      order: z.string().optional(),
      limit: z.number().optional(),
    },
    async ({ conversation_id, order, limit }) => {
      try {
        const data = await restGet('messages', {
          filters: { conversation_id: `eq.${conversation_id}` },
          order: order || 'created_at.asc',
          limit: limit || 100,
        });
        return toolResult(data);
      } catch (e) {
        return toolError(e);
      }
    },
  );

  server.tool(
    'messages_create',
    'Record a message on a conversation (a note of something said or sent; this does NOT deliver SMS/email - use send_sms / the email tools for that). organization_id and contact_id are taken from the conversation.',
    {
      conversation_id: z.string(),
      body: z.string(),
      sender_name: z.string().optional(),
      sender_id: z.string().optional().describe('Stored as sender_identifier (user id, phone number or email)'),
      channel: z.enum(['sms', 'email', 'voice', 'webchat', 'phone']).optional().describe("Defaults to the conversation's channel; 'phone' is an alias for 'voice'"),
      direction: z.enum(['inbound', 'outbound', 'system']).optional(),
      message_type: z.string().optional().describe('text (default), call_event, note, ...'),
    },
    async ({ conversation_id, body, sender_name, sender_id, channel, direction, message_type }) => {
      try {
        // messages needs organization_id + contact_id (both NOT NULL); the conversation has them.
        const conv = (await restGet('conversations', { select: 'organization_id,contact_id,channel', filters: { id: `eq.${conversation_id}` }, limit: 1 })) as
          { organization_id: string; contact_id: string; channel: string | null }[];
        if (!conv?.[0]) throw new Error(`conversation ${conversation_id} not found (or not visible to you)`);
        const ch = channel === 'phone' ? 'voice' : channel ?? (conv[0].channel === 'phone' ? 'voice' : conv[0].channel) ?? 'sms';
        const data = await restPost('messages', {
          organization_id: conv[0].organization_id, conversation_id, contact_id: conv[0].contact_id, channel: ch,
          direction: direction ?? 'outbound', body, message_type: message_type ?? 'text', status: 'sent',
          sender_name: sender_name ?? null, sender_identifier: sender_id ?? null,
        }, 'return=representation');
        return toolResult(data);
      } catch (e) {
        return toolError(e);
      }
    },
  );

  server.tool(
    'snippets_list',
    'List reusable message snippets',
    { limit: z.number().optional() },
    async ({ limit }) => {
      try {
        const data = await restGet('snippets', { order: 'name.asc', limit: limit || 100 });
        return toolResult(data);
      } catch (e) {
        return toolError(e);
      }
    },
  );

  server.tool(
    'snippets_create',
    'Create a reusable message snippet',
    { name: z.string(), content: z.string(), category: z.string().optional() },
    async (params) => {
      try {
        const data = await restPost('snippets', params, 'return=representation');
        return toolResult(data);
      } catch (e) {
        return toolError(e);
      }
    },
  );

  server.tool(
    'snippets_update',
    'Update a snippet',
    { id: z.string(), name: z.string().optional(), content: z.string().optional() },
    async ({ id, ...body }) => {
      try {
        const data = await restPatch('snippets', { id: `eq.${id}` }, body, 'return=representation');
        return toolResult(data);
      } catch (e) {
        return toolError(e);
      }
    },
  );

  server.tool(
    'snippets_delete',
    'Delete a snippet',
    { id: z.string() },
    async ({ id }) => {
      try {
        await restDelete('snippets', { id: `eq.${id}` });
        return toolResult({ success: true });
      } catch (e) {
        return toolError(e);
      }
    },
  );

  server.tool(
    'conversation_rule_execute',
    'Execute conversation routing rules for a new message',
    { conversation_id: z.string(), message_id: z.string() },
    async (params) => {
      try {
        const data = await callEdgeFunction('conversation-rule-executor', params);
        return toolResult(data);
      } catch (e) {
        return toolError(e);
      }
    },
  );

  server.tool(
    'ai_draft_generate',
    'Generate or refresh an AI-drafted reply for a conversation',
    {
      conversation_id: z.string(),
      instructions: z.string().optional().describe('Tone or content instructions'),
    },
    async (params) => {
      try {
        const data = await callEdgeFunction('ai-draft-updater', params);
        return toolResult(data);
      } catch (e) {
        return toolError(e);
      }
    },
  );
  // --- conversation_log_message: log client comms an agent sent outside the portal ------------
  server.tool(
    'conversation_log_message',
    'Log a client communication into Conversations (the client\'s one open conversation; created if none). Use for email/SMS an agent sent (or received) OUTSIDE the OS. Agent-authored portal comments on tickets, change requests and client reviews are logged automatically - do not log those again. Needs contact_id, or a project_id whose project has a client contact. Deduped on (channel, external_id). Returns { conversation_id, message_id, deduped }.',
    {
      project_id: z.string().uuid().optional(),
      contact_id: z.string().uuid().optional(),
      channel: z.enum(['portal', 'email', 'sms']),
      direction: z.enum(['outbound', 'inbound']),
      body: z.string().min(1).max(50000),
      subject: z.string().max(500).optional(),
      external_id: z.string().max(300).optional().describe('Provider message id or your own stable key (dedupe)'),
      metadata: z.record(z.unknown()).optional(),
    },
    async (p) => {
      try {
        if (!p.project_id && !p.contact_id) throw new Error('pass contact_id or project_id');
        const who = await whoami();
        const res = await restRpc('conversation_log_message', {
          p_org: who.organization_id,
          p_channel: p.channel,
          p_direction: p.direction,
          p_body: p.body,
          p_project_id: p.project_id ?? null,
          p_contact_id: p.contact_id ?? null,
          p_subject: p.subject ?? null,
          p_external_id: p.external_id ?? null,
          p_metadata: p.metadata ?? {},
          p_sender_name: null,
        });
        return toolResult(res);
      } catch (e) {
        return toolError(e);
      }
    },
  );
}
