import { useEffect, useRef, useState } from 'react';
import { Loader2, MessageSquare, ShieldCheck } from 'lucide-react';
import {
  describeMfaError,
  isPhoneMfaDisabledError,
  isValidOtp,
  maskPhone,
  normalizePhoneE164,
  secondsUntilResend,
} from '../../../../lib/mfa';
import {
  discardPendingFactor,
  enrollPhone,
  startChallenge,
  verifyChallenge,
} from '../../../../services/mfa';
import { OtpCodeInput } from '../../../mfa/OtpCodeInput';
import { MfaErrorBox, MfaModalShell } from './MfaModalShell';

interface SmsEnrollModalProps {
  defaultPhone?: string | null;
  onClose: () => void;
  onEnrolled: (friendlyName: string) => void | Promise<void>;
  /** Called when Supabase reports Phone MFA is switched off, so the section can show a notice. */
  onPhoneMfaUnavailable?: () => void;
}

type Step = 'phone' | 'code';

/** Enroll phone factor -> challenge (sends SMS) -> verify the code (marks the factor verified). */
export function SmsEnrollModal({ defaultPhone, onClose, onEnrolled, onPhoneMfaUnavailable }: SmsEnrollModalProps) {
  const [step, setStep] = useState<Step>('phone');
  const [phoneInput, setPhoneInput] = useState(defaultPhone ?? '');
  const [friendlyName, setFriendlyName] = useState('Mobile phone');
  const [phone, setPhone] = useState<string | null>(null);
  const [factorId, setFactorId] = useState<string | null>(null);
  const [challengeId, setChallengeId] = useState<string | null>(null);
  const [lastSentAt, setLastSentAt] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState<'send' | 'verify' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const completed = useRef(false);
  const pendingId = useRef<string | null>(null);

  const cooldown = secondsUntilResend(lastSentAt, now);

  useEffect(() => {
    return () => {
      if (!completed.current && pendingId.current) void discardPendingFactor(pendingId.current);
    };
  }, []);

  useEffect(() => {
    if (lastSentAt === null) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [lastSentAt]);

  const sendTo = async (id: string) => {
    const cid = await startChallenge(id, 'phone');
    setChallengeId(cid);
    setLastSentAt(Date.now());
    setNow(Date.now());
  };

  const start = async (e: React.FormEvent) => {
    e.preventDefault();
    const normalized = normalizePhoneE164(phoneInput);
    if (!normalized) {
      setError('Enter a valid mobile number, for example +15551234567.');
      return;
    }
    const name = friendlyName.trim() || 'Mobile phone';
    setBusy('send');
    setError(null);
    try {
      const { factorId: id } = await enrollPhone(normalized, name);
      pendingId.current = id;
      setFactorId(id);
      setPhone(normalized);
      await sendTo(id);
      setStep('code');
    } catch (err) {
      if (isPhoneMfaDisabledError(err)) onPhoneMfaUnavailable?.();
      setError(describeMfaError(err, 'Could not send the verification text.'));
    } finally {
      setBusy(null);
    }
  };

  const resend = async () => {
    if (!factorId || cooldown > 0 || busy) return;
    setBusy('send');
    setError(null);
    try {
      await sendTo(factorId);
      setCode('');
    } catch (err) {
      setError(describeMfaError(err, 'Could not resend the code.'));
    } finally {
      setBusy(null);
    }
  };

  const verify = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!factorId || !challengeId || !isValidOtp(code, 'phone')) return;
    setBusy('verify');
    setError(null);
    try {
      await verifyChallenge(factorId, challengeId, code);
      completed.current = true;
      await onEnrolled(friendlyName.trim() || 'Mobile phone');
    } catch (err) {
      if ((err as { code?: string })?.code === 'mfa_challenge_expired') setChallengeId(null);
      setError(describeMfaError(err, 'Verification failed.'));
      setCode('');
    } finally {
      setBusy(null);
    }
  };

  const inputClass =
    'w-full px-4 py-2 rounded-lg bg-hud-bg-card border border-hud-bg-elev text-white placeholder-hud-cream-mute focus:outline-none focus:ring-2 focus:ring-hud-gold focus:border-transparent';

  return (
    <MfaModalShell
      title="Add SMS verification"
      subtitle="We'll text a one-time code to this number when you sign in."
      icon={<MessageSquare className="w-5 h-5" />}
      onClose={onClose}
      closeDisabled={busy !== null}
    >
      {step === 'phone' ? (
        <form onSubmit={start} className="space-y-4">
          <div>
            <label htmlFor="sms-phone" className="block text-sm font-medium text-hud-cream-soft mb-2">
              Mobile number
            </label>
            <input
              id="sms-phone"
              type="tel"
              autoComplete="tel"
              autoFocus
              value={phoneInput}
              onChange={(e) => { setPhoneInput(e.target.value); setError(null); }}
              className={inputClass}
              placeholder="+1 555 123 4567"
            />
            <p className="text-xs text-hud-cream-mute mt-1">Include the country code. US/Canada numbers can omit +1.</p>
          </div>
          <div>
            <label htmlFor="sms-name" className="block text-sm font-medium text-hud-cream-soft mb-2">
              Name
            </label>
            <input
              id="sms-name"
              type="text"
              maxLength={60}
              value={friendlyName}
              onChange={(e) => setFriendlyName(e.target.value)}
              className={inputClass}
            />
          </div>
          {error && <MfaErrorBox message={error} />}
          <div className="flex justify-end gap-3">
            <button type="button" onClick={onClose} disabled={busy !== null} className="px-4 py-2 rounded-lg bg-hud-bg-card text-white hover:bg-hud-bg-elev disabled:opacity-50">
              Cancel
            </button>
            <button
              type="submit"
              disabled={busy !== null || !phoneInput.trim()}
              className="px-4 py-2 rounded-lg bg-hud-gold-deep text-white hover:bg-hud-gold disabled:opacity-50 inline-flex items-center gap-2"
            >
              {busy === 'send' && <Loader2 className="w-4 h-4 animate-spin" />}
              Send code
            </button>
          </div>
        </form>
      ) : (
        <form onSubmit={verify} className="space-y-4">
          <p className="text-sm text-hud-cream-soft">
            Enter the code we texted to <span className="text-white font-medium">{maskPhone(phone)}</span>.
          </p>
          <OtpCodeInput
            id="sms-enroll-code"
            value={code}
            onChange={(v) => { setCode(v); setError(null); }}
            maxLength={10}
            autoFocus
            disabled={busy === 'verify'}
          />
          <div className="flex items-center justify-between text-xs">
            <button
              type="button"
              onClick={() => { setStep('phone'); setError(null); setCode(''); }}
              disabled={busy !== null}
              className="text-hud-cream-dim hover:text-white disabled:opacity-50"
            >
              Change number
            </button>
            <button
              type="button"
              onClick={resend}
              disabled={cooldown > 0 || busy !== null}
              className="text-hud-gold-soft hover:underline disabled:text-hud-cream-mute disabled:no-underline disabled:cursor-not-allowed"
            >
              {cooldown > 0 ? `Resend in ${cooldown}s` : 'Resend code'}
            </button>
          </div>
          {error && <MfaErrorBox message={error} />}
          <div className="flex justify-end gap-3">
            <button type="button" onClick={onClose} disabled={busy !== null} className="px-4 py-2 rounded-lg bg-hud-bg-card text-white hover:bg-hud-bg-elev disabled:opacity-50">
              Cancel
            </button>
            <button
              type="submit"
              disabled={busy !== null || !challengeId || !isValidOtp(code, 'phone')}
              className="px-4 py-2 rounded-lg bg-hud-gold-deep text-white hover:bg-hud-gold disabled:opacity-50 inline-flex items-center gap-2"
            >
              {busy === 'verify' ? <Loader2 className="w-4 h-4 animate-spin" /> : <ShieldCheck className="w-4 h-4" />}
              Verify and enable
            </button>
          </div>
        </form>
      )}
    </MfaModalShell>
  );
}
