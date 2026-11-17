import { useCallback, useEffect, useState } from 'react';
import { useAuth } from '../contexts/AuthContext';
import {
  EMPTY_ACCOUNTS,
  getProviderState,
  invalidateProviderCache,
  type ProviderState,
} from '../services/connectedProvider';

const EMPTY: ProviderState = { connected: [], primary: null, emails: {}, orgDefault: null, accounts: EMPTY_ACCOUNTS };

/**
 * The signed-in user's connected workspace providers (Google Workspace / Microsoft 365).
 * `primary` is the one new mail/events/files go to by default.
 */
export function useWorkspaceProvider(): ProviderState & { loading: boolean; refresh: () => void } {
  const { user } = useAuth();
  const [state, setState] = useState<ProviderState>(EMPTY);
  const [loading, setLoading] = useState(true);
  const [nonce, setNonce] = useState(0);

  const userId = user?.id;
  const orgId = user?.organization?.id ?? user?.organization_id ?? null;

  useEffect(() => {
    let cancelled = false;
    if (!userId) {
      setState(EMPTY);
      setLoading(false);
      return;
    }
    setLoading(true);
    getProviderState(userId, orgId)
      .then((s) => { if (!cancelled) setState(s); })
      .catch(() => { if (!cancelled) setState(EMPTY); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [userId, orgId, nonce]);

  const refresh = useCallback(() => {
    invalidateProviderCache();
    setNonce((n) => n + 1);
  }, []);

  return { ...state, loading, refresh };
}
