import type { ServiceStatus, ErrorSeverity } from '../../hooks/useSystemDashboardData';

interface StatusBadgeProps {
  status: ServiceStatus | ErrorSeverity;
  label?: string;
  size?: 'sm' | 'md';
}

const statusColors: Record<ServiceStatus | ErrorSeverity, { bg: string; text: string; dot: string }> = {
  healthy: { bg: 'bg-hud-emerald/10', text: 'text-hud-emerald', dot: 'bg-hud-emerald' },
  degraded: { bg: 'bg-hud-rust/10', text: 'text-hud-rust', dot: 'bg-hud-rust' },
  critical: { bg: 'bg-hud-plum/10', text: 'text-hud-plum', dot: 'bg-hud-plum' },
  disconnected: { bg: 'bg-hud-cream-mute/10', text: 'text-hud-cream-dim', dot: 'bg-hud-cream-dim' },
  info: { bg: 'bg-blue-500/10', text: 'text-blue-400', dot: 'bg-blue-400' },
  warning: { bg: 'bg-hud-rust/10', text: 'text-hud-rust', dot: 'bg-hud-rust' },
  error: { bg: 'bg-hud-plum/10', text: 'text-hud-plum', dot: 'bg-hud-plum' },
};

const statusLabels: Record<ServiceStatus | ErrorSeverity, string> = {
  healthy: 'Healthy',
  degraded: 'Degraded',
  critical: 'Critical',
  disconnected: 'Disconnected',
  info: 'Info',
  warning: 'Warning',
  error: 'Error',
};

export function StatusBadge({ status, label, size = 'sm' }: StatusBadgeProps) {
  const colors = statusColors[status];
  const displayLabel = label || statusLabels[status];

  const sizeClasses = {
    sm: 'px-2 py-0.5 text-xs',
    md: 'px-3 py-1 text-sm',
  };

  return (
    <span
      className={`inline-flex items-center gap-1.5 ${colors.bg} ${colors.text} ${sizeClasses[size]} rounded-full font-medium`}
    >
      <span className={`w-1.5 h-1.5 rounded-full ${colors.dot}`} />
      {displayLabel}
    </span>
  );
}
