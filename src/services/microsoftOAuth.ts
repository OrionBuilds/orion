import { supabase } from '../lib/supabase';
import { callEdgeFunction, parseEdgeFunctionError } from '../lib/edgeFunction';
import { NO_MS_CAPABILITIES, parseCapabilities, primaryAccount, shapeAccounts, type MsAccountDetail, type MsAccountType, type MsCapabilities } from '../lib/microsoftAccounts';

export type { MsAccountDetail } from '../lib/microsoftAccounts';

export interface MicrosoftConnection {
  connected: boolean;
  email: string | null;
  needsReauth: boolean;
  syncStatus: string | null;
  lastSyncAt: string | null;
  error: string | null;
}

export const EMPTY_MICROSOFT_CONNECTION: MicrosoftConnection = {
  connected: false, email: null, needsReauth: false, syncStatus: null, lastSyncAt: null, error: null,
};

/** Every Microsoft account the signed-in user has connected, primary first (the view is per-user). */
export async function getMicrosoftConnections(): Promise<MsAccountDetail[]> {
  const { data, error } = await supabase.from('microsoft_connection_status').select('*');
  if (error) throw error;
  return shapeAccounts(data as Parameters<typeof shapeAccounts>[0]);
}

export interface AgentMailbox {
  email: string;
  connected: boolean;
  needsReauth: boolean;
  lastSyncAt: string | null;
  error: string | null;
}

/** An agent's (Clara's) mailbox, which lives on the agent's own user. SuperAdmin only; null when none is connected or not permitted. */
export async function getAgentMailbox(agent = 'clara'): Promise<AgentMailbox | null> {
  const { data, error } = await supabase.rpc('ms_agent_mailbox_status', { p_agent: agent });
  if (error || !Array.isArray(data) || data.length === 0) return null;
  const r = data[0] as {
    email: string; connection_status: string | null; last_sync_at: string | null;
    sync_error: string | null; last_refresh_error: string | null;
  };
  const needsReauth = r.connection_status === 'needs_reauth';
  return {
    email: r.email,
    connected: r.connection_status === 'active',
    needsReauth,
    lastSyncAt: r.last_sync_at,
    error: r.sync_error || r.last_refresh_error || null,
  };
}

function toConnection(a: MsAccountDetail | null): MicrosoftConnection {
  if (!a) return EMPTY_MICROSOFT_CONNECTION;
  return {
    connected: true,
    email: a.email,
    needsReauth: a.needsReauth,
    syncStatus: a.syncStatus,
    lastSyncAt: a.lastSyncAt,
    error: a.error,
  };
}

/** The primary account's connection state (existing single-account callers). */
export async function getMicrosoftConnection(): Promise<MicrosoftConnection> {
  return toConnection(primaryAccount(await getMicrosoftConnections()));
}

export interface MicrosoftOAuthOptions {
  /** 'add' connects an additional account instead of re-authorising the current one. */
  mode?: 'add';
  /** Which kind of account to connect; omitted = the home organization (as before). */
  accountType?: MsAccountType;
  /** Pre-fills the Microsoft sign-in with this account (re-auth of a specific account). */
  loginHint?: string;
}

/** Returns the Microsoft sign-in URL; the caller navigates the window to it. */
/** `agent` (e.g. 'clara'): a SuperAdmin attaches that agent's own mailbox instead of their own. */
export async function initiateMicrosoftOAuth(agent?: string, opts: MicrosoftOAuthOptions = {}): Promise<string> {
  const response = await callEdgeFunction('microsoft-oauth-start', {
    redirect_uri: `${window.location.origin}/settings/profile?tab=connected-accounts`,
    ...(agent ? { agent } : {}),
    ...(opts.mode ? { mode: opts.mode } : {}),
    ...(opts.accountType ? { account_type: opts.accountType } : {}),
    ...(opts.loginHint ? { login_hint: opts.loginHint } : {}),
  });
  if (!response.ok) {
    const err = await response.json().catch(() => ({}));
    throw new Error(parseEdgeFunctionError(err, 'Failed to start Microsoft sign-in'));
  }
  return (await response.json()).authUrl;
}

/** Removes one account (`connectionId`) or, with none, the user's only account. */
export async function disconnectMicrosoft(connectionId?: string): Promise<void> {
  const response = await callEdgeFunction('microsoft-disconnect', connectionId ? { connection_id: connectionId } : {});
  if (!response.ok) {
    const err = await response.json().catch(() => ({}));
    throw new Error(parseEdgeFunctionError(err, 'Failed to disconnect Microsoft'));
  }
}

async function callAccounts(body: Record<string, unknown>, fallback: string): Promise<void> {
  const response = await callEdgeFunction('microsoft-accounts', body);
  if (!response.ok) {
    const err = await response.json().catch(() => ({}));
    throw new Error(parseEdgeFunctionError(err, fallback));
  }
}

export function setPrimaryMicrosoftAccount(connectionId: string): Promise<void> {
  return callAccounts({ action: 'set-primary', connection_id: connectionId }, 'Failed to change the primary account');
}

/** An empty label clears it. */
export function setMicrosoftAccountLabel(connectionId: string, label: string): Promise<void> {
  return callAccounts({ action: 'set-label', connection_id: connectionId, label: label.trim() }, 'Failed to rename the account');
}

/** Whether the server allows other-organization and personal accounts; disabled on any failure. */
export async function getMicrosoftCapabilities(): Promise<MsCapabilities> {
  try {
    const response = await callEdgeFunction('microsoft-accounts', { action: 'list' });
    if (!response.ok) return NO_MS_CAPABILITIES;
    return parseCapabilities(await response.json());
  } catch {
    return NO_MS_CAPABILITIES;
  }
}

/** The app's client id as carried in a Microsoft sign-in URL (public, not a secret); null if absent. */
export function clientIdFromAuthUrl(authUrl: string): string | null {
  try {
    return new URL(authUrl).searchParams.get('client_id');
  } catch {
    return null;
  }
}
