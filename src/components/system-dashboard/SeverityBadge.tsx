import type { ErrorSeverity } from '../../hooks/useSystemDashboardData';

interface SeverityBadgeProps {
  severity: ErrorSeverity;
}

const severityStyles: Record<ErrorSeverity, { bg: string; text: string }> = {
  info: { bg: 'bg-blue-500/10', text: 'text-blue-400' },
  warning: { bg: 'bg-hud-rust/10', text: 'text-hud-rust' },
  error: { bg: 'bg-hud-plum/10', text: 'text-hud-plum' },
  critical: { bg: 'bg-hud-plum/20', text: 'text-hud-plum/40' },
};

const severityLabels: Record<ErrorSeverity, string> = {
  info: 'INFO',
  warning: 'WARN',
  error: 'ERROR',
  critical: 'CRIT',
};

export function SeverityBadge({ severity }: SeverityBadgeProps) {
  const styles = severityStyles[severity];

  return (
    <span
      className={`inline-flex items-center px-2 py-0.5 ${styles.bg} ${styles.text} text-xs font-mono font-medium rounded`}
    >
      {severityLabels[severity]}
    </span>
  );
}
