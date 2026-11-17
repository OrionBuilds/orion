// File storage for the Media module, provider-aware (dual-provider product):
//   - Google Workspace users -> `drive-api` (Google Drive)
//   - Microsoft 365 users    -> `sharepoint-api` (SharePoint/OneDrive, a Drive-API-compatible facade)
// The provider comes from the workspace-provider resolver (services/connectedProvider.ts); users with
// neither connected default to the Microsoft path (its connect prompt). The exported names and
// Google-Drive-shaped objects are shared by both backends so the Media UI needs no branching.
import { supabase } from '../lib/supabase';
import { fetchEdge } from '../lib/edgeFunction';
import type { DriveConnection, DriveConnectionStatus } from '../types';
import { pickByConnection, primaryAccount, resolveGoogleConnectionId, showAccountPicker } from '../lib/googleAccounts';
import {
  getFilesConnectionPreference,
  getFilesGoogleConnectionPreference,
  getFilesProviderPreference,
  getMyProviderState,
  pickProvider,
  resolveFilesConnectionId,
  type WorkspaceProvider,
} from './connectedProvider';

const FILES_API_BY_PROVIDER: Record<WorkspaceProvider, string> = {
  google: 'drive-api',
  microsoft: 'sharepoint-api',
};

/** The file-storage provider for the signed-in user (Microsoft when nothing is connected). */
export async function getFilesProvider(): Promise<WorkspaceProvider> {
  try {
    const state = await getMyProviderState();
    // The user's Media choice wins when that provider is connected; otherwise the resolver's pick.
    return pickProvider(state.connected, { prefer: getFilesProviderPreference(), orgDefault: state.orgDefault }) ?? 'microsoft';
  } catch {
    return 'microsoft';
  }
}

export interface GoogleDriveFileInfo {
  id: string;
  name: string;
  mimeType: string;
  size?: string;
  owners?: { emailAddress: string }[];
  parents?: string[];
  thumbnailLink?: string;
  webViewLink?: string;
  iconLink?: string;
  trashed?: boolean;
  createdTime?: string;
  modifiedTime?: string;
  shared?: boolean;
  driveId?: string;
}

export interface GoogleDriveFolderInfo {
  id: string;
  name: string;
  parents?: string[];
}

export interface SharedDriveInfo {
  id: string;
  name: string;
  backgroundImageLink?: string;
  createdTime?: string;
}

/**
 * The account the user picked for files (Microsoft or Google), only for users with 2+ accounts on
 * that provider's drive; undefined otherwise so single-account calls are byte-for-byte what they were.
 */
async function filesConnectionId(provider: WorkspaceProvider): Promise<string | undefined> {
  try {
    const state = await getMyProviderState();
    if (provider === 'microsoft') {
      return resolveFilesConnectionId(state.accounts.microsoft, getFilesConnectionPreference());
    }
    return resolveGoogleConnectionId(state.accounts.google, getFilesGoogleConnectionPreference());
  } catch {
    return undefined;
  }
}

/**
 * The Google account whose Drive the Media page shows: the saved choice, else the primary once the
 * user has 2+ accounts; undefined for a single account (the legacy per-user row).
 */
async function selectedGoogleDriveConnection(): Promise<{ wanted?: string; primary?: string }> {
  try {
    const { accounts } = (await getMyProviderState());
    const google = accounts.google;
    if (!showAccountPicker(google)) return {};
    const primary = primaryAccount(google)?.id;
    return { wanted: resolveGoogleConnectionId(google, getFilesGoogleConnectionPreference()) ?? primary, primary };
  } catch {
    return {};
  }
}

async function callDriveApi(action: string, body?: Record<string, unknown>) {
  const provider = await getFilesProvider();
  const connection_id = await filesConnectionId(provider);
  const response = await fetchEdge(FILES_API_BY_PROVIDER[provider], {
    body: { action, ...body, ...(connection_id ? { connection_id } : {}) },
  });

  if (!response.ok) {
    const err = await response.json().catch(() => ({}));
    throw new Error(err.error || `Files API ${action} failed`);
  }

  return response.json();
}

export async function initiateDriveOAuth(redirectUri?: string): Promise<string> {
  const response = await fetchEdge('drive-oauth-start', {
    body: { redirect_uri: redirectUri || `${window.location.origin}/media` },
  });

  if (!response.ok) {
    const err = await response.json().catch(() => ({}));
    throw new Error(err.error || 'Failed to start Google Drive OAuth');
  }

  const data = await response.json();
  return data.authUrl;
}

export async function autoConnectDrive(
  providerToken: string,
  providerRefreshToken: string
): Promise<{ connected: boolean; email?: string }> {
  const response = await fetchEdge('drive-auto-connect', {
    body: { provider_token: providerToken, provider_refresh_token: providerRefreshToken },
  });

  if (!response.ok) {
    const err = await response.json().catch(() => ({}));
    throw new Error(err.error || 'Failed to auto-connect Drive');
  }

  return response.json();
}

export async function getDriveConnection(
  userId: string
): Promise<DriveConnection | null> {
  if ((await getFilesProvider()) === 'google') {
    // Google Drive: drive-api reads drive_connections (written by google-oauth-unified / drive-oauth),
    // one row per Google account. Token columns are not selected (the UI never needs them).
    const { wanted, primary } = await selectedGoogleDriveConnection();
    const { data, error } = await supabase
      .from('drive_connections')
      .select('id, organization_id, user_id, connected_by, email, token_expiry, scopes, root_folder_id, is_active, created_at, updated_at, connection_id')
      .eq('user_id', userId);
    if (error) throw error;
    return pickByConnection(data as (DriveConnection & { connection_id: string | null })[] | null, wanted, primary);
  }

  // Microsoft: the "drive" connection is the user's Microsoft 365 connection. Read the UI-facing
  // user_connected_accounts (user-readable) — NOT microsoft_oauth_master, which is service-role-only
  // (RLS) and so returns null from the browser, making the Files page look disconnected.
  const { data, error } = await supabase
    .from('user_connected_accounts')
    .select('id, user_id, provider_account_email, connected_at, updated_at')
    .eq('user_id', userId)
    .eq('provider', 'microsoft_365')
    .maybeSingle();

  if (error) throw error;
  if (!data) return null;
  return {
    id: data.id,
    user_id: data.user_id,
    email: data.provider_account_email,
    is_active: true,
    // Token freshness is handled server-side on each call; the UI only needs "connected".
    token_expiry: new Date(Date.now() + 365 * 24 * 3600 * 1000).toISOString(),
    updated_at: data.updated_at || data.connected_at,
  } as unknown as DriveConnection;
}

export async function disconnectDrive(userId: string): Promise<void> {
  if ((await getFilesProvider()) === 'google') {
    // With 2+ Google accounts only the shown account's Drive is switched off.
    const { wanted } = await selectedGoogleDriveConnection();
    let update = supabase
      .from('drive_connections')
      .update({ is_active: false, updated_at: new Date().toISOString() })
      .eq('user_id', userId);
    if (wanted) update = update.eq('connection_id', wanted);
    const { error: connError } = await update;
    if (connError) throw connError;

    if (wanted) {
      const { data: stillActive } = await supabase
        .from('drive_connections')
        .select('id')
        .eq('user_id', userId)
        .eq('is_active', true)
        .limit(1);
      if (stillActive && stillActive.length > 0) return;
    }
    const { error: flagError } = await supabase
      .from('users')
      .update({ google_drive_connected: false, updated_at: new Date().toISOString() })
      .eq('id', userId);
    if (flagError) throw flagError;
    return;
  }
  // Files ride on the Microsoft connection; manage connect/disconnect from the Microsoft card.
  throw new Error('Manage the Microsoft connection from Settings → Connected Accounts.');
}

export async function getConnectionStatus(
  userId: string
): Promise<DriveConnectionStatus> {
  const connection = await getDriveConnection(userId);

  if (!connection || !connection.is_active) {
    return { connected: false, email: null, tokenExpired: false, lastSyncAt: null };
  }

  const expiry = new Date(connection.token_expiry);
  const tokenExpired = expiry.getTime() < Date.now();

  return {
    connected: true,
    email: connection.email,
    tokenExpired,
    lastSyncAt: connection.updated_at,
  };
}

export async function listDriveFilesViaApi(
  folderId: string = 'root',
  pageToken?: string,
  driveId?: string
): Promise<{ files: GoogleDriveFileInfo[]; nextPageToken?: string }> {
  return callDriveApi('list', { folderId, pageToken, driveId });
}

/** A drive a folder can be picked from, for an explicit provider (the project folder picker). */
export interface PickerDrive {
  /** null = Google "My Drive" (no driveId sent). */
  id: string | null;
  name: string;
  /** Folder id that lists the drive's top level. */
  rootId: string;
}

async function callFilesApiFor(provider: WorkspaceProvider, action: string, body?: Record<string, unknown>) {
  // users with 2+ accounts on this provider browse the account they picked; single-account calls are unchanged
  const connectionId = await filesConnectionId(provider);
  const response = await fetchEdge(FILES_API_BY_PROVIDER[provider], { body: { action, ...body, ...(connectionId ? { connection_id: connectionId } : {}) } });
  if (!response.ok) {
    const err = await response.json().catch(() => ({}));
    throw new Error(err.error || `Files API ${action} failed`);
  }
  return response.json();
}

export async function listPickerDrives(provider: WorkspaceProvider): Promise<PickerDrive[]> {
  if (provider === 'google') {
    const data = await callFilesApiFor('google', 'list-shared-drives');
    const shared = ((data.drives || []) as SharedDriveInfo[]).map((d) => ({ id: d.id, name: d.name, rootId: d.id }));
    return [{ id: null, name: 'My Drive', rootId: 'root' }, ...shared];
  }
  const data = await callFilesApiFor('microsoft', 'list-drives');
  return ((data.drives || []) as { id: string; name: string }[]).map((d) => ({ id: d.id, name: d.name, rootId: 'root' }));
}

/** Sub-folders of a folder on an explicit provider/drive. */
export async function listPickerFolders(
  provider: WorkspaceProvider,
  driveId: string | null,
  folderId: string
): Promise<GoogleDriveFileInfo[]> {
  const data = await callFilesApiFor(provider, 'list', { folderId, ...(driveId ? { driveId } : {}) });
  return ((data.files || []) as GoogleDriveFileInfo[]).filter((f) => isFolder(f.mimeType));
}

export async function listSharedDrives(): Promise<SharedDriveInfo[]> {
  if ((await getFilesProvider()) === 'google') {
    const data = await callDriveApi('list-shared-drives');
    return data.drives || [];
  }
  // SharePoint exposes a single shared "Office" library, not multiple shared drives.
  return [];
}

export async function listSharedWithMeViaApi(
  pageToken?: string
): Promise<{ files: GoogleDriveFileInfo[]; nextPageToken?: string }> {
  if ((await getFilesProvider()) === 'google') {
    return callDriveApi('list-shared-with-me', { pageToken });
  }
  // No "shared with me" surface over the shared library facade.
  return { files: [] };
}

export async function searchDriveFilesViaApi(
  query: string,
  mimeTypes?: string[],
  driveId?: string
): Promise<GoogleDriveFileInfo[]> {
  const data = await callDriveApi('search', { query, mimeTypes, driveId });
  return data.files || [];
}

export async function createDriveFolderViaApi(
  name: string,
  parentId: string = 'root',
  driveId?: string
): Promise<GoogleDriveFolderInfo> {
  const data = await callDriveApi('create-folder', { name, parentId, driveId });
  return data.folder || data;
}

export async function deleteDriveFileViaApi(fileId: string): Promise<void> {
  await callDriveApi('delete', { fileId });
}

export async function getDownloadUrl(fileId: string): Promise<{ url: string; accessToken?: string }> {
  // SharePoint returns a pre-authenticated download URL; drive-api returns url + bearer token.
  return callDriveApi('get-download-url', { fileId });
}

export async function uploadFileToDrive(
  file: File,
  parentId: string = 'root',
  driveId?: string
): Promise<GoogleDriveFileInfo> {
  const formData = new FormData();
  formData.append('file', file);

  const params: Record<string, string> = { action: 'upload', parentId };
  if (driveId) params.driveId = driveId;

  const provider = await getFilesProvider();
  const connectionId = await filesConnectionId(provider);
  if (connectionId) params.connection_id = connectionId;

  const response = await fetchEdge(FILES_API_BY_PROVIDER[provider], { body: formData, params });

  if (!response.ok) {
    const err = await response.json().catch(() => ({}));
    throw new Error(err.error || 'Failed to upload file');
  }

  const data = await response.json();
  return data.file || data;
}

export async function shareDriveFile(
  fileId: string,
  email: string,
  role: string = 'reader'
): Promise<void> {
  if ((await getFilesProvider()) === 'google') {
    await callDriveApi('share', { fileId, email, role, type: 'user' });
    return;
  }
  // Per-user grants aren't exposed by the shared-library facade; create an org share link instead.
  await callDriveApi('get-share-link', { fileId });
}

export async function getShareLink(fileId: string): Promise<string> {
  const data = await callDriveApi('get-share-link', { fileId });
  return data.link;
}

export async function downloadDriveFile(fileId: string, fileName: string): Promise<void> {
  const { url, accessToken } = await getDownloadUrl(fileId);
  const response = await fetch(url, {
    headers: accessToken ? { Authorization: `Bearer ${accessToken}` } : {},
  });

  if (!response.ok) throw new Error('Failed to download file');

  const blob = await response.blob();
  const blobUrl = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = blobUrl;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(blobUrl);
}

export function isFolder(mimeType: string): boolean {
  return mimeType === 'application/vnd.google-apps.folder';
}

export function getFileTypeCategory(mimeType: string): string {
  if (mimeType.startsWith('image/')) return 'image';
  if (mimeType.startsWith('video/')) return 'video';
  if (mimeType.startsWith('audio/')) return 'audio';
  if (mimeType === 'application/pdf') return 'pdf';
  if (mimeType.includes('spreadsheet') || mimeType.includes('excel')) return 'spreadsheet';
  if (mimeType.includes('document') || mimeType.includes('word')) return 'document';
  if (mimeType.includes('presentation') || mimeType.includes('powerpoint')) return 'presentation';
  if (mimeType.startsWith('text/')) return 'text';
  return 'other';
}