/**
 * Workspace-provider resolver (frontend twin of supabase/functions/_shared/provider.ts).
 *
 * Orion is dual-provider: each user connects Google Workspace, Microsoft 365, or both, and every
 * feature (mail, calendar, files, meetings, chat) routes to whichever is connected. The source of
 * truth is `user_connected_accounts` (status 'connected'): 'microsoft_365' -> microsoft,
 * 'google_workspace' / legacy 'google_gmail' -> google. When a user has both, the org default
 * (organizations.default_workspace_provider) decides, then Microsoft (the incumbent).
 */
import { supabase } from '../lib/supabase';
import { shapeAccounts, showAccountPicker, type MsAccount, type MsConnectionRow } from '../lib/microsoftAccounts';
import { shapeGoogleAccounts, toGoogleAccounts, type GoogleAccount, type GoogleConnectionRow } from '../lib/googleAccounts';

export type WorkspaceProvider = 'google' | 'microsoft';

export const GOOGLE_ACCOUNT_PROVIDERS = ['google_workspace', 'google_gmail'] as const;
export const MICROSOFT_ACCOUNT_PROVIDERS = ['microsoft_365'] as const;
const ALL_ACCOUNT_PROVIDERS: string[] = [...GOOGLE_ACCOUNT_PROVIDERS, ...MICROSOFT_ACCOUNT_PROVIDERS];

export const PROVIDER_LABELS: Record<WorkspaceProvider, { suite: string; mail: string; calendar: string; files: string; meetings: string }> = {
  google: { suite: 'Google Workspace', mail: 'Gmail', calendar: 'Google Calendar', files: 'Google Drive', meetings: 'Google Meet' },
  microsoft: { suite: 'Microsoft 365', mail: 'Outlook', calendar: 'Outlook Calendar', files: 'SharePoint / OneDrive', meetings: 'Microsoft Teams' },
};

export function normalizeAccountProvider(p: string | null | undefined): WorkspaceProvider | null {
  if (!p) return null;
  if ((GOOGLE_ACCOUNT_PROVIDERS as readonly string[]).includes(p)) return 'google';
  if ((MICROSOFT_ACCOUNT_PROVIDERS as readonly string[]).includes(p)) return 'microsoft';
  return null;
}

export function isWorkspaceProvider(v: unknown): v is WorkspaceProvider {
  return v === 'google' || v === 'microsoft';
}

export interface AccountRow {
  provider: string;
  status?: string | null;
  provider_account_email?: string | null;
}

/** Distinct connected providers, Microsoft first. */
export function connectedProviders(rows: AccountRow[]): WorkspaceProvider[] {
  const out = new Set<WorkspaceProvider>();
  for (const r of rows) {
    if (r.status && r.status !== 'connected') continue;
    const p = normalizeAccountProvider(r.provider);
    if (p) out.add(p);
  }
  return (['microsoft', 'google'] as WorkspaceProvider[]).filter((p) => out.has(p));
}

/** prefer (if connected) > org default (if connected) > first connected; null when none. */
export function pickProvider(
  connected: WorkspaceProvider[],
  opts: { prefer?: WorkspaceProvider | null; orgDefault?: WorkspaceProvider | null } = {}
): WorkspaceProvider | null {
  if (connected.length === 0) return null;
  if (opts.prefer && connected.includes(opts.prefer)) return opts.prefer;
  if (opts.orgDefault && connected.includes(opts.orgDefault)) return opts.orgDefault;
  return connected[0];
}

export interface ProviderState {
  /** Every connected workspace provider for the user. */
  connected: WorkspaceProvider[];
  /** The one to use by default for new mail/events/files (null = none connected). */
  primary: WorkspaceProvider | null;
  /** Connected account address per provider. */
  emails: Partial<Record<WorkspaceProvider, string | null>>;
  /** organizations.default_workspace_provider (null = unset). */
  orgDefault: WorkspaceProvider | null;
  /** Every connected account per provider (`emails.microsoft` / `emails.google` stay the primary's address). */
  accounts: { microsoft: MsAccount[]; google: GoogleAccount[] };
}

export const EMPTY_ACCOUNTS: ProviderState['accounts'] = { microsoft: [], google: [] };

const FILES_PROVIDER_PREF_KEY = 'orion_files_provider';

/** The user's chosen file-storage provider in Media (null = follow the resolver). Per browser. */
export function getFilesProviderPreference(): WorkspaceProvider | null {
  try {
    const v = localStorage.getItem(FILES_PROVIDER_PREF_KEY);
    return isWorkspaceProvider(v) ? v : null;
  } catch {
    return null;
  }
}

export function setFilesProviderPreference(p: WorkspaceProvider | null): void {
  try {
    if (p) localStorage.setItem(FILES_PROVIDER_PREF_KEY, p);
    else localStorage.removeItem(FILES_PROVIDER_PREF_KEY);
  } catch { /* storage unavailable: the choice just won't persist */ }
}

/**
 * Saves the choice for the user (user_preferences.files_provider) as well as this browser, so it
 * follows them to other devices. The local copy is written first: if the column isn't there yet
 * (migration pending) the choice still works in this browser.
 */
export async function saveFilesProviderPreference(userId: string, p: WorkspaceProvider | null): Promise<void> {
  setFilesProviderPreference(p);
  invalidateProviderCache();
  const { error } = await supabase
    .from('user_preferences')
    .upsert({ user_id: userId, files_provider: p, updated_at: new Date().toISOString() }, { onConflict: 'user_id' });
  if (error) console.warn('[files provider] could not save the preference:', error.message);
}

/**
 * Pulls the saved choice into this browser. Returns the effective preference (the saved one when
 * valid, otherwise whatever this browser already had). A changed value drops the provider cache.
 */
export async function loadFilesProviderPreference(userId: string): Promise<WorkspaceProvider | null> {
  const local = getFilesProviderPreference();
  const { data, error } = await supabase
    .from('user_preferences')
    .select('files_provider')
    .eq('user_id', userId)
    .maybeSingle();
  if (error) return local;
  const saved = (data as { files_provider?: string | null } | null)?.files_provider;
  if (!isWorkspaceProvider(saved)) return local;
  if (saved !== local) {
    setFilesProviderPreference(saved);
    invalidateProviderCache();
  }
  return saved;
}

const FILES_MS_CONNECTION_KEY = 'orion_files_ms_connection';

/** The Microsoft account chosen for Media/files (null = the primary). Per browser. */
export function getFilesConnectionPreference(): string | null {
  try {
    return localStorage.getItem(FILES_MS_CONNECTION_KEY) || null;
  } catch {
    return null;
  }
}

export function setFilesConnectionPreference(connectionId: string | null): void {
  try {
    if (connectionId) localStorage.setItem(FILES_MS_CONNECTION_KEY, connectionId);
    else localStorage.removeItem(FILES_MS_CONNECTION_KEY);
  } catch { /* storage unavailable: the choice just won't persist */ }
}

/**
 * The `connection_id` to send with file calls: only for users with 2+ Microsoft accounts and only
 * when the saved choice is still one of them; otherwise undefined (the server uses the primary).
 */
export function resolveFilesConnectionId(accounts: MsAccount[], preference: string | null): string | undefined {
  if (!showAccountPicker(accounts) || !preference) return undefined;
  return accounts.some((a) => a.id === preference) ? preference : undefined;
}

const FILES_GOOGLE_CONNECTION_KEY = 'orion_files_google_connection';

/** The Google account chosen for Media/files (null = the primary). Per browser. */
export function getFilesGoogleConnectionPreference(): string | null {
  try {
    return localStorage.getItem(FILES_GOOGLE_CONNECTION_KEY) || null;
  } catch {
    return null;
  }
}

export function setFilesGoogleConnectionPreference(connectionId: string | null): void {
  try {
    if (connectionId) localStorage.setItem(FILES_GOOGLE_CONNECTION_KEY, connectionId);
    else localStorage.removeItem(FILES_GOOGLE_CONNECTION_KEY);
  } catch { /* storage unavailable: the choice just won't persist */ }
}

let cache: { key: string; at: number; value: Promise<ProviderState> } | null = null;
const TTL_MS = 30_000;

/** Clears the cached state (call after connecting/disconnecting an account). */
export function invalidateProviderCache(): void {
  cache = null;
}

async function loadProviderState(userId: string, organizationId?: string | null): Promise<ProviderState> {
  const [accountsRes, orgRes, msRes, googleRes] = await Promise.all([
    supabase
      .from('user_connected_accounts')
      .select('provider, status, provider_account_email')
      .eq('user_id', userId)
      .in('provider', ALL_ACCOUNT_PROVIDERS),
    organizationId
      ? supabase.from('organizations').select('default_workspace_provider').eq('id', organizationId).maybeSingle()
      : Promise.resolve({ data: null, error: null }),
    // One row per Microsoft account; an error (view not migrated yet) just means no account list.
    supabase.from('microsoft_connection_status').select('*'),
    // Same for Google: one row per account from the token-free status view.
    supabase.from('google_connection_status').select('*'),
  ]);
  const rows = (accountsRes.data || []) as AccountRow[];
  const connected = connectedProviders(rows);
  // Column may not exist until the dual-provider migration is applied: treat errors as "unset".
  const rawDefault = orgRes.error ? null : (orgRes.data as { default_workspace_provider?: string | null } | null)?.default_workspace_provider;
  const orgDefault = isWorkspaceProvider(rawDefault) ? rawDefault : null;
  const emails: ProviderState['emails'] = {};
  for (const r of rows) {
    const p = normalizeAccountProvider(r.provider);
    if (p && (!r.status || r.status === 'connected') && !emails[p]) emails[p] = r.provider_account_email ?? null;
  }
  const msAccounts: MsAccount[] = msRes.error
    ? []
    : shapeAccounts(msRes.data as MsConnectionRow[]).map(({ id, email, label, isPrimary, status, accountType, tenantId }) => ({ id, email, label, isPrimary, status, accountType, tenantId }));
  const googleAccounts: GoogleAccount[] = googleRes.error
    ? []
    : toGoogleAccounts(shapeGoogleAccounts(googleRes.data as GoogleConnectionRow[]));
  return { connected, primary: pickProvider(connected, { orgDefault }), emails, orgDefault, accounts: { microsoft: msAccounts, google: googleAccounts } };
}

/** The signed-in (or given) user's workspace providers. Cached for 30s. */
export async function getProviderState(userId: string, organizationId?: string | null): Promise<ProviderState> {
  const key = `${userId}|${organizationId ?? ''}`;
  if (cache && cache.key === key && Date.now() - cache.at < TTL_MS) return cache.value;
  const value = loadProviderState(userId, organizationId).catch((err) => {
    cache = null;
    throw err;
  });
  cache = { key, at: Date.now(), value };
  return value;
}

/** Convenience: the provider to use for the current user, honouring an explicit preference. */
export async function resolveUserProvider(
  userId: string,
  opts: { organizationId?: string | null; prefer?: WorkspaceProvider | null } = {}
): Promise<WorkspaceProvider | null> {
  const state = await getProviderState(userId, opts.organizationId);
  return pickProvider(state.connected, { prefer: opts.prefer, orgDefault: state.orgDefault });
}

/** Resolves the current auth user id (for services that aren't handed one). */
export async function currentUserId(): Promise<string | null> {
  const { data } = await supabase.auth.getUser();
  return data.user?.id ?? null;
}

/** The current auth user's provider state (empty state when signed out). */
export async function getMyProviderState(organizationId?: string | null): Promise<ProviderState> {
  const uid = await currentUserId();
  if (!uid) return { connected: [], primary: null, emails: {}, orgDefault: null, accounts: EMPTY_ACCOUNTS };
  let orgId = organizationId;
  if (orgId === undefined) {
    const { data } = await supabase.from('users').select('organization_id').eq('id', uid).maybeSingle();
    orgId = (data as { organization_id?: string | null } | null)?.organization_id ?? null;
  }
  return getProviderState(uid, orgId);
}
