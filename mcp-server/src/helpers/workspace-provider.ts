/**
 * Workspace-provider routing for MCP tools (Google Workspace vs Microsoft 365).
 *
 * Mirrors supabase/functions/_shared/provider.ts: the caller's provider comes from
 * user_connected_accounts (microsoft_365 -> microsoft, google_workspace / legacy google_gmail ->
 * google, status 'connected'). A caller with both follows organizations.default_workspace_provider,
 * then Microsoft. Tools take `provider: 'google' | 'microsoft' | 'auto'` (default auto).
 *
 * The route helpers below are PURE (unit-tested): they translate one tool action into the edge
 * function + action + payload of the chosen provider.
 */
import { z } from 'zod';
import { restGet } from './rest-client.js';
import { resolveCaller } from './pipelineGuard.js';
import { getRequestMemo } from './auth-context.js';

export type WorkspaceProvider = 'google' | 'microsoft';
export type RequestedProvider = WorkspaceProvider | 'auto' | undefined;

export const providerParam = z
  .enum(['google', 'microsoft', 'auto'])
  .optional()
  .describe("Workspace provider: 'google' (Google Workspace), 'microsoft' (Microsoft 365) or 'auto' (default: whichever the caller has connected; org default when both)");

const GOOGLE_ACCOUNT_PROVIDERS = ['google_workspace', 'google_gmail'];
const MICROSOFT_ACCOUNT_PROVIDERS = ['microsoft_365'];

export function normalizeAccountProvider(p: string | null | undefined): WorkspaceProvider | null {
  if (!p) return null;
  if (GOOGLE_ACCOUNT_PROVIDERS.includes(p)) return 'google';
  if (MICROSOFT_ACCOUNT_PROVIDERS.includes(p)) return 'microsoft';
  return null;
}

export function connectedProviders(rows: { provider: string; status?: string | null }[]): WorkspaceProvider[] {
  const out = new Set<WorkspaceProvider>();
  for (const r of rows) {
    if (r.status && r.status !== 'connected') continue;
    const p = normalizeAccountProvider(r.provider);
    if (p) out.add(p);
  }
  return (['microsoft', 'google'] as WorkspaceProvider[]).filter((p) => out.has(p));
}

export function pickProvider(
  connected: WorkspaceProvider[],
  orgDefault?: WorkspaceProvider | null,
): WorkspaceProvider | null {
  if (connected.length === 0) return null;
  if (orgDefault && connected.includes(orgDefault)) return orgDefault;
  return connected[0];
}

export const NOT_CONNECTED_MESSAGE =
  'No Google Workspace or Microsoft 365 account is connected for this user. Connect one in Settings > Profile > Connected Accounts, or pass provider explicitly.';

const MEMO_KEY = 'workspace_provider';

/** Resolves `auto` (or undefined) to the caller's provider; explicit values pass through. */
export async function resolveWorkspaceProvider(requested: RequestedProvider): Promise<WorkspaceProvider> {
  if (requested === 'google' || requested === 'microsoft') return requested;
  const memo = getRequestMemo();
  const cached = memo?.get(MEMO_KEY) as WorkspaceProvider | undefined;
  if (cached) return cached;

  const caller = await resolveCaller();
  const rows = (await restGet('user_connected_accounts', {
    select: 'provider,status',
    filters: {
      user_id: `eq.${caller.user_id}`,
      provider: `in.(${[...GOOGLE_ACCOUNT_PROVIDERS, ...MICROSOFT_ACCOUNT_PROVIDERS].join(',')})`,
    },
  })) as { provider: string; status?: string | null }[] | null;
  const connected = connectedProviders(rows ?? []);
  let orgDefault: WorkspaceProvider | null = null;
  if (connected.length > 1) {
    try {
      const org = (await restGet('organizations', {
        select: 'default_workspace_provider',
        filters: { id: `eq.${caller.organization_id}` },
      })) as { default_workspace_provider?: string | null }[] | null;
      const v = org?.[0]?.default_workspace_provider;
      orgDefault = v === 'google' || v === 'microsoft' ? v : null;
    } catch {
      orgDefault = null; // column absent before the dual-provider migration
    }
  }
  const picked = pickProvider(connected, orgDefault);
  if (!picked) throw new Error(NOT_CONNECTED_MESSAGE);
  memo?.set(MEMO_KEY, picked);
  return picked;
}

// ---------------------------------------------------------------------------------------------
// Pure route helpers
// ---------------------------------------------------------------------------------------------

export interface EdgeRoute {
  slug: string;
  method?: 'GET' | 'POST' | 'DELETE';
  /** Path suffix after the slug (path-routed functions). */
  path?: string;
  query?: Record<string, string>;
  body?: Record<string, unknown>;
}

/** camelCase / snake_case -> kebab-case ("getThread" -> "get-thread"). */
export function kebab(action: string): string {
  return action
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replace(/_/g, '-')
    .toLowerCase();
}

const MAIL_ALIASES: Record<string, string> = { list: 'list-messages', get: 'get-message', profile: 'get-profile' };
const GMAIL_ACTIONS = new Set([
  'get-profile', 'list-messages', 'get-message', 'get-thread', 'send', 'reply', 'create-draft', 'update-draft',
  'delete-draft', 'list-drafts', 'trash', 'archive', 'modify-labels', 'get-attachment', 'list-attachments',
]);
const OUTLOOK_ACTIONS = new Set([
  'send', 'reply', 'create-draft', 'update-draft', 'delete-draft', 'send-draft', 'get-thread', 'get-message',
  'trash', 'archive', 'move', 'mark-read', 'set-flag', 'set-categories', 'modify-labels', 'list-attachments',
  'get-attachment', 'list-folders',
]);

/** Personal mailbox action -> gmail-api or microsoft-mail. */
export function mailRoute(provider: WorkspaceProvider, action: string, payload: Record<string, unknown> = {}): EdgeRoute {
  const a = MAIL_ALIASES[action] ?? kebab(action);
  if (provider === 'google') {
    if (!GMAIL_ACTIONS.has(a)) throw new Error(`Gmail does not support action '${action}'. Supported: ${[...GMAIL_ACTIONS].join(', ')}`);
    const body: Record<string, unknown> = { ...payload, action: a };
    if ((a === 'send' || a === 'create-draft' || a === 'update-draft') && body.htmlBody === undefined && typeof body.body === 'string') {
      body.htmlBody = body.body;
    }
    return { slug: 'gmail-api', body };
  }
  if (!OUTLOOK_ACTIONS.has(a)) {
    throw new Error(
      `Outlook does not support action '${action}'${a === 'list-messages' ? ' (Outlook mail is mirrored into Conversations: use the conversations/inbox tools to list messages)' : ''}. Supported: ${[...OUTLOOK_ACTIONS].join(', ')}`,
    );
  }
  const body: Record<string, unknown> = { ...payload, action: a };
  if (body.body === undefined && typeof body.htmlBody === 'string') {
    body.body = body.htmlBody;
    if (body.contentType === undefined) body.contentType = 'html';
  }
  if (typeof body.to === 'string') body.to = [body.to];
  return { slug: 'microsoft-mail', body };
}

const FILE_ALIASES: Record<string, string> = { get: 'get-metadata', createFolder: 'create-folder', shareLink: 'get-share-link' };
const DRIVE_ACTIONS = new Set([
  'list', 'list-shared-drives', 'list-shared-with-me', 'search', 'get-metadata', 'create-folder', 'delete',
  'get-download-url', 'share', 'get-share-link', 'export-doc', 'enrich-meeting', 'enrich-meetings-batch',
]);
const SHAREPOINT_ACTIONS = new Set(['list', 'search', 'get-metadata', 'create-folder', 'delete', 'get-share-link', 'get-download-url']);

/** File storage action -> drive-api (Google Drive) or sharepoint-api (SharePoint/OneDrive, Drive-shaped). */
export function filesRoute(provider: WorkspaceProvider, action: string, payload: Record<string, unknown> = {}): EdgeRoute {
  const a = FILE_ALIASES[action] ?? kebab(action);
  const allowed = provider === 'google' ? DRIVE_ACTIONS : SHAREPOINT_ACTIONS;
  if (!allowed.has(a)) {
    throw new Error(`${provider === 'google' ? 'Google Drive' : 'SharePoint/OneDrive'} does not support action '${action}'. Supported: ${[...allowed].join(', ')}`);
  }
  return { slug: provider === 'google' ? 'drive-api' : 'sharepoint-api', body: { ...payload, action: a } };
}

/**
 * On-demand calendar pull for the CALLER's own connection. Both targets are user-facing (accept a
 * user JWT); the cron runners (google-calendar-sync-runner, microsoft-calendar-sync) are not.
 */
export function calendarSyncRoute(provider: WorkspaceProvider, incremental = false): EdgeRoute {
  if (provider === 'google') return { slug: 'google-calendar-sync', body: { action: incremental ? 'sync-incremental' : 'sync' } };
  return { slug: 'microsoft-calendar', body: { action: 'sync' } };
}

/** Starts the provider's OAuth connect flow for the caller; returns { authUrl }. */
export function connectRoute(provider: WorkspaceProvider, opts: { appOrigin?: string } = {}): EdgeRoute {
  if (provider === 'google') {
    return { slug: 'google-oauth-unified', method: 'POST', path: 'start', query: opts.appOrigin ? { app_origin: opts.appOrigin } : undefined };
  }
  return { slug: 'microsoft-oauth-start', body: {} };
}
