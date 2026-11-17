interface SystemHealthIndicatorProps {
  label: string;
  status: 'connected' | 'degraded' | 'disconnected';
  onClick?: () => void;
}

const statusConfig = {
  connected: {
    dot: 'bg-hud-emerald',
    text: 'text-hud-emerald',
    label: 'Connected',
  },
  degraded: {
    dot: 'bg-hud-rust',
    text: 'text-hud-rust',
    label: 'Degraded',
  },
  disconnected: {
    dot: 'bg-hud-cream-mute',
    text: 'text-hud-cream-mute',
    label: 'Not connected',
  },
};

export function SystemHealthIndicator({ label, status, onClick }: SystemHealthIndicatorProps) {
  const config = statusConfig[status];

  return (
    <button
      onClick={onClick}
      className="flex items-center gap-3 px-4 py-2.5 bg-hud-bg-card border border-hud-bg-elev rounded-lg hover:bg-hud-bg-elev/50 transition-colors focus:outline-none focus:ring-2 focus:ring-hud-gold/40"
    >
      <span className={`h-2 w-2 rounded-full ${config.dot}`} />
      <div className="text-left">
        <p className="text-sm font-medium text-white">{label}</p>
        <p className={`text-xs ${config.text}`}>{config.label}</p>
      </div>
    </button>
  );
}
