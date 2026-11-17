import { useCallback, useMemo } from 'react';
import { useAuth } from '../contexts/AuthContext';
import { usePaymentsAccess } from './usePaymentsAccess';
import { getStartPageOptions, type CanOpenNavEntry, type StartPageOption } from '../lib/startPage';

/** The sidebar's access test (permission, feature flag, Payments allow-list) as a function. */
export function useCanOpenNavEntry(): CanOpenNavEntry {
  const { hasPermission, isFeatureEnabled } = useAuth();
  const canAccessPayments = usePaymentsAccess();
  return useCallback<CanOpenNavEntry>(
    (entry) =>
      (entry.path !== '/payments' || canAccessPayments) &&
      hasPermission(entry.permission) &&
      (!entry.featureFlag || isFeatureEnabled(entry.featureFlag)),
    [hasPermission, isFeatureEnabled, canAccessPayments]
  );
}

/** Start-page choices for the signed-in user: Dashboard plus every module they can open. */
export function useStartPageOptions(): StartPageOption[] {
  const canOpen = useCanOpenNavEntry();
  return useMemo(() => getStartPageOptions(canOpen), [canOpen]);
}
