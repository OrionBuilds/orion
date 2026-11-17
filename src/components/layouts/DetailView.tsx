import { type ReactNode } from 'react';
import { ArrowLeft, type LucideIcon } from 'lucide-react';
import { useNavigate } from 'react-router-dom';

interface Tab {
  id: string;
  label: string;
  icon?: LucideIcon;
}

interface Action {
  label: string;
  icon?: LucideIcon;
  onClick: () => void;
  variant?: 'primary' | 'secondary' | 'danger';
}

interface DetailViewProps {
  title: string;
  subtitle?: string;
  backPath?: string;
  tabs?: Tab[];
  activeTab?: string;
  onTabChange?: (tabId: string) => void;
  actions?: Action[];
  children: ReactNode;
  stickyHeader?: boolean;
}

export function DetailView({
  title,
  subtitle,
  backPath,
  tabs,
  activeTab,
  onTabChange,
  actions,
  children,
  stickyHeader = false,
}: DetailViewProps) {
  const navigate = useNavigate();

  return (
    <div className="flex flex-col h-full">
      <div
        className={`bg-hud-bg-mid border-b border-hud-bg-card ${
          stickyHeader ? 'sticky top-0 z-10' : ''
        }`}
      >
        <div className="px-6 py-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-4">
              {backPath && (
                <button
                  onClick={() => navigate(backPath)}
                  className="p-2 rounded-lg hover:bg-hud-bg-card transition-colors text-hud-cream-dim hover:text-white"
                >
                  <ArrowLeft className="w-5 h-5" />
                </button>
              )}
              <div>
                <h1 className="text-xl font-semibold text-white">{title}</h1>
                {subtitle && <p className="text-sm text-hud-cream-dim mt-0.5">{subtitle}</p>}
              </div>
            </div>

            {actions && actions.length > 0 && (
              <div className="flex items-center gap-2">
                {actions.map((action, index) => {
                  const Icon = action.icon;
                  const variantClasses = {
                    primary:
                      'bg-gradient-to-r from-hud-gold to-hud-teal text-white hover:from-hud-gold-deep hover:to-hud-teal shadow-lg shadow-hud-gold/25',
                    secondary: 'bg-hud-bg-card text-hud-cream-soft hover:bg-hud-bg-elev',
                    danger: 'bg-hud-plum/10 text-hud-plum hover:bg-hud-plum/20',
                  };
                  return (
                    <button
                      key={index}
                      onClick={action.onClick}
                      className={`px-4 py-2 rounded-lg transition-all font-medium text-sm flex items-center gap-2 ${
                        variantClasses[action.variant || 'secondary']
                      }`}
                    >
                      {Icon && <Icon className="w-4 h-4" />}
                      {action.label}
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        </div>

        {tabs && tabs.length > 0 && onTabChange && (
          <div className="px-6 -mb-px">
            <nav className="flex gap-1">
              {tabs.map((tab) => {
                const Icon = tab.icon;
                const isActive = tab.id === activeTab;
                return (
                  <button
                    key={tab.id}
                    onClick={() => onTabChange(tab.id)}
                    className={`px-4 py-3 text-sm font-medium transition-colors border-b-2 flex items-center gap-2 ${
                      isActive
                        ? 'text-hud-gold-soft border-hud-gold-soft'
                        : 'text-hud-cream-dim border-transparent hover:text-white hover:border-hud-cream-mute'
                    }`}
                  >
                    {Icon && <Icon className="w-4 h-4" />}
                    {tab.label}
                  </button>
                );
              })}
            </nav>
          </div>
        )}
      </div>

      <div className="flex-1 p-6">{children}</div>
    </div>
  );
}
