import { useState, useEffect } from 'react';
import { X, AlertTriangle, DollarSign } from 'lucide-react';
import type { Opportunity, LostReason } from '../../types';
import { getLostReasons } from '../../services/lostReasons';
import { formatCurrencyOptionalCents } from '../../utils/formatters';
import { Portal } from '../shared/Portal';

interface CloseLostModalProps {
  opportunity: Opportunity;
  onClose: () => void;
  onConfirm: (lostReasonId: string, lostReasonText: string, notes?: string) => Promise<void>;
}

export function CloseLostModal({ opportunity, onClose, onConfirm }: CloseLostModalProps) {
  const [lostReasons, setLostReasons] = useState<LostReason[]>([]);
  const [selectedReasonId, setSelectedReasonId] = useState<string>('');
  const [notes, setNotes] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    loadLostReasons();
  }, []);

  async function loadLostReasons() {
    try {
      const reasons = await getLostReasons(true);
      setLostReasons(reasons);
      if (reasons.length > 0) {
        setSelectedReasonId(reasons[0].id);
      }
    } catch (err) {
      console.error('Failed to load lost reasons:', err);
      setError('Failed to load lost reasons');
    } finally {
      setLoading(false);
    }
  }

  const handleConfirm = async () => {
    if (!selectedReasonId) {
      setError('Please select a reason');
      return;
    }

    const selectedReason = lostReasons.find(r => r.id === selectedReasonId);
    if (!selectedReason) return;

    setSaving(true);
    try {
      await onConfirm(selectedReasonId, selectedReason.name, notes || undefined);
    } catch (err) {
      console.error('Failed to close opportunity:', err);
      setError('Failed to mark as lost');
      setSaving(false);
    }
  };

  const contactName = opportunity.contact
    ? `${opportunity.contact.first_name} ${opportunity.contact.last_name}`.trim()
    : 'Unknown Contact';

  return (
    <Portal><div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div className="bg-hud-bg-card rounded-xl w-full max-w-md shadow-xl">
        <div className="flex items-center justify-between p-4 border-b border-hud-bg-elev">
          <div className="flex items-center gap-2 text-hud-plum">
            <AlertTriangle className="w-5 h-5" />
            <h2 className="text-lg font-semibold">Mark as Lost</h2>
          </div>
          <button onClick={onClose} className="p-1 hover:bg-hud-bg-elev rounded">
            <X className="w-5 h-5 text-hud-cream-dim" />
          </button>
        </div>

        <div className="p-4 space-y-4">
          <div className="p-3 bg-hud-bg-elev/50 rounded-lg">
            <div className="text-white font-medium mb-1">{contactName}</div>
            <div className="flex items-center gap-2 text-sm text-hud-emerald">
              <DollarSign className="w-4 h-4" />
              {formatCurrencyOptionalCents(Number(opportunity.value_amount), opportunity.currency)}
            </div>
            {opportunity.pipeline && (
              <div className="text-sm text-hud-cream-dim mt-1">
                {opportunity.pipeline.name} - {opportunity.stage?.name}
              </div>
            )}
          </div>

          {loading ? (
            <div className="flex items-center justify-center py-8">
              <div className="animate-spin w-6 h-6 border-2 border-hud-gold-soft border-t-transparent rounded-full" />
            </div>
          ) : (
            <>
              <div>
                <label className="block text-sm font-medium text-hud-cream-soft mb-2">
                  Reason for Loss <span className="text-hud-plum">*</span>
                </label>
                <select
                  value={selectedReasonId}
                  onChange={(e) => setSelectedReasonId(e.target.value)}
                  className="w-full px-3 py-2.5 bg-hud-bg-elev border border-hud-cream-mute rounded-lg text-white"
                >
                  <option value="" disabled>Select a reason...</option>
                  {lostReasons.map(reason => (
                    <option key={reason.id} value={reason.id}>
                      {reason.name}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label className="block text-sm font-medium text-hud-cream-soft mb-2">
                  Additional Notes (optional)
                </label>
                <textarea
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  placeholder="Any additional context about why this was lost..."
                  rows={3}
                  className="w-full px-3 py-2 bg-hud-bg-elev border border-hud-cream-mute rounded-lg text-white placeholder-hud-cream-dim resize-none"
                />
              </div>

              {error && (
                <div className="p-3 bg-hud-plum/20 border border-hud-plum/50 rounded-lg text-hud-plum text-sm">
                  {error}
                </div>
              )}
            </>
          )}
        </div>

        <div className="flex justify-end gap-2 p-4 border-t border-hud-bg-elev">
          <button
            onClick={onClose}
            className="px-4 py-2 text-hud-cream-soft hover:bg-hud-bg-elev rounded-lg"
            disabled={saving}
          >
            Cancel
          </button>
          <button
            onClick={handleConfirm}
            disabled={saving || loading || !selectedReasonId}
            className="px-4 py-2 bg-hud-plum text-white rounded-lg hover:bg-hud-plum disabled:opacity-50 flex items-center gap-2"
          >
            {saving ? (
              <>
                <div className="animate-spin w-4 h-4 border-2 border-white border-t-transparent rounded-full" />
                Saving...
              </>
            ) : (
              'Mark as Lost'
            )}
          </button>
        </div>
      </div>
    </div></Portal>
  );
}
