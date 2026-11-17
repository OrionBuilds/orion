import type { ReactNode } from 'react';

interface ComposerToolbarProps {
  leftIcons: ReactNode;
  centerContent?: ReactNode;
  onClear: () => void;
  onSend: () => void;
  sendDisabled: boolean;
  sending: boolean;
}

export function ComposerToolbar({
  leftIcons,
  centerContent,
  onClear,
  onSend,
  sendDisabled,
  sending,
}: ComposerToolbarProps) {
  return (
    <div className="flex items-center justify-between px-4 py-2 border-t border-hud-bg-elev">
      <div className="flex items-center gap-1">
        {leftIcons}
      </div>

      <div className="flex items-center gap-3">
        {centerContent && (
          <span className="text-sm text-hud-cream-dim mr-2">{centerContent}</span>
        )}
        <button
          onClick={onClear}
          className="px-4 py-1.5 text-sm text-hud-cream-soft border border-hud-cream-mute rounded-lg hover:bg-hud-bg-elev transition-colors"
        >
          Clear
        </button>
        <button
          onClick={onSend}
          disabled={sendDisabled}
          className="px-6 py-1.5 text-sm font-medium text-white bg-gradient-to-r from-hud-gold to-hud-teal rounded-lg hover:from-hud-gold-deep hover:to-hud-teal disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
        >
          {sending ? (
            <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin mx-2" />
          ) : (
            'Send'
          )}
        </button>
      </div>
    </div>
  );
}
