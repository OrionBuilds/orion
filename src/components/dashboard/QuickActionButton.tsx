import type { LucideIcon } from 'lucide-react';

interface QuickActionButtonProps {
  icon: LucideIcon;
  label: string;
  sublabel?: string;
  onClick: () => void;
  disabled?: boolean;
  iconColor?: string;
}

export function QuickActionButton({
  icon: Icon,
  label,
  sublabel,
  onClick,
  disabled,
  iconColor = 'text-hud-gold-soft',
}: QuickActionButtonProps) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={`flex flex-col items-center justify-center p-4 bg-hud-bg-card border border-hud-bg-elev rounded-xl transition-all min-w-0 sm:min-w-[120px] ${
        disabled
          ? 'opacity-50 cursor-not-allowed'
          : 'hover:bg-hud-bg-elev hover:border-hud-cream-mute focus:outline-none focus:ring-2 focus:ring-hud-gold/40'
      }`}
    >
      <Icon className={`h-6 w-6 ${iconColor} mb-2`} />
      <span className="text-sm font-medium text-white">{label}</span>
      {sublabel && <span className="text-xs text-hud-cream-mute mt-0.5">{sublabel}</span>}
    </button>
  );
}
