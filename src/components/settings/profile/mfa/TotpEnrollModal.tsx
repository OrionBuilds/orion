import { useEffect, useRef, useState } from 'react';
import { Check, Copy, Loader2, ShieldCheck, Smartphone } from 'lucide-react';
import { describeMfaError, isValidOtp } from '../../../../lib/mfa';
import {
  challengeAndVerifyTotp,
  discardPendingFactor,
  enrollTotp,
  type TotpEnrollment,
} from '../../../../services/mfa';
import { OtpCodeInput } from '../../../mfa/OtpCodeInput';
import { MfaErrorBox, MfaModalShell } from './MfaModalShell';

interface TotpEnrollModalProps {
  onClose: () => void;
  onEnrolled: (friendlyName: string) => void | Promise<void>;
}

type Step = 'name' | 'scan';

/** Enroll -> show QR + secret -> verify the first code (which marks the factor verified). */
export function TotpEnrollModal({ onClose, onEnrolled }: TotpEnrollModalProps) {
  const [step, setStep] = useState<Step>('name');
  const [friendlyName, setFriendlyName] = useState('Authenticator app');
  const [enrollment, setEnrollment] = useState<TotpEnrollment | null>(null);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const completed = useRef(false);
  const pendingId = useRef<string | null>(null);

  // A factor enrolled but never verified is dropped when the modal goes away.
  useEffect(() => {
    return () => {
      if (!completed.current && pendingId.current) void discardPendingFactor(pendingId.current);
    };
  }, []);

  const start = async (e: React.FormEvent) => {
    e.preventDefault();
    const name = friendlyName.trim();
    if (!name) {
      setError('Give this authenticator a name.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const result = await enrollTotp(name);
      pendingId.current = result.factorId;
      setEnrollment(result);
      setStep('scan');
    } catch (err) {
      setError(describeMfaError(err, 'Could not start authenticator setup.'));
    } finally {
      setBusy(false);
    }
  };

  const verify = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!enrollment || !isValidOtp(code, 'totp')) return;
    setBusy(true);
    setError(null);
    try {
      await challengeAndVerifyTotp(enrollment.factorId, code);
      completed.current = true;
      await onEnrolled(friendlyName.trim());
    } catch (err) {
      setError(describeMfaError(err, 'Verification failed.'));
      setCode('');
    } finally {
      setBusy(false);
    }
  };

  const copySecret = async () => {
    if (!enrollment) return;
    try {
      await navigator.clipboard.writeText(enrollment.secret);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard can be blocked; the secret is still selectable on screen.
    }
  };

  return (
    <MfaModalShell
      title="Add authenticator app"
      subtitle="Google Authenticator, 1Password, Authy, Microsoft Authenticator or similar."
      icon={<Smartphone className="w-5 h-5" />}
      onClose={onClose}
      closeDisabled={busy}
    >
      {step === 'name' ? (
        <form onSubmit={start} className="space-y-4">
          <div>
            <label htmlFor="totp-name" className="block text-sm font-medium text-hud-cream-soft mb-2">
              Name
            </label>
            <input
              id="totp-name"
              type="text"
              value={friendlyName}
              maxLength={60}
              autoFocus
              onChange={(e) => setFriendlyName(e.target.value)}
              className="w-full px-4 py-2 rounded-lg bg-hud-bg-card border border-hud-bg-elev text-white placeholder-hud-cream-mute focus:outline-none focus:ring-2 focus:ring-hud-gold focus:border-transparent"
              placeholder="e.g. iPhone authenticator"
            />
            <p className="text-xs text-hud-cream-mute mt-1">Helps you tell your methods apart.</p>
          </div>
          {error && <MfaErrorBox message={error} />}
          <div className="flex justify-end gap-3">
            <button type="button" onClick={onClose} className="px-4 py-2 rounded-lg bg-hud-bg-card text-white hover:bg-hud-bg-elev">
              Cancel
            </button>
            <button
              type="submit"
              disabled={busy}
              className="px-4 py-2 rounded-lg bg-hud-gold-deep text-white hover:bg-hud-gold disabled:opacity-50 inline-flex items-center gap-2"
            >
              {busy && <Loader2 className="w-4 h-4 animate-spin" />}
              Continue
            </button>
          </div>
        </form>
      ) : (
        enrollment && (
          <form onSubmit={verify} className="space-y-5">
            <ol className="space-y-1 text-sm text-hud-cream-soft list-decimal list-inside">
              <li>Scan this QR code with your authenticator app.</li>
              <li>Enter the 6-digit code it shows.</li>
            </ol>
            <div className="flex justify-center">
              {/* eslint-disable-next-line no-restricted-syntax -- a QR code needs a light quiet zone to scan */}
              <div className="p-3 rounded-lg bg-white">
                <img src={enrollment.qrCode} alt="QR code for your authenticator app" className="w-44 h-44" />
              </div>
            </div>
            <div>
              <p className="text-xs text-hud-cream-dim mb-1.5">Can't scan? Enter this key manually (time-based):</p>
              <div className="flex items-center gap-2">
                <code className="flex-1 px-3 py-2 rounded-lg bg-hud-bg-card border border-hud-bg-elev text-hud-cream text-xs font-mono break-all select-all">
                  {enrollment.secret}
                </code>
                <button
                  type="button"
                  onClick={copySecret}
                  aria-label="Copy setup key"
                  className="p-2 rounded-lg bg-hud-bg-card border border-hud-bg-elev text-hud-cream-dim hover:text-white"
                >
                  {copied ? <Check className="w-4 h-4 text-hud-emerald" /> : <Copy className="w-4 h-4" />}
                </button>
              </div>
            </div>
            <OtpCodeInput id="totp-enroll-code" value={code} onChange={(v) => { setCode(v); setError(null); }} autoFocus disabled={busy} />
            {error && <MfaErrorBox message={error} />}
            <div className="flex justify-end gap-3">
              <button type="button" onClick={onClose} disabled={busy} className="px-4 py-2 rounded-lg bg-hud-bg-card text-white hover:bg-hud-bg-elev disabled:opacity-50">
                Cancel
              </button>
              <button
                type="submit"
                disabled={busy || !isValidOtp(code, 'totp')}
                className="px-4 py-2 rounded-lg bg-hud-gold-deep text-white hover:bg-hud-gold disabled:opacity-50 inline-flex items-center gap-2"
              >
                {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <ShieldCheck className="w-4 h-4" />}
                Verify and enable
              </button>
            </div>
          </form>
        )
      )}
    </MfaModalShell>
  );
}
