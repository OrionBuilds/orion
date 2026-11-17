import { NavLink, useLocation } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthContext';
import { organizationTabs, type NavTab } from '../../config/navigation';
import type { PermissionKey } from '../../types';
import {
  User,
  Building2,
  Calendar,
  Bot,
  Mail,
  Phone,
  Zap,
  LayoutList,
  Braces,
  Target,
  Video,
  HeartPulse,
  Database,
  CreditCard,
  Download,
  LucideIcon,
} from 'lucide-react';

interface SettingsNavItem {
  name: string;
  path: string;
  icon: LucideIcon;
  requiresPermission?: PermissionKey;
  /** Section made of tabs: shown when any tab is accessible, links to the first, active on all. */
  tabs?: NavTab[];
}

interface SettingsNavSection {
  title: string;
  items: SettingsNavItem[];
}

const settingsNavSections: SettingsNavSection[] = [
  {
    title: 'Personal',
    items: [
      {
        name: 'My Profile',
        path: '/settings/profile',
        icon: User,
      },
    ],
  },
  {
    title: 'Organization',
    items: [
      // Staff Management and Brandboard are tabs inside Organization (see OrganizationSettingsLayout).
      {
        name: 'Organization',
        path: '/settings/organization',
        icon: Building2,
        tabs: organizationTabs,
      },
    ],
  },
  {
    title: 'Communication',
    items: [
      {
        name: 'Calendars',
        path: '/settings/calendars',
        icon: Calendar,
      },
      {
        name: 'Email Services',
        path: '/settings/email-services',
        icon: Mail,
      },
      {
        name: 'Payments',
        path: '/settings/payments',
        icon: CreditCard,
        requiresPermission: 'payments.manage',
      },
      {
        name: 'Phone System',
        path: '/settings/phone-system',
        icon: Phone,
        requiresPermission: 'phone.settings.view',
      },
    ],
  },
  {
    title: 'AI & Automation',
    items: [
      {
        name: 'AI Agents',
        path: '/settings/ai-agents',
        icon: Bot,
        requiresPermission: 'ai.settings.view',
      },
      // The old "Clara Assistant" settings page (/settings/assistant) is deleted; Clara lives in the
      // pinned agent threads in Conversations.
    ],
  },
  {
    title: 'Data & Fields',
    items: [
      {
        name: 'Custom Fields',
        path: '/settings/custom-fields',
        icon: LayoutList,
      },
      {
        name: 'Custom Objects',
        path: '/settings/custom-objects',
        icon: Database,
      },
      {
        name: 'Lead Scoring',
        path: '/settings/scoring',
        icon: Target,
      },
    ],
  },
  {
    title: 'Developer',
    items: [
      {
        name: 'Custom Values',
        path: '/settings/custom-values',
        icon: Braces,
      },
      {
        name: 'Integrations',
        path: '/settings/integrations',
        icon: Zap,
      },
      {
        name: 'Data Migration',
        path: '/settings/migration',
        icon: Download,
        requiresPermission: 'settings.manage',
      },
    ],
  },
  {
    title: 'System',
    items: [
      {
        name: 'System Health',
        path: '/settings/system/crud-health-check',
        icon: HeartPulse,
        requiresPermission: 'audit.view',
      },
      {
        name: 'Meeting Processing',
        path: '/settings/system/meet-processing',
        icon: Video,
        requiresPermission: 'audit.view',
      },
    ],
  },
];

interface SettingsNavProps {
  onNavigate?: () => void;
}

export function SettingsNav({ onNavigate }: SettingsNavProps) {
  const { hasPermission, isFeatureEnabled } = useAuth();
  const { pathname } = useLocation();

  const canOpenTab = (tab: NavTab) =>
    hasPermission(tab.permission) && (!tab.featureFlag || isFeatureEnabled(tab.featureFlag));

  const visibleSections = settingsNavSections
    .map((section) => ({
      ...section,
      items: section.items
        .filter((item) => {
          if (item.tabs) return item.tabs.some(canOpenTab);
          if (item.requiresPermission && !hasPermission(item.requiresPermission)) {
            return false;
          }
          return true;
        })
        // A tabbed entry links to the first tab the user can open.
        .map((item) => (item.tabs ? { ...item, path: item.tabs.find(canOpenTab)!.path } : item)),
    }))
    .filter((section) => section.items.length > 0);

  const isTabbedActive = (item: SettingsNavItem) =>
    item.tabs!.some((tab) => pathname === tab.path || pathname.startsWith(tab.path + '/'));

  return (
    <nav className="flex flex-col gap-6 p-4">
      {visibleSections.map((section) => (
        <div key={section.title}>
          <h3 className="px-4 mb-2 text-xs font-semibold text-hud-cream-mute uppercase tracking-wider">
            {section.title}
          </h3>
          <div className="space-y-1">
            {section.items.map((item) => {
              const Icon = item.icon;
              return (
                <NavLink
                  key={item.path}
                  to={item.path}
                  onClick={onNavigate}
                  className={({ isActive }) =>
                    `flex items-center gap-3 px-4 py-2.5 rounded-lg transition-colors ${
                      (item.tabs ? isTabbedActive(item) : isActive)
                        ? 'bg-gradient-to-r from-hud-gold/10 to-hud-teal/10 border border-hud-gold/20 text-hud-gold-soft'
                        : 'text-hud-cream-dim hover:text-white hover:bg-hud-bg-card'
                    }`
                  }
                >
                  <Icon className="w-5 h-5 flex-shrink-0" />
                  <span className="font-medium">{item.name}</span>
                </NavLink>
              );
            })}
          </div>
        </div>
      ))}
    </nav>
  );
}
