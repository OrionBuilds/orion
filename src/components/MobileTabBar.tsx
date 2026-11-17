import { NavLink, useLocation } from 'react-router-dom';
import { Home, MessageSquare, ClipboardCheck, Calendar, Bot } from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';
import { useDevice } from '../contexts/DeviceContext';
import { useUnreadCount } from '../hooks/useUnreadCount';
import { usePendingApprovalCount } from '../hooks/usePendingApprovalCount';

export interface TabDef {
  key: string;
  label: string;
  path: string;
  icon: typeof Home;
  permission?: string;
  featureFlag?: string;
}

/**
 * Thumb-reach navigation for phones, ordered by what the owner does from a phone: talk to Clara, read and answer messages,
 * approve what the agents drafted, check the day. Everything else (Contacts, Projects, Documents ...) is in the menu (top left).
 */
export const MOBILE_TABS: TabDef[] = [
  { key: 'home', label: 'Home', path: '/', icon: Home },
  { key: 'clara', label: 'Clara', path: '/clara', icon: Bot, permission: 'personal_assistant.view' },
  { key: 'conversations', label: 'Inbox', path: '/conversations', icon: MessageSquare, permission: 'conversations.view', featureFlag: 'conversations' },
  { key: 'approvals', label: 'Approvals', path: '/automation/approvals', icon: ClipboardCheck, permission: 'automation.view', featureFlag: 'automation' },
  { key: 'calendars', label: 'Calendar', path: '/calendars', icon: Calendar, permission: 'calendars.view', featureFlag: 'calendars' },
];

/** Tabs the user may open (same permission + feature-flag rules as the sidebar). */
export function visibleTabs(
  tabs: TabDef[],
  can: { hasPermission: (p: never) => boolean; isFeatureEnabled: (f: string) => boolean },
): TabDef[] {
  return tabs.filter((t) =>
    (!t.permission || can.hasPermission(t.permission as never)) && (!t.featureFlag || can.isFeatureEnabled(t.featureFlag)));
}

export function isTabActive(pathname: string, path: string): boolean {
  return path === '/' ? pathname === '/' : pathname === path || pathname.startsWith(path + '/');
}

export function MobileTabBar() {
  const { device } = useDevice();
  const { hasPermission, isFeatureEnabled } = useAuth();
  const { unreadCount } = useUnreadCount();
  const { count: pendingApprovals } = usePendingApprovalCount(device === 'phone');
  const { pathname } = useLocation();
  if (device !== 'phone') return null;

  const tabs = visibleTabs(MOBILE_TABS, { hasPermission: hasPermission as (p: never) => boolean, isFeatureEnabled });
  const base = 'flex-1 flex flex-col items-center justify-center gap-0.5 min-w-0 text-[11px] font-medium touch-manipulation transition-colors';

  return (
    <nav
      aria-label="Primary"
      className="fixed bottom-0 inset-x-0 z-30 hud-glass-panel border-t border-hud-line-soft pb-safe pl-safe pr-safe flex"
      style={{ height: 'calc(var(--tabbar-h) + var(--safe-bottom))' }}
    >
      {tabs.map((t) => {
        const active = isTabActive(pathname, t.path);
        const Icon = t.icon;
        const badge = t.key === 'conversations' ? unreadCount : t.key === 'approvals' ? pendingApprovals : 0;
        return (
          <NavLink
            key={t.key}
            to={t.path}
            aria-current={active ? 'page' : undefined}
            className={`${base} ${active ? 'text-hud-gold' : 'text-hud-cream-dim'}`}
          >
            <span className="relative">
              <Icon className="w-5 h-5" />
              {badge > 0 && (
                <span className="absolute -top-1.5 -right-2.5 min-w-[16px] h-4 px-1 bg-hud-plum text-hud-cream text-[10px] font-semibold rounded-full flex items-center justify-center">
                  {badge > 99 ? '99+' : badge}
                </span>
              )}
            </span>
            <span className="truncate">{t.label}</span>
          </NavLink>
        );
      })}
    </nav>
  );
}
