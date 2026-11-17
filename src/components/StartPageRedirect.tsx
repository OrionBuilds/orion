import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Navigate } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import { getUserPreferences } from '../services/profile';
import { clearStartPagePending, isStartPagePending, resolveStartPage } from '../lib/startPage';
import { useCanOpenNavEntry } from '../hooks/useStartPageOptions';
import { PageLoader } from './shared/PageLoader';

/**
 * Route element for "/": on entry into the app (fresh load at "/" or sign-in) it sends the user to
 * their chosen start page; otherwise, and when none is set, it renders the dashboard.
 */
export function StartPageRedirect({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const userId = user?.id;
  // AuthContext's helpers change identity every render; read the latest through a ref.
  const canOpen = useCanOpenNavEntry();
  const canOpenRef = useRef(canOpen);
  canOpenRef.current = canOpen;
  const [pending] = useState(isStartPagePending);
  // undefined while the preference loads; null = stay on the dashboard.
  const [target, setTarget] = useState<string | null | undefined>(pending ? undefined : null);

  useEffect(() => {
    if (!pending || !userId) return;
    let cancelled = false;
    getUserPreferences(userId)
      .then((prefs) => resolveStartPage(prefs?.default_landing_page, canOpenRef.current))
      .catch((err) => {
        console.error('Failed to load start page preference:', err);
        return null;
      })
      .then((path) => {
        if (cancelled) return;
        clearStartPagePending();
        setTarget(path);
      });
    return () => {
      cancelled = true;
    };
  }, [pending, userId]);

  if (target === undefined) return <PageLoader />;
  if (target) return <Navigate to={target} replace />;
  return <>{children}</>;
}
