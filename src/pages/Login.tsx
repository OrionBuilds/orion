import { useState, useEffect } from 'react';
import { useNavigate, useLocation, Link } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import { requestStartPage } from '../lib/startPage';
import { Loader2, AlertCircle, Eye, EyeOff } from 'lucide-react';
import { MfaChallenge } from '../components/mfa/MfaChallenge';

function getErrorMessage(error: unknown): string {
  if (!(error instanceof Error)) {
    return 'Invalid email or password';
  }

  const message = error.message.toLowerCase();

  if (message.includes('invalid login credentials') || message.includes('invalid credentials')) {
    return 'Invalid email or password';
  }
  if (message.includes('email not confirmed')) {
    return 'Please verify your email address';
  }
  if (message.includes('user not found')) {
    return 'Invalid email or password';
  }
  if (message.includes('disabled') || message.includes('banned')) {
    return 'Account disabled. Contact your administrator.';
  }
  if (message.includes('rate') || message.includes('too many')) {
    return 'Too many attempts. Please try again later.';
  }
  if (message.includes('network') || message.includes('fetch')) {
    return 'Unable to connect. Please check your connection.';
  }

  return 'Invalid email or password';
}

function isValidEmail(email: string): boolean {
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return emailRegex.test(email);
}

export function Login() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState('');
  const [emailError, setEmailError] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [isGoogleLoading, setIsGoogleLoading] = useState(false);
  const [isMicrosoftLoading, setIsMicrosoftLoading] = useState(false);

  const { signIn, signInWithGoogle, signInWithMicrosoft, user, session, mfaStatus, isLoading: authLoading } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();

  // Keep the query string and hash so a notification deep link (?taskId=, ?appointmentId=, ?tab=)
  // still lands on the record after sign-in.
  const fromLoc = (location.state as { from?: { pathname: string; search?: string; hash?: string } })?.from;
  const from = fromLoc?.pathname ? `${fromLoc.pathname}${fromLoc.search ?? ''}${fromLoc.hash ?? ''}` : '/';

  useEffect(() => {
    const hash = window.location.hash;
    if (hash) {
      const params = new URLSearchParams(hash.replace('#', ''));
      const errorDesc = params.get('error_description');
      const errorCode = params.get('error');
      if (errorDesc || errorCode) {
        const desc = errorDesc ?? '';
        if (desc.includes('AUTH_DOMAIN_NOT_AUTHORIZED')) {
          const domainMatch = desc.match(/"([^"]+)"/);
          navigate(
            `/auth/access-denied?reason=domain_not_authorized${domainMatch ? `&detail=${encodeURIComponent(domainMatch[1])}` : ''}`,
            { replace: true },
          );
          return;
        }
        if (desc.includes('AUTH_PROVIDER_NOT_ALLOWED')) {
          navigate('/auth/access-denied?reason=provider_not_allowed', { replace: true });
          return;
        }
        setError(`Sign-in failed: ${errorDesc || errorCode}`);
        window.location.hash = '';
      }
    }
  }, [navigate]);

  useEffect(() => {
    // Only leave the login page once any second factor is satisfied (see MfaChallenge below).
    if (!authLoading && user && mfaStatus === 'satisfied') {
      // No deep link to return to: "/" sends the user on to their chosen start page.
      if (from === '/') requestStartPage();
      navigate(from, { replace: true });
    }
  }, [user, authLoading, mfaStatus, navigate, from]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setEmailError('');

    if (!isValidEmail(email)) {
      setEmailError('Please enter a valid email address');
      return;
    }

    setIsLoading(true);

    try {
      await signIn(email, password);
    } catch (err) {
      setError(getErrorMessage(err));
      setPassword('');
    } finally {
      setIsLoading(false);
    }
  };

  const handleGoogleSignIn = async () => {
    setError('');
    setIsGoogleLoading(true);
    try {
      await signInWithGoogle();
    } catch (err) {
      setError(getErrorMessage(err));
      setIsGoogleLoading(false);
    }
  };

  const handleMicrosoftSignIn = async () => {
    setError('');
    setIsMicrosoftLoading(true);
    try {
      await signInWithMicrosoft();
    } catch (err) {
      setError(getErrorMessage(err));
      setIsMicrosoftLoading(false);
    }
  };

  if (authLoading) {
    return (
      <div className="min-h-dvh bg-hud-bg-mid flex items-center justify-center">
        <Loader2 className="w-8 h-8 text-hud-gold animate-spin" />
      </div>
    );
  }

  // Password / OAuth sign-in succeeded but the account has a verified MFA factor and this
  // session is still aal1 (or the level couldn't be read): finish with the second factor.
  // Survives reloads because the aal claim lives in the persisted session token.
  if (session && (mfaStatus === 'required' || mfaStatus === 'error')) {
    return <MfaChallenge />;
  }

  if (session && mfaStatus === 'unknown') {
    return (
      <div className="min-h-dvh bg-hud-bg-mid flex items-center justify-center">
        <Loader2 className="w-8 h-8 text-hud-gold animate-spin" />
      </div>
    );
  }

  if (user) {
    return null;
  }

  return (
    <div className="min-h-dvh bg-hud-bg-mid flex items-center justify-center px-4">
      <div className="w-full max-w-md">
        <div className="text-center mb-8">
          <img
            src="/assets/logo/logo.png"
            alt="Orion OS"
            className="h-16 mx-auto mb-4"
          />
          <h1 className="text-2xl font-bold text-white mb-1">Orion OS</h1>
          <p className="text-hud-cream-dim">Sign in to your workspace</p>
        </div>

        <div className="bg-hud-bg-card rounded-xl border border-hud-bg-elev p-8">
          <form onSubmit={handleSubmit} className="space-y-5">
            {error && (
              <div
                className="flex items-center gap-2 p-3 rounded-lg bg-hud-plum/10 border border-hud-plum/30 text-hud-plum text-sm"
                role="alert"
              >
                <AlertCircle className="w-4 h-4 flex-shrink-0" />
                <span>{error}</span>
              </div>
            )}

            <div>
              <label htmlFor="email" className="block text-sm font-medium text-hud-cream-soft mb-2">
                Email address
              </label>
              <input
                id="email"
                type="email"
                value={email}
                onChange={(e) => {
                  setEmail(e.target.value);
                  if (emailError) setEmailError('');
                }}
                required
                autoComplete="email"
                aria-describedby={emailError ? 'email-error' : undefined}
                aria-invalid={!!emailError}
                className={`w-full px-4 py-2.5 rounded-lg bg-hud-bg-mid border text-white placeholder-hud-cream-dim focus:outline-none focus:ring-2 focus:ring-hud-gold focus:border-transparent transition-colors ${
                  emailError ? 'border-hud-plum' : 'border-hud-cream-mute'
                }`}
                placeholder="you@example.com"
              />
              {emailError && (
                <p id="email-error" className="mt-1.5 text-sm text-hud-plum">
                  {emailError}
                </p>
              )}
            </div>

            <div>
              <label htmlFor="password" className="block text-sm font-medium text-hud-cream-soft mb-2">
                Password
              </label>
              <div className="relative">
                <input
                  id="password"
                  type={showPassword ? 'text' : 'password'}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                  autoComplete="current-password"
                  className="w-full px-4 py-2.5 pr-11 rounded-lg bg-hud-bg-mid border border-hud-cream-mute text-white placeholder-hud-cream-dim focus:outline-none focus:ring-2 focus:ring-hud-gold focus:border-transparent transition-colors"
                  placeholder="Enter your password"
                />
                <button
                  type="button"
                  onClick={() => setShowPassword(!showPassword)}
                  aria-label={showPassword ? 'Hide password' : 'Show password'}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-hud-cream-dim hover:text-hud-gold-soft focus:outline-none focus:text-hud-gold-soft transition-colors"
                >
                  {showPassword ? (
                    <EyeOff className="w-5 h-5" />
                  ) : (
                    <Eye className="w-5 h-5" />
                  )}
                </button>
              </div>
            </div>

            <div className="flex justify-end">
              <Link
                to="/forgot-password"
                className="text-sm text-hud-gold-soft hover:text-hud-gold-soft focus:outline-none focus:underline transition-colors"
              >
                Forgot password?
              </Link>
            </div>

            <button
              type="submit"
              disabled={isLoading}
              className="w-full py-2.5 px-4 rounded-lg bg-gradient-to-r from-hud-gold to-hud-teal text-white font-medium hover:from-hud-gold-deep hover:to-hud-teal focus:outline-none focus:ring-2 focus:ring-hud-gold focus:ring-offset-2 focus:ring-offset-hud-bg-card disabled:opacity-50 disabled:cursor-not-allowed transition-all duration-200"
            >
              {isLoading ? (
                <span className="flex items-center justify-center gap-2">
                  <Loader2 className="w-4 h-4 animate-spin" />
                  Signing in...
                </span>
              ) : (
                'Sign in'
              )}
            </button>
          </form>

          <div className="relative my-6">
            <div className="absolute inset-0 flex items-center">
              <div className="w-full border-t border-hud-cream-mute" />
            </div>
            <div className="relative flex justify-center text-sm">
              <span className="bg-hud-bg-card px-3 text-hud-cream-dim">or</span>
            </div>
          </div>

          <button
            type="button"
            onClick={handleMicrosoftSignIn}
            disabled={isMicrosoftLoading || isGoogleLoading}
            className="w-full mb-3 flex items-center justify-center gap-3 py-2.5 px-4 rounded-lg bg-white text-hud-bg-elev font-medium hover:bg-hud-cream focus:outline-none focus:ring-2 focus:ring-hud-gold focus:ring-offset-2 focus:ring-offset-hud-bg-card disabled:opacity-50 disabled:cursor-not-allowed transition-all duration-200"
          >
            {isMicrosoftLoading ? (
              <Loader2 className="w-5 h-5 animate-spin text-hud-cream-mute" />
            ) : (
              <svg className="w-5 h-5" viewBox="0 0 23 23">
                <path fill="#F25022" d="M1 1h10v10H1z" />
                <path fill="#7FBA00" d="M12 1h10v10H12z" />
                <path fill="#00A4EF" d="M1 12h10v10H1z" />
                <path fill="#FFB900" d="M12 12h10v10H12z" />
              </svg>
            )}
            {isMicrosoftLoading ? 'Signing in...' : 'Sign in with Microsoft'}
          </button>

          <button
            type="button"
            onClick={handleGoogleSignIn}
            disabled={isGoogleLoading}
            className="w-full flex items-center justify-center gap-3 py-2.5 px-4 rounded-lg bg-white text-hud-bg-elev font-medium hover:bg-hud-cream focus:outline-none focus:ring-2 focus:ring-hud-gold focus:ring-offset-2 focus:ring-offset-hud-bg-card disabled:opacity-50 disabled:cursor-not-allowed transition-all duration-200"
          >
            {isGoogleLoading ? (
              <Loader2 className="w-5 h-5 animate-spin text-hud-cream-mute" />
            ) : (
              <svg className="w-5 h-5" viewBox="0 0 24 24">
                <path
                  d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z"
                  fill="#4285F4"
                />
                <path
                  d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
                  fill="#34A853"
                />
                <path
                  d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"
                  fill="#FBBC05"
                />
                <path
                  d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"
                  fill="#EA4335"
                />
              </svg>
            )}
            {isGoogleLoading ? 'Signing in...' : 'Sign in with Google'}
          </button>
        </div>

        <p className="mt-6 text-center text-sm text-hud-cream-mute">
          Contact your administrator if you need access
        </p>
      </div>
    </div>
  );
}
