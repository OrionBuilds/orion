import {
  UserPlus,
  MessageSquare,
  Target,
  Calendar,
  FileText,
  Bot,
  ClipboardCheck,
  Send,
  Trophy,
  XCircle,
  ArrowRight,
} from 'lucide-react';
import type { ActivityLogEntry, ActivityFilter, EventType } from '../../services/activityLog';

interface ActivityFeedProps {
  events: ActivityLogEntry[];
  activeFilter: ActivityFilter;
  onFilterChange: (filter: ActivityFilter) => void;
  onItemClick?: (event: ActivityLogEntry) => void;
  isLoading?: boolean;
}

const filterTabs: { value: ActivityFilter; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'mine', label: 'Mine' },
  { value: 'team', label: 'Team' },
];

const eventIcons: Record<string, typeof UserPlus> = {
  contact: UserPlus,
  conversation: MessageSquare,
  message: Send,
  opportunity: Target,
  opportunity_won: Trophy,
  opportunity_lost: XCircle,
  opportunity_stage: ArrowRight,
  appointment: Calendar,
  invoice: FileText,
  ai_agent: Bot,
  task: ClipboardCheck,
};

const eventColors: Record<string, string> = {
  contact: 'bg-hud-gold/10 text-hud-gold-soft',
  conversation: 'bg-hud-teal/10 text-hud-teal',
  message: 'bg-hud-teal/10 text-hud-teal',
  opportunity: 'bg-hud-rust/10 text-hud-rust',
  appointment: 'bg-rose-500/10 text-rose-400',
  invoice: 'bg-hud-emerald/10 text-hud-emerald',
  ai_agent: 'bg-violet-500/10 text-violet-400',
  task: 'bg-blue-500/10 text-blue-400',
};

function getIconForEvent(eventType: EventType) {
  if (eventType.includes('opportunity_won')) return eventIcons.opportunity_won;
  if (eventType.includes('opportunity_lost')) return eventIcons.opportunity_lost;
  if (eventType.includes('opportunity_stage')) return eventIcons.opportunity_stage;
  if (eventType.includes('message')) return eventIcons.message;

  const baseType = eventType.split('_')[0];
  return eventIcons[baseType] || MessageSquare;
}

function getColorForEvent(eventType: EventType) {
  const baseType = eventType.split('_')[0];
  return eventColors[baseType] || 'bg-hud-cream-mute/10 text-hud-cream-dim';
}

function formatTimeAgo(dateString: string): string {
  const date = new Date(dateString);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMins / 60);
  const diffDays = Math.floor(diffHours / 24);

  if (diffMins < 1) return 'Just now';
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  if (diffDays < 7) return `${diffDays}d ago`;
  return date.toLocaleDateString();
}

export function ActivityFeed({
  events,
  activeFilter,
  onFilterChange,
  onItemClick,
  isLoading,
}: ActivityFeedProps) {
  return (
    <div className="bg-hud-bg-card rounded-xl border border-hud-bg-elev">
      <div className="flex items-center justify-between px-5 py-4 border-b border-hud-bg-elev">
        <h3 className="text-sm font-semibold text-white">Recent Activity</h3>
        <div className="flex gap-1 p-1 bg-hud-bg-mid rounded-lg">
          {filterTabs.map((tab) => (
            <button
              key={tab.value}
              onClick={() => onFilterChange(tab.value)}
              className={`px-3 py-1 text-xs font-medium rounded-md transition-colors ${
                activeFilter === tab.value
                  ? 'bg-hud-bg-elev text-white'
                  : 'text-hud-cream-dim hover:text-white'
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>
      </div>

      <div className="divide-y divide-hud-bg-elev/50">
        {isLoading ? (
          <LoadingSkeleton />
        ) : events.length === 0 ? (
          <div className="px-5 py-8 text-center">
            <p className="text-sm text-hud-cream-mute">No recent activity</p>
          </div>
        ) : (
          events.map((event) => {
            const Icon = getIconForEvent(event.event_type);
            const colorClass = getColorForEvent(event.event_type);

            return (
              <button
                key={event.id}
                onClick={() => onItemClick?.(event)}
                className="w-full flex items-start gap-3 px-5 py-3 hover:bg-hud-bg-elev/30 transition-colors text-left"
              >
                <div className={`p-2 rounded-lg ${colorClass}`}>
                  <Icon className="h-4 w-4" />
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm text-white truncate">{event.summary}</p>
                  <div className="flex items-center gap-2 mt-0.5">
                    {event.user && (
                      <span className="text-xs text-hud-cream-mute">{event.user.name}</span>
                    )}
                    {event.user && <span className="text-hud-cream-mute">·</span>}
                    <span className="text-xs text-hud-cream-mute">{formatTimeAgo(event.created_at)}</span>
                  </div>
                </div>
              </button>
            );
          })
        )}
      </div>
    </div>
  );
}

function LoadingSkeleton() {
  return (
    <div className="p-5 space-y-4 animate-pulse">
      {[1, 2, 3, 4].map((i) => (
        <div key={i} className="flex items-start gap-3">
          <div className="h-8 w-8 bg-hud-bg-elev rounded-lg" />
          <div className="flex-1 space-y-2">
            <div className="h-4 w-3/4 bg-hud-bg-elev rounded" />
            <div className="h-3 w-1/3 bg-hud-bg-elev rounded" />
          </div>
        </div>
      ))}
    </div>
  );
}
