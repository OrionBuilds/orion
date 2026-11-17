import { TrendingUp, TrendingDown, Minus, type LucideIcon } from 'lucide-react';

interface DeltaResult {
  current: number;
  previous: number;
  delta: number;
  deltaPercent: number;
  trend: 'up' | 'down' | 'stable';
}

interface AnalyticsKPICardProps {
  title: string;
  value: string | number;
  delta?: DeltaResult;
  icon?: LucideIcon;
  iconColor?: string;
  sublabel?: string;
  invertTrend?: boolean;
  onClick?: () => void;
}

export function AnalyticsKPICard({
  title,
  value,
  delta,
  icon: Icon,
  iconColor = 'text-blue-600',
  sublabel,
  invertTrend = false,
  onClick,
}: AnalyticsKPICardProps) {
  const getTrendIcon = () => {
    if (!delta) return null;

    const trend = delta.trend;
    if (trend === 'up') {
      return <TrendingUp className="w-4 h-4" />;
    } else if (trend === 'down') {
      return <TrendingDown className="w-4 h-4" />;
    }
    return <Minus className="w-4 h-4" />;
  };

  const getTrendColor = () => {
    if (!delta) return 'text-hud-cream-mute';

    const trend = delta.trend;
    const isPositive = invertTrend ? trend === 'down' : trend === 'up';
    const isNegative = invertTrend ? trend === 'up' : trend === 'down';

    if (isPositive) return 'text-hud-emerald-dim';
    if (isNegative) return 'text-hud-plum';
    return 'text-hud-cream-mute';
  };

  const formatDelta = () => {
    if (!delta) return '';
    const sign = delta.deltaPercent > 0 ? '+' : '';
    return `${sign}${delta.deltaPercent}%`;
  };

  return (
    <div
      className={`bg-white dark:bg-hud-bg-card rounded-xl border border-hud-cream-soft dark:border-hud-bg-elev p-5 ${
        onClick ? 'cursor-pointer hover:border-blue-300 dark:hover:border-blue-600 transition-colors' : ''
      }`}
      onClick={onClick}
    >
      <div className="flex items-start justify-between mb-3">
        <span className="text-sm font-medium text-hud-cream-mute dark:text-hud-cream-dim uppercase tracking-wide">
          {title}
        </span>
        {Icon && (
          <div className={`p-2 rounded-lg bg-hud-bg-elev dark:bg-hud-bg-elev ${iconColor}`}>
            <Icon className="w-5 h-5" />
          </div>
        )}
      </div>

      <div className="flex items-end gap-3">
        <span className="text-2xl font-bold text-hud-bg-mid dark:text-white">
          {typeof value === 'number' ? value.toLocaleString() : value}
        </span>

        {delta && (
          <div className={`flex items-center gap-1 text-sm font-medium ${getTrendColor()}`}>
            {getTrendIcon()}
            <span>{formatDelta()}</span>
          </div>
        )}
      </div>

      {sublabel && (
        <p className="mt-2 text-sm text-hud-cream-mute dark:text-hud-cream-dim">{sublabel}</p>
      )}
    </div>
  );
}
