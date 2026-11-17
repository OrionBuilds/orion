import { useState, useEffect } from 'react';
import { X, AlertTriangle } from 'lucide-react';
import { adjustScore, getAdjustmentLimits, type EntityScore, type AdjustmentLimits } from '../../services/scoring';
import { Portal } from '../shared/Portal';

interface AdjustScoreModalProps {
  entityType: 'contact' | 'opportunity';
  entityId: string;
  score: EntityScore;
  onClose: () => void;
  onSaved: () => void;
}

export function AdjustScoreModal({ entityType, entityId, score, onClose, onSaved }: AdjustScoreModalProps) {
  const [limits, setLimits] = useState<AdjustmentLimits | null>(null);
  const [isPositive, setIsPositive] = useState(true);
  const [points, setPoints] = useState<number>(0);
  const [reason, setReason] = useState('');
  const [loading, setLoading] = useState(false);
  const [loadingLimits, setLoadingLimits] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    loadLimits();
  }, []);

  async function loadLimits() {
    try {
      const data = await getAdjustmentLimits();
      setLimits(data);
    } catch (err) {
      console.error('Failed to load limits:', err);
    } finally {
      setLoadingLimits(false);
    }
  }

  const maxScore = score.scoring_models?.max_score;
  const currentScore = score.current_score;
  const finalPoints = isPositive ? Math.abs(points) : -Math.abs(points);
  let newScore = currentScore + finalPoints;
  if (maxScore !== null && maxScore !== undefined && newScore > maxScore) {
    newScore = maxScore;
  }
  if (newScore < 0) {
    newScore = 0;
  }

  const exceedsLimit = limits && (
    (isPositive && points > limits.max_positive_adjustment) ||
    (!isPositive && points > limits.max_negative_adjustment)
  );

  const requiresReason = limits?.require_reason && (!reason || reason.trim() === '');

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();

    if (points === 0) {
      setError('Points cannot be zero');
      return;
    }

    if (exceedsLimit) {
      setError(`Adjustment exceeds the ${isPositive ? 'positive' : 'negative'} limit of ${isPositive ? limits?.max_positive_adjustment : limits?.max_negative_adjustment} points`);
      return;
    }

    if (requiresReason) {
      setError('A reason is required for manual adjustments');
      return;
    }

    try {
      setLoading(true);
      setError('');
      await adjustScore({
        modelId: score.model_id,
        entityType,
        entityId,
        points: finalPoints,
        reason: reason.trim() || undefined,
      });
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to adjust score');
    } finally {
      setLoading(false);
    }
  }

  return (
    <Portal><div className="fixed inset-0 z-50 overflow-y-auto">
      <div className="flex min-h-full items-center justify-center p-4">
        <div className="fixed inset-0 bg-black/50" onClick={onClose} />
        <div className="relative w-full max-w-md bg-white rounded-xl shadow-xl">
          <div className="flex items-center justify-between px-6 py-4 border-b border-hud-cream-soft">
            <h2 className="text-lg font-semibold text-hud-bg-mid">Adjust Score</h2>
            <button onClick={onClose} className="p-1 rounded hover:bg-hud-cream">
              <X className="h-5 w-5 text-hud-cream-mute" />
            </button>
          </div>

          <form onSubmit={handleSubmit} className="p-6 space-y-5">
            {error && (
              <div className="flex items-center gap-2 p-3 bg-hud-plum/10 border border-hud-plum/25 rounded-lg text-sm text-hud-plum">
                <AlertTriangle className="h-4 w-4 flex-shrink-0" />
                {error}
              </div>
            )}

            <div className="text-center py-4 bg-hud-bg-elev rounded-lg">
              <p className="text-sm text-hud-cream-mute mb-1">{score.scoring_models?.name || 'Current Score'}</p>
              <p className="text-3xl font-bold text-white">{currentScore}</p>
            </div>

            <div>
              <label className="block text-sm font-medium text-hud-bg-elev mb-2">Adjustment</label>
              <div className="flex items-center gap-3">
                <div className="flex rounded-lg overflow-hidden border border-hud-cream-soft">
                  <button
                    type="button"
                    onClick={() => setIsPositive(true)}
                    className={`px-4 py-2 text-sm font-medium transition-colors ${
                      isPositive
                        ? 'bg-green-100 text-green-700 border-r border-hud-cream-soft'
                        : 'bg-white text-hud-cream-mute hover:bg-hud-bg-elev border-r border-hud-cream-soft'
                    }`}
                  >
                    + Add
                  </button>
                  <button
                    type="button"
                    onClick={() => setIsPositive(false)}
                    className={`px-4 py-2 text-sm font-medium transition-colors ${
                      !isPositive
                        ? 'bg-hud-plum/15 text-hud-plum'
                        : 'bg-white text-hud-cream-mute hover:bg-hud-bg-elev'
                    }`}
                  >
                    - Subtract
                  </button>
                </div>
                <input
                  type="number"
                  value={points || ''}
                  onChange={(e) => setPoints(Math.abs(Number(e.target.value)))}
                  min={0}
                  placeholder="0"
                  className="w-24 px-3 py-2 border border-hud-cream-soft rounded-lg focus:ring-2 focus:ring-hud-teal focus:border-hud-teal"
                />
                <span className="text-sm text-hud-cream-mute">points</span>
              </div>
              {limits && (
                <p className="mt-1 text-xs text-hud-cream-mute">
                  Limit: +{limits.max_positive_adjustment} / -{limits.max_negative_adjustment} points
                </p>
              )}
            </div>

            {points > 0 && (
              <div className="flex items-center justify-between p-4 bg-hud-bg-elev rounded-lg">
                <span className="text-sm text-hud-cream-mute">New Score</span>
                <div className="flex items-center gap-2">
                  <span className="text-sm text-hud-cream-dim line-through">{currentScore}</span>
                  <span className="text-lg font-bold text-white">{newScore}</span>
                  <span className={`text-sm font-medium ${isPositive ? 'text-green-600' : 'text-hud-plum'}`}>
                    ({isPositive ? '+' : ''}{finalPoints})
                  </span>
                </div>
              </div>
            )}

            <div>
              <label className="block text-sm font-medium text-hud-bg-elev mb-1">
                Reason {limits?.require_reason && <span className="text-hud-plum">*</span>}
              </label>
              <textarea
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder="Explain why you're adjusting this score..."
                rows={3}
                className="w-full px-3 py-2 border border-hud-cream-soft rounded-lg focus:ring-2 focus:ring-hud-teal focus:border-hud-teal resize-none"
              />
              <p className="mt-1 text-xs text-hud-cream-mute text-right">{reason.length}/500</p>
            </div>

            <div className="flex justify-end gap-3 pt-4 border-t border-hud-cream-soft">
              <button
                type="button"
                onClick={onClose}
                className="px-4 py-2 text-sm font-medium text-hud-bg-elev bg-white border border-hud-cream-soft rounded-lg hover:bg-hud-cream"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={loading || loadingLimits || points === 0}
                className="px-4 py-2 text-sm font-medium text-hud-bg-deep bg-hud-teal rounded-lg hover:bg-hud-teal disabled:opacity-50"
              >
                {loading ? 'Adjusting...' : 'Apply Adjustment'}
              </button>
            </div>
          </form>
        </div>
      </div>
    </div></Portal>
  );
}
