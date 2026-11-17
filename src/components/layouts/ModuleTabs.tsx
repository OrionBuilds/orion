import { Navigate, NavLink, useLocation } from 'react-router-dom';
import { useAccessibleTabs } from '../../hooks/useAccessibleTabs';
import type { NavTab } from '../../config/navigation';

/** Index route for a tabbed module: lands on the first tab the user can open. */
export function FirstAccessibleTab({ tabs }: { tabs: NavTab[] }) {
  const accessible = useAccessibleTabs(tabs);
  return <Navigate to={accessible[0]?.path ?? '/unauthorized'} replace />;
}

/**
 * Pill tab bar for modules whose tabs are separate routes (Documents).
 * Renders nothing when the user can open fewer than two tabs.
 */
export function ModuleTabs({ tabs }: { tabs: NavTab[] }) {
  const { pathname } = useLocation();
  const accessible = useAccessibleTabs(tabs);
  if (accessible.length < 2) return null;

  // Longest match wins, so a nested tab path beats its parent tab.
  const activePath = accessible
    .map((tab) => tab.path)
    .filter((path) => pathname === path || pathname.startsWith(path + '/'))
    .sort((a, b) => b.length - a.length)[0];

  return (
    <nav className="flex flex-wrap items-center gap-2">
      {accessible.map((tab) => {
        const Icon = tab.icon;
        const active = tab.path === activePath;
        return (
          <NavLink
            key={tab.path}
            to={tab.path}
            className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
              active
                ? 'bg-hud-gold text-hud-bg-deep'
                : 'bg-hud-bg-card text-hud-cream-soft hover:bg-hud-bg-elev hover:text-white'
            }`}
          >
            <Icon className="w-4 h-4" />
            {tab.name}
          </NavLink>
        );
      })}
    </nav>
  );
}
