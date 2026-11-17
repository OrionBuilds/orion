import { Component, type ReactNode } from 'react';
import { AlertTriangle, RefreshCw, Home } from 'lucide-react';

interface ErrorBoundaryProps {
  children: ReactNode;
  fallback?: ReactNode;
}

interface ErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
}

// Every route is React.lazy()-loaded (App.tsx), so a page's JS is fetched by its content-hashed
// filename only the first time that route is visited in this tab. If a Netlify deploy has landed
// since the tab was opened, that filename no longer exists — the fetch 404s and lands here as
// "Failed to fetch dynamically imported module" (Vite/Rollup's wording; other browsers/bundlers
// phrase it slightly differently, matched below too). This is not a real app error, it's a stale
// tab, and the fix is the same every time: reload once to pick up the current build. A plain
// "Try Again" click doesn't help here — it re-renders with the same already-broken lazy import.
const CHUNK_LOAD_ERROR_RX =
  /failed to fetch dynamically imported module|error loading dynamically imported module|importing a module script failed/i;

// Timestamp-, not session-, guarded: a tab can legitimately live across several real deploys in a
// day, and each of those deserves its own one-time auto-reload — a permanent "only ever once per
// tab" flag would silently stop self-healing after the first deploy and go back to dumping this
// error screen on the user. A short window is enough to prevent a genuine crash-loop (a reload
// that immediately re-throws the same error) from reloading forever.
const RELOAD_GUARD_KEY = 'orion:chunk-reload-at';
const RELOAD_GUARD_WINDOW_MS = 10_000;

function shouldAutoReload(error: Error): boolean {
  if (!CHUNK_LOAD_ERROR_RX.test(error.message)) return false;
  try {
    const last = Number(sessionStorage.getItem(RELOAD_GUARD_KEY) || '0');
    if (Date.now() - last < RELOAD_GUARD_WINDOW_MS) return false;
    sessionStorage.setItem(RELOAD_GUARD_KEY, String(Date.now()));
    return true;
  } catch {
    return true; // sessionStorage unavailable (private mode, etc.) — still worth one attempt
  }
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    console.error('ErrorBoundary caught:', error, errorInfo);
    if (shouldAutoReload(error)) {
      window.location.reload();
    }
  }

  handleReload = () => {
    window.location.reload();
  };

  handleGoHome = () => {
    window.location.href = '/';
  };

  handleRetry = () => {
    this.setState({ hasError: false, error: null });
  };

  render() {
    if (this.state.hasError) {
      if (this.props.fallback) {
        return this.props.fallback;
      }

      return (
        <div className="flex items-center justify-center min-h-[60dvh] p-8">
          <div className="max-w-md w-full text-center">
            <div className="w-14 h-14 rounded-full bg-hud-plum/10 flex items-center justify-center mx-auto mb-5">
              <AlertTriangle className="w-7 h-7 text-hud-plum" />
            </div>
            <h2 className="text-xl font-semibold text-white mb-2">
              Something went wrong
            </h2>
            <p className="text-sm text-hud-cream-dim mb-6">
              An unexpected error occurred while loading this page. You can try again or navigate elsewhere.
            </p>
            <div className="flex items-center justify-center gap-3">
              <button
                onClick={this.handleRetry}
                className="inline-flex items-center gap-2 px-4 py-2 bg-hud-gold-deep hover:bg-hud-gold-deep text-white text-sm font-medium rounded-lg transition-colors"
              >
                <RefreshCw className="w-4 h-4" />
                Try Again
              </button>
              <button
                onClick={this.handleGoHome}
                className="inline-flex items-center gap-2 px-4 py-2 bg-hud-bg-card hover:bg-hud-bg-elev text-hud-cream-soft text-sm font-medium rounded-lg border border-hud-bg-elev transition-colors"
              >
                <Home className="w-4 h-4" />
                Dashboard
              </button>
            </div>
            {this.state.error && (
              <p className="mt-6 text-xs text-hud-cream-mute font-mono break-all">
                {this.state.error.message}
              </p>
            )}
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}
