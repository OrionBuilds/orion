import { useEffect, useState } from 'react';
import { AlertTriangle, ExternalLink } from 'lucide-react';
import { useAuth } from '../../contexts/AuthContext';
import { getMeetAccessStatus, type MeetAccessStatus } from '../../services/googleMeet';
import { useWorkspaceProvider } from '../../hooks/useWorkspaceProvider';

interface MeetAccessBannerProps {
  /** Shown above meeting pickers; hidden entirely when access is healthy. */
  className?: string;
}

/**
 * Warns when the signed-in user's Google grant can't produce Meet transcripts —
 * either the Meet scope was never granted (their consent predates it) or the
 * refresh token has been revoked. Without this the meeting picker just looks
 * empty and there's no way to tell why.
 *
 * Dual-provider: only shown to users with Google Workspace connected. Microsoft-only users get
 * Teams transcripts via teams-meeting-processor / Import transcript and never see this banner.
 */
export function MeetAccessBanner({ className = '' }: MeetAccessBannerProps) {
  const { user } = useAuth();
  const { connected, loading } = useWorkspaceProvider();
  const usesGoogle = connected.includes('google');
  const [status, setStatus] = useState<MeetAccessStatus | null>(null);

  useEffect(() => {
    if (!user?.id || !usesGoogle) return;
    let active = true;
    getMeetAccessStatus(user.id)
      .then((s) => { if (active) setStatus(s); })
      .catch(() => { /* non-blocking */ });
    return () => { active = false; };
  }, [user?.id, usesGoogle]);

  if (loading || !usesGoogle || !status || !status.needsReconnect) return null;

  const reason = !status.connected
    ? 'Google Meet access is not set up.'
    : status.tokenBroken
      ? 'Google has revoked this connection.'
      : 'This connection was authorized before meeting access was added.';

  return (
    <div
      className={`rounded-lg border border-hud-rust/30 bg-hud-rust/10 p-3 flex items-start gap-3 ${className}`}
    >
      <AlertTriangle className="w-4 h-4 text-hud-rust flex-shrink-0 mt-0.5" />
      <div className="text-sm">
        <p className="font-medium text-hud-rust/40">Meeting transcripts unavailable</p>
        <p className="text-hud-rust/80 mt-0.5">
          {reason} Reconnect Google to pull in Meet transcripts, recordings and notes
          {status.email ? ` for ${status.email}` : ''}.
        </p>
        <a
          href="/settings/profile?tab=connected-accounts"
          className="inline-flex items-center gap-1 mt-2 text-hud-rust/40 hover:text-hud-rust/25 font-medium"
        >
          Reconnect Google
          <ExternalLink className="w-3 h-3" />
        </a>
      </div>
    </div>
  );
}
