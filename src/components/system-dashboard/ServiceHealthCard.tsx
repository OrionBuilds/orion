import { Activity, Database, Server, Cog, Plug, Bot, type LucideIcon } from 'lucide-react';
import type { ServiceHealth, ServiceStatus } from '../../hooks/useSystemDashboardData';
import { StatusBadge } from './StatusBadge';

type ConnectivityStatus = 'connected' | 'degraded' | 'disconnected';

interface ServiceHealthCardProps {
  service?: ServiceHealth;
  title?: string;
  icon?: LucideIcon;
  status?: ConnectivityStatus;
  description?: string;
  onClick?: () => void;
  isLoading?: boolean;
}

const serviceIcons: Record<string, typeof Activity> = {
  API: Server,
  'Auth Service': Activity,
  Database: Database,
  'Queue Workers': Cog,
  Integrations: Plug,
  'AI Services': Bot,
};

const connectivityToServiceStatus: Record<ConnectivityStatus, ServiceStatus> = {
  connected: 'healthy',
  degraded: 'degraded',
  disconnected: 'disconnected',
};

const connectivityLabels: Record<ConnectivityStatus, string> = {
  connected: 'Connected',
  degraded: 'Degraded',
  disconnected: 'Not connected',
};

export function ServiceHealthCard({
  service,
  title,
  icon: CustomIcon,
  status: connectivityStatus,
  description,
  onClick,
  isLoading,
}: ServiceHealthCardProps) {
  const isSimpleMode = !service && title;

  const displayStatus = isSimpleMode
    ? connectivityToServiceStatus[connectivityStatus || 'disconnected']
    : service?.status || 'disconnected';

  const Icon = isSimpleMode
    ? (CustomIcon || Activity)
    : (serviceIcons[service?.name || ''] || Activity);

  const displayTitle = isSimpleMode ? title : service?.name;

  const statusBg = {
    healthy: 'bg-hud-emerald/10',
    degraded: 'bg-hud-rust/10',
    critical: 'bg-hud-plum/10',
    disconnected: 'bg-hud-cream-mute/10',
  }[displayStatus];

  const iconColor = {
    healthy: 'text-hud-emerald',
    degraded: 'text-hud-rust',
    critical: 'text-hud-plum',
    disconnected: 'text-hud-cream-dim',
  }[displayStatus];

  const Wrapper = onClick ? 'button' : 'div';
  const wrapperClass = onClick
    ? 'w-full text-left bg-hud-bg-card rounded-xl border border-hud-bg-elev p-4 transition-colors hover:bg-hud-bg-elev/50 focus:outline-none focus:ring-2 focus:ring-hud-gold/40'
    : 'bg-hud-bg-card rounded-xl border border-hud-bg-elev p-4';

  if (isLoading) {
    return (
      <div className="bg-hud-bg-card rounded-xl border border-hud-bg-elev p-4 animate-pulse">
        <div className="flex items-start justify-between mb-3">
          <div className="w-9 h-9 bg-hud-bg-elev rounded-lg" />
          <div className="w-20 h-5 bg-hud-bg-elev rounded-full" />
        </div>
        <div className="w-24 h-4 bg-hud-bg-elev rounded mb-2" />
        <div className="w-full h-3 bg-hud-bg-elev rounded" />
      </div>
    );
  }

  if (isSimpleMode) {
    return (
      <Wrapper onClick={onClick} className={wrapperClass}>
        <div className="flex items-start justify-between mb-3">
          <div className={`p-2 rounded-lg ${statusBg}`}>
            <Icon className={`h-5 w-5 ${iconColor}`} />
          </div>
          <div className={`flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium ${
            connectivityStatus === 'connected'
              ? 'bg-hud-emerald/10 text-hud-emerald'
              : connectivityStatus === 'degraded'
              ? 'bg-hud-rust/10 text-hud-rust'
              : 'bg-hud-cream-mute/10 text-hud-cream-dim'
          }`}>
            <span className={`w-1.5 h-1.5 rounded-full ${
              connectivityStatus === 'connected'
                ? 'bg-hud-emerald'
                : connectivityStatus === 'degraded'
                ? 'bg-hud-rust'
                : 'bg-hud-cream-dim'
            }`} />
            {connectivityLabels[connectivityStatus || 'disconnected']}
          </div>
        </div>
        <h4 className="text-sm font-medium text-white mb-1">{displayTitle}</h4>
        {description && (
          <p className="text-xs text-hud-cream-dim">{description}</p>
        )}
      </Wrapper>
    );
  }

  return (
    <Wrapper onClick={onClick} className={wrapperClass}>
      <div className="flex items-start justify-between mb-3">
        <div className={`p-2 rounded-lg ${statusBg}`}>
          <Icon className={`h-5 w-5 ${iconColor}`} />
        </div>
        <StatusBadge status={displayStatus} />
      </div>
      <h4 className="text-sm font-medium text-white mb-2">{displayTitle}</h4>
      {service && (
        <div className="space-y-1">
          <div className="flex justify-between text-xs">
            <span className="text-hud-cream-mute">Uptime</span>
            <span className="text-hud-cream-soft">{service.uptime}%</span>
          </div>
          <div className="flex justify-between text-xs">
            <span className="text-hud-cream-mute">Latency</span>
            <span className="text-hud-cream-soft">{service.latency}ms</span>
          </div>
          {service.lastIncident && (
            <div className="flex justify-between text-xs">
              <span className="text-hud-cream-mute">Last incident</span>
              <span className="text-hud-cream-soft">
                {new Date(service.lastIncident).toLocaleDateString([], {
                  month: 'short',
                  day: 'numeric',
                })}
              </span>
            </div>
          )}
        </div>
      )}
    </Wrapper>
  );
}
