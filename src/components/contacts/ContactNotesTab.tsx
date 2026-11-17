import { useState, useRef, useCallback } from 'react';
import { useAuth } from '../../contexts/AuthContext';
import { createNote, updateNote, deleteNote, toggleNotePin } from '../../services/contactNotes';
import type { ContactNote, ContactNoteMetadata } from '../../types';
import {
  Plus,
  Edit2,
  Trash2,
  Pin,
  Loader2,
  MessageSquare,
  Video,
  ExternalLink,
  FileText,
  Calendar,
  Users,
  ChevronDown,
  ChevronUp,
} from 'lucide-react';
import { MentionText } from '../shared/MentionText';
import { MentionAwareTextarea } from '../shared/MentionAwareTextarea';
import { useToast } from '../../contexts/ToastContext';
import { getErrorMessage, logError } from '../../lib/errors';

interface ContactNotesTabProps {
  contactId: string;
  notes: ContactNote[];
  onRefresh: () => void;
}

export function ContactNotesTab({ contactId, notes, onRefresh }: ContactNotesTabProps) {
  const { user: currentUser, hasPermission, isSuperAdmin } = useAuth();
  const { showToast } = useToast();
  const [isAdding, setIsAdding] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [content, setContent] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);

  const canEdit = hasPermission('contacts.edit');
  const isAdmin = isSuperAdmin || currentUser?.role?.hierarchy_level === 2;

  const handleAdd = async () => {
    if (!currentUser || !content.trim()) return;

    try {
      setIsSubmitting(true);
      await createNote(contactId, content.trim(), currentUser);
      setContent('');
      setIsAdding(false);
      onRefresh();
    } catch (err) {
      logError('ContactNotesTab.handleAdd', err);
      showToast('error', 'Failed to add note', getErrorMessage(err));
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleUpdate = async (noteId: string) => {
    if (!currentUser || !content.trim()) return;

    try {
      setIsSubmitting(true);
      await updateNote(noteId, content.trim(), currentUser);
      setContent('');
      setEditingId(null);
      onRefresh();
    } catch (err) {
      logError('ContactNotesTab.handleUpdate', err);
      showToast('error', 'Failed to update note', getErrorMessage(err));
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleDelete = async (noteId: string) => {
    if (!currentUser || !confirm('Are you sure you want to delete this note?')) return;

    try {
      await deleteNote(noteId, currentUser);
      onRefresh();
    } catch (err) {
      logError('ContactNotesTab.handleDelete', err);
      showToast('error', 'Failed to delete note', getErrorMessage(err));
    }
  };

  const handleTogglePin = async (note: ContactNote) => {
    try {
      await toggleNotePin(note.id, !note.is_pinned);
      onRefresh();
    } catch (err) {
      logError('ContactNotesTab.handleTogglePin', err);
      showToast('error', 'Failed to update note', getErrorMessage(err));
    }
  };

  const startEditing = (note: ContactNote) => {
    setEditingId(note.id);
    setContent(note.content);
    setIsAdding(false);
  };

  const cancelEdit = () => {
    setEditingId(null);
    setContent('');
    setIsAdding(false);
  };

  const canModifyNote = (note: ContactNote) => {
    return note.user_id === currentUser?.id || isAdmin;
  };

  const isMeetNote = (note: ContactNote) => note.source_type === 'google_meet';
  const orgId = currentUser?.organization_id;

  return (
    <div className="space-y-4">
      {canEdit && !isAdding && !editingId && (
        <button
          onClick={() => {
            setIsAdding(true);
            setContent('');
          }}
          className="inline-flex items-center gap-2 text-sm text-hud-gold-soft hover:text-hud-gold-soft transition-colors"
        >
          <Plus className="w-4 h-4" />
          Add Note
        </button>
      )}

      {isAdding && (
        <div className="bg-hud-bg-card/50 rounded-lg p-4">
          {orgId ? (
            <MentionAwareTextarea
              allowedTypes={['user']}
              value={content}
              onChange={setContent}
              orgId={orgId}
              placeholder="Write a note... use @ to mention a contact, opportunity, project, or user"
              rows={4}
              autoFocus
            />
          ) : (
            <textarea
              value={content}
              onChange={(e) => setContent(e.target.value)}
              placeholder="Write a note..."
              rows={4}
              className="w-full px-3 py-2 rounded-lg bg-hud-bg-card border border-hud-bg-elev text-white placeholder-hud-cream-dim focus:outline-none focus:ring-2 focus:ring-hud-gold focus:border-transparent resize-none"
              autoFocus
            />
          )}
          <div className="flex justify-end gap-2 mt-3">
            <button
              onClick={cancelEdit}
              className="px-3 py-1.5 rounded-lg text-sm text-hud-cream-dim hover:text-white transition-colors"
            >
              Cancel
            </button>
            <button
              onClick={handleAdd}
              disabled={!content.trim() || isSubmitting}
              className="inline-flex items-center gap-2 px-3 py-1.5 rounded-lg bg-hud-gold text-hud-bg-deep text-sm font-medium hover:bg-hud-gold-deep transition-colors disabled:opacity-50"
            >
              {isSubmitting && <Loader2 className="w-4 h-4 animate-spin" />}
              Add Note
            </button>
          </div>
        </div>
      )}

      <div className="space-y-3">
        {notes.map((note) =>
          isMeetNote(note) ? (
            <MeetNoteCard
              key={note.id}
              note={note}
              canModify={canModifyNote(note)}
              onTogglePin={() => handleTogglePin(note)}
              onDelete={() => handleDelete(note.id)}
            />
          ) : (
            <div
              key={note.id}
              className={`bg-hud-bg-card/50 rounded-lg p-4 ${note.is_pinned ? 'ring-1 ring-hud-rust/30' : ''}`}
            >
              {editingId === note.id ? (
                <>
                  {orgId ? (
                    <MentionAwareTextarea
              allowedTypes={['user']}
                      value={content}
                      onChange={setContent}
                      orgId={orgId}
                      rows={4}
                      autoFocus
                    />
                  ) : (
                    <textarea
                      value={content}
                      onChange={(e) => setContent(e.target.value)}
                      rows={4}
                      className="w-full px-3 py-2 rounded-lg bg-hud-bg-card border border-hud-bg-elev text-white placeholder-hud-cream-dim focus:outline-none focus:ring-2 focus:ring-hud-gold focus:border-transparent resize-none"
                      autoFocus
                    />
                  )}
                  <div className="flex justify-end gap-2 mt-3">
                    <button
                      onClick={cancelEdit}
                      className="px-3 py-1.5 rounded-lg text-sm text-hud-cream-dim hover:text-white transition-colors"
                    >
                      Cancel
                    </button>
                    <button
                      onClick={() => handleUpdate(note.id)}
                      disabled={!content.trim() || isSubmitting}
                      className="inline-flex items-center gap-2 px-3 py-1.5 rounded-lg bg-hud-gold text-hud-bg-deep text-sm font-medium hover:bg-hud-gold-deep transition-colors disabled:opacity-50"
                    >
                      {isSubmitting && <Loader2 className="w-4 h-4 animate-spin" />}
                      Save
                    </button>
                  </div>
                </>
              ) : (
                <>
                  <div className="flex items-start justify-between gap-4">
                    <div className="flex-1">
                      <div className="flex items-center gap-2 mb-2">
                        <span className="text-sm font-medium text-white">
                          {note.user?.name || 'Unknown'}
                        </span>
                        <span className="text-xs text-hud-cream-mute">
                          {new Date(note.created_at).toLocaleString()}
                        </span>
                        {note.is_pinned && (
                          <Pin className="w-3 h-3 text-hud-rust" />
                        )}
                      </div>
                      <p className="text-sm text-hud-cream-soft whitespace-pre-wrap">
                        <MentionText text={note.content} />
                      </p>
                    </div>
                    {canModifyNote(note) && (
                      <div className="flex items-center gap-1">
                        <button
                          onClick={() => handleTogglePin(note)}
                          className={`p-1.5 rounded transition-colors ${
                            note.is_pinned
                              ? 'text-hud-rust hover:bg-hud-rust/10'
                              : 'text-hud-cream-mute hover:text-hud-cream-soft hover:bg-hud-bg-elev'
                          }`}
                          title={note.is_pinned ? 'Unpin note' : 'Pin note'}
                        >
                          <Pin className="w-4 h-4" />
                        </button>
                        <button
                          onClick={() => startEditing(note)}
                          className="p-1.5 rounded text-hud-cream-mute hover:text-hud-cream-soft hover:bg-hud-bg-elev transition-colors"
                          title="Edit note"
                        >
                          <Edit2 className="w-4 h-4" />
                        </button>
                        <button
                          onClick={() => handleDelete(note.id)}
                          className="p-1.5 rounded text-hud-cream-mute hover:text-hud-plum hover:bg-hud-plum/10 transition-colors"
                          title="Delete note"
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                      </div>
                    )}
                  </div>
                </>
              )}
            </div>
          )
        )}
      </div>

      {notes.length === 0 && !isAdding && (
        <div className="text-center py-8">
          <MessageSquare className="w-12 h-12 text-hud-cream-mute mx-auto mb-3" />
          <p className="text-hud-cream-dim">No notes yet</p>
          {canEdit && (
            <button
              onClick={() => {
                setIsAdding(true);
                setContent('');
              }}
              className="mt-2 text-sm text-hud-gold-soft hover:text-hud-gold-soft transition-colors"
            >
              Add the first note
            </button>
          )}
        </div>
      )}
    </div>
  );
}

interface MeetNoteCardProps {
  note: ContactNote;
  canModify: boolean;
  onTogglePin: () => void;
  onDelete: () => void;
}

function MeetNoteCard({ note, canModify, onTogglePin, onDelete }: MeetNoteCardProps) {
  const [isExpanded, setIsExpanded] = useState(false);
  const meta = note.metadata as ContactNoteMetadata | null;

  const hasRecording = !!meta?.drive_urls?.recording;
  const hasTranscript = !!meta?.drive_urls?.transcript;
  const hasGeminiNotes = !!meta?.drive_urls?.gemini_notes;
  const hasCalendarLink = !!meta?.calendar_html_link;

  const attendeeCount = meta?.attendees?.length || 0;
  const durationMinutes = meta?.duration_minutes;

  return (
    <div
      className={`rounded-lg border overflow-hidden ${
        note.is_pinned
          ? 'border-hud-rust/30 bg-hud-bg-card/60'
          : 'border-hud-teal/20 bg-gradient-to-r from-hud-bg-card/70 to-hud-teal/20'
      }`}
    >
      <div className="p-4">
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-center gap-2.5 min-w-0">
            <div className="flex-shrink-0 w-8 h-8 rounded-lg bg-hud-teal/15 flex items-center justify-center">
              <Video className="w-4 h-4 text-hud-teal" />
            </div>
            <div className="min-w-0">
              <h4 className="text-sm font-semibold text-white truncate">
                {note.title || 'Google Meet Note'}
              </h4>
              <div className="flex items-center gap-2 mt-0.5">
                <span className="text-xs text-hud-teal/80 font-medium">
                  Auto-generated from Google Meet
                </span>
                {note.is_pinned && <Pin className="w-3 h-3 text-hud-rust" />}
              </div>
            </div>
          </div>

          <div className="flex items-center gap-1 flex-shrink-0">
            {canModify && (
              <>
                <button
                  onClick={onTogglePin}
                  className={`p-1.5 rounded transition-colors ${
                    note.is_pinned
                      ? 'text-hud-rust hover:bg-hud-rust/10'
                      : 'text-hud-cream-mute hover:text-hud-cream-soft hover:bg-hud-bg-elev'
                  }`}
                  title={note.is_pinned ? 'Unpin' : 'Pin'}
                >
                  <Pin className="w-3.5 h-3.5" />
                </button>
                <button
                  onClick={onDelete}
                  className="p-1.5 rounded text-hud-cream-mute hover:text-hud-plum hover:bg-hud-plum/10 transition-colors"
                  title="Delete"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              </>
            )}
          </div>
        </div>

        <div className="flex items-center gap-3 mt-3 text-xs text-hud-cream-dim">
          <span className="flex items-center gap-1">
            <Calendar className="w-3 h-3" />
            {new Date(note.created_at).toLocaleDateString('en-US', {
              month: 'short',
              day: 'numeric',
              year: 'numeric',
            })}
          </span>
          {durationMinutes && (
            <span>{durationMinutes} min</span>
          )}
          {attendeeCount > 0 && (
            <span className="flex items-center gap-1">
              <Users className="w-3 h-3" />
              {attendeeCount} attendee{attendeeCount !== 1 ? 's' : ''}
            </span>
          )}
        </div>

        <div className="flex items-center gap-2 mt-3 flex-wrap">
          {hasRecording && (
            <a
              href={meta!.drive_urls!.recording!}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-hud-teal/10 text-hud-teal text-xs font-medium hover:bg-hud-teal/20 transition-colors"
            >
              <Video className="w-3 h-3" />
              Recording
              <ExternalLink className="w-2.5 h-2.5" />
            </a>
          )}
          {hasTranscript && (
            <a
              href={meta!.drive_urls!.transcript!}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-sky-500/10 text-sky-400 text-xs font-medium hover:bg-sky-500/20 transition-colors"
            >
              <FileText className="w-3 h-3" />
              Transcript
              <ExternalLink className="w-2.5 h-2.5" />
            </a>
          )}
          {hasGeminiNotes && (
            <a
              href={meta!.drive_urls!.gemini_notes!}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-hud-rust/10 text-hud-rust text-xs font-medium hover:bg-hud-rust/20 transition-colors"
            >
              <FileText className="w-3 h-3" />
              Gemini Notes
              <ExternalLink className="w-2.5 h-2.5" />
            </a>
          )}
          {hasCalendarLink && (
            <a
              href={meta!.calendar_html_link!}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-hud-cream-mute/10 text-hud-cream-dim text-xs font-medium hover:bg-hud-cream-mute/20 transition-colors"
            >
              <Calendar className="w-3 h-3" />
              Event
              <ExternalLink className="w-2.5 h-2.5" />
            </a>
          )}
        </div>

        <button
          onClick={() => setIsExpanded(!isExpanded)}
          className="flex items-center gap-1 mt-3 text-xs text-hud-cream-dim hover:text-hud-cream-soft transition-colors"
        >
          {isExpanded ? (
            <>
              <ChevronUp className="w-3.5 h-3.5" />
              Hide details
            </>
          ) : (
            <>
              <ChevronDown className="w-3.5 h-3.5" />
              Show meeting details
            </>
          )}
        </button>
      </div>

      {isExpanded && (
        <div className="border-t border-hud-bg-elev/50 px-4 py-3">
          <p className="text-sm text-hud-cream-soft whitespace-pre-wrap leading-relaxed">
            {note.content}
          </p>
        </div>
      )}
    </div>
  );
}
