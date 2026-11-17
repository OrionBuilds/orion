import { Activity, Shield } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { formatDateTimeShort } from '../../utils/formatters';

interface DocumentAuditEvent {
  id: string;
  event_type: string;
  actor_type: string;
  metadata: Record<string, unknown>;
  created_at: string;
}

interface DocumentAuditTrailProps {
  events: DocumentAuditEvent[];
  iconMap: Record<string, { icon: LucideIcon; color: string }>;
}

export function DocumentAuditTrail({ events, iconMap }: DocumentAuditTrailProps) {
  if (events.length === 0) return null;

  return (
    <div className="bg-hud-bg-card/50 rounded-lg border border-hud-bg-elev p-5">
      <h3 className="font-semibold text-white mb-4 flex items-center gap-2">
        <Shield className="w-5 h-5 text-hud-gold-soft" />
        Audit Trail
      </h3>
      <div className="space-y-3">
        {events.map((evt) => {
          const style = iconMap[evt.event_type] || { icon: Activity, color: 'text-hud-cream-dim' };
          const EvtIcon = style.icon;
          return (
            <div key={evt.id} className="flex gap-3">
              <div className="w-8 h-8 rounded-full bg-hud-bg-mid flex items-center justify-center flex-shrink-0">
                <EvtIcon className={`w-4 h-4 ${style.color}`} />
              </div>
              <div className="flex-1 pb-3 border-b border-hud-bg-elev/50">
                <p className="text-white text-sm">
                  {evt.event_type.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())}
                </p>
                <div className="flex items-center gap-2 mt-1 text-xs text-hud-cream-dim">
                  <span className="capitalize">{evt.actor_type}</span>
                  <span>{formatDateTimeShort(evt.created_at, { hour: 'numeric' })}</span>
                </div>
                {Boolean(evt.metadata?.signer_email) && (
                  <p className="text-xs text-hud-cream-mute mt-1">
                    {String(evt.metadata.signer_name || '')} ({String(evt.metadata.signer_email)})
                  </p>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
