import { useState } from 'react';
import { AlertTriangle, X } from 'lucide-react';
import type { CustomField } from '../../../types';
import { Portal } from '../../shared/Portal';

interface DependencyWarningModalProps {
  field: CustomField;
  valueCount: number;
  onConfirm: () => void;
  onCancel: () => void;
  deleting?: boolean;
}

export function DependencyWarningModal({
  field,
  valueCount,
  onConfirm,
  onCancel,
  deleting = false,
}: DependencyWarningModalProps) {
  const [confirmed, setConfirmed] = useState(false);

  return (
    <Portal><div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/60" onClick={onCancel} />
      <div className="relative bg-hud-bg-card rounded-xl shadow-xl w-full max-w-md border border-hud-bg-elev">
        <div className="flex items-center justify-between px-6 py-4 border-b border-hud-bg-elev">
          <h2 className="text-lg font-semibold text-white">Delete Custom Field</h2>
          <button
            onClick={onCancel}
            className="p-2 text-hud-cream-dim hover:text-white hover:bg-hud-bg-elev rounded-lg transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="p-6 space-y-4">
          <div className="flex items-start gap-4 p-4 bg-hud-plum/10 border border-hud-plum/30 rounded-lg">
            <div className="p-2 bg-hud-plum/20 rounded-lg shrink-0">
              <AlertTriangle className="w-5 h-5 text-hud-plum" />
            </div>
            <div>
              <p className="font-medium text-hud-plum">Warning: This action cannot be undone</p>
              <p className="text-sm text-hud-cream-dim mt-1">
                You are about to delete the custom field <span className="font-medium text-white">"{field.name}"</span>
              </p>
            </div>
          </div>

          {valueCount > 0 && (
            <div className="p-4 bg-hud-rust/10 border border-hud-rust/30 rounded-lg">
              <p className="text-sm text-hud-rust">
                <span className="font-semibold">{valueCount.toLocaleString()}</span> record{valueCount !== 1 ? 's' : ''} currently {valueCount !== 1 ? 'use' : 'uses'} this field.
              </p>
              <p className="text-sm text-hud-cream-dim mt-2">
                Existing data will be <span className="text-hud-rust font-medium">hidden, not deleted</span>. The data will no longer be visible in the UI but can be recovered if needed.
              </p>
            </div>
          )}

          <div className="space-y-2">
            <p className="text-sm font-medium text-hud-cream-soft">Field Details</p>
            <div className="p-3 bg-hud-bg-mid rounded-lg space-y-1">
              <div className="flex justify-between text-sm">
                <span className="text-hud-cream-mute">Field Key:</span>
                <span className="text-hud-cream-soft font-mono">{field.field_key}</span>
              </div>
              <div className="flex justify-between text-sm">
                <span className="text-hud-cream-mute">Type:</span>
                <span className="text-hud-cream-soft">{field.field_type}</span>
              </div>
              <div className="flex justify-between text-sm">
                <span className="text-hud-cream-mute">Scope:</span>
                <span className="text-hud-cream-soft capitalize">{field.scope}</span>
              </div>
            </div>
          </div>

          <label className="flex items-start gap-3 cursor-pointer">
            <input
              type="checkbox"
              checked={confirmed}
              onChange={(e) => setConfirmed(e.target.checked)}
              className="mt-1 w-4 h-4 rounded border-hud-cream-mute bg-hud-bg-mid text-hud-gold focus:ring-hud-gold focus:ring-offset-hud-bg-card"
            />
            <span className="text-sm text-hud-cream-soft">
              I understand that deleting this field will hide all associated data and this action cannot be easily reversed.
            </span>
          </label>
        </div>

        <div className="flex items-center justify-end gap-3 px-6 py-4 border-t border-hud-bg-elev bg-hud-bg-mid/50">
          <button
            type="button"
            onClick={onCancel}
            className="px-4 py-2 text-sm font-medium text-hud-cream-soft border border-hud-cream-mute rounded-lg hover:bg-hud-bg-elev transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={onConfirm}
            disabled={!confirmed || deleting}
            className="px-4 py-2 text-sm font-medium text-white bg-hud-plum rounded-lg hover:bg-hud-plum disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            {deleting ? 'Deleting...' : 'Delete Field'}
          </button>
        </div>
      </div>
    </div></Portal>
  );
}
