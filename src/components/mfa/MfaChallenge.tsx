import { useCallback, useEffect, useState } from 'react';
import { AlertCircle, Loader2, LogOut, RotateCcw, ShieldCheck } from 'lucide-react';
import { useAuth } from '../../contexts/AuthContext';
import { describeMfaError } from '../../lib/mfa';
import { listVerifiedMfaFactors, type MfaFactor } from '../../services/mfa';
import { MfaVerifyPanel } from './MfaVerifyPanel';

/**
 * Second sign-in step, shown by the Login page while the session is aal1 and the user has a
 * verified factor (or the level could not be read). On success Supabase upgrades the session to
 * aal2, AuthContext flips mfaStatus to 'satisfied' and Login navigates on.
 */
export function MfaChallenge() {
  const { user, session, mfaStatus, refreshMfaStatus, signOut } = useAuth();
  const [factors, setFactors] = useState<MfaFactor[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [retrying, setRetrying] = useState(false);

  const load = useCallback(async () => {
    setLoadError(null);
    try {
      setFactors(await listVerifiedMfaFactors());
    } catch (err) {
      setFactors([]);
      setLoadError(describeMfaError(err, 'Could not load your verification methods.'));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const retry = async () => {
    setRetrying(true);
    try {
      await refreshMfaStatus();
      await load();
    } finally {
      setRetrying(false);
    }
  };

  const email = user?.email ?? session?.user?.email ?? '';

  return (
    <div className="min-h-dvh bg-hud-bg-mid flex items-center justify-center px-4">
      <div className="w-full max-w-md">
        <div className="text-center mb-8">
          <img src="/assets/logo/logo.png" alt="Orion OS" className="h-16 mx-auto mb-4" />
          <h1 className="text-2xl font-bold text-white mb-1">Two-factor verification</h1>
          <p className="text-hud-cream-dim">
            {email ? <>Confirm it's you to finish signing in as <span className="text-hud-cream-soft">{email}</span>.</> : "Confirm it's you to finish signing in."}
          </p>
        </div>

        <div className="bg-hud-bg-card rounded-xl border border-hud-bg-elev p-8 space-y-5">
          {factors === null ? (
            <div className="flex justify-center py-6">
              <Loader2 className="w-6 h-6 text-hud-gold animate-spin" />
            </div>
          ) : loadError || factors.length === 0 ? (
            <div className="space-y-4">
              <div
                role="alert"
                className="flex items-start gap-2 p-3 rounded-lg bg-hud-plum/10 border border-hud-plum/30 text-hud-plum text-sm"
              >
                <AlertCircle className="w-4 h-4 flex-shrink-0 mt-0.5" />
                <span>
                  {loadError ??
                    (mfaStatus === 'error'
                      ? "We couldn't confirm your sign-in security status. Check your connection and try again."
                      : 'No verification methods could be found for this account.')}
                </span>
              </div>
              <button
                type="button"
                onClick={retry}
                disabled={retrying}
                className="w-full py-2.5 px-4 rounded-lg bg-hud-bg-elev border border-hud-cream-mute text-white font-medium hover:border-hud-gold disabled:opacity-50 inline-flex items-center justify-center gap-2"
              >
                {retrying ? <Loader2 className="w-4 h-4 animate-spin" /> : <RotateCcw className="w-4 h-4" />}
                Try again
              </button>
            </div>
          ) : (
            <MfaVerifyPanel
              factors={factors}
              submitLabel="Verify and continue"
              onVerified={async () => {
                await refreshMfaStatus();
              }}
            />
          )}

          <div className="pt-4 border-t border-hud-bg-elev flex items-center justify-between gap-3">
            <p className="text-xs text-hud-cream-mute">
              Lost your device? Ask an administrator to reset your two-factor authentication.
            </p>
            <button
              type="button"
              onClick={() => void signOut()}
              className="flex-shrink-0 inline-flex items-center gap-1.5 text-sm text-hud-cream-dim hover:text-white"
            >
              <LogOut className="w-4 h-4" />
              Sign out
            </button>
          </div>
        </div>

        <p className="mt-6 flex items-center justify-center gap-1.5 text-xs text-hud-cream-mute">
          <ShieldCheck className="w-3.5 h-3.5" />
          Two-factor authentication is enabled on this account.
        </p>
      </div>
    </div>
  );
}
