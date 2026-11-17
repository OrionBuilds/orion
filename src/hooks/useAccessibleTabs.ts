import { useAuth } from '../contexts/AuthContext';
import type { NavTab } from '../config/navigation';

/** Tabs the current user may open: permission granted and feature flag (if any) enabled. */
export function useAccessibleTabs(tabs: NavTab[]): NavTab[] {
  const { hasPermission, isFeatureEnabled } = useAuth();
  return tabs.filter(
    (tab) => hasPermission(tab.permission) && (!tab.featureFlag || isFeatureEnabled(tab.featureFlag))
  );
}
