import { Navigate, useLocation } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import type { PermissionKey } from '../types';
import { Loader2 } from 'lucide-react';
import { resolveRouteAccess } from '../lib/mfa';

interface ProtectedRouteProps {
  children: React.ReactNode;
  permission?: PermissionKey;
  featureFlag?: string;
}

export function ProtectedRoute({ children, permission, featureFlag }: ProtectedRouteProps) {
  const { user, session, isLoading, hasPermission, isFeatureEnabled, mfaStatus } = useAuth();
  const location = useLocation();

  const hashHasTokens = typeof window !== 'undefined' &&
    (window.location.hash.includes('access_token=') || window.location.hash.includes('refresh_token='));

  const access = resolveRouteAccess({
    isLoading,
    hasSession: !!session,
    hasUser: !!user,
    mfaStatus,
    oauthTokensInHash: hashHasTokens,
  });

  if (access === 'loading') {
    return (
      <div className="min-h-dvh flex items-center justify-center bg-hud-bg-mid">
        <Loader2 className="w-8 h-8 animate-spin text-hud-gold" />
      </div>
    );
  }

  // 'mfa' also lands on /login: the Login page renders the second-factor challenge while the
  // session is aal1 and the user has a verified factor, then returns to `from`.
  if (access === 'login' || access === 'mfa') {
    return <Navigate to="/login" state={{ from: location }} replace />;
  }

  if (permission && !hasPermission(permission)) {
    return <Navigate to="/unauthorized" replace />;
  }

  if (featureFlag && !isFeatureEnabled(featureFlag)) {
    return <Navigate to="/feature-disabled" replace />;
  }

  return <>{children}</>;
}
