import { TrendingUp, TrendingDown, Minus } from 'lucide-react';

interface PlatformMetrics {
  platform: string;
  postsCount: number;
  avgEngagement: number;
  avgReach: number;
  topMediaType: string;
  bestPostingHour: number;
  trend: 'up' | 'down' | 'stable';
}

interface PlatformComparisonCardProps {
  data: PlatformMetrics;
  onClick?: () => void;
}

const platformColors: Record<string, { bg: string; text: string; border: string }> = {
  instagram: { bg: 'bg-pink-50 dark:bg-pink-900/20', text: 'text-pink-600', border: 'border-pink-200 dark:border-pink-800' },
  facebook: { bg: 'bg-blue-50 dark:bg-blue-900/20', text: 'text-blue-600', border: 'border-blue-200 dark:border-blue-800' },
  linkedin: { bg: 'bg-sky-50 dark:bg-sky-900/20', text: 'text-sky-600', border: 'border-sky-200 dark:border-sky-800' },
  twitter: { bg: 'bg-hud-bg-elev dark:bg-hud-bg-card', text: 'text-hud-cream-mute', border: 'border-hud-cream-soft dark:border-hud-bg-elev' },
  tiktok: { bg: 'bg-hud-bg-elev dark:bg-hud-bg-mid/20', text: 'text-hud-cream-mute', border: 'border-hud-cream-soft dark:border-hud-bg-card' },
  youtube: { bg: 'bg-hud-plum/10 dark:bg-hud-plum/20', text: 'text-hud-plum', border: 'border-hud-plum/25 dark:border-hud-plum' },
};

export function PlatformComparisonCard({ data, onClick }: PlatformComparisonCardProps) {
  const colors = platformColors[data.platform.toLowerCase()] || platformColors.twitter;

  const formatHour = (hour: number) => {
    if (hour === 0) return '12AM';
    if (hour === 12) return '12PM';
    if (hour > 12) return `${hour - 12}PM`;
    return `${hour}AM`;
  };

  const getTrendIcon = () => {
    switch (data.trend) {
      case 'up':
        return <TrendingUp className="w-4 h-4 text-hud-emerald" />;
      case 'down':
        return <TrendingDown className="w-4 h-4 text-hud-plum" />;
      default:
        return <Minus className="w-4 h-4 text-hud-cream-dim" />;
    }
  };

  return (
    <div
      className={`${colors.bg} border ${colors.border} rounded-xl p-5 ${
        onClick ? 'cursor-pointer hover:shadow-md transition-shadow' : ''
      }`}
      onClick={onClick}
    >
      <div className="flex items-start justify-between mb-4">
        <div className="flex items-center gap-2">
          <span className={`text-lg font-semibold ${colors.text}`}>
            {data.platform.charAt(0).toUpperCase() + data.platform.slice(1)}
          </span>
          {getTrendIcon()}
        </div>
        <span className="text-xs text-hud-cream-mute dark:text-hud-cream-dim bg-white dark:bg-hud-bg-elev px-2 py-1 rounded">
          {data.postsCount} posts
        </span>
      </div>

      <div className="grid grid-cols-2 gap-4 mb-4">
        <div>
          <p className="text-xs text-hud-cream-mute dark:text-hud-cream-dim mb-1">Avg Engagement</p>
          <p className="text-xl font-bold text-hud-bg-mid dark:text-white">{data.avgEngagement}%</p>
        </div>
        <div>
          <p className="text-xs text-hud-cream-mute dark:text-hud-cream-dim mb-1">Avg Reach</p>
          <p className="text-xl font-bold text-hud-bg-mid dark:text-white">{data.avgReach}%</p>
        </div>
      </div>

      <div className="flex items-center justify-between pt-3 border-t border-hud-cream-soft dark:border-hud-cream-mute">
        <div className="flex items-center gap-1">
          <span className="text-xs text-hud-cream-mute dark:text-hud-cream-dim">Best:</span>
          <span className="text-xs font-medium text-hud-bg-elev dark:text-hud-cream-soft capitalize">
            {data.topMediaType}
          </span>
        </div>
        <div className="flex items-center gap-1">
          <span className="text-xs text-hud-cream-mute dark:text-hud-cream-dim">Peak:</span>
          <span className="text-xs font-medium text-hud-bg-elev dark:text-hud-cream-soft">
            {formatHour(data.bestPostingHour)}
          </span>
        </div>
      </div>
    </div>
  );
}
