import { type LucideIcon } from 'lucide-react';

interface EmptyStateProps {
  icon: LucideIcon;
  title: string;
  description: string;
  primaryAction?: {
    label: string;
    onClick: () => void;
  };
  secondaryAction?: {
    label: string;
    onClick: () => void;
  };
  helpText?: string;
}

export function EmptyState({
  icon: Icon,
  title,
  description,
  primaryAction,
  secondaryAction,
  helpText,
}: EmptyStateProps) {
  return (
    <div className="flex flex-col items-center justify-center py-16 px-4">
      <div className="p-4 rounded-full bg-hud-bg-card/50 border border-hud-bg-elev mb-4">
        <Icon className="w-10 h-10 text-hud-cream-mute" />
      </div>
      <h3 className="text-lg font-semibold text-white mb-2">{title}</h3>
      <p className="text-hud-cream-dim text-center max-w-sm mb-6">{description}</p>

      <div className="flex items-center gap-3">
        {primaryAction && (
          <button
            onClick={primaryAction.onClick}
            className="px-4 py-2 bg-gradient-to-r from-hud-gold to-hud-teal text-white rounded-lg hover:from-hud-gold-deep hover:to-hud-teal transition-all font-medium text-sm shadow-lg shadow-hud-gold/25"
          >
            {primaryAction.label}
          </button>
        )}
        {secondaryAction && (
          <button
            onClick={secondaryAction.onClick}
            className="px-4 py-2 bg-hud-bg-card text-hud-cream-soft rounded-lg hover:bg-hud-bg-elev transition-colors font-medium text-sm"
          >
            {secondaryAction.label}
          </button>
        )}
      </div>

      {helpText && (
        <p className="text-xs text-hud-cream-mute mt-6 text-center max-w-sm">{helpText}</p>
      )}
    </div>
  );
}
