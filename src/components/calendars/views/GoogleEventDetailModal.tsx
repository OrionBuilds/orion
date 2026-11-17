import { useState, useMemo } from 'react';
import {
  X, Calendar as CalendarIcon, Clock, MapPin, Video, ExternalLink,
  Users, Edit3, Trash2, Save, Loader2, AlertTriangle,
  Check, XCircle, HelpCircle, ArrowLeftRight, ArrowRight, ArrowLeft,
} from 'lucide-react';
import type { GoogleCalendarEvent } from '../../../types';
import { formatTimeRange, toLocalDatetimeString } from '../../../utils/calendarViewUtils';
import { useAuth } from '../../../contexts/AuthContext';
import { updateGoogleCalendarEvent, deleteGoogleCalendarEvent, rsvpGoogleCalendarEvent } from '../../../services/googleCalendarEvents';
import { PROVIDER_LABELS } from '../../../services/connectedProvider';
import { Portal } from '../../shared/Portal';

interface GoogleEventDetailModalProps {
  event: GoogleCalendarEvent;
  onClose: () => void;
  onUpdated: () => void;
  canEdit?: boolean;
}

export function GoogleEventDetailModal({
  event,
  onClose,
  onUpdated,
  canEdit = true,
}: GoogleEventDetailModalProps) {
  const { user } = useAuth();
  const labels = PROVIDER_LABELS[event.provider ?? 'google'];
  const [isEditing, setIsEditing] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [isRsvping, setIsRsvping] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [localAttendees, setLocalAttendees] = useState(event.attendees);

  const currentUserEmail = user?.email?.toLowerCase();
  const currentUserAttendee = useMemo(() => {
    if (!localAttendees || !currentUserEmail) return null;
    return localAttendees.find(
      (att: { email?: string }) => att.email?.toLowerCase() === currentUserEmail
    ) || null;
  }, [localAttendees, currentUserEmail]);

  const currentRsvpStatus = currentUserAttendee?.responseStatus || null;

  const handleRsvp = async (response: 'accepted' | 'declined' | 'tentative') => {
    setIsRsvping(true);
    setError(null);
    try {
      await rsvpGoogleCalendarEvent(event.id, response, event.provider);
      setLocalAttendees((prev: typeof localAttendees) =>
        (prev || []).map((att: { email?: string; responseStatus?: string; [key: string]: unknown }) =>
          att.email?.toLowerCase() === currentUserEmail
            ? { ...att, responseStatus: response }
            : att
        )
      );
      onUpdated();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update RSVP');
    } finally {
      setIsRsvping(false);
    }
  };

  const [editSummary, setEditSummary] = useState(event.summary || '');
  const [editDescription, setEditDescription] = useState(event.description || '');
  const [editLocation, setEditLocation] = useState(event.location || '');
  const [editStartDate, setEditStartDate] = useState(
    toLocalDatetimeString(new Date(event.start_time))
  );
  const [editEndDate, setEditEndDate] = useState(
    toLocalDatetimeString(new Date(event.end_time))
  );

  const timeDisplay = useMemo(
    () => formatTimeRange(event.start_time, event.end_time),
    [event.start_time, event.end_time]
  );

  const dateDisplay = useMemo(() => {
    const start = new Date(event.start_time);
    if (event.all_day) {
      return start.toLocaleDateString('en-US', {
        weekday: 'long', month: 'long', day: 'numeric', year: 'numeric',
      });
    }
    return start.toLocaleDateString('en-US', {
      weekday: 'long', month: 'long', day: 'numeric', year: 'numeric',
    });
  }, [event.start_time, event.all_day]);

  const meetLink = event.hangout_link || null;

  const handleSave = async () => {
    setIsSaving(true);
    setError(null);
    try {
      await updateGoogleCalendarEvent(event.id, {
        summary: editSummary,
        description: editDescription,
        location: editLocation,
        start_time: new Date(editStartDate).toISOString(),
        end_time: new Date(editEndDate).toISOString(),
        all_day: event.all_day,
        timezone: event.timezone,
      }, event.provider);
      setIsEditing(false);
      onUpdated();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update event');
    } finally {
      setIsSaving(false);
    }
  };

  const handleDelete = async () => {
    setIsDeleting(true);
    setError(null);
    try {
      await deleteGoogleCalendarEvent(event.id, event.provider);
      onClose();
      onUpdated();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete event');
    } finally {
      setIsDeleting(false);
    }
  };

  return (
    <Portal><div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />
      <div className="relative w-full max-w-lg mx-4 bg-hud-bg-mid rounded-xl border border-hud-bg-elev shadow-2xl max-h-[90dvh] overflow-y-auto">
        <div className="flex items-center justify-between p-4 border-b border-hud-bg-card">
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 rounded-lg bg-hud-teal/20 flex items-center justify-center">
              <CalendarIcon className="w-4 h-4 text-hud-teal" />
            </div>
            <div>
              <h3 className="text-lg font-semibold text-white">
                {isEditing ? 'Edit Event' : `${labels.calendar} Event`}
              </h3>
              <div className="flex items-center gap-2">
                <p className="text-xs text-hud-teal">Synced from {labels.calendar}</p>
                {event.sync_direction && (
                  <span className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium ${
                    event.sync_direction === 'bidirectional'
                      ? 'bg-hud-gold/15 text-hud-gold-soft'
                      : event.sync_direction === 'to_google'
                        ? 'bg-blue-500/15 text-blue-400'
                        : 'bg-hud-teal/15 text-hud-teal'
                  }`}>
                    {event.sync_direction === 'bidirectional' ? (
                      <ArrowLeftRight className="w-2.5 h-2.5" />
                    ) : event.sync_direction === 'to_google' ? (
                      <ArrowRight className="w-2.5 h-2.5" />
                    ) : (
                      <ArrowLeft className="w-2.5 h-2.5" />
                    )}
                    {event.sync_direction === 'bidirectional' ? '2-way' : event.sync_direction === 'to_google' ? 'CRM > Google' : 'Google > CRM'}
                  </span>
                )}
              </div>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg hover:bg-hud-bg-card transition-colors"
          >
            <X className="w-5 h-5 text-hud-cream-dim" />
          </button>
        </div>

        {error && (
          <div className="mx-4 mt-4 p-3 rounded-lg bg-hud-plum/10 border border-hud-plum/30 flex items-center gap-2">
            <AlertTriangle className="w-4 h-4 text-hud-plum flex-shrink-0" />
            <p className="text-sm text-hud-plum/40">{error}</p>
          </div>
        )}

        <div className="p-4 space-y-4">
          {isEditing ? (
            <>
              <div>
                <label className="block text-sm font-medium text-hud-cream-soft mb-1">Title</label>
                <input
                  type="text"
                  value={editSummary}
                  onChange={(e) => setEditSummary(e.target.value)}
                  className="w-full px-3 py-2 rounded-lg bg-hud-bg-card border border-hud-bg-elev text-white placeholder-hud-cream-dim text-sm focus:outline-none focus:ring-2 focus:ring-hud-teal focus:border-transparent"
                />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-sm font-medium text-hud-cream-soft mb-1">Start</label>
                  <input
                    type="datetime-local"
                    value={editStartDate}
                    onChange={(e) => setEditStartDate(e.target.value)}
                    className="w-full px-3 py-2 rounded-lg bg-hud-bg-card border border-hud-bg-elev text-white text-sm focus:outline-none focus:ring-2 focus:ring-hud-teal focus:border-transparent"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-hud-cream-soft mb-1">End</label>
                  <input
                    type="datetime-local"
                    value={editEndDate}
                    onChange={(e) => setEditEndDate(e.target.value)}
                    className="w-full px-3 py-2 rounded-lg bg-hud-bg-card border border-hud-bg-elev text-white text-sm focus:outline-none focus:ring-2 focus:ring-hud-teal focus:border-transparent"
                  />
                </div>
              </div>
              <div>
                <label className="block text-sm font-medium text-hud-cream-soft mb-1">Location</label>
                <input
                  type="text"
                  value={editLocation}
                  onChange={(e) => setEditLocation(e.target.value)}
                  placeholder="Add location..."
                  className="w-full px-3 py-2 rounded-lg bg-hud-bg-card border border-hud-bg-elev text-white placeholder-hud-cream-dim text-sm focus:outline-none focus:ring-2 focus:ring-hud-teal focus:border-transparent"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-hud-cream-soft mb-1">Description</label>
                <textarea
                  value={editDescription}
                  onChange={(e) => setEditDescription(e.target.value)}
                  rows={3}
                  placeholder="Add description..."
                  className="w-full px-3 py-2 rounded-lg bg-hud-bg-card border border-hud-bg-elev text-white placeholder-hud-cream-dim text-sm focus:outline-none focus:ring-2 focus:ring-hud-teal focus:border-transparent resize-none"
                />
              </div>
            </>
          ) : (
            <>
              <div>
                <h4 className="text-xl font-semibold text-white">
                  {event.summary || '(No title)'}
                </h4>
                {event.transparency === 'transparent' && (
                  <span className="inline-block mt-1 text-xs bg-hud-bg-elev text-hud-cream-soft px-2 py-0.5 rounded">
                    Free
                  </span>
                )}
              </div>

              <div className="space-y-3">
                <div className="flex items-start gap-3">
                  <Clock className="w-4 h-4 text-hud-cream-dim mt-0.5 flex-shrink-0" />
                  <div>
                    <p className="text-sm text-white">{dateDisplay}</p>
                    {!event.all_day && (
                      <p className="text-sm text-hud-cream-dim">{timeDisplay}</p>
                    )}
                    {event.all_day && (
                      <p className="text-sm text-hud-cream-dim">All day</p>
                    )}
                  </div>
                </div>

                {event.location && (
                  <div className="flex items-start gap-3">
                    <MapPin className="w-4 h-4 text-hud-cream-dim mt-0.5 flex-shrink-0" />
                    <p className="text-sm text-white">{event.location}</p>
                  </div>
                )}

                {meetLink && (
                  <div className="flex items-start gap-3">
                    <Video className="w-4 h-4 text-hud-cream-dim mt-0.5 flex-shrink-0" />
                    <a
                      href={meetLink}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-sm text-hud-teal hover:text-hud-teal/40 underline"
                    >
                      Join {labels.meetings}
                    </a>
                  </div>
                )}

                {event.description && (
                  <div className="pt-2 border-t border-hud-bg-card">
                    <p className="text-sm text-hud-cream-soft whitespace-pre-wrap">
                      {event.description}
                    </p>
                  </div>
                )}

                {event.organizer_email && (
                  <div className="flex items-start gap-3 pt-2 border-t border-hud-bg-card">
                    <Users className="w-4 h-4 text-hud-cream-dim mt-0.5 flex-shrink-0" />
                    <div>
                      <p className="text-xs text-hud-cream-mute mb-1">Organizer</p>
                      <p className="text-sm text-white">
                        {event.organizer_display_name || event.organizer_email}
                      </p>
                    </div>
                  </div>
                )}

                {currentUserAttendee && (
                  <div className="pt-2 border-t border-hud-bg-card">
                    <p className="text-xs text-hud-cream-mute mb-2">Your Response</p>
                    <div className="flex items-center gap-2">
                      <button
                        onClick={() => handleRsvp('accepted')}
                        disabled={isRsvping}
                        className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium transition-colors ${
                          currentRsvpStatus === 'accepted'
                            ? 'bg-hud-emerald/20 text-hud-emerald border border-hud-emerald/40'
                            : 'bg-hud-bg-card text-hud-cream-soft hover:bg-hud-emerald/10 hover:text-hud-emerald'
                        }`}
                      >
                        <Check className="w-3.5 h-3.5" />
                        Yes
                      </button>
                      <button
                        onClick={() => handleRsvp('declined')}
                        disabled={isRsvping}
                        className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium transition-colors ${
                          currentRsvpStatus === 'declined'
                            ? 'bg-hud-plum/20 text-hud-plum border border-hud-plum/40'
                            : 'bg-hud-bg-card text-hud-cream-soft hover:bg-hud-plum/10 hover:text-hud-plum'
                        }`}
                      >
                        <XCircle className="w-3.5 h-3.5" />
                        No
                      </button>
                      <button
                        onClick={() => handleRsvp('tentative')}
                        disabled={isRsvping}
                        className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium transition-colors ${
                          currentRsvpStatus === 'tentative'
                            ? 'bg-hud-rust/20 text-hud-rust border border-hud-rust/40'
                            : 'bg-hud-bg-card text-hud-cream-soft hover:bg-hud-rust/10 hover:text-hud-rust'
                        }`}
                      >
                        <HelpCircle className="w-3.5 h-3.5" />
                        Maybe
                      </button>
                      {isRsvping && <Loader2 className="w-4 h-4 text-hud-cream-dim animate-spin" />}
                    </div>
                  </div>
                )}

                {localAttendees && localAttendees.length > 0 && (
                  <div className="pt-2 border-t border-hud-bg-card">
                    <p className="text-xs text-hud-cream-mute mb-2">
                      Attendees ({localAttendees.length})
                    </p>
                    <div className="space-y-1.5 max-h-32 overflow-y-auto">
                      {localAttendees.map((att, i) => (
                        <div key={i} className="flex items-center gap-2">
                          <div className="w-6 h-6 rounded-full bg-hud-bg-elev flex items-center justify-center">
                            <span className="text-xs text-hud-cream-dim">
                              {(att.displayName || att.email || '?')[0].toUpperCase()}
                            </span>
                          </div>
                          <div className="min-w-0">
                            <p className="text-sm text-white truncate">
                              {att.displayName || att.email}
                            </p>
                            {att.responseStatus && att.responseStatus !== 'needsAction' && (
                              <p className={`text-xs ${
                                att.responseStatus === 'accepted' ? 'text-hud-emerald' :
                                att.responseStatus === 'declined' ? 'text-hud-plum' :
                                'text-hud-rust'
                              }`}>
                                {att.responseStatus}
                              </p>
                            )}
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            </>
          )}
        </div>

        {showDeleteConfirm && (
          <div className="mx-4 mb-4 p-3 rounded-lg bg-hud-plum/10 border border-hud-plum/30">
            <p className="text-sm text-hud-plum/40 mb-3">
              This will permanently delete the event from {labels.calendar}. Are you sure?
            </p>
            <div className="flex items-center gap-2">
              <button
                onClick={handleDelete}
                disabled={isDeleting}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-hud-plum text-white text-sm font-medium hover:bg-hud-plum transition-colors disabled:opacity-50"
              >
                {isDeleting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Trash2 className="w-3.5 h-3.5" />}
                Delete
              </button>
              <button
                onClick={() => setShowDeleteConfirm(false)}
                className="px-3 py-1.5 rounded-lg bg-hud-bg-card text-hud-cream-soft text-sm hover:bg-hud-bg-elev transition-colors"
              >
                Cancel
              </button>
            </div>
          </div>
        )}

        <div className="flex items-center justify-between p-4 border-t border-hud-bg-card">
          <div className="flex items-center gap-2">
            {event.html_link && (
              <a
                href={event.html_link}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-hud-bg-card text-hud-cream-soft text-sm hover:bg-hud-bg-elev hover:text-white transition-colors"
              >
                <ExternalLink className="w-3.5 h-3.5" />
                Open in {event.provider === 'microsoft' ? 'Outlook' : 'Google'}
              </a>
            )}
          </div>
          <div className="flex items-center gap-2">
            {isEditing ? (
              <>
                <button
                  onClick={() => setIsEditing(false)}
                  className="px-3 py-1.5 rounded-lg bg-hud-bg-card text-hud-cream-soft text-sm hover:bg-hud-bg-elev transition-colors"
                >
                  Cancel
                </button>
                <button
                  onClick={handleSave}
                  disabled={isSaving}
                  className="flex items-center gap-1.5 px-4 py-1.5 rounded-lg bg-hud-teal text-hud-bg-deep text-sm font-medium hover:bg-hud-teal transition-colors disabled:opacity-50"
                >
                  {isSaving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />}
                  Save
                </button>
              </>
            ) : canEdit ? (
              <>
                <button
                  onClick={() => setShowDeleteConfirm(true)}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-hud-bg-card text-hud-plum text-sm hover:bg-hud-plum/10 transition-colors"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                  Delete
                </button>
                <button
                  onClick={() => setIsEditing(true)}
                  className="flex items-center gap-1.5 px-4 py-1.5 rounded-lg bg-hud-teal text-hud-bg-deep text-sm font-medium hover:bg-hud-teal transition-colors"
                >
                  <Edit3 className="w-3.5 h-3.5" />
                  Edit
                </button>
              </>
            ) : null}
          </div>
        </div>
      </div>
    </div></Portal>
  );
}
