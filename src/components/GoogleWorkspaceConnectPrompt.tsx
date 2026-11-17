import { useEffect, useState } from 'react';
import { Loader2, X } from 'lucide-react';
import { useWorkspaceProvider } from '../hooks/useWorkspaceProvider';
import {
  initiateUnifiedGoogleOAuth,
  openUnifiedGoogleOAuthPopup,
} from '../services/googleOAuthUnified';
import { GOOGLE_CONNECT_PENDING_KEY } from '../services/auth';

/**
 * After "Sign in with Google", offer to connect Google Workspace (Gmail, Calendar, Drive). Signing in
 * with Google only proves who you are; mail, calendar and files need Google's own consent screen, so we
 * ask once and the user starts it with a click (no consent is ever granted on their behalf). Microsoft
 * sign-in does this in one step; this is its Google counterpart. Users who sign in another way, already
 * have Google connected, or choose "Not now" never see it again.
 */
export function GoogleWorkspaceConnectPrompt() {
  const { connected, loading, refresh } = useWorkspaceProvider();
  const [pending, setPending] = useState(() => readPending());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const hasGoogle = connected.includes('google');

  useEffect(() => {
    // Connected already (this or another way): nothing to offer, drop the marker.
    if (pending && !loading && hasGoogle) clearPending(setPending);
  }, [pending, loading, hasGoogle]);

  if (!pending || loading || hasGoogle) return null;

  const connect = async () => {
    setBusy(true);
    setError(null);
    try {
      const authUrl = await initiateUnifiedGoogleOAuth();
      const result = await openUnifiedGoogleOAuthPopup(authUrl);
      if (result.success) {
        refresh();
        clearPending(setPending);
      } else if (result.error && result.error !== 'Popup closed') {
        setError(result.error);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not start Google connection');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div role="status" className="mb-4 flex flex-wrap items-center gap-3 rounded-xl border border-hud-gold/30 bg-hud-bg-card px-4 py-3">
      <div className="min-w-0 flex-1 text-sm text-white">
        <span className="font-medium">Connect Google Workspace?</span>{' '}
        <span className="text-hud-cream-dim">
          You signed in with Google. Connect it to bring in Gmail, Calendar and Drive. Google will ask you to approve access.
        </span>
        {error && <span className="ml-2 text-rose-400">{error}</span>}
      </div>
      <button
        type="button"
        onClick={() => void connect()}
        disabled={busy}
        className="inline-flex items-center gap-2 rounded-lg bg-hud-gold px-3 py-1.5 text-sm font-medium text-black disabled:opacity-50"
      >
        {busy && <Loader2 className="h-4 w-4 animate-spin" />}
        Connect
      </button>
      <button
        type="button"
        aria-label="Not now"
        title="Not now"
        onClick={() => clearPending(setPending)}
        className="rounded-lg p-1.5 text-hud-cream-dim hover:bg-hud-bg-elev hover:text-white"
      >
        <X className="h-4 w-4" />
      </button>
    </div>
  );
}

function readPending(): boolean {
  try { return localStorage.getItem(GOOGLE_CONNECT_PENDING_KEY) === '1'; } catch { return false; }
}

function clearPending(set: (v: boolean) => void): void {
  try { localStorage.removeItem(GOOGLE_CONNECT_PENDING_KEY); } catch { /* storage unavailable */ }
  set(false);
}
