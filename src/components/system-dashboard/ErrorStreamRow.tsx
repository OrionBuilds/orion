import { useState } from 'react';
import { ChevronDown, ChevronRight, Eye, CheckCircle } from 'lucide-react';
import type { SystemError } from '../../hooks/useSystemDashboardData';
import { SeverityBadge } from './SeverityBadge';

interface ErrorStreamRowProps {
  error: SystemError;
  onAcknowledge: (id: string) => void;
  onViewLogs?: () => void;
}

function formatTimestamp(timestamp: string): string {
  const date = new Date(timestamp);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);

  if (diffMins < 1) return 'Just now';
  if (diffMins < 60) return `${diffMins}m ago`;
  const diffHours = Math.floor(diffMins / 60);
  if (diffHours < 24) return `${diffHours}h ago`;
  return date.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

export function ErrorStreamRow({ error, onAcknowledge, onViewLogs }: ErrorStreamRowProps) {
  const [expanded, setExpanded] = useState(false);

  const rowBorderColor = {
    info: 'border-l-blue-400',
    warning: 'border-l-hud-rust',
    error: 'border-l-hud-plum',
    critical: 'border-l-hud-plum',
  }[error.severity];

  return (
    <div
      className={`bg-hud-bg-card/50 border-l-2 ${rowBorderColor} rounded-r-lg ${
        error.acknowledged ? 'opacity-60' : ''
      }`}
    >
      <div className="p-3">
        <div className="flex items-start gap-3">
          <button
            onClick={() => setExpanded(!expanded)}
            className="p-1 hover:bg-hud-bg-elev rounded transition-colors mt-0.5"
            disabled={!error.stackTrace}
          >
            {error.stackTrace ? (
              expanded ? (
                <ChevronDown className="h-4 w-4 text-hud-cream-dim" />
              ) : (
                <ChevronRight className="h-4 w-4 text-hud-cream-dim" />
              )
            ) : (
              <div className="w-4 h-4" />
            )}
          </button>

          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 mb-1">
              <SeverityBadge severity={error.severity} />
              <span className="text-xs text-hud-cream-mute font-medium">{error.service}</span>
              <span className="text-xs text-hud-cream-mute">|</span>
              <span className="text-xs text-hud-cream-mute">{formatTimestamp(error.timestamp)}</span>
              {error.affectedCount > 0 && (
                <>
                  <span className="text-xs text-hud-cream-mute">|</span>
                  <span className="text-xs text-hud-cream-dim">
                    {error.affectedCount} affected
                  </span>
                </>
              )}
            </div>
            <p className="text-sm text-white truncate">{error.summary}</p>
          </div>

          <div className="flex items-center gap-1">
            {onViewLogs && (
              <button
                onClick={onViewLogs}
                className="p-1.5 hover:bg-hud-bg-elev rounded transition-colors"
                title="View logs"
              >
                <Eye className="h-4 w-4 text-hud-cream-dim" />
              </button>
            )}
            {!error.acknowledged && (
              <button
                onClick={() => onAcknowledge(error.id)}
                className="p-1.5 hover:bg-hud-bg-elev rounded transition-colors"
                title="Acknowledge"
              >
                <CheckCircle className="h-4 w-4 text-hud-cream-dim" />
              </button>
            )}
          </div>
        </div>
      </div>

      {expanded && error.stackTrace && (
        <div className="px-3 pb-3 pt-0">
          <pre className="bg-hud-bg-mid rounded p-3 text-xs text-hud-cream-soft font-mono overflow-x-auto">
            {error.stackTrace}
          </pre>
        </div>
      )}
    </div>
  );
}
