import { useState } from 'react';
import { X, AlertTriangle } from 'lucide-react';
import { Portal } from '../shared/Portal';

interface ConfirmDangerModalProps {
  isOpen: boolean;
  onClose: () => void;
  onConfirm: () => void;
  title: string;
  description: string;
  confirmText?: string;
  isLoading?: boolean;
}

export function ConfirmDangerModal({
  isOpen,
  onClose,
  onConfirm,
  title,
  description,
  confirmText = 'CONFIRM',
  isLoading,
}: ConfirmDangerModalProps) {
  const [inputValue, setInputValue] = useState('');

  if (!isOpen) return null;

  const isValid = inputValue === confirmText;

  function handleConfirm() {
    if (isValid) {
      onConfirm();
      setInputValue('');
    }
  }

  function handleClose() {
    setInputValue('');
    onClose();
  }

  return (
    <Portal><div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="fixed inset-0 bg-black/60" onClick={handleClose} />
      <div className="relative bg-hud-bg-card rounded-xl border border-hud-bg-elev shadow-xl max-w-md w-full mx-4">
        <div className="flex items-center justify-between p-4 border-b border-hud-bg-elev">
          <div className="flex items-center gap-3">
            <div className="p-2 bg-hud-plum/10 rounded-lg">
              <AlertTriangle className="h-5 w-5 text-hud-plum" />
            </div>
            <h2 className="text-lg font-semibold text-white">{title}</h2>
          </div>
          <button
            onClick={handleClose}
            className="p-1.5 hover:bg-hud-bg-elev rounded-lg transition-colors"
          >
            <X className="h-5 w-5 text-hud-cream-dim" />
          </button>
        </div>

        <div className="p-4">
          <p className="text-sm text-hud-cream-soft mb-4">{description}</p>

          <div className="mb-4">
            <label className="block text-sm text-hud-cream-dim mb-2">
              Type <span className="font-mono text-hud-plum">{confirmText}</span> to confirm
            </label>
            <input
              type="text"
              value={inputValue}
              onChange={e => setInputValue(e.target.value)}
              className="w-full px-3 py-2 bg-hud-bg-mid border border-hud-cream-mute rounded-lg text-white placeholder:text-hud-cream-dim focus:outline-none focus:ring-2 focus:ring-hud-plum/50 focus:border-hud-plum"
              placeholder={confirmText}
            />
          </div>

          <div className="flex gap-3">
            <button
              onClick={handleClose}
              className="flex-1 px-4 py-2 bg-hud-bg-elev hover:bg-hud-cream-mute rounded-lg text-sm font-medium text-white transition-colors"
            >
              Cancel
            </button>
            <button
              onClick={handleConfirm}
              disabled={!isValid || isLoading}
              className="flex-1 px-4 py-2 bg-hud-plum hover:bg-hud-plum disabled:bg-hud-plum/50 disabled:cursor-not-allowed rounded-lg text-sm font-medium text-white transition-colors"
            >
              {isLoading ? 'Processing...' : 'Confirm'}
            </button>
          </div>
        </div>
      </div>
    </div></Portal>
  );
}
