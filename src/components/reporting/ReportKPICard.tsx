import { TrendingUp, TrendingDown, Minus } from 'lucide-react';
import type { ReportComposeKPI } from '../../types/aiReports';
import { formatCurrency } from '../../utils/formatters';

interface ReportKPICardProps {
  kpi: ReportComposeKPI;
}

function formatValue(value: number | string, format?: string): string {
  if (typeof value === 'string') return value;
  if (format === 'currency') {
    return formatCurrency(value, { maximumFractionDigits: 0 });
  }
  if (format === 'percentage') {
    return `${(value * 100).toFixed(1)}%`;
  }
  if (value >= 1000000) return `${(value / 1000000).toFixed(1)}M`;
  if (value >= 1000) return `${(value / 1000).toFixed(1)}K`;
  return new Intl.NumberFormat('en-US').format(value);
}

export function ReportKPICard({ kpi }: ReportKPICardProps) {
  const trend = kpi.trend || (kpi.delta_pct != null ? (kpi.delta_pct > 0 ? 'up' : kpi.delta_pct < 0 ? 'down' : 'flat') : 'flat');

  const trendConfig = {
    up: { icon: TrendingUp, color: 'text-hud-emerald', bg: 'bg-hud-emerald/10', border: 'border-hud-emerald/20' },
    down: { icon: TrendingDown, color: 'text-hud-plum', bg: 'bg-hud-plum/10', border: 'border-hud-plum/20' },
    flat: { icon: Minus, color: 'text-hud-cream-dim', bg: 'bg-hud-cream-mute/10', border: 'border-hud-cream-mute/20' },
  };

  const config = trendConfig[trend];
  const TrendIcon = config.icon;

  return (
    <div className={`bg-hud-bg-card/80 rounded-xl border border-hud-bg-elev/60 p-5 transition-all hover:bg-hud-bg-card`}>
      <div className="flex items-start justify-between mb-3">
        <span className="text-sm font-medium text-hud-cream-dim leading-tight">{kpi.label}</span>
        {kpi.delta_pct != null && (
          <div className={`flex items-center gap-1 px-2 py-0.5 rounded-full ${config.bg} ${config.border} border`}>
            <TrendIcon className={`w-3 h-3 ${config.color}`} />
            <span className={`text-xs font-medium ${config.color}`}>
              {kpi.delta_pct > 0 ? '+' : ''}{(kpi.delta_pct * 100).toFixed(1)}%
            </span>
          </div>
        )}
      </div>
      <div className="text-2xl font-bold text-white tracking-tight">
        {formatValue(kpi.value, kpi.format)}
      </div>
    </div>
  );
}

interface ReportKPIGridProps {
  kpis: ReportComposeKPI[];
}

export function ReportKPIGrid({ kpis }: ReportKPIGridProps) {
  if (!kpis || kpis.length === 0) return null;

  const gridCols = kpis.length <= 2 ? 'grid-cols-2' : kpis.length === 3 ? 'grid-cols-3' : 'grid-cols-2 lg:grid-cols-4';

  return (
    <div className={`grid ${gridCols} gap-4`}>
      {kpis.map((kpi, i) => (
        <ReportKPICard key={`${kpi.label}-${i}`} kpi={kpi} />
      ))}
    </div>
  );
}
