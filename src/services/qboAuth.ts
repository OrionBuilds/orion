import { supabase } from '../lib/supabase';
import { callEdgeFunction } from '../lib/edgeFunction';
import type { QBOConnection } from '../types';

// Token columns are not readable by browser roles; the QBO edge functions hold the tokens.
export async function getQBOConnection(): Promise<QBOConnection | null> {
  const { data, error } = await supabase
    .from('payment_provider_connections')
    .select('id, org_id, provider, realm_id, company_name, token_expiry, last_sync_at, connected_by, created_at, updated_at, connected_by_user:users!connected_by(id, name, email)')
    .eq('provider', 'quickbooks_online')
    .maybeSingle();

  if (error) {
    console.error('Error fetching QBO connection:', error);
  }

  if (data) return data as unknown as QBOConnection;

  // Only the QuickBooks row: the org has several connected integrations, and an unscoped
  // maybeSingle() errors on more than one (which made QuickBooks look disconnected).
  const { data: intConn } = await supabase
    .from('integration_connections')
    .select('id, org_id, token_expires_at, account_info, connected_by, connected_at')
    .eq('status', 'connected')
    .not('account_info->>realm_id', 'is', null)
    .maybeSingle();

  if (!intConn || !intConn.account_info?.realm_id) return null;

  return {
    id: intConn.id,
    org_id: intConn.org_id,
    realm_id: intConn.account_info.realm_id,
    company_name: intConn.account_info.company_name || 'QuickBooks Company',
    token_expiry: intConn.token_expires_at,
    last_sync_at: null,
    connected_by: intConn.connected_by,
    created_at: intConn.connected_at,
    updated_at: intConn.connected_at,
  } as QBOConnection;
}

export async function isQBOConnected(): Promise<boolean> {
  const connection = await getQBOConnection();
  return connection !== null;
}

export async function generateQBOAuthUrl(orgId: string, redirectUri: string): Promise<string> {
  const response = await callEdgeFunction('qbo-oauth-start', { orgId, redirectUri });

  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.error || 'Failed to generate QBO auth URL');
  }

  const data = await response.json();
  return data.authUrl;
}

export async function exchangeQBOCode(
  code: string,
  realmId: string,
  redirectUri: string
): Promise<QBOConnection> {
  const response = await callEdgeFunction('qbo-oauth-callback', { code, realmId, redirectUri });

  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.message || 'Failed to exchange QBO authorization code');
  }

  const data = await response.json();
  return data.connection;
}

export async function refreshQBOToken(): Promise<void> {
  const response = await callEdgeFunction('qbo-oauth-callback', { action: 'refresh' });

  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.message || 'Failed to refresh QBO token');
  }
}

export async function disconnectQBO(): Promise<void> {
  const response = await callEdgeFunction('qbo-oauth-callback', { action: 'disconnect' });

  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.message || 'Failed to disconnect QBO');
  }
}

export async function getQBOConnectionStatus(): Promise<{
  connected: boolean;
  companyName?: string;
  realmId?: string;
  lastSyncAt?: string;
  tokenExpiring?: boolean;
}> {
  const connection = await getQBOConnection();

  if (!connection) {
    return { connected: false };
  }

  const tokenExpiry = new Date(connection.token_expiry);
  const now = new Date();
  const fiveMinutesFromNow = new Date(now.getTime() + 5 * 60 * 1000);
  const tokenExpiring = tokenExpiry <= fiveMinutesFromNow;

  return {
    connected: true,
    companyName: connection.company_name,
    realmId: connection.realm_id,
    lastSyncAt: connection.last_sync_at || undefined,
    tokenExpiring,
  };
}