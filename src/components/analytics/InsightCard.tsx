import { Clock, Image, FileText, TrendingUp, Globe, Lightbulb } from 'lucide-react';

interface AIInsight {
  category: 'timing' | 'content' | 'media' | 'engagement' | 'platform';
  title: string;
  description: string;
  confidence: 'high' | 'medium' | 'low';
  dataPoints: string[];
}

interface InsightCardProps {
  insight: AIInsight;
}

const categoryConfig: Record<string, { icon: typeof Clock; color: string; bgColor: string }> = {
  timing: {
    icon: Clock,
    color: 'text-blue-600 dark:text-blue-400',
    bgColor: 'bg-blue-100 dark:bg-blue-900/30',
  },
  content: {
    icon: FileText,
    color: 'text-hud-emerald-dim dark:text-hud-emerald',
    bgColor: 'bg-hud-emerald/15 dark:bg-hud-emerald-dim/30',
  },
  media: {
    icon: Image,
    color: 'text-hud-rust dark:text-hud-rust',
    bgColor: 'bg-hud-rust/15 dark:bg-hud-rust/30',
  },
  engagement: {
    icon: TrendingUp,
    color: 'text-rose-600 dark:text-rose-400',
    bgColor: 'bg-rose-100 dark:bg-rose-900/30',
  },
  platform: {
    icon: Globe,
    color: 'text-sky-600 dark:text-sky-400',
    bgColor: 'bg-sky-100 dark:bg-sky-900/30',
  },
};

const confidenceColors: Record<string, { bg: string; text: string }> = {
  high: { bg: 'bg-hud-emerald/15 dark:bg-hud-emerald-dim/30', text: 'text-hud-emerald dark:text-hud-emerald/40' },
  medium: { bg: 'bg-hud-rust/15 dark:bg-hud-rust/30', text: 'text-hud-rust dark:text-hud-rust/40' },
  low: { bg: 'bg-hud-cream dark:bg-hud-bg-elev', text: 'text-hud-cream-mute dark:text-hud-cream-dim' },
};

export function InsightCard({ insight }: InsightCardProps) {
  const config = categoryConfig[insight.category] || {
    icon: Lightbulb,
    color: 'text-hud-cream-mute',
    bgColor: 'bg-hud-cream',
  };
  const Icon = config.icon;
  const confidenceStyle = confidenceColors[insight.confidence];

  return (
    <div className="bg-white dark:bg-hud-bg-card border border-hud-cream-soft dark:border-hud-bg-elev rounded-xl p-5">
      <div className="flex items-start gap-4">
        <div className={`p-2.5 rounded-lg ${config.bgColor}`}>
          <Icon className={`w-5 h-5 ${config.color}`} />
        </div>

        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-2">
            <h3 className="font-semibold text-hud-bg-mid dark:text-white">
              {insight.title}
            </h3>
            <span
              className={`px-2 py-0.5 rounded text-xs font-medium ${confidenceStyle.bg} ${confidenceStyle.text}`}
            >
              {insight.confidence}
            </span>
          </div>

          <p className="text-sm text-hud-cream-mute dark:text-hud-cream-soft mb-3">
            {insight.description}
          </p>

          {insight.dataPoints.length > 0 && (
            <div className="flex flex-wrap gap-2">
              {insight.dataPoints.map((point, index) => (
                <span
                  key={index}
                  className="text-xs text-hud-cream-mute dark:text-hud-cream-dim bg-hud-cream dark:bg-hud-bg-elev px-2 py-1 rounded"
                >
                  {point}
                </span>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
