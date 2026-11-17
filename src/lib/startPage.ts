/**
 * Start page (Profile → Preferences → "Start Page"): where the user lands after signing in or on
 * opening the app at "/". The choices are the sidebar's modules (src/config/navigation.ts) that the
 * user can open; user_preferences.default_landing_page stores the chosen path.
 */
import { navigationConfig, type NavTab } from '../config/navigation';

/** Stored value for the dashboard (the column's default); the dashboard itself lives at "/". */
export const DASHBOARD_START_PAGE = '/dashboard';

export interface StartPageOption {
  path: string;
  label: string;
  group: string;
}

/** Same test as the sidebar: permission granted and feature flag (if any) on. */
export type CanOpenNavEntry = (entry: Pick<NavTab, 'path' | 'permission' | 'featureFlag'>) => boolean;

export function getStartPageOptions(canOpen: CanOpenNavEntry): StartPageOption[] {
  const options: StartPageOption[] = [{ path: DASHBOARD_START_PAGE, label: 'Dashboard', group: 'General' }];
  for (const section of navigationConfig) {
    const group = section.title ?? '';
    for (const item of section.items) {
      if (item.tabs) {
        // Tabbed modules (Documents) offer each tab, since each tab is its own page.
        for (const tab of item.tabs.filter(canOpen)) options.push({ path: tab.path, label: tab.name, group });
      } else if (canOpen(item)) {
        options.push({ path: item.path, label: item.name, group });
      }
    }
  }
  return options;
}

/** Where "/" should send the user, or null to stay on the dashboard (unset, dashboard, or no longer accessible). */
export function resolveStartPage(saved: string | null | undefined, canOpen: CanOpenNavEntry): string | null {
  if (!saved || saved === '/' || saved === DASHBOARD_START_PAGE) return null;
  return getStartPageOptions(canOpen).some((o) => o.path === saved) ? saved : null;
}

// The start page applies once per entry into the app: opening it at "/" (a fresh load) or signing
// in without a deep link. Later visits to "/" (the sidebar's Dashboard link) show the dashboard.
let startPagePending = typeof window !== 'undefined' && window.location.pathname === '/';

export function requestStartPage(): void {
  startPagePending = true;
}

export function isStartPagePending(): boolean {
  return startPagePending;
}

export function clearStartPagePending(): void {
  startPagePending = false;
}
