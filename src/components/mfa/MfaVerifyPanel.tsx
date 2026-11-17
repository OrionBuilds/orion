import { useEffect, useState } from 'react';
import { AlertCircle, KeyRound, Loader2, MessageSquare, ShieldCheck, Smartphone } from 'lucide-react';
import {
  describeMfaError,
  isValidOtp,
  maskPhone,
  secondsUntilResend,
} from '../../lib/mfa';
import {
  challengeAndVerifyTotp,
  startChallenge,
  verifyChallenge,
  type MfaFactor,
} from '../../services/mfa';
import { OtpCodeInput } from './OtpCodeInput';
import { factorLabel } from './factorLabel';

interface MfaVerifyPanelProps {
  /** Verified factors the user may answer with. */
  factors: MfaFactor[];
  onVerified: () => void | Promise<void>;
  initialFactorId?: string;
  submitLabel?: string;
  autoFocus?: boolean;
}

/**
 * Answers an MFA challenge with one of the user's verified factors: pick the factor, then either
 * type the authenticator code (TOTP) or have a code texted and type it (SMS, with resend
 * cooldown). Used by the login challenge and by "remove factor" re-verification.
 */
export function MfaVerifyPanel({
  factors,
  onVerified,
  initialFactorId,
  submitLabel = 'Verify',
  autoFocus = true,
}: MfaVerifyPanelProps) {
  const preferred =
    factors.find((f) => f.id === initialFactorId) ??
    factors.find((f) => f.factorType === 'totp') ??
    factors[0];
  const [factorId, setFactorId] = useState<string | undefined>(preferred?.id);
  const [challengeId, setChallengeId] = useState<string | null>(null);
  const [lastSentAt, setLastSentAt] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState<'send' | 'verify' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);

  const factor = factors.find((f) => f.id === factorId) ?? preferred;
  const isPhone = factor?.factorType === 'phone';
  const cooldown = secondsUntilResend(lastSentAt, now);

  useEffect(() => {
    if (lastSentAt === null) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [lastSentAt]);

  const selectFactor = (id: string) => {
    if (id === factorId) return;
    setFactorId(id);
    setChallengeId(null);
    setLastSentAt(null);
    setCode('');
    setError(null);
    setInfo(null);
  };

  const sendCode = async () => {
    if (!factor || busy) return;
    setBusy('send');
    setError(null);
    setInfo(null);
    try {
      const id = await startChallenge(factor.id, 'phone');
      setChallengeId(id);
      setLastSentAt(Date.now());
      setNow(Date.now());
      setCode('');
      setInfo(`Code sent to ${maskPhone(factor.phone) || 'your phone'}.`);
    } catch (err) {
      setError(describeMfaError(err, 'Could not send the code.'));
    } finally {
      setBusy(null);
    }
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!factor || busy) return;
    if (!isValidOtp(code, factor.factorType)) {
      setError(factor.factorType === 'totp' ? 'Enter the 6-digit code from your authenticator app.' : 'Enter the code from the text message.');
      return;
    }
    setBusy('verify');
    setError(null);
    try {
      if (factor.factorType === 'totp') {
        await challengeAndVerifyTotp(factor.id, code);
      } else {
        if (!challengeId) {
          setError('Send a code first.');
          return;
        }
        await verifyChallenge(factor.id, challengeId, code);
      }
      await onVerified();
    } catch (err) {
      const code_ = (err as { code?: string })?.code;
      if (code_ === 'mfa_challenge_expired') setChallengeId(null);
      setError(describeMfaError(err, 'Verification failed.'));
      setCode('');
    } finally {
      setBusy(null);
    }
  };

  if (!factor) {
    return (
      <p className="text-sm text-hud-cream-dim">No verification methods are available.</p>
    );
  }

  return (
    <form onSubmit={submit} className="space-y-4">
      {factors.length > 1 && (
        <fieldset className="space-y-2">
          <legend className="text-sm font-medium text-hud-cream-soft mb-2">Verify with</legend>
          {factors.map((f) => {
            const Icon = f.factorType === 'totp' ? Smartphone : MessageSquare;
            const selected = f.id === factor.id;
            return (
              <label
                key={f.id}
                className={`flex items-center gap-3 p-3 rounded-lg border cursor-pointer transition-colors ${
                  selected
                    ? 'border-hud-gold bg-hud-gold/10'
                    : 'border-hud-bg-elev bg-hud-bg-mid hover:border-hud-cream-mute'
                }`}
              >
                <input
                  type="radio"
                  name="mfa-factor"
                  value={f.id}
                  checked={selected}
                  onChange={() => selectFactor(f.id)}
                  className="sr-only"
                />
                <Icon className={`w-4 h-4 ${selected ? 'text-hud-gold-soft' : 'text-hud-cream-dim'}`} />
                <span className="text-sm text-white">{factorLabel(f)}</span>
              </label>
            );
          })}
        </fieldset>
      )}

      {factors.length === 1 && (
        <div className="flex items-center gap-2 text-sm text-hud-cream-dim">
          {isPhone ? <MessageSquare className="w-4 h-4" /> : <Smartphone className="w-4 h-4" />}
          <span>{factorLabel(factor)}</span>
        </div>
      )}

      {isPhone && !challengeId ? (
        <button
          type="button"
          onClick={sendCode}
          disabled={busy !== null}
          className="w-full py-2.5 px-4 rounded-lg bg-hud-bg-elev border border-hud-cream-mute text-white font-medium hover:border-hud-gold disabled:opacity-50 disabled:cursor-not-allowed transition-colors inline-flex items-center justify-center gap-2"
        >
          {busy === 'send' ? <Loader2 className="w-4 h-4 animate-spin" /> : <MessageSquare className="w-4 h-4" />}
          Text me a code
        </button>
      ) : (
        <>
          <OtpCodeInput
            id="mfa-code"
            value={code}
            onChange={(v) => {
              setCode(v);
              if (error) setError(null);
            }}
            maxLength={isPhone ? 10 : 6}
            autoFocus={autoFocus}
            disabled={busy === 'verify'}
            label={isPhone ? 'Code from the text message' : 'Code from your authenticator app'}
          />
          {isPhone && (
            <div className="flex items-center justify-between text-xs">
              <span className="text-hud-cream-dim">{info}</span>
              <button
                type="button"
                onClick={sendCode}
                disabled={cooldown > 0 || busy !== null}
                className="text-hud-gold-soft hover:underline disabled:text-hud-cream-mute disabled:no-underline disabled:cursor-not-allowed"
              >
                {cooldown > 0 ? `Resend in ${cooldown}s` : 'Resend code'}
              </button>
            </div>
          )}
        </>
      )}

      {error && (
        <div
          role="alert"
          className="flex items-start gap-2 p-3 rounded-lg bg-hud-plum/10 border border-hud-plum/30 text-hud-plum text-sm"
        >
          <AlertCircle className="w-4 h-4 flex-shrink-0 mt-0.5" />
          <span>{error}</span>
        </div>
      )}

      {(!isPhone || challengeId) && (
        <button
          type="submit"
          disabled={busy !== null || !isValidOtp(code, factor.factorType)}
          className="w-full py-2.5 px-4 rounded-lg bg-gradient-to-r from-hud-gold to-hud-teal text-white font-medium hover:from-hud-gold-deep hover:to-hud-teal disabled:opacity-50 disabled:cursor-not-allowed transition-all inline-flex items-center justify-center gap-2"
        >
          {busy === 'verify' ? <Loader2 className="w-4 h-4 animate-spin" /> : <ShieldCheck className="w-4 h-4" />}
          {submitLabel}
        </button>
      )}

      {!isPhone && (
        <p className="flex items-center gap-1.5 text-xs text-hud-cream-mute">
          <KeyRound className="w-3.5 h-3.5" />
          Open your authenticator app and enter the current 6-digit code.
        </p>
      )}
    </form>
  );
}
