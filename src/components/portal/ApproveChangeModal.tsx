import { useState } from 'react';
import { CheckCircle2, DollarSign, Clock, AlertCircle } from 'lucide-react';
import type { ProjectChangeRequest } from '../../types';
import { Portal } from '../shared/Portal';

interface Props {
  request: ProjectChangeRequest;
  onConfirm: () => Promise<void>;
  onClose: () => void;
}

export function ApproveChangeModal({ request, onConfirm, onClose }: Props) {
  const [processing, setProcessing] = useState(false);
  const [error, setError] = useState('');

  async function handleConfirm() {
    setProcessing(true);
    setError('');
    try {
      await onConfirm();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to approve. Please try again.');
    } finally {
      setProcessing(false);
    }
  }

  return (
    <Portal><div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/40" onClick={onClose} />
      <div className="relative bg-white [color-scheme:light] rounded-2xl shadow-xl w-full max-w-md p-6 animate-in fade-in zoom-in-95 duration-200">
        <div className="flex items-center gap-3 mb-5">
          <div className="w-10 h-10 bg-hud-emerald/15 rounded-xl flex items-center justify-center">
            <CheckCircle2 className="w-5 h-5 text-hud-emerald-dim" />
          </div>
          <div>
            <h2 className="text-base font-bold text-hud-bg-mid">Approve Change Request</h2>
            <p className="text-sm text-hud-cream-mute">This action cannot be undone</p>
          </div>
        </div>

        <div className="bg-hud-bg-elev rounded-xl p-4 mb-5 space-y-3">
          <p className="text-sm font-medium text-white">{request.title}</p>

          {(request.cost_impact_visible_to_client && request.cost_impact > 0) && (
            <div className="flex items-center gap-2 text-sm">
              <DollarSign className="w-4 h-4 text-hud-cream-dim" />
              <span className="text-hud-cream-mute">Additional cost:</span>
              <span className="font-semibold text-white">
                +${Number(request.cost_impact).toLocaleString()}
              </span>
            </div>
          )}

          {(request.timeline_impact_visible_to_client && request.timeline_impact_days > 0) && (
            <div className="flex items-center gap-2 text-sm">
              <Clock className="w-4 h-4 text-hud-cream-dim" />
              <span className="text-hud-cream-mute">Timeline extension:</span>
              <span className="font-semibold text-white">+{request.timeline_impact_days} days</span>
            </div>
          )}
        </div>

        <p className="text-sm text-hud-cream-mute mb-5">
          By approving, you authorize the project team to proceed with this change. Any associated costs and
          timeline impacts will apply to your project.
        </p>

        {error && (
          <div className="flex items-center gap-2 text-sm text-hud-plum bg-hud-plum/10 border border-hud-plum/25 rounded-lg px-3 py-2 mb-4">
            <AlertCircle className="w-4 h-4 flex-none" />
            {error}
          </div>
        )}

        <div className="flex gap-3">
          <button
            onClick={onClose}
            className="flex-1 py-2.5 text-sm text-hud-cream-mute bg-hud-cream hover:bg-hud-cream-soft rounded-xl transition-colors font-medium"
          >
            Cancel
          </button>
          <button
            onClick={handleConfirm}
            disabled={processing}
            className="flex-1 flex items-center justify-center gap-2 py-2.5 text-sm font-semibold text-white hover:text-hud-bg-deep bg-hud-emerald-dim hover:bg-hud-emerald disabled:opacity-50 rounded-xl transition-colors"
          >
            <CheckCircle2 className="w-4 h-4" />
            {processing ? 'Approving...' : 'Confirm Approval'}
          </button>
        </div>
      </div>
    </div></Portal>
  );
}
