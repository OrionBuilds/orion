import { supabase } from '../lib/supabase';
import { callEdgeFunction, fetchEdge, parseEdgeFunctionError } from '../lib/edgeFunction';
import { shapeGoogleAccounts, type GoogleAccountDetail, type GoogleConnectionRow } from '../lib/googleAccounts';

export type { GoogleAccountDetail } from '../lib/googleAccounts';

const SLUG = 'google-oauth-unified';

export interface UnifiedGoogleConnection {
  connected: boolean;
  legacy?: boolean;
  email: string | null;
  gmail: boolean;
  calendar: boolean;
  drive: boolean;
  scopes: string[];
  connectedAt?: string;
  tokenExpired?: boolean;
  /** Every connected account (absent from older deploys; the fields above describe the primary). */
  accounts?: { id: string; email: string; label?: string | null; is_primary: boolean; connection_status: string }[];
}

export async function getUnifiedGoogleConnection(): Promise<UnifiedGoogleConnection> {
  const response = await fetchEdge(SLUG, { method: 'GET', path: '/connection' });
  if (!response.ok) throw new Error('Failed to get Google connection status');
  return response.json();
}

export interface GoogleOAuthOptions {
  /** 'add' connects an additional account instead of re-authorising the current one. */
  mode?: 'add';
  /** Pre-fills the Google sign-in with this account (re-auth of a specific account). */
  loginHint?: string;
}

/** Returns the Google sign-in URL (all Google scopes); the caller opens it in the popup. */
export async function initiateUnifiedGoogleOAuth(opts: GoogleOAuthOptions = {}): Promise<string> {
  const appOrigin = window.location.origin;
  const body = {
    ...(opts.mode ? { mode: opts.mode } : {}),
    ...(opts.loginHint ? { login_hint: opts.loginHint } : {}),
  };
  const response = await fetchEdge(SLUG, {
    method: 'POST',
    path: '/start',
    params: { app_origin: appOrigin },
    ...(Object.keys(body).length > 0 ? { body } : {}),
  });

  if (!response.ok) {
    const err = await response.json().catch(() => ({}));
    throw new Error(err.error || 'Failed to start Google OAuth');
  }

  const data = await response.json();
  return data.authUrl;
}

/** Removes one account (`connectionId`) or, with none, the user's only account. */
export async function disconnectUnifiedGoogle(connectionId?: string): Promise<void> {
  const response = await fetchEdge(SLUG, {
    method: 'POST',
    path: '/disconnect',
    ...(connectionId ? { body: { connection_id: connectionId } } : {}),
  });
  if (!response.ok) {
    const err = await response.json().catch(() => ({}));
    throw new Error(err.error || 'Failed to disconnect Google');
  }
}

interface AccountsListEntry {
  id: string;
  email: string;
  label?: string | null;
  is_primary?: boolean;
  connection_status?: string;
  last_refresh_error?: string | null;
  granted_scopes?: string[] | string | null;
}

/** Fallback when the status view is unavailable: the `google-accounts` list (no sync info). */
async function listGoogleAccountsViaEdge(): Promise<GoogleConnectionRow[]> {
  const response = await callEdgeFunction('google-accounts', { action: 'list' });
  if (!response.ok) throw new Error('Failed to list Google accounts');
  const data = await response.json();
  return ((data?.accounts ?? []) as AccountsListEntry[]).map((a) => ({
    connection_id: a.id,
    email: a.email,
    label: a.label ?? null,
    is_primary: a.is_primary ?? false,
    connection_status: a.connection_status ?? 'active',
    last_refresh_error: a.last_refresh_error ?? null,
    granted_scopes: a.granted_scopes ?? null,
  }));
}

/**
 * Every Google account the signed-in user has connected, primary first. Reads the token-free
 * `google_connection_status` view (per-user by RLS); when the view is not there yet it falls back to
 * the `google-accounts` list, and gives up (throws) only if both fail.
 */
export async function getGoogleConnections(): Promise<GoogleAccountDetail[]> {
  const { data, error } = await supabase.from('google_connection_status').select('*');
  if (!error) return shapeGoogleAccounts(data as GoogleConnectionRow[]);
  return shapeGoogleAccounts(await listGoogleAccountsViaEdge());
}

async function callGoogleAccounts(body: Record<string, unknown>, fallback: string): Promise<void> {
  const response = await callEdgeFunction('google-accounts', body);
  if (!response.ok) {
    const err = await response.json().catch(() => ({}));
    throw new Error(parseEdgeFunctionError(err, fallback));
  }
}

export function setPrimaryGoogleAccount(connectionId: string): Promise<void> {
  return callGoogleAccounts({ action: 'set-primary', connection_id: connectionId }, 'Failed to change the primary account');
}

/** An empty label clears it. */
export function setGoogleAccountLabel(connectionId: string, label: string): Promise<void> {
  return callGoogleAccounts({ action: 'set-label', connection_id: connectionId, label: label.trim() }, 'Failed to rename the account');
}

export function openUnifiedGoogleOAuthPopup(authUrl: string): Promise<{ success: boolean; email?: string; error?: string }> {
  return new Promise((resolve) => {
    const width = 500;
    const height = 600;
    const left = window.screenX + (window.outerWidth - width) / 2;
    const top = window.screenY + (window.outerHeight - height) / 2;

    const popup = window.open(
      authUrl,
      'google-oauth',
      `width=${width},height=${height},left=${left},top=${top}`
    );

    let resolved = false;
    const safeResolve = (value: { success: boolean; email?: string; error?: string }) => {
      if (!resolved) {
        resolved = true;
        clearInterval(checkClosed);
        window.removeEventListener('message', handleMessage);
        resolve(value);
      }
    };

    const handleMessage = (event: MessageEvent) => {
      if (event.data?.type === 'google-oauth-success') {
        safeResolve({ success: true, email: event.data.email });
      } else if (event.data?.type === 'google-oauth-error') {
        safeResolve({ success: false, error: event.data.error });
      }
    };

    window.addEventListener('message', handleMessage);

    const checkClosed = setInterval(() => {
      try {
        if (popup?.closed) {
          safeResolve({ success: false, error: 'Popup closed' });
        }
      } catch {
        safeResolve({ success: false, error: 'Popup closed' });
      }
    }, 500);
  });
}
