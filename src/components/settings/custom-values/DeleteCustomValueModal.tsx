import { AlertTriangle } from 'lucide-react';
import type { CustomValue } from '../../../services/customValues';
import { formatTokenKey } from '../../../services/customValues';
import { Portal } from '../../shared/Portal';

interface Props {
  value: CustomValue;
  usageCount: number;
  onClose: () => void;
  onConfirm: () => void;
}

export function DeleteCustomValueModal({ value, usageCount, onClose, onConfirm }: Props) {
  return (
    <Portal><div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
      <div className="bg-hud-bg-card rounded-xl p-6 max-w-md w-full mx-4 shadow-xl border border-hud-bg-elev">
        <div className="flex items-center gap-3 text-hud-plum mb-4">
          <div className="p-2 bg-hud-plum/10 rounded-lg">
            <AlertTriangle className="h-6 w-6" />
          </div>
          <h3 className="text-lg font-semibold text-white">Delete Custom Value</h3>
        </div>

        <div className="space-y-4">
          <p className="text-hud-cream-soft">
            Are you sure you want to delete this custom value?
          </p>

          <div className="p-3 bg-hud-bg-mid rounded-lg border border-hud-bg-elev">
            <p className="text-sm text-hud-cream-dim mb-1">Token being deleted:</p>
            <code className="text-hud-gold-soft font-mono text-sm">
              {formatTokenKey(value.key)}
            </code>
          </div>

          {usageCount > 0 && (
            <div className="p-3 bg-hud-rust/10 rounded-lg border border-hud-rust/20">
              <p className="text-sm text-hud-rust">
                This value is referenced in <strong>{usageCount}</strong> place{usageCount > 1 ? 's' : ''} across automations, snippets, and AI prompts.
              </p>
            </div>
          )}

          <p className="text-sm text-hud-cream-dim">
            Existing content containing this token will show an unresolved placeholder.
            Past sent messages are not affected.
          </p>
        </div>

        <div className="flex justify-end gap-3 mt-6">
          <button
            onClick={onClose}
            className="px-4 py-2 text-hud-cream-dim hover:text-hud-cream-soft text-sm font-medium rounded-lg hover:bg-hud-bg-elev"
          >
            Cancel
          </button>
          <button
            onClick={onConfirm}
            className="px-4 py-2 bg-hud-plum text-white rounded-lg text-sm font-medium hover:bg-hud-plum"
          >
            Delete Value
          </button>
        </div>
      </div>
    </div></Portal>
  );
}
