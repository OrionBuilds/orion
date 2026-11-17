import { useEffect } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import { Shield, ArrowLeft, Loader2 } from 'lucide-react';
import { COMPANY } from '../components/public-document/documentTheme';

export function ForgotPassword() {
  const { session, isLoading } = useAuth();
  const navigate = useNavigate();

  useEffect(() => {
    if (!isLoading && session) {
      navigate('/', { replace: true });
    }
  }, [session, isLoading, navigate]);

  if (isLoading) {
    return (
      <div className="min-h-dvh bg-hud-bg-mid flex items-center justify-center">
        <Loader2 className="w-8 h-8 text-hud-gold animate-spin" />
      </div>
    );
  }

  if (session) {
    return null;
  }

  return (
    <div className="min-h-dvh bg-hud-bg-mid flex items-center justify-center px-4">
      <div className="w-full max-w-md">
        <div className="bg-hud-bg-card rounded-xl border border-hud-bg-elev p-8">
          <div className="flex flex-col items-center text-center">
            <div className="w-16 h-16 rounded-full bg-hud-gold/10 flex items-center justify-center mb-6">
              <Shield className="w-8 h-8 text-hud-gold-soft" />
            </div>

            <h1 className="text-xl font-semibold text-white mb-4">
              Password Reset Required
            </h1>

            <p className="text-hud-cream-dim leading-relaxed mb-4">
              For security reasons, password resets are handled manually.
              Please contact your system administrator to regain access to your account.
            </p>

            <p className="text-hud-cream-mute text-sm mb-8">
              If you are unsure who your administrator is, contact your organization's internal support team.
            </p>

            <div className="w-full space-y-3">
              <Link
                to="/login"
                className="w-full py-2.5 px-4 rounded-lg bg-gradient-to-r from-hud-gold to-hud-teal text-white font-medium hover:from-hud-gold-deep hover:to-hud-teal focus:outline-none focus:ring-2 focus:ring-hud-gold focus:ring-offset-2 focus:ring-offset-hud-bg-card transition-all duration-200 flex items-center justify-center gap-2"
              >
                <ArrowLeft className="w-4 h-4" />
                Back to Sign In
              </Link>

              <a
                href={`mailto:${COMPANY.email}?subject=Password%20Reset%20Request`}
                className="w-full py-2.5 px-4 rounded-lg bg-hud-bg-card border border-hud-bg-elev text-white font-medium hover:bg-hud-bg-elev focus:outline-none focus:ring-2 focus:ring-hud-gold focus:ring-offset-2 focus:ring-offset-hud-bg-card transition-all duration-200 flex items-center justify-center"
              >
                Contact Administrator
              </a>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
