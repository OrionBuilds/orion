import { DollarSign, TrendingUp, Trophy, XCircle, Target } from 'lucide-react';
import type { OpportunityStats } from '../../types';
import { formatCompactCurrency } from '../../utils/formatters';

interface PipelineSummaryStripProps {
  stats: OpportunityStats;
  isVisible: boolean;
}

export function PipelineSummaryStrip({ stats, isVisible }: PipelineSummaryStripProps) {
  if (!isVisible) return null;

  return (
    <div className="flex items-center gap-6 px-4 py-3 bg-hud-bg-card/50 border-b border-hud-bg-elev overflow-x-auto">
      <div className="flex items-center gap-2 whitespace-nowrap">
        <div className="p-1.5 rounded bg-hud-rust/20">
          <DollarSign className="w-4 h-4 text-hud-rust" />
        </div>
        <div>
          <div className="text-xs text-hud-cream-dim">Pipeline Value</div>
          <div className="text-lg font-semibold text-hud-rust">
            {formatCompactCurrency(stats.totalValue)}
          </div>
        </div>
      </div>

      <div className="w-px h-10 bg-hud-bg-elev" />

      <div className="flex items-center gap-2 whitespace-nowrap">
        <div className="p-1.5 rounded bg-hud-gold/20">
          <Target className="w-4 h-4 text-hud-gold-soft" />
        </div>
        <div>
          <div className="text-xs text-hud-cream-dim">Open</div>
          <div className="flex items-baseline gap-2">
            <span className="text-lg font-semibold text-white">{stats.openOpportunities}</span>
            <span className="text-sm text-hud-cream-dim">
              ({formatCompactCurrency(stats.totalValue - stats.wonValue)})
            </span>
          </div>
        </div>
      </div>

      <div className="w-px h-10 bg-hud-bg-elev" />

      <div className="flex items-center gap-2 whitespace-nowrap">
        <div className="p-1.5 rounded bg-hud-emerald/20">
          <Trophy className="w-4 h-4 text-hud-emerald" />
        </div>
        <div>
          <div className="text-xs text-hud-cream-dim">Won</div>
          <div className="flex items-baseline gap-2">
            <span className="text-lg font-semibold text-hud-emerald">{stats.wonOpportunities}</span>
            <span className="text-sm text-hud-emerald/70">
              ({formatCompactCurrency(stats.wonValue)})
            </span>
          </div>
        </div>
      </div>

      <div className="w-px h-10 bg-hud-bg-elev" />

      <div className="flex items-center gap-2 whitespace-nowrap">
        <div className="p-1.5 rounded bg-hud-plum/20">
          <XCircle className="w-4 h-4 text-hud-plum" />
        </div>
        <div>
          <div className="text-xs text-hud-cream-dim">Lost</div>
          <div className="text-lg font-semibold text-hud-plum">{stats.lostOpportunities}</div>
        </div>
      </div>

      <div className="w-px h-10 bg-hud-bg-elev" />

      <div className="flex items-center gap-2 whitespace-nowrap">
        <div className="p-1.5 rounded bg-hud-cream-mute">
          <TrendingUp className="w-4 h-4 text-hud-cream-soft" />
        </div>
        <div>
          <div className="text-xs text-hud-cream-dim">Win Rate</div>
          <div className="text-lg font-semibold text-white">
            {stats.conversionRate.toFixed(1)}%
          </div>
        </div>
      </div>
    </div>
  );
}
