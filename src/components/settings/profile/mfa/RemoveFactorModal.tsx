import { useState } from 'react';
import { Trash2 } from 'lucide-react';
import { describeMfaError } from '../../../../lib/mfa';
import { unenrollFactor, type MfaFactor } from '../../../../services/mfa';
import { MfaVerifyPanel } from '../../../mfa/MfaVerifyPanel';
import { factorLabel } from '../../../mfa/factorLabel';
import { MfaErrorBox, MfaModalShell } from './MfaModalShell';

interface RemoveFactorModalProps {
  target: MfaFactor;
  verifiedFactors: MfaFactor[];
  onClose: () => void;
  onRemoved: () => void | Promise<void>;
}

/**
 * Removing a factor needs a fresh second-factor check first. The user may answer with any of their
 * verified methods (including the one being removed), so a lost phone can be removed with the
 * authenticator app and vice versa. Supabase itself also requires an aal2 session to unenroll a
 * verified factor.
 */
export function RemoveFactorModal({ target, verifiedFactors, onClose, onRemoved }: RemoveFactorModalProps) {
  const [error, setError] = useState<string | null>(null);
  const isLast = verifiedFactors.length <= 1;

  return (
    <MfaModalShell
      title="Remove verification method"
      subtitle={factorLabel(target)}
      icon={<Trash2 className="w-5 h-5" />}
      onClose={onClose}
    >
      <div className="space-y-4">
        <p className="text-sm text-hud-cream-soft">
          Confirm it's you with a current code before removing this method.
          {isLast && (
            <span className="block mt-2 text-hud-rust">
              This is your only method. Removing it turns off two-factor authentication for your account.
            </span>
          )}
        </p>
        {error && <MfaErrorBox message={error} />}
        <MfaVerifyPanel
          factors={verifiedFactors}
          initialFactorId={verifiedFactors.find((f) => f.id !== target.id)?.id ?? target.id}
          submitLabel="Verify and remove"
          onVerified={async () => {
            setError(null);
            try {
              await unenrollFactor(target.id);
              await onRemoved();
            } catch (err) {
              setError(describeMfaError(err, 'Could not remove this method.'));
            }
          }}
        />
        <div className="flex justify-end">
          <button type="button" onClick={onClose} className="px-4 py-2 rounded-lg bg-hud-bg-card text-white hover:bg-hud-bg-elev">
            Cancel
          </button>
        </div>
      </div>
    </MfaModalShell>
  );
}
