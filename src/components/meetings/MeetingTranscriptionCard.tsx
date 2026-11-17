import { useState } from 'react';
import type { MeetingTranscription } from '../../types';
import {
  Video,
  Calendar,
  Clock,
  Users,
  ChevronDown,
  ChevronUp,
  MessageSquare,
  ListChecks,
  FileText,
} from 'lucide-react';
import { MeetingRecordingLink } from './MeetingRecordingLink';
import { MeetingActionItemsPanel } from './MeetingActionItemsPanel';
import { MeetingFollowUpApprovalsLink } from './MeetingFollowUpApprovalsLink';
import { formatDateShort } from '../../utils/formatters';

interface MeetingTranscriptionCardProps {
  meeting: MeetingTranscription;
  onSelect?: () => void;
  isSelected?: boolean;
  showTranscript?: boolean;
  currentUserId?: string;
  orgId?: string;
  onTaskCreated?: () => void;
}

export function MeetingTranscriptionCard({
  meeting,
  onSelect,
  isSelected,
  showTranscript = false,
  currentUserId,
  orgId,
  onTaskCreated,
}: MeetingTranscriptionCardProps) {
  const [isExpanded, setIsExpanded] = useState(false);

  const formatDuration = (minutes: number | null) => {
    if (!minutes) return '-';
    const hrs = Math.floor(minutes / 60);
    const mins = minutes % 60;
    return hrs > 0 ? `${hrs}h ${mins}m` : `${mins}m`;
  };

  const CardWrapper = onSelect ? 'button' : 'div';

  return (
    <div
      className={`rounded-lg border transition-colors ${
        isSelected
          ? 'border-hud-gold bg-hud-gold/10'
          : 'border-hud-bg-elev bg-hud-bg-card/50 hover:border-hud-cream-mute'
      }`}
    >
      <CardWrapper
        onClick={onSelect}
        className={`w-full p-4 text-left ${onSelect ? 'cursor-pointer' : ''}`}
      >
        <div className="flex items-start gap-4">
          <div className={`w-10 h-10 rounded-lg flex items-center justify-center flex-shrink-0 ${
            meeting.recording_url ? 'bg-hud-gold/20' : 'bg-hud-bg-elev'
          }`}>
            <Video className={`w-5 h-5 ${meeting.recording_url ? 'text-hud-gold-soft' : 'text-hud-cream-dim'}`} />
          </div>

          <div className="flex-1 min-w-0">
            <div className="flex items-center justify-between gap-3 mb-2">
              <h3 className="font-medium text-white truncate">{meeting.meeting_title}</h3>
              {meeting.recording_url && (
                <MeetingRecordingLink
                  recordingUrl={meeting.recording_url}
                  variant="badge"
                />
              )}
            </div>

            <div className="flex flex-wrap items-center gap-4 text-sm text-hud-cream-dim mb-3">
              <span className="flex items-center gap-1">
                <Calendar className="w-4 h-4" />
                {formatDateShort(meeting.meeting_date, { weekday: true })}
              </span>
              <span className="flex items-center gap-1">
                <Clock className="w-4 h-4" />
                {formatDuration(meeting.duration_minutes)}
              </span>
              <span className="flex items-center gap-1">
                <Users className="w-4 h-4" />
                {meeting.participants.length} participants
              </span>
            </div>

            {meeting.summary && (
              <p className="text-sm text-hud-cream-soft line-clamp-2 mb-3">{meeting.summary}</p>
            )}

            <div className="flex flex-wrap gap-4">
              {meeting.key_points && meeting.key_points.length > 0 && (
                <span className="flex items-center gap-1 text-xs text-hud-cream-dim">
                  <MessageSquare className="w-3 h-3" />
                  {meeting.key_points.length} key points
                </span>
              )}
              {meeting.action_items && meeting.action_items.length > 0 && (
                <span className="flex items-center gap-1 text-xs text-hud-cream-dim">
                  <ListChecks className="w-3 h-3" />
                  {meeting.action_items.length} action items
                </span>
              )}
              {meeting.transcript_text && (
                <span className="flex items-center gap-1 text-xs text-hud-cream-dim">
                  <FileText className="w-3 h-3" />
                  Transcript available
                </span>
              )}
            </div>
          </div>
        </div>
      </CardWrapper>

      <MeetingFollowUpApprovalsLink meetingTranscriptionId={meeting.id} />

      {(showTranscript || meeting.key_points.length > 0 || meeting.action_items.length > 0) && (
        <div className="border-t border-hud-bg-elev">
          <button
            onClick={() => setIsExpanded(!isExpanded)}
            className="w-full px-4 py-2 flex items-center justify-center gap-2 text-sm text-hud-cream-dim hover:text-white transition-colors"
          >
            {isExpanded ? (
              <>
                <ChevronUp className="w-4 h-4" />
                Hide Details
              </>
            ) : (
              <>
                <ChevronDown className="w-4 h-4" />
                Show Details
              </>
            )}
          </button>

          {isExpanded && (
            <div className="px-4 pb-4 space-y-4">
              {meeting.key_points && meeting.key_points.length > 0 && (
                <div>
                  <h4 className="text-sm font-medium text-hud-cream-soft mb-2 flex items-center gap-2">
                    <MessageSquare className="w-4 h-4 text-hud-gold-soft" />
                    Key Points
                  </h4>
                  <ul className="space-y-1">
                    {meeting.key_points.map((point, i) => (
                      <li key={i} className="text-sm text-hud-cream-dim flex items-start gap-2">
                        <span className="text-hud-gold-soft mt-1">-</span>
                        {point}
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {currentUserId && (
                <MeetingActionItemsPanel
                  meetingTranscriptionId={meeting.id}
                  currentUserId={currentUserId}
                  onTaskCreated={onTaskCreated}
                  contactId={meeting.contact_id ?? undefined}
                  orgId={orgId}
                />
              )}

              {(!currentUserId) && meeting.action_items && meeting.action_items.length > 0 && (
                <div>
                  <h4 className="text-sm font-medium text-hud-cream-soft mb-2 flex items-center gap-2">
                    <ListChecks className="w-4 h-4 text-hud-rust" />
                    Action Items
                  </h4>
                  <ul className="space-y-2">
                    {meeting.action_items.map((item, i) => (
                      <li key={i} className="text-sm text-hud-cream-dim flex items-start gap-2">
                        <input
                          type="checkbox"
                          checked={item.completed}
                          readOnly
                          className="mt-1 w-4 h-4 rounded border-hud-cream-mute bg-hud-bg-elev text-hud-gold"
                        />
                        <div>
                          <p>{item.description}</p>
                          {item.assignee && (
                            <p className="text-xs text-hud-cream-mute">Assigned to: {item.assignee}</p>
                          )}
                        </div>
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {showTranscript && meeting.transcript_text && (
                <div>
                  <h4 className="text-sm font-medium text-hud-cream-soft mb-2 flex items-center gap-2">
                    <FileText className="w-4 h-4 text-hud-cream-dim" />
                    Transcript
                  </h4>
                  <div className="max-h-64 overflow-auto bg-hud-bg-mid/50 rounded-lg p-3">
                    <pre className="text-xs text-hud-cream-dim whitespace-pre-wrap font-mono">
                      {meeting.transcript_text}
                    </pre>
                  </div>
                </div>
              )}

              {meeting.recording_url && (
                <div className="pt-2">
                  <MeetingRecordingLink
                    recordingUrl={meeting.recording_url}
                    recordingDuration={meeting.recording_duration}
                    recordingSizeBytes={meeting.recording_size_bytes}
                    variant="card"
                    showDuration
                    showSize
                  />
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
