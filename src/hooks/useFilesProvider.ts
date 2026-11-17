import { useCallback, useEffect, useState } from 'react';
import { primaryAccount, showAccountPicker, type MsAccount } from '../lib/microsoftAccounts';
import { resolveGoogleConnectionId, type GoogleAccount } from '../lib/googleAccounts';
import { useAuth } from '../contexts/AuthContext';
import { useWorkspaceProvider } from './useWorkspaceProvider';
import {
  getFilesConnectionPreference,
  getFilesGoogleConnectionPreference,
  getFilesProviderPreference,
  resolveFilesConnectionId,
  setFilesConnectionPreference,
  setFilesGoogleConnectionPreference,
  loadFilesProviderPreference,
  pickProvider,
  saveFilesProviderPreference,
  type WorkspaceProvider,
} from '../services/connectedProvider';

export interface DriveOption {
  provider: WorkspaceProvider;
  connected: boolean;
  email: string | null;
}

/** Both drives, Microsoft first, with whether each is connected for this user. */
export function buildDriveOptions(
  connected: WorkspaceProvider[],
  emails: Partial<Record<WorkspaceProvider, string | null>>
): DriveOption[] {
  return (['microsoft', 'google'] as WorkspaceProvider[]).map((provider) => ({
    provider,
    connected: connected.includes(provider),
    email: emails[provider] ?? null,
  }));
}

/**
 * The cloud drive the user is working in: their saved choice when that drive is connected, else the
 * org default, else the first connected. `select` saves the choice (per user, and in this browser)
 * and returns false, without changing anything, when that drive isn't connected yet.
 */
export function useFilesProvider() {
  const { user } = useAuth();
  const ws = useWorkspaceProvider();
  const [preference, setPreference] = useState<WorkspaceProvider | null>(() => getFilesProviderPreference());

  const userId = user?.id;
  useEffect(() => {
    if (!userId) return;
    let cancelled = false;
    loadFilesProviderPreference(userId).then((p) => { if (!cancelled) setPreference(p); }).catch(() => {});
    return () => { cancelled = true; };
  }, [userId]);

  const provider = pickProvider(ws.connected, { prefer: preference, orgDefault: ws.orgDefault });
  const options = buildDriveOptions(ws.connected, ws.emails);

  const select = useCallback((p: WorkspaceProvider): boolean => {
    if (!ws.connected.includes(p)) return false;
    setPreference(p);
    if (userId) void saveFilesProviderPreference(userId, p);
    return true;
  }, [ws.connected, userId]);

  // Which Microsoft account the files calls use (only meaningful with 2+ accounts).
  const [connectionPref, setConnectionPref] = useState<string | null>(() => getFilesConnectionPreference());
  const msAccounts = ws.accounts.microsoft;
  const connectionId = resolveFilesConnectionId(msAccounts, connectionPref) ?? primaryAccount(msAccounts)?.id ?? null;
  const selectConnection = useCallback((id: string): boolean => {
    if (!msAccounts.some((a) => a.id === id)) return false;
    setConnectionPref(id);
    setFilesConnectionPreference(id);
    return true;
  }, [msAccounts]);

  // Same for Google Drive (only meaningful with 2+ Google accounts).
  const [googlePref, setGooglePref] = useState<string | null>(() => getFilesGoogleConnectionPreference());
  const googleAccounts = ws.accounts.google;
  const googleConnectionId = resolveGoogleConnectionId(googleAccounts, googlePref) ?? primaryAccount(googleAccounts)?.id ?? null;
  const selectGoogleConnection = useCallback((id: string): boolean => {
    if (!googleAccounts.some((a) => a.id === id)) return false;
    setGooglePref(id);
    setFilesGoogleConnectionPreference(id);
    return true;
  }, [googleAccounts]);

  return {
    provider, options, connected: ws.connected, loading: ws.loading, refresh: ws.refresh, select,
    /** Microsoft accounts to pick from; the picker shows only when `showAccounts`. */
    msAccounts: msAccounts as MsAccount[],
    showAccounts: provider === 'microsoft' && showAccountPicker(msAccounts),
    connectionId,
    selectConnection,
    /** Google accounts to pick from; the picker shows only when `showGoogleAccounts`. */
    googleAccounts: googleAccounts as GoogleAccount[],
    showGoogleAccounts: provider === 'google' && showAccountPicker(googleAccounts),
    googleConnectionId,
    selectGoogleConnection,
  };
}
