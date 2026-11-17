import type { ReactNode } from 'react';
import { formatDateTimeShort } from '../../utils/formatters';

interface DocumentActivity {
  id: string;
  activity_type: string;
  description: string;
  created_at: string;
  actor?: { name?: string | null } | null;
}

interface DocumentActivityFeedProps {
  activities: DocumentActivity[];
  renderIcon: (activityType: string) => ReactNode;
}

export function DocumentActivityFeed({ activities, renderIcon }: DocumentActivityFeedProps) {
  return (
    <div className="max-w-2xl mx-auto">
      <div className="space-y-4">
        {activities.length === 0 ? (
          <p className="text-center text-hud-cream-dim py-8">No activity recorded</p>
        ) : (
          activities.map((activity) => (
            <div key={activity.id} className="flex gap-4">
              <div className="w-8 h-8 rounded-full bg-hud-bg-card flex items-center justify-center flex-shrink-0">
                {renderIcon(activity.activity_type)}
              </div>
              <div className="flex-1 pb-4 border-b border-hud-bg-elev/50">
                <p className="text-white">{activity.description}</p>
                <div className="flex items-center gap-2 mt-1 text-sm text-hud-cream-dim">
                  {activity.actor?.name && <span>{activity.actor.name}</span>}
                  <span>{formatDateTimeShort(activity.created_at, { hour: 'numeric' })}</span>
                </div>
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
