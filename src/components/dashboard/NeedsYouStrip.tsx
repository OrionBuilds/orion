import { Link } from 'react-router-dom';
import { ClipboardCheck, MessageSquare, Bot, CalendarDays } from 'lucide-react';
import { useAuth } from '../../contexts/AuthContext';
import { useUnreadCount } from '../../hooks/useUnreadCount';
import { usePendingApprovalCount } from '../../hooks/usePendingApprovalCount';

type Tile = { key: string; to: string; label: string; value?: number; icon: typeof Bot; hot: boolean; show: boolean };

/** What needs the owner on a phone, one tap each: approvals waiting, unread messages, the agent threads, today's schedule. */
export function NeedsYouStrip() {
  const { hasPermission, isFeatureEnabled } = useAuth();
  const { unreadCount } = useUnreadCount();
  const { count: approvals } = usePendingApprovalCount();

  const tiles: Tile[] = [
    { key: 'approvals', to: '/automation/approvals', label: approvals === 1 ? 'Approval waiting' : 'Approvals waiting', value: approvals, icon: ClipboardCheck, hot: approvals > 0,
      show: hasPermission('automation.view') && isFeatureEnabled('automation') },
    { key: 'unread', to: '/conversations', label: 'Unread messages', value: unreadCount, icon: MessageSquare, hot: unreadCount > 0,
      show: hasPermission('conversations.view') && isFeatureEnabled('conversations') },
    { key: 'clara', to: '/clara', label: 'Ask Clara', icon: Bot, hot: false,
      show: hasPermission('personal_assistant.view') && hasPermission('conversations.view') },
    { key: 'today', to: '/calendars', label: "Today's schedule", icon: CalendarDays, hot: false,
      show: hasPermission('calendars.view') && isFeatureEnabled('calendars') },
  ].filter((t) => t.show);
  if (tiles.length === 0) return null;

  return (
    <section aria-label="Needs you" className="grid grid-cols-2 gap-2 sm:hidden" data-testid="needs-you">
      {tiles.map((t) => {
        const Icon = t.icon;
        return (
          <Link
            key={t.key}
            to={t.to}
            className={`flex items-center gap-3 rounded-xl border px-3 py-3 touch-manipulation active:scale-[0.98] transition ${
              t.hot ? 'border-hud-gold/50 bg-hud-gold/10' : 'border-hud-bg-elev bg-hud-bg-card'
            }`}
          >
            <Icon className={`w-5 h-5 shrink-0 ${t.hot ? 'text-hud-gold-soft' : 'text-hud-cream-dim'}`} />
            <div className="min-w-0">
              {t.value !== undefined && <p className={`text-lg font-semibold leading-none ${t.hot ? 'text-white' : 'text-hud-cream-soft'}`}>{t.value}</p>}
              <p className={`text-xs ${t.value !== undefined ? 'mt-1' : ''} text-hud-cream-dim truncate`}>{t.label}</p>
            </div>
          </Link>
        );
      })}
    </section>
  );
}
