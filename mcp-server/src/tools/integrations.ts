import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { restGet, restPatch, restDelete } from '../helpers/rest-client.js';
import { callEdgeFunction, callEdgeRoute } from '../helpers/edge-client.js';
import { connectRoute, providerParam, resolveWorkspaceProvider } from '../helpers/workspace-provider.js';
import { resolveCaller } from '../helpers/pipelineGuard.js';
import { toolResult, toolError } from '../helpers/tool-utils.js';

export function registerIntegrationsTools(server: McpServer): void {
  server.tool(
    'integrations_list',
    'List available integration definitions',
    {},
    async () => {
      try {
        const data = await restGet('integrations', { order: 'name.asc' });
        return toolResult(data);
      } catch (e) {
        return toolError(e);
      }
    },
  );

  server.tool(
    'integrations_get',
    'Get integration detail',
    { id: z.string() },
    async ({ id }) => {
      try {
        const data = await restGet('integrations', {
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
    'integration_connections_list',
    'List active integration connections',
    { limit: z.number().optional() },
    async ({ limit }) => {
      try {
        const data = await restGet('integration_connections', {
          // Explicit columns: token/credential columns are not readable by user roles.
          select: 'id,integration_id,org_id,user_id,status,token_expires_at,account_info,error_message,connected_at,connected_by,updated_at,integration:integrations(id,name,icon_url)',
          order: 'connected_at.desc',
          limit: limit || 50,
        });
        return toolResult(data);
      } catch (e) {
        return toolError(e);
      }
    },
  );

  server.tool(
    'integration_connections_create',
    'Not supported: integrations are connected by a person in Settings → Integrations (OAuth sign-in or an API key ' +
      'saved server-side), never by writing a connection row. Returns an error that says so.',
    { integration_id: z.string() },
    async () =>
      toolError(new Error(
        'Integration connections are created by connecting the integration in Settings → Integrations; agents cannot create them.',
      )),
  );

  server.tool(
    'integration_connections_update',
    'Update an integration connection\'s status or error note (e.g. mark it disconnected). Tokens and credentials ' +
      'are not editable here.',
    {
      id: z.string(),
      status: z.enum(['connected', 'disconnected', 'error']).optional(),
      error_message: z.string().nullable().optional(),
    },
    async ({ id, ...body }) => {
      try {
        // return=minimal: the full row includes token columns that user roles cannot read.
        await restPatch('integration_connections', { id: `eq.${id}` }, { ...body, updated_at: new Date().toISOString() }, 'return=minimal');
        return toolResult({ success: true, id });
      } catch (e) {
        return toolError(e);
      }
    },
  );

  server.tool(
    'integration_connections_delete',
    'Disconnect an integration',
    { id: z.string() },
    async ({ id }) => {
      try {
        await restDelete('integration_connections', { id: `eq.${id}` });
        return toolResult({ success: true });
      } catch (e) {
        return toolError(e);
      }
    },
  );

  server.tool(
    'outgoing_webhooks_list',
    'List outgoing webhook configurations',
    {},
    async () => {
      try {
        const data = await restGet('outgoing_webhooks', {
          // Explicit columns: the signing-secret columns are not readable by user roles.
          select: 'id,org_id,name,url,events,headers,enabled,retry_count,created_at,updated_at,created_by',
          order: 'name.asc',
        });
        return toolResult(data);
      } catch (e) {
        return toolError(e);
      }
    },
  );

  server.tool(
    'outgoing_webhooks_create',
    'Create an outgoing webhook. The signing secret is generated and stored sealed by the integrations-webhooks ' +
      'function; it is not returned to agents (a person sees it once when creating the webhook in Settings).',
    {
      name: z.string(),
      url: z.string().url(),
      events: z.array(z.string()).min(1),
      headers: z.record(z.string()).optional(),
      retry_count: z.number().int().min(0).max(10).optional(),
    },
    async (params) => {
      try {
        const data = (await callEdgeFunction('integrations-webhooks', { action: 'create', ...params })) as Record<string, unknown>;
        // Keep the one-time signing secret out of agent transcripts.
        const webhook = { ...(data ?? {}) };
        delete webhook.signing_secret;
        return toolResult(webhook);
      } catch (e) {
        return toolError(e);
      }
    },
  );

  server.tool(
    'outgoing_webhooks_update',
    'Update an outgoing webhook',
    {
      id: z.string(),
      name: z.string().optional(),
      url: z.string().optional(),
      events: z.array(z.string()).optional(),
      headers: z.record(z.string()).optional(),
      enabled: z.boolean().optional(),
      retry_count: z.number().int().min(0).max(10).optional(),
    },
    async ({ id, ...body }) => {
      try {
        // return=minimal: the full row includes the signing secret, which user roles cannot read.
        await restPatch('outgoing_webhooks', { id: `eq.${id}` }, { ...body, updated_at: new Date().toISOString() }, 'return=minimal');
        return toolResult({ success: true, id });
      } catch (e) {
        return toolError(e);
      }
    },
  );

  server.tool(
    'outgoing_webhooks_delete',
    'Delete an outgoing webhook',
    { id: z.string() },
    async ({ id }) => {
      try {
        await restDelete('outgoing_webhooks', { id: `eq.${id}` });
        return toolResult({ success: true });
      } catch (e) {
        return toolError(e);
      }
    },
  );

  server.tool(
    'webhook_deliveries_list',
    'List webhook delivery attempts for a webhook',
    {
      webhook_id: z.string(),
      limit: z.number().optional(),
    },
    async ({ webhook_id, limit }) => {
      try {
        const data = await restGet('webhook_deliveries', {
          filters: { webhook_id: `eq.${webhook_id}` },
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
    'integrations_connect',
    'Initiate an integration connection flow via Edge Function',
    {
      integration_id: z.string(),
      config: z.record(z.unknown()).optional(),
    },
    async (params) => {
      try {
        const data = await callEdgeFunction('integrations-connect', params);
        return toolResult(data);
      } catch (e) {
        return toolError(e);
      }
    },
  );

  server.tool(
    'integrations_webhooks',
    'Process incoming webhook payloads from integrated services',
    {
      source: z.string(),
      event: z.string(),
      data: z.record(z.unknown()).optional(),
    },
    async (params) => {
      try {
        const data = await callEdgeFunction('integrations-webhooks', params);
        return toolResult(data);
      } catch (e) {
        return toolError(e);
      }
    },
  );

  // google-oauth-unified is path-routed: POST /start, GET /connection, POST /disconnect.
  server.tool(
    'google_oauth_unified',
    'Google Workspace connection for the caller. Actions: start (returns authUrl), status (connection + scopes; silently refreshes an expired token), revoke (disconnect Google). For Microsoft 365 use workspace_connect / workspace_provider_status.',
    {
      action: z.enum(['start', 'status', 'revoke']).describe('start, status, revoke'),
      payload: z.record(z.unknown()).optional().describe('start: { app_origin? }'),
    },
    async ({ action, payload }) => {
      try {
        let data: unknown;
        if (action === 'start') {
          const appOrigin = typeof payload?.app_origin === 'string' ? payload.app_origin : undefined;
          data = await callEdgeRoute(connectRoute('google', { appOrigin }));
        } else if (action === 'status') {
          data = await callEdgeFunction('google-oauth-unified', undefined, 'GET', { path: 'connection' });
        } else {
          data = await callEdgeFunction('google-oauth-unified', {}, 'POST', { path: 'disconnect' });
        }
        return toolResult(data);
      } catch (e) {
        return toolError(e);
      }
    },
  );

  // google-token-refresh-cron is a cron target (X-Cron-Secret) and 401s for agent JWTs. Agents get
  // the user-facing equivalent for their OWN connection: Google's /connection silently refreshes an
  // expired token; Microsoft tokens refresh on use (microsoft-token-refresh-cron covers the rest).
  server.tool(
    'google_token_refresh',
    "Refresh/check the caller's own workspace OAuth token (Google: refreshes if expired; Microsoft: refreshed automatically on use, returns connection state).",
    { provider: providerParam },
    async ({ provider }) => {
      try {
        const p = await resolveWorkspaceProvider(provider);
        if (p === 'google') {
          const data = await callEdgeFunction('google-oauth-unified', undefined, 'GET', { path: 'connection' });
          return toolResult({ provider: p, ...(data as object) });
        }
        const caller = await resolveCaller();
        const rows = await restGet('user_connected_accounts', {
          select: 'provider,provider_account_email,status,connected_at,last_synced_at',
          filters: { user_id: `eq.${caller.user_id}`, provider: 'eq.microsoft_365' },
        });
        return toolResult({ provider: p, accounts: rows, note: 'Microsoft tokens are refreshed on use and by the scheduled microsoft-token-refresh-cron.' });
      } catch (e) {
        return toolError(e);
      }
    },
  );

  server.tool(
    'workspace_provider_status',
    "Which workspace provider (Google Workspace / Microsoft 365) the caller resolves to, plus their connected accounts.",
    {},
    async () => {
      try {
        const caller = await resolveCaller();
        const accounts = await restGet('user_connected_accounts', {
          select: 'provider,provider_account_email,status,connected_at',
          filters: { user_id: `eq.${caller.user_id}`, provider: 'in.(google_workspace,google_gmail,microsoft_365)' },
        });
        let resolved: string | null = null;
        let error: string | undefined;
        try { resolved = await resolveWorkspaceProvider('auto'); } catch (e) { error = (e as Error).message; }
        return toolResult({ resolved, accounts, ...(error ? { error } : {}) });
      } catch (e) {
        return toolError(e);
      }
    },
  );

  server.tool(
    'workspace_connect',
    'Start connecting Google Workspace or Microsoft 365 for the caller. Returns an authUrl to open in a browser.',
    { provider: z.enum(['google', 'microsoft']), app_origin: z.string().optional() },
    async ({ provider, app_origin }) => {
      try {
        const data = await callEdgeRoute(connectRoute(provider, { appOrigin: app_origin }));
        return toolResult({ provider, ...(data as object) });
      } catch (e) {
        return toolError(e);
      }
    },
  );

  server.tool(
    'portal_auth',
    'Client portal authentication. Actions: requestCode, verifyCode, validateSession',
    {
      action: z.string().describe('requestCode, verifyCode, validateSession'),
      payload: z.record(z.unknown()).optional(),
    },
    async ({ action, payload }) => {
      try {
        // The edge function is `client-portal-auth` and uses kebab-case actions; map the tool's
        // documented camelCase names to it. Unknown actions pass through unchanged.
        const ACTION_MAP: Record<string, string> = {
          requestCode: 'send-code',
          verifyCode: 'verify-code',
          validateSession: 'validate-session',
        };
        const data = await callEdgeFunction('client-portal-auth', { action: ACTION_MAP[action] ?? action, ...payload });
        return toolResult(data);
      } catch (e) {
        return toolError(e);
      }
    },
  );

  server.tool(
    'secrets_api',
    'Manage application secrets and API keys. Actions: list, create, delete',
    {
      action: z.string().describe('list, create, delete'),
      payload: z.record(z.unknown()).optional(),
    },
    async ({ action, payload }) => {
      try {
        const data = await callEdgeFunction('secrets-api', { action, ...payload });
        return toolResult(data);
      } catch (e) {
        return toolError(e);
      }
    },
  );

  server.tool(
    'secrets_scanner',
    'Scan for exposed or misconfigured secrets',
    {},
    async () => {
      try {
        const data = await callEdgeFunction('secrets-scanner', {});
        return toolResult(data);
      } catch (e) {
        return toolError(e);
      }
    },
  );
}
