import { NavLink, Outlet } from 'react-router-dom';
import { organizationTabs } from '../config/navigation';
import { useAccessibleTabs } from '../hooks/useAccessibleTabs';
import { TABBED_MODULE_CONTEXT } from '../hooks/useInTabbedModule';

// Settings → Organization: Organization, Staff Management and Brandboard as tabs that keep their URLs.
export function OrganizationSettingsLayout() {
  const tabs = useAccessibleTabs(organizationTabs);

  return (
    <div>
      <div className="mb-4">
        <h2 className="text-xl font-semibold text-white">Organization Settings</h2>
        <p className="text-hud-cream-dim mt-1">Manage organization configuration</p>
      </div>

      {tabs.length > 1 && (
        <div className="border-b border-hud-bg-card mb-6">
          <div className="flex gap-1 overflow-x-auto">
            {tabs.map((tab) => {
              const Icon = tab.icon;
              return (
                <NavLink
                  key={tab.path}
                  to={tab.path}
                  className={({ isActive }) => `
                    flex items-center gap-2 px-4 py-3 border-b-2 transition-colors whitespace-nowrap
                    ${isActive ? 'border-hud-gold text-hud-gold-soft' : 'border-transparent text-hud-cream-dim hover:text-white'}
                  `}
                >
                  <Icon className="w-4 h-4" />
                  <span className="font-medium">{tab.name}</span>
                </NavLink>
              );
            })}
          </div>
        </div>
      )}

      <Outlet context={TABBED_MODULE_CONTEXT} />
    </div>
  );
}
