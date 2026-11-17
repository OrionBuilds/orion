import { Maximize2, Minimize2 } from 'lucide-react';

export type ComposerTab = 'email' | 'sms' | 'internal_comment';

interface ComposerTabBarProps {
  activeTab: ComposerTab;
  onTabChange: (tab: ComposerTab) => void;
  hasEmail: boolean;
  hasSms: boolean;
  expanded: boolean;
  onToggleExpand: () => void;
}

export function ComposerTabBar({
  activeTab,
  onTabChange,
  hasEmail,
  hasSms,
  expanded,
  onToggleExpand,
}: ComposerTabBarProps) {
  const tabClass = (tab: ComposerTab) =>
    `px-1 pb-2 text-sm font-medium border-b-2 transition-colors cursor-pointer ${
      activeTab === tab
        ? 'text-hud-gold-soft border-hud-gold'
        : 'text-hud-cream-dim border-transparent hover:text-hud-cream-soft'
    }`;

  return (
    <div className="flex items-center justify-between px-4 pt-3 border-b border-hud-bg-elev">
      <div className="flex items-center gap-5">
        {hasEmail && (
          <button className={tabClass('email')} onClick={() => onTabChange('email')}>
            Email
          </button>
        )}
        {hasSms && (
          <button className={tabClass('sms')} onClick={() => onTabChange('sms')}>
            SMS
          </button>
        )}
      </div>

      <div className="flex items-center gap-3">
        <button className={tabClass('internal_comment')} onClick={() => onTabChange('internal_comment')}>
          Internal Comment
        </button>
        <button
          onClick={onToggleExpand}
          className="p-1 text-hud-cream-dim hover:text-white transition-colors mb-2"
          title={expanded ? 'Collapse' : 'Expand'}
        >
          {expanded ? <Minimize2 size={16} /> : <Maximize2 size={16} />}
        </button>
      </div>
    </div>
  );
}
