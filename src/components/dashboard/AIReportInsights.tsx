import { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { Sparkles, TrendingUp, TrendingDown, Minus, ChevronRight, Loader2, RefreshCw, AlertCircle } from 'lucide-react';
import { useAuth } from '../../contexts/AuthContext';
import { getDashboardInsights } from '../../services/dashboardInsights';
import type { DashboardInsightCard } from '../../types/aiReports';

interface AIReportInsightsProps {
  className?: string;
}

const trendConfig = {
  up: { icon: TrendingUp, color: 'text-hud-emerald' },
  down: { icon: TrendingDown, color: 'text-hud-plum' },
  flat: { icon: Minus, color: 'text-hud-cream-dim' },
};

function formatValue(value: number, format: DashboardInsightCard['format']): string {
  if (format === 'currency') {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: 'USD',
      maximumFractionDigits: 0,
    }).format(value || 0);
  }
  if (format === 'percentage') {
    return `${(value || 0).toFixed(1)}%`;
  }
  return new Intl.NumberFormat('en-US').format(value || 0);
}

function relativeTime(iso: string | null): string {
  if (!iso) return '';
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '';
  const diffMs = Date.now() - then;
  const mins = Math.floor(diffMs / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}

export function AIReportInsights({ className = '' }: AIReportInsightsProps) {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [cards, setCards] = useState<DashboardInsightCard[]>([]);
  const [narrative, setNarrative] = useState('');
  const [generatedAt, setGeneratedAt] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (force = false) => {
    if (force) setIsRefreshing(true);
    try {
      const data = await getDashboardInsights(force);
      setCards(data.cards || []);
      setNarrative(data.narrative || '');
      setGeneratedAt(data.generated_at);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load insights');
    } finally {
      setIsLoading(false);
      setIsRefreshing(false);
    }
  }, []);

  useEffect(() => {
    if (user?.organization_id) load(false);
  }, [user?.organization_id, load]);

  const header = (
    <div className="flex items-center justify-between px-5 py-4 border-b border-hud-bg-elev">
      <div className="flex items-center gap-2">
        <Sparkles className="w-4 h-4 text-hud-gold-soft" />
        <h3 className="text-sm font-semibold text-white">AI Report Insights</h3>
        {generatedAt && (
          <span className="text-[11px] text-hud-cream-mute hidden sm:inline">· Updated {relativeTime(generatedAt)}</span>
        )}
      </div>
      <div className="flex items-center gap-3">
        <button
          onClick={() => load(true)}
          disabled={isRefreshing || isLoading}
          title="Regenerate AI insight"
          className="flex items-center gap-1 text-xs font-medium text-hud-cream-dim hover:text-hud-cream-soft transition-colors disabled:opacity-50"
        >
          <RefreshCw className={`h-3.5 w-3.5 ${isRefreshing ? 'animate-spin' : ''}`} />
        </button>
        <button
          onClick={() => navigate('/reporting')}
          className="flex items-center gap-1 text-xs font-medium text-hud-gold-soft hover:text-hud-gold-soft transition-colors"
        >
          View Reports
          <ChevronRight className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  );

  if (isLoading) {
    return (
      <div className={`bg-hud-bg-card rounded-xl border border-hud-bg-elev ${className}`}>
        {header}
        <div className="p-5 flex items-center justify-center h-32">
          <Loader2 className="w-5 h-5 text-hud-cream-mute animate-spin" />
        </div>
      </div>
    );
  }

  if (error && cards.length === 0) {
    return (
      <div className={`bg-hud-bg-card rounded-xl border border-hud-bg-elev ${className}`}>
        {header}
        <div className="p-5 flex items-center justify-center gap-2 h-32 text-sm text-hud-cream-dim">
          <AlertCircle className="w-4 h-4 text-hud-rust" />
          <span>{error}</span>
          <button onClick={() => load(false)} className="text-hud-gold-soft hover:text-hud-gold-soft underline ml-2">Retry</button>
        </div>
      </div>
    );
  }

  return (
    <div className={`bg-hud-bg-card rounded-xl border border-hud-bg-elev ${className}`}>
      {header}

      {narrative && (
        <div className="px-5 pt-4">
          <p className="text-xs text-hud-cream-soft leading-relaxed bg-hud-bg-elev/30 border border-hud-bg-elev/50 rounded-lg px-3 py-2">
            {narrative}
          </p>
        </div>
      )}

      <div className="p-4 grid grid-cols-2 lg:grid-cols-3 gap-3">
        {cards.map((card) => {
          const trend = card.trend || 'flat';
          const config = trendConfig[trend];
          const TrendIcon = config.icon;

          return (
            <div
              key={card.card_id}
              className="bg-hud-bg-elev/40 border border-hud-bg-elev/60 rounded-lg p-3 flex flex-col"
            >
              <div className="flex items-center justify-between mb-1.5">
                <span className="text-xs text-hud-cream-dim truncate pr-2" title={card.title}>{card.title}</span>
                {card.delta_pct != null && (
                  <TrendIcon className={`w-3 h-3 flex-shrink-0 ${config.color}`} />
                )}
              </div>
              <div className="text-lg font-bold text-white">{formatValue(card.value, card.format)}</div>
              <div className="flex items-center gap-2 mt-0.5">
                {card.delta_pct != null && (
                  <span className={`text-xs ${config.color}`}>
                    {card.delta_pct > 0 ? '+' : ''}{card.delta_pct.toFixed(1)}%
                  </span>
                )}
                <span className="text-[11px] text-hud-cream-mute truncate">{card.period}</span>
              </div>
              {card.insight && (
                <p className="text-[11px] text-hud-cream-dim mt-2 leading-snug line-clamp-2" title={card.insight}>
                  {card.insight}
                </p>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
