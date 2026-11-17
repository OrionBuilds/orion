import { useState, useEffect, useCallback } from 'react';
import { Lock, AlertTriangle, Eye, EyeOff } from 'lucide-react';
import { supabase } from '../lib/supabase';
import { onSessionEvent, markSessionRestored } from '../lib/edgeFunction';
import * as authService from '../services/auth';
import { Portal } from './shared/Portal';

export function ReAuthModal() {
  const [visible, setVisible] = useState(false);
  const [email, setEmail] = useState('');
  const [provider, setProvider] = useState<string>('email');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    const unsubscribe = onSessionEvent((event) => {
      if (event === 'expired') {
        (async () => {
          const { data: { session: refreshed }, error } = await supabase.auth.refreshSession();
          if (!error && refreshed) {
            markSessionRestored();
            return;
          }
          const { data: { session: current } } = await supabase.auth.getSession();
          setEmail(current?.user?.email || '');
          setProvider((current?.user?.app_metadata?.provider as string) || 'email');
          setVisible(true);
          setPassword('');
          setError('');
        })();
      } else if (event === 'restored') {
        setVisible(false);
      }
    });
    return unsubscribe;
  }, []);

  const handlePasswordSubmit = useCallback(async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email || !password) return;
    setLoading(true);
    setError('');
    try {
      const { error: signInError } = await supabase.auth.signInWithPassword({ email, password });
      if (signInError) {
        setError(signInError.message);
        return;
      }
      markSessionRestored();
      setVisible(false);
      setPassword('');
    } catch {
      setError('Authentication failed. Please try again.');
    } finally {
      setLoading(false);
    }
  }, [email, password]);

  useEffect(() => {
    const { data: { subscription } } = supabase.auth.onAuthStateChange((event, newSession) => {
      if ((event === 'SIGNED_IN' || event === 'TOKEN_REFRESHED') && newSession) {
        markSessionRestored();
        setVisible(false);
        setLoading(false);
      }
    });

    return () => subscription.unsubscribe();
  }, []);

  const handleMicrosoftSignIn = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      await authService.signInWithMicrosoft(window.location.origin + window.location.pathname);
    } catch {
      setError('Microsoft sign-in failed. Please try again.');
      setLoading(false);
    }
  }, []);

  const handleGoogleSignIn = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      await authService.signInWithGoogle(window.location.origin + window.location.pathname);
    } catch {
      setError('Google sign-in failed. Please try again.');
      setLoading(false);
    }
  }, []);

  if (!visible) return null;

  const isMicrosoftUser = provider === 'azure' || (() => { try { return localStorage.getItem('orion_login_provider') === 'microsoft'; } catch { return false; } })();
  const isGoogleUser = provider === 'google' || isMicrosoftUser;
  const providerName = isMicrosoftUser ? 'Microsoft' : 'Google';

  return (
    <Portal><div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className="w-full max-w-md rounded-xl bg-white shadow-2xl p-8">
        <div className="flex items-center gap-3 mb-6">
          <div className="flex items-center justify-center w-10 h-10 rounded-full bg-hud-rust/15">
            <AlertTriangle className="w-5 h-5 text-hud-rust" />
          </div>
          <div>
            <h2 className="text-lg font-semibold text-hud-bg-mid">Session Expired</h2>
            <p className="text-sm text-hud-cream-mute">
              {isGoogleUser
                ? `Your session has expired. Sign in with ${providerName} to continue.`
                : 'Please re-enter your password to continue.'}
            </p>
          </div>
        </div>

        {isGoogleUser ? (
          <div className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-hud-bg-elev mb-1">Email</label>
              <input
                type="email"
                value={email}
                disabled
                className="w-full px-3 py-2 border border-hud-cream-soft rounded-lg bg-hud-bg-elev text-hud-cream-mute text-sm"
              />
            </div>

            {error && (
              <p className="text-sm text-hud-plum bg-hud-plum/10 px-3 py-2 rounded-lg">{error}</p>
            )}

            <button
              type="button"
              onClick={isMicrosoftUser ? handleMicrosoftSignIn : handleGoogleSignIn}
              disabled={loading}
              className="w-full flex items-center justify-center gap-3 py-2.5 px-4 border border-hud-cream-soft rounded-lg bg-white hover:bg-hud-cream disabled:opacity-50 disabled:cursor-not-allowed transition-colors text-sm font-medium text-hud-bg-elev"
            >
              <svg className="w-4 h-4 flex-shrink-0" viewBox="0 0 24 24">
                <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" />
                <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" />
                <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" />
                <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" />
              </svg>
              {loading ? 'Redirecting...' : `Sign in with ${providerName}`}
            </button>
          </div>
        ) : (
          <form onSubmit={handlePasswordSubmit} className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-hud-bg-elev mb-1">Email</label>
              <input
                type="email"
                value={email}
                disabled
                className="w-full px-3 py-2 border border-hud-cream-soft rounded-lg bg-hud-bg-elev text-hud-cream-mute text-sm"
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-hud-bg-elev mb-1">Password</label>
              <div className="relative">
                <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
                  <Lock className="w-4 h-4 text-hud-cream-dim" />
                </div>
                <input
                  type={showPassword ? 'text' : 'password'}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  autoFocus
                  className="w-full pl-9 pr-10 py-2 border border-hud-cream-soft rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                  placeholder="Enter your password"
                />
                <button
                  type="button"
                  onClick={() => setShowPassword(!showPassword)}
                  className="absolute inset-y-0 right-0 pr-3 flex items-center"
                >
                  {showPassword ? (
                    <EyeOff className="w-4 h-4 text-hud-cream-dim" />
                  ) : (
                    <Eye className="w-4 h-4 text-hud-cream-dim" />
                  )}
                </button>
              </div>
            </div>

            {error && (
              <p className="text-sm text-hud-plum bg-hud-plum/10 px-3 py-2 rounded-lg">{error}</p>
            )}

            <button
              type="submit"
              disabled={loading || !password}
              className="w-full py-2.5 px-4 bg-blue-600 text-white text-sm font-medium rounded-lg hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              {loading ? 'Signing in...' : 'Continue Session'}
            </button>
          </form>
        )}
      </div>
    </div></Portal>
  );
}
