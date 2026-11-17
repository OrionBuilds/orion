import type { LucideIcon } from 'lucide-react';
import type { ServiceStatus } from '../../hooks/useSystemDashboardData';

interface SystemStatCardProps {
  title: string;
  value: string | number;
  sublabel?: string;
  icon: LucideIcon;
  status?: ServiceStatus;
  trend?: 'up' | 'down' | 'stable';
  onClick?: () => void;
  isLoading?: boolean;
}

const statusStyles: Record<ServiceStatus, { bg: string; text: string; border: string }> = {
  healthy: {
    bg: 'bg-hud-emerald/10',
    text: 'text-hud-emerald',
    border: 'border-hud-emerald/20',
  },
  degraded: {
    bg: 'bg-hud-rust/10',
    text: 'text-hud-rust',
    border: 'border-hud-rust/20',
  },
  critical: {
    bg: 'bg-hud-plum/10',
    text: 'text-hud-plum',
    border: 'border-hud-plum/20',
  },
  disconnected: {
    bg: 'bg-hud-cream-mute/10',
    text: 'text-hud-cream-dim',
    border: 'border-hud-cream-mute/20',
  },
};

export function SystemStatCard({
  title,
  value,
  sublabel,
  icon: Icon,
  status = 'healthy',
  trend,
  onClick,
  isLoading,
}: SystemStatCardProps) {
  const styles = statusStyles[status];

  if (isLoading) {
    return (
      <div className="bg-hud-bg-card rounded-xl border border-hud-bg-elev p-5">
        <div className="animate-pulse">
          <div className="flex items-center justify-between mb-3">
            <div className="h-4 w-24 bg-hud-bg-elev rounded" />
            <div className="h-8 w-8 bg-hud-bg-elev rounded" />
          </div>
          <div className="h-8 w-16 bg-hud-bg-elev rounded mb-2" />
          <div className="h-3 w-20 bg-hud-bg-elev rounded" />
        </div>
      </div>
    );
  }

  const Wrapper = onClick ? 'button' : 'div';
  const wrapperProps = onClick
    ? {
        onClick,
        className: `w-full text-left bg-hud-bg-card rounded-xl border ${styles.border} border-hud-bg-elev p-5 transition-colors hover:bg-hud-bg-elev/50 focus:outline-none focus:ring-2 focus:ring-hud-gold/40`,
      }
    : {
        className: `bg-hud-bg-card rounded-xl border ${styles.border} border-hud-bg-elev p-5`,
      };

  return (
    <Wrapper {...(wrapperProps as any)}>
      <div className="flex items-center justify-between mb-3">
        <span className="text-sm font-medium text-hud-cream-dim">{title}</span>
        <div className={`p-2 rounded-lg ${styles.bg}`}>
          <Icon className={`h-5 w-5 ${styles.text}`} />
        </div>
      </div>
      <div className="flex items-baseline gap-2">
        <span className="text-3xl font-semibold text-white">{value}</span>
        {trend && (
          <span
            className={`text-sm font-medium ${
              trend === 'down' ? 'text-hud-emerald' : trend === 'up' ? 'text-hud-plum' : 'text-hud-cream-dim'
            }`}
          >
            {trend === 'down' ? '↓' : trend === 'up' ? '↑' : '→'}
          </span>
        )}
      </div>
      {sublabel && <p className="mt-1 text-sm text-hud-cream-mute">{sublabel}</p>}
    </Wrapper>
  );
}
