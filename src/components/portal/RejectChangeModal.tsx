import { useState } from 'react';
import { XCircle, AlertCircle } from 'lucide-react';
import type { ProjectChangeRequest } from '../../types';
import { Portal } from '../shared/Portal';

interface Props {
  request: ProjectChangeRequest;
  onConfirm: (reason: string) => Promise<void>;
  onClose: () => void;
}

export function RejectChangeModal({ request, onConfirm, onClose }: Props) {
  const [reason, setReason] = useState('');
  const [processing, setProcessing] = useState(false);
  const [error, setError] = useState('');

  async function handleConfirm() {
    setProcessing(true);
    setError('');
    try {
      await onConfirm(reason);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to reject. Please try again.');
    } finally {
      setProcessing(false);
    }
  }

  return (
    <Portal><div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/40" onClick={onClose} />
      <div className="relative bg-white [color-scheme:light] rounded-2xl shadow-xl w-full max-w-md p-6 animate-in fade-in zoom-in-95 duration-200">
        <div className="flex items-center gap-3 mb-5">
          <div className="w-10 h-10 bg-hud-plum/15 rounded-xl flex items-center justify-center">
            <XCircle className="w-5 h-5 text-hud-plum" />
          </div>
          <div>
            <h2 className="text-base font-bold text-hud-bg-mid">Reject Change Request</h2>
            <p className="text-sm text-hud-cream-mute">{request.title}</p>
          </div>
        </div>

        <p className="text-sm text-hud-cream-mute mb-4">
          Please let the project team know why you are declining this change request. Your feedback helps them understand your needs.
        </p>

        <div className="mb-5">
          <label className="block text-sm font-medium text-hud-bg-elev mb-1.5">
            Reason <span className="text-hud-cream-dim font-normal">(optional)</span>
          </label>
          <textarea
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            rows={3}
            placeholder="e.g. Budget constraints, scope creep, need to discuss alternatives..."
            className="w-full px-3 py-2.5 text-sm border border-hud-cream-soft rounded-xl focus:outline-none focus:ring-2 focus:ring-hud-plum/30 focus:border-hud-plum resize-none bg-white text-hud-bg-mid placeholder-hud-cream-mute"
          />
        </div>

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
            className="flex-1 flex items-center justify-center gap-2 py-2.5 text-sm font-semibold text-white bg-hud-plum hover:bg-hud-plum disabled:opacity-50 rounded-xl transition-colors"
          >
            <XCircle className="w-4 h-4" />
            {processing ? 'Processing...' : 'Confirm Rejection'}
          </button>
        </div>
      </div>
    </div></Portal>
  );
}
