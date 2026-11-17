import { Suspense } from 'react';
import { NavLink, Outlet, useLocation } from 'react-router-dom';
import { FolderKanban, List, GitBranch, TrendingUp } from 'lucide-react';
import { usePaymentsAccess } from '../hooks/usePaymentsAccess';
import { PageLoader } from '../components/shared/PageLoader';
import { FILL_MAIN_HEIGHT_MD } from './appShell';

const allTabs = [
  { path: '/projects', label: 'Board', icon: FolderKanban, exact: true },
  { path: '/projects/list', label: 'List', icon: List },
  { path: '/projects/pipelines', label: 'Pipelines', icon: GitBranch },
  { path: '/projects/profitability', label: 'Profitability', icon: TrendingUp },
];

export function ProjectsLayout() {
  const location = useLocation();
  const canAccessPayments = usePaymentsAccess();

  const tabs = canAccessPayments
    ? allTabs
    : allTabs.filter((t) => t.path !== '/projects/profitability');

  const isActiveTab = (path: string, exact?: boolean) => {
    if (exact) {
      return location.pathname === path;
    }
    return location.pathname.startsWith(path);
  };

  return (
    // Fixed height on md+ so the Board tab's columns (and the List/Pipelines tabs' own scroll
    // areas) scroll inside the page instead of growing it -- see appShell.ts.
    <div className={`h-full ${FILL_MAIN_HEIGHT_MD} min-w-0 flex flex-col`}>
      <div className="flex-none border-b border-hud-bg-elev bg-hud-bg-card/50">
        <div className="px-3 sm:px-6 pt-2">
          <h1 className="hidden sm:block text-xl font-semibold text-white mb-2">Project Manager</h1>
          <nav className="flex gap-1 overflow-x-auto">
            {tabs.map((tab) => {
              const Icon = tab.icon;
              const active = isActiveTab(tab.path, tab.exact);
              return (
                <NavLink
                  key={tab.path}
                  to={tab.path}
                  className={`flex shrink-0 whitespace-nowrap items-center gap-2 px-4 py-2.5 text-sm font-medium rounded-t-lg transition-colors ${
                    active
                      ? 'bg-hud-bg-mid text-white border-t border-l border-r border-hud-bg-elev'
                      : 'text-hud-cream-dim hover:text-white hover:bg-hud-bg-elev/50'
                  }`}
                >
                  <Icon className="w-4 h-4" />
                  {tab.label}
                </NavLink>
              );
            })}
          </nav>
        </div>
      </div>
      <div className="flex-1 overflow-hidden">
        <Suspense fallback={<PageLoader />}>
          <Outlet />
        </Suspense>
      </div>
    </div>
  );
}
