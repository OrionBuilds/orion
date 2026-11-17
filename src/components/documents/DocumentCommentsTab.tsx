import { Loader2, MessageSquare, User } from 'lucide-react';
import type { User as AuthUser } from '../../types';
import { formatDateTimeShort } from '../../utils/formatters';

interface DocumentComment {
  id: string;
  is_client_comment: boolean;
  client_name: string | null;
  content: string;
  created_at: string;
  user?: AuthUser | null;
}

interface DocumentCommentsTabProps {
  comments: DocumentComment[];
  newComment: string;
  onNewCommentChange: (value: string) => void;
  onSubmit: () => void;
  isSubmitting: boolean;
}

export function DocumentCommentsTab({
  comments,
  newComment,
  onNewCommentChange,
  onSubmit,
  isSubmitting,
}: DocumentCommentsTabProps) {
  return (
    <div className="max-w-2xl mx-auto space-y-4">
      <div className="flex gap-3">
        <textarea
          value={newComment}
          onChange={(e) => onNewCommentChange(e.target.value)}
          placeholder="Add a comment..."
          className="flex-1 px-4 py-3 bg-hud-bg-card border border-hud-bg-elev rounded-lg text-white placeholder-hud-cream-dim resize-none focus:outline-none focus:ring-2 focus:ring-hud-gold/50"
          rows={3}
        />
      </div>
      <div className="flex justify-end">
        <button
          onClick={onSubmit}
          disabled={!newComment.trim() || isSubmitting}
          className="flex items-center gap-2 px-4 py-2 bg-hud-gold-deep hover:bg-hud-gold disabled:bg-hud-bg-elev disabled:text-hud-cream-dim disabled:cursor-not-allowed text-white hover:text-hud-bg-deep rounded-lg transition-colors"
        >
          {isSubmitting ? (
            <Loader2 className="w-4 h-4 animate-spin" />
          ) : (
            <MessageSquare className="w-4 h-4" />
          )}
          Add Comment
        </button>
      </div>

      <div className="space-y-4 mt-6">
        {comments.length === 0 ? (
          <p className="text-center text-hud-cream-dim py-8">No comments yet</p>
        ) : (
          comments.map((comment) => (
            <div key={comment.id} className="p-4 bg-hud-bg-card/50 rounded-lg border border-hud-bg-elev">
              <div className="flex items-center gap-3 mb-2">
                <div className="w-8 h-8 rounded-full bg-hud-bg-elev flex items-center justify-center">
                  {comment.is_client_comment ? (
                    <User className="w-4 h-4 text-hud-rust" />
                  ) : (
                    <span className="text-xs font-medium text-white">
                      {comment.user?.name?.[0] || 'U'}
                    </span>
                  )}
                </div>
                <div>
                  <p className="text-white text-sm font-medium">
                    {comment.is_client_comment
                      ? comment.client_name || 'Client'
                      : comment.user?.name || 'Unknown'}
                  </p>
                  <p className="text-xs text-hud-cream-dim">{formatDateTimeShort(comment.created_at, { hour: 'numeric' })}</p>
                </div>
              </div>
              <p className="text-hud-cream-soft">{comment.content}</p>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
