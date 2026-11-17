import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Send } from 'lucide-react';
import { getMeetingFollowUpApprovalCounts } from '../../services/workflowApprovals';

/**
 * Clara drafts each external attendee's post-meeting recap into the approvals queue; this points
 * there when any exist for the meeting. Renders nothing otherwise (or if the lookup fails).
 */
export function MeetingFollowUpApprovalsLink({ meetingTranscriptionId }: { meetingTranscriptionId: string }) {
  const [counts, setCounts] = useState<{ total: number; pending: number } | null>(null);

  useEffect(() => {
    let cancelled = false;
    getMeetingFollowUpApprovalCounts(meetingTranscriptionId)
      .then((c) => { if (!cancelled) setCounts(c); })
      .catch(() => { if (!cancelled) setCounts(null); });
    return () => { cancelled = true; };
  }, [meetingTranscriptionId]);

  if (!counts || counts.total === 0) return null;

  return (
    <div className="px-4 pb-3">
      <Link
        to="/automation/approvals"
        className="inline-flex items-center gap-1 text-xs text-hud-gold-soft hover:text-hud-gold"
      >
        <Send className="w-3 h-3" />
        Follow-up drafts are in Approvals
        {counts.pending > 0 && <span className="text-hud-cream-dim">({counts.pending} awaiting review)</span>}
      </Link>
    </div>
  );
}
