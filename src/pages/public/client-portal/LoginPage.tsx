import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { Mail, Loader2, ArrowRight, ShieldCheck } from 'lucide-react';
import { useClientPortalV2 } from '../../../contexts/ClientPortalContextV2';
import { sendLoginCode } from '../../../services/clientPortal';

export function ClientPortalLoginPage() {
  const { state, inviteToken, pendingEmail, setPendingEmail, setState } = useClientPortalV2();
  const navigate = useNavigate();

  const [email, setEmail] = useState(pendingEmail ?? '');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // If already authenticated, redirect to dashboard
  useEffect(() => {
    if (state === 'authenticated') {
      navigate('/client-portal/dashboard', { replace: true });
    }
  }, [state, navigate]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email.trim()) return;

    setLoading(true);
    setError(null);

    try {
      const result = await sendLoginCode(email.trim(), inviteToken ?? undefined);
      if (result.rateLimited) {
        setError('Please wait 60 seconds before requesting another code.');
      } else {
        setPendingEmail(email.trim());
        setState('needs_code');
        navigate('/client-portal/verify');
      }
    } catch (err) {
      setError('Something went wrong. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  const showNoInviteWarning = !inviteToken && state === 'unauthenticated';

  // Brief transitional state while the effect above redirects.
  if (state === 'authenticated') {
    return (
      <div className="min-h-dvh bg-hud-bg-deep flex items-center justify-center">
        <div className="animate-spin rounded-full h-8 w-8 border-t-2 border-b-2 border-hud-gold" />
      </div>
    );
  }

  return (
    <div className="min-h-dvh flex items-center justify-center p-4">
      <div className="w-full max-w-md">
        {/* Card */}
        <div className="bg-hud-bg-mid border border-hud-bg-card rounded-2xl p-8 sm:p-10 shadow-xl">
          <div className="flex items-center justify-center w-14 h-14 bg-hud-gold/10 rounded-xl mb-6 mx-auto">
            <ShieldCheck size={28} className="text-hud-gold-soft" />
          </div>

          <h1 className="text-2xl font-bold text-white text-center mb-2">
            Client Portal
          </h1>
          <p className="text-sm text-hud-cream-dim text-center mb-8">
            Enter your email to receive a verification code
          </p>

          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="relative">
              <Mail size={18} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-hud-cream-mute" />
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@company.com"
                autoFocus
                required
                className="w-full pl-11 pr-4 py-3 bg-hud-bg-card border border-hud-bg-elev rounded-xl text-white placeholder-hud-cream-mute focus:outline-none focus:ring-2 focus:ring-hud-gold focus:border-transparent transition-all text-sm"
              />
            </div>

            {error && (
              <p className="text-sm text-hud-plum text-center">{error}</p>
            )}

            <button
              type="submit"
              disabled={loading || !email.trim()}
              className="w-full flex items-center justify-center gap-2 py-3 bg-hud-gold hover:bg-hud-gold-deep disabled:opacity-50 disabled:cursor-not-allowed text-hud-bg-deep font-semibold rounded-xl transition-colors text-sm"
            >
              {loading ? (
                <Loader2 size={18} className="animate-spin" />
              ) : (
                <>
                  Send Verification Code
                  <ArrowRight size={16} />
                </>
              )}
            </button>
          </form>

          {showNoInviteWarning && (
            <p className="text-xs text-hud-cream-mute text-center mt-6 leading-relaxed">
              If you have not received an invite email, please contact your service provider for access.
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
