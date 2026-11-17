import { Video, ExternalLink, Play, Clock, HardDrive } from 'lucide-react';
import { formatRecordingSize, recordingSource, RECORDING_SOURCE_LABEL } from '../../services/googleMeet';

interface MeetingRecordingLinkProps {
  recordingUrl: string | null;
  recordingDuration?: string | null;
  recordingSizeBytes?: number | null;
  variant?: 'button' | 'badge' | 'inline' | 'card';
  showDuration?: boolean;
  showSize?: boolean;
}

export function MeetingRecordingLink({
  recordingUrl,
  recordingDuration,
  recordingSizeBytes,
  variant = 'badge',
  showDuration = false,
  showSize = false,
}: MeetingRecordingLinkProps) {
  if (!recordingUrl) {
    return null;
  }

  if (variant === 'button') {
    return (
      <a
        href={recordingUrl}
        target="_blank"
        rel="noopener noreferrer"
        className="inline-flex items-center gap-2 px-4 py-2 bg-hud-gold-deep hover:bg-hud-gold text-white hover:text-hud-bg-deep rounded-lg transition-colors"
      >
        <Play className="w-4 h-4" />
        View Recording
        <ExternalLink className="w-3 h-3" />
      </a>
    );
  }

  if (variant === 'badge') {
    return (
      <a
        href={recordingUrl}
        target="_blank"
        rel="noopener noreferrer"
        className="inline-flex items-center gap-1.5 px-2.5 py-1 bg-hud-gold/20 hover:bg-hud-gold/30 text-hud-gold-soft rounded-full text-xs font-medium transition-colors"
      >
        <Video className="w-3 h-3" />
        Recording
        <ExternalLink className="w-3 h-3" />
      </a>
    );
  }

  if (variant === 'inline') {
    return (
      <a
        href={recordingUrl}
        target="_blank"
        rel="noopener noreferrer"
        className="inline-flex items-center gap-1 text-hud-gold-soft hover:text-hud-gold-soft text-sm transition-colors"
      >
        <Video className="w-4 h-4" />
        <span>View Recording</span>
        <ExternalLink className="w-3 h-3" />
      </a>
    );
  }

  if (variant === 'card') {
    return (
      <a
        href={recordingUrl}
        target="_blank"
        rel="noopener noreferrer"
        className="block p-4 bg-hud-bg-card/50 hover:bg-hud-bg-card border border-hud-bg-elev rounded-lg transition-colors group"
      >
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-lg bg-hud-gold/20 flex items-center justify-center group-hover:bg-hud-gold/30 transition-colors">
            <Video className="w-5 h-5 text-hud-gold-soft" />
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-white font-medium flex items-center gap-2">
              Meeting Recording
              <ExternalLink className="w-4 h-4 text-hud-cream-dim group-hover:text-hud-gold-soft transition-colors" />
            </p>
            <div className="flex items-center gap-3 text-sm text-hud-cream-dim mt-0.5">
              {showDuration && recordingDuration && (
                <span className="flex items-center gap-1">
                  <Clock className="w-3 h-3" />
                  {recordingDuration}
                </span>
              )}
              {showSize && recordingSizeBytes && (
                <span className="flex items-center gap-1">
                  <HardDrive className="w-3 h-3" />
                  {formatRecordingSize(recordingSizeBytes)}
                </span>
              )}
              {!showDuration && !showSize && (
                <span>{RECORDING_SOURCE_LABEL[recordingSource(recordingUrl)]}</span>
              )}
            </div>
          </div>
        </div>
      </a>
    );
  }

  return null;
}
