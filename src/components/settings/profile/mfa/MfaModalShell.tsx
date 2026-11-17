import type { ReactNode } from 'react';
import { X } from 'lucide-react';
import { Portal } from '../../../shared/Portal';

interface MfaModalShellProps {
  title: string;
  subtitle?: string;
  icon: ReactNode;
  onClose: () => void;
  closeDisabled?: boolean;
  children: ReactNode;
}

export function MfaModalShell({ title, subtitle, icon, onClose, closeDisabled, children }: MfaModalShellProps) {
  return (
    <Portal>
      <div className="fixed inset-0 bg-black/70 z-[60] flex items-center justify-center p-4" role="dialog" aria-modal="true" aria-label={title}>
        <div className="bg-hud-bg-mid rounded-xl border border-hud-bg-card max-w-md w-full max-h-[90dvh] overflow-y-auto">
          <div className="flex items-start justify-between gap-3 p-6 pb-4 border-b border-hud-bg-card">
            <div className="flex items-start gap-3">
              <div className="p-2 rounded-lg bg-hud-gold/10 text-hud-gold-soft">{icon}</div>
              <div>
                <h3 className="text-lg font-semibold text-white">{title}</h3>
                {subtitle && <p className="text-sm text-hud-cream-dim mt-0.5">{subtitle}</p>}
              </div>
            </div>
            <button
              type="button"
              onClick={onClose}
              disabled={closeDisabled}
              aria-label="Close"
              className="p-1.5 rounded-lg text-hud-cream-dim hover:text-white hover:bg-hud-bg-card disabled:opacity-50"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
          <div className="p-6">{children}</div>
        </div>
      </div>
    </Portal>
  );
}

export function MfaErrorBox({ message }: { message: string }) {
  return (
    <div role="alert" className="p-3 rounded-lg bg-hud-plum/10 border border-hud-plum/30 text-hud-plum text-sm">
      {message}
    </div>
  );
}
