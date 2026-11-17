import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { restGet } from '../helpers/rest-client.js';
import { callEdgeFunction, callEdgeRoute } from '../helpers/edge-client.js';
import {
  connectRoute,
  mailRoute,
  providerParam,
  resolveWorkspaceProvider,
  type RequestedProvider,
} from '../helpers/workspace-provider.js';
import { toolResult, toolError } from '../helpers/tool-utils.js';

export function registerCommunicationsTools(server: McpServer): void {
  server.tool(
    'call_logs_list',
    'List phone call log records',
    {
      contact_id: z.string().optional(),
      direction: z.string().optional().describe('eq.inbound or eq.outbound'),
      limit: z.number().optional(),
    },
    async ({ contact_id, direction, limit }) => {
      try {
        const filters: Record<string, string> = {};
        if (contact_id) filters['contact_id'] = `eq.${contact_id}`;
        if (direction) filters['direction'] = direction;
        const data = await restGet('call_logs', {
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
    'email_domains_list',
    'List configured email sending domains',
    {},
    async () => {
      try {
        const data = await restGet('email_domains', { order: 'domain.asc' });
        return toolResult(data);
      } catch (e) {
        return toolError(e);
      }
    },
  );

  server.tool(
    'email_from_addresses_list',
    'List verified sender email addresses',
    {},
    async () => {
      try {
        const data = await restGet('email_from_addresses', { order: 'email.asc' });
        return toolResult(data);
      } catch (e) {
        return toolError(e);
      }
    },
  );

  // Personal mailbox: Gmail (gmail-api) or Outlook (microsoft-mail), by the caller's provider.
  // Registered under the neutral name and the legacy gmail_api name (same handler).
  const mailboxSchema = {
    action: z.string().describe(
      'Kebab or camelCase action. Both: send, reply, get-message (get), get-thread, create-draft, update-draft, delete-draft, trash, archive, modify-labels, list-attachments, get-attachment. Gmail only: list-messages (list), get-profile, list-drafts. Outlook only: send-draft, move, mark-read, set-flag, set-categories, list-folders.',
    ),
    payload: z.record(z.unknown()).optional().describe('Action params, e.g. send: { to, subject, body|htmlBody, cc?, bcc? }; message actions: { messageId }'),
    provider: providerParam,
  };
  const mailboxHandler = async ({ action, payload, provider }: { action: string; payload?: Record<string, unknown>; provider?: RequestedProvider }) => {
    try {
      const p = await resolveWorkspaceProvider(provider);
      const data = await callEdgeRoute(mailRoute(p, action, payload ?? {}));
      return toolResult({ provider: p, ...(typeof data === 'object' && data !== null ? data : { result: data }) });
    } catch (e) {
      return toolError(e);
    }
  };
  server.tool(
    'mailbox_api',
    "The caller's personal mailbox (Gmail or Outlook, whichever is connected; provider overrides).",
    mailboxSchema,
    mailboxHandler,
  );
  server.tool(
    'gmail_api',
    'Legacy alias of mailbox_api: personal mailbox operations routed to Gmail or Outlook by the caller\'s connected provider.',
    mailboxSchema,
    mailboxHandler,
  );

  server.tool(
    'gmail_oauth_start',
    'Start connecting the caller\'s mailbox: Google Workspace (Gmail) or Microsoft 365 (Outlook). Returns an authUrl to open.',
    { redirect_uri: z.string().optional(), provider: providerParam },
    async ({ redirect_uri, provider }) => {
      try {
        // Connecting needs an explicit choice when nothing is connected yet; auto falls back to Google.
        const p = provider === 'google' || provider === 'microsoft' ? provider
          : await resolveWorkspaceProvider(provider).catch(() => 'google' as const);
        const data = p === 'google'
          ? await callEdgeFunction('gmail-oauth-start', { redirect_uri })
          : await callEdgeRoute(connectRoute('microsoft'));
        return toolResult({ provider: p, ...(data as object) });
      } catch (e) {
        return toolError(e);
      }
    },
  );

  const outlookSyncNote = {
    provider: 'microsoft',
    synced: false,
    note: 'Outlook mail is pulled automatically by the scheduled microsoft-mail-sync job (cron-only); there is no on-demand sync for agent callers.',
  };

  server.tool(
    'gmail_sync',
    'Full mailbox sync for the caller (Gmail: on-demand full sync; Outlook: scheduled automatically)',
    { provider: providerParam },
    async ({ provider }) => {
      try {
        const p = await resolveWorkspaceProvider(provider);
        if (p === 'microsoft') return toolResult(outlookSyncNote);
        const data = await callEdgeFunction('gmail-sync', {});
        return toolResult(data);
      } catch (e) {
        return toolError(e);
      }
    },
  );

  server.tool(
    'gmail_sync_incremental',
    'Incremental mailbox sync (new/changed messages only). Gmail on demand; Outlook is scheduled automatically.',
    { provider: providerParam },
    async ({ provider }) => {
      try {
        const p = await resolveWorkspaceProvider(provider);
        if (p === 'microsoft') return toolResult(outlookSyncNote);
        const data = await callEdgeFunction('gmail-sync-incremental', {});
        return toolResult(data);
      } catch (e) {
        return toolError(e);
      }
    },
  );

  server.tool(
    'resend_provider',
    'Manage the Resend email provider connection. Actions: status (current connection state), test (send a verification probe)',
    {
      orgId: z.string(),
      action: z.enum(['status', 'test']).optional().describe('status (default) or test'),
    },
    async ({ orgId, action }) => {
      try {
        const data = await callEdgeFunction('resend-provider', { orgId, action: action ?? 'status' });
        return toolResult(data);
      } catch (e) {
        return toolError(e);
      }
    },
  );

  server.tool(
    'resend_domains',
    'List or sync Resend sending domains. Actions: list (default), sync (pull latest verification status from Resend)',
    {
      orgId: z.string(),
      action: z.enum(['list', 'sync']).optional().describe('list (default) or sync'),
    },
    async ({ orgId, action }) => {
      try {
        const data = await callEdgeFunction('resend-domains', { orgId, action: action ?? 'list' });
        return toolResult(data);
      } catch (e) {
        return toolError(e);
      }
    },
  );

  server.tool(
    'send_sms',
    'Send an SMS message via Twilio',
    {
      to: z.string().describe('E.164 destination'),
      body: z.string(),
      from: z.string().optional().describe('E.164 sender; defaults to the platform number'),
      contact_id: z.string().optional(),
      conversation_id: z.string().optional(),
    },
    async ({ to, body, from, contact_id, conversation_id }) => {
      try {
        // The edge function is twilio-sms-send (there is no `send-sms`); it takes toNumber/fromNumber
        // and derives the org from the caller's JWT.
        const data = await callEdgeFunction('twilio-sms-send', {
          toNumber: to, body, fromNumber: from, contactId: contact_id, conversationId: conversation_id,
        });
        return toolResult(data);
      } catch (e) {
        return toolError(e);
      }
    },
  );

  server.tool(
    'phone_settings',
    'Manage phone system settings. Actions: get, update, get-status',
    {
      action: z.string(),
      payload: z.record(z.unknown()).optional(),
    },
    async ({ action, payload }) => {
      try {
        const data = await callEdgeFunction('phone-settings', { action, ...payload });
        return toolResult(data);
      } catch (e) {
        return toolError(e);
      }
    },
  );

  server.tool(
    'phone_voice_routing',
    'Configure voice call routing rules and IVR',
    { action: z.string(), payload: z.record(z.unknown()).optional() },
    async ({ action, payload }) => {
      try {
        const data = await callEdgeFunction('phone-voice-routing', { action, ...payload });
        return toolResult(data);
      } catch (e) {
        return toolError(e);
      }
    },
  );

  server.tool(
    'phone_dnc',
    'Manage Do Not Call (DNC) list. Actions: list, add, remove, check',
    {
      action: z.string(),
      payload: z.record(z.unknown()).optional(),
    },
    async ({ action, payload }) => {
      try {
        const data = await callEdgeFunction('phone-dnc', { action, ...payload });
        return toolResult(data);
      } catch (e) {
        return toolError(e);
      }
    },
  );

  server.tool(
    'phone_test',
    'Test phone connectivity and configuration',
    { test_type: z.string().optional(), phone_number: z.string().optional() },
    async (params) => {
      try {
        const data = await callEdgeFunction('phone-test', params);
        return toolResult(data);
      } catch (e) {
        return toolError(e);
      }
    },
  );

  // Workspace chat (Google Chat / Teams chat) was removed: Conversations is the comms hub.
}
