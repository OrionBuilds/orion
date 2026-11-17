import { ArrowLeft } from 'lucide-react';

export interface DetailTab<T extends string> {
  id: T;
  label: string;
  count?: number;
}

/**
 * Header + tab chrome shared by the record detail pages.
 *
 * Seven pages (Contact, Opportunity, Project, Invoice, Calendar, AI Agent,
 * Workflow Run) each rebuilt the same shell: a back arrow, a title with optional
 * status badges, a subtitle line, an actions cluster, and a tab strip. They had
 * drifted apart on the details — back arrows were w-4 on some pages and w-5 on
 * others, titles ranged from text-lg to text-2xl, and five of the seven declared
 * their tab list inline while two used a local const. Same move as the shared
 * Proposal/Contract detail shell in 59afe85.
 *
 * `badges` and `actions` are slots rather than props with a schema: what belongs
 * there is genuinely page-specific (a lead score, a status pill, a dropdown menu),
 * and encoding that as configuration would be worse than passing nodes.
 */
export function DetailPageShell<T extends string>({
  onBack,
  title,
  badges,
  subtitle,
  actions,
  tabs,
  activeTab,
  onTabChange,
  children,
}: {
  onBack: () => void;
  title: React.ReactNode;
  badges?: React.ReactNode;
  subtitle?: React.ReactNode;
  actions?: React.ReactNode;
  tabs?: DetailTab<T>[];
  activeTab?: T;
  onTabChange?: (id: T) => void;
  children: React.ReactNode;
}) {
  return (
    <div className="h-full flex flex-col md:overflow-hidden">
      <div className="flex-none border-b border-hud-bg-elev bg-hud-bg-card/50">
        <div className="px-3 sm:px-6 py-3 sm:py-4">
          <div className={`flex flex-wrap items-center gap-3${tabs?.length ? ' mb-3' : ''}`}>
            <button
              onClick={onBack}
              aria-label="Back"
              className="p-1.5 text-hud-cream-dim hover:text-white rounded-lg hover:bg-hud-bg-elev transition-colors"
            >
              <ArrowLeft className="w-4 h-4" />
            </button>

            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-3">
                <h1 className="text-lg font-semibold text-white truncate">{title}</h1>
                {badges}
              </div>
              {subtitle && <p className="text-sm text-hud-cream-dim mt-0.5 truncate">{subtitle}</p>}
            </div>

            {actions && <div className="flex flex-wrap items-center gap-2 w-full sm:w-auto">{actions}</div>}
          </div>

          {tabs && tabs.length > 0 && (
            <nav className="flex gap-1 overflow-x-auto">
              {tabs.map((tab) => (
                <button
                  key={tab.id}
                  onClick={() => onTabChange?.(tab.id)}
                  className={`px-4 py-2 text-sm font-medium rounded-t-lg transition-colors whitespace-nowrap ${
                    activeTab === tab.id
                      ? 'bg-hud-bg-mid text-white border-t border-l border-r border-hud-bg-elev'
                      : 'text-hud-cream-dim hover:text-white hover:bg-hud-bg-elev/50'
                  }`}
                >
                  {tab.label}
                  {tab.count !== undefined && (
                    <span className="ml-1.5 text-xs text-hud-cream-mute">{tab.count}</span>
                  )}
                </button>
              ))}
            </nav>
          )}
        </div>
      </div>

      <div className="flex-1 min-h-0 flex flex-col md:flex-row md:overflow-hidden">{children}</div>
    </div>
  );
}
