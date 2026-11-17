import { Suspense } from 'react';
import { NavLink, Outlet, useLocation } from 'react-router-dom';
import { Target, GitBranch } from 'lucide-react';
import { PageLoader } from '../components/shared/PageLoader';
import { FILL_MAIN_HEIGHT_MD } from './appShell';

const tabs = [
  { path: '/opportunities', label: 'Opportunities', icon: Target, exact: true },
  { path: '/opportunities/pipelines', label: 'Pipelines', icon: GitBranch },
];

export function OpportunitiesLayout() {
  const location = useLocation();

  const isActiveTab = (path: string, exact?: boolean) => {
    if (exact) {
      return location.pathname === path || location.pathname === '/opportunities/list';
    }
    return location.pathname.startsWith(path);
  };

  return (
    // Fixed height on md+ so the board's columns (and the Pipelines tab's own scroll areas)
    // scroll inside the page instead of growing it -- see appShell.ts.
    <div className={`h-full ${FILL_MAIN_HEIGHT_MD} min-w-0 flex flex-col`}>
      <div className="flex-none border-b border-hud-bg-elev bg-hud-bg-card/50">
        <div className="px-3 sm:px-6 pt-2">
          <h1 className="hidden sm:block text-xl font-semibold text-white mb-2">Opportunities</h1>
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
