import { useState, useEffect } from 'react';
import { X, ArrowUpRight, ArrowDownRight, User, Zap, Timer, ChevronDown } from 'lucide-react';
import { getScoreHistory, type ScoreEvent, formatScoreChange, getScoreChangeColor } from '../../services/scoring';
import { Portal } from '../shared/Portal';

interface ScoreHistoryPanelProps {
  entityType: 'contact' | 'opportunity';
  entityId: string;
  modelId: string;
  modelName: string;
  onClose: () => void;
}

export function ScoreHistoryPanel({ entityType, entityId, modelId, modelName, onClose }: ScoreHistoryPanelProps) {
  const [events, setEvents] = useState<ScoreEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [hasMore, setHasMore] = useState(false);
  const [offset, setOffset] = useState(0);
  const limit = 20;

  useEffect(() => {
    loadHistory();
  }, []);

  async function loadHistory(append = false) {
    try {
      setLoading(true);
      const result = await getScoreHistory(entityType, entityId, {
        modelId,
        limit,
        offset: append ? offset : 0,
      });
      setEvents(append ? [...events, ...result.events] : result.events);
      setHasMore(result.events.length === limit);
      setOffset(append ? offset + limit : limit);
    } catch (error) {
      console.error('Failed to load score history:', error);
    } finally {
      setLoading(false);
    }
  }

  function getSourceIcon(source: string) {
    switch (source) {
      case 'rule':
        return <Zap className="h-4 w-4 text-blue-500" />;
      case 'manual':
        return <User className="h-4 w-4 text-purple-500" />;
      case 'decay':
        return <Timer className="h-4 w-4 text-orange-500" />;
      default:
        return null;
    }
  }

  function getSourceLabel(source: string) {
    switch (source) {
      case 'rule':
        return 'Rule';
      case 'manual':
        return 'Manual';
      case 'decay':
        return 'Decay';
      default:
        return source;
    }
  }

  function formatDate(dateString: string): string {
    const date = new Date(dateString);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffHours = Math.floor(diffMs / (1000 * 60 * 60));
    const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

    if (diffHours < 1) {
      const diffMinutes = Math.floor(diffMs / (1000 * 60));
      return `${diffMinutes} min ago`;
    }
    if (diffHours < 24) {
      return `${diffHours}h ago`;
    }
    if (diffDays < 7) {
      return `${diffDays}d ago`;
    }
    return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  }

  return (
    <Portal><div className="fixed inset-0 z-50 overflow-hidden">
      <div className="absolute inset-0 bg-black/50" onClick={onClose} />
      <div className="absolute inset-y-0 right-0 w-full max-w-md bg-white shadow-xl flex flex-col">
        <div className="flex items-center justify-between px-6 py-4 border-b border-hud-cream-soft">
          <div>
            <h2 className="text-lg font-semibold text-hud-bg-mid">Score History</h2>
            <p className="text-sm text-hud-cream-mute">{modelName}</p>
          </div>
          <button onClick={onClose} className="p-1 rounded hover:bg-hud-cream">
            <X className="h-5 w-5 text-hud-cream-mute" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-6">
          {loading && events.length === 0 ? (
            <div className="flex items-center justify-center h-32">
              <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-hud-teal" />
            </div>
          ) : events.length === 0 ? (
            <div className="text-center py-12">
              <p className="text-hud-cream-mute">No score history yet.</p>
            </div>
          ) : (
            <div className="space-y-4">
              {events.map((event, index) => (
                <div
                  key={event.id}
                  className={`relative pl-6 pb-4 ${
                    index < events.length - 1 ? 'border-l-2 border-hud-cream' : ''
                  }`}
                >
                  <div className="absolute left-0 top-0 -translate-x-1/2 w-3 h-3 rounded-full bg-white border-2 border-hud-cream-soft" />
                  <div className="bg-hud-bg-elev rounded-lg p-4">
                    <div className="flex items-center justify-between mb-2">
                      <div className="flex items-center gap-2">
                        {event.points_delta > 0 ? (
                          <ArrowUpRight className="h-4 w-4 text-green-500" />
                        ) : (
                          <ArrowDownRight className="h-4 w-4 text-hud-plum" />
                        )}
                        <span className={`text-lg font-bold ${getScoreChangeColor(event.points_delta)}`}>
                          {formatScoreChange(event.points_delta)}
                        </span>
                        <span className="text-sm text-hud-cream-mute">
                          ({event.previous_score} → {event.new_score})
                        </span>
                      </div>
                      <span className="text-xs text-hud-cream-dim">{formatDate(event.created_at)}</span>
                    </div>
                    <p className="text-sm text-hud-cream-soft mb-2">{event.reason}</p>
                    <div className="flex items-center gap-3 text-xs text-hud-cream-mute">
                      <span className="flex items-center gap-1">
                        {getSourceIcon(event.source)}
                        {getSourceLabel(event.source)}
                      </span>
                      {event.scoring_rules?.name && (
                        <span className="px-2 py-0.5 bg-blue-50 text-blue-700 rounded">
                          {event.scoring_rules.name}
                        </span>
                      )}
                      {event.users && (
                        <span className="flex items-center gap-1">
                          <User className="h-3 w-3" />
                          {/* REAL BUG FIX: users join has `name`, not first_name/last_name —
                              the old expression always fell through to email. */}
                          {event.users.name || event.users.email}
                        </span>
                      )}
                    </div>
                  </div>
                </div>
              ))}

              {hasMore && (
                <button
                  onClick={() => loadHistory(true)}
                  disabled={loading}
                  className="flex items-center justify-center gap-2 w-full py-3 text-sm text-hud-teal hover:text-hud-teal disabled:opacity-50"
                >
                  {loading ? (
                    <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-hud-teal" />
                  ) : (
                    <>
                      <ChevronDown className="h-4 w-4" />
                      Load more
                    </>
                  )}
                </button>
              )}
            </div>
          )}
        </div>
      </div>
    </div></Portal>
  );
}
