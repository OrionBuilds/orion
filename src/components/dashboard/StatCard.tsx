import type { ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';

type AccentColor = 'cyan' | 'teal' | 'amber' | 'rose' | 'emerald' | 'blue';

interface StatCardProps {
  title: string;
  value: number | string;
  sublabel?: string;
  delta?: number;
  deltaType?: 'positive' | 'negative' | 'neutral';
  icon: LucideIcon;
  accentColor?: AccentColor;
  onClick?: () => void;
  isLoading?: boolean;
}

const accentColorMap: Record<AccentColor, { icon: string; border: string }> = {
  cyan: { icon: 'text-hud-gold-soft', border: 'border-hud-gold/20' },
  teal: { icon: 'text-hud-teal', border: 'border-hud-teal/20' },
  amber: { icon: 'text-hud-rust', border: 'border-hud-rust/20' },
  rose: { icon: 'text-rose-400', border: 'border-rose-500/20' },
  emerald: { icon: 'text-hud-emerald', border: 'border-hud-emerald/20' },
  blue: { icon: 'text-blue-400', border: 'border-blue-500/20' },
};

export function StatCard({
  title,
  value,
  sublabel,
  delta,
  deltaType = 'neutral',
  icon: Icon,
  accentColor = 'cyan',
  onClick,
  isLoading,
}: StatCardProps) {
  const colors = accentColorMap[accentColor];

  const deltaColors = {
    positive: 'text-hud-emerald',
    negative: 'text-hud-plum',
    neutral: 'text-hud-cream-dim',
  };

  if (isLoading) {
    return (
      <div className={`bg-hud-bg-card rounded-xl border border-hud-bg-elev p-3 md:p-5`}>
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

  return (
    <button
      onClick={onClick}
      className={`w-full text-left bg-hud-bg-card rounded-xl border ${colors.border} border-hud-bg-elev p-3 md:p-5 transition-colors hover:bg-hud-bg-elev/50 focus:outline-none focus:ring-2 focus:ring-hud-gold/40 touch-manipulation`}
    >
      <div className="flex items-center justify-between mb-2 md:mb-3">
        <span className="text-sm font-medium text-hud-cream-dim">{title}</span>
        <Icon className={`h-5 w-5 ${colors.icon}`} />
      </div>
      <div className="flex items-baseline gap-2">
        <span className="text-2xl md:text-3xl font-semibold text-white">{value}</span>
        {delta !== undefined && (
          <span className={`text-sm font-medium ${deltaColors[deltaType]}`}>
            {deltaType === 'positive' ? '+' : deltaType === 'negative' ? '' : ''}
            {delta}%
          </span>
        )}
      </div>
      {sublabel && <p className="mt-1 text-xs md:text-sm text-hud-cream-mute">{sublabel}</p>}
    </button>
  );
}
