import { useState } from 'react';
import {
  X, Loader2, CalendarDays, MapPin, Video, Users, Plus, Trash2,
} from 'lucide-react';
import type { Calendar } from '../../../types';
import { createCalendarEvent } from '../../../services/calendarEvents';
import { useAuth } from '../../../contexts/AuthContext';
import { useWorkspaceProvider } from '../../../hooks/useWorkspaceProvider';
import { createOutlookCalendarEvent } from '../../../services/googleCalendarEvents';
import { MicrosoftAccountSelect } from '../../shared/MicrosoftAccountSelect';
import { GoogleAccountSelect } from '../../shared/GoogleAccountSelect';
import { showAccountPicker } from '../../../lib/microsoftAccounts';
import { defaultGoogleCalendarConnectionId, googleCalendarConnectionIdForCreate } from '../../../lib/googleAccounts';
import { formatDateString } from '../../../utils/calendarViewUtils';
import { Portal } from '../../shared/Portal';

interface NewEventModalProps {
  calendar: Calendar;
  calendars?: Calendar[];
  preselectedDate?: Date;
  onClose: () => void;
  onSuccess: () => void;
}

export function NewEventModal({
  calendar: initialCalendar,
  calendars,
  preselectedDate,
  onClose,
  onSuccess,
}: NewEventModalProps) {
  const { user: currentUser } = useAuth();
  const [selectedCalendarId, setSelectedCalendarId] = useState(initialCalendar.id);
  const calendar = calendars?.find(c => c.id === selectedCalendarId) || initialCalendar;
  // Users with 2+ Microsoft accounts choose which Outlook calendar also receives the event
  // (default: none, so nothing is written to Outlook unless chosen; '' = CRM calendar only). Single-account users see nothing new.
  const { accounts: workspaceAccounts } = useWorkspaceProvider();
  const msAccounts = workspaceAccounts.microsoft;
  const [pickedOutlook, setPickedOutlook] = useState<string | null>(null);
  const outlookConnectionId = pickedOutlook ?? '';
  // Users with 2+ Google accounts choose which Google calendar receives the event (default: the primary).
  const googleAccounts = workspaceAccounts.google;
  const [pickedGoogle, setPickedGoogle] = useState<string | null>(null);
  const googleConnectionId = pickedGoogle && googleAccounts.some((a) => a.id === pickedGoogle)
    ? pickedGoogle
    : defaultGoogleCalendarConnectionId(googleAccounts);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const defaultDate = formatDateString(preselectedDate || new Date());
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [location, setLocation] = useState('');
  const [startDate, setStartDate] = useState(defaultDate);
  const [startTime, setStartTime] = useState('09:00');
  const [endDate, setEndDate] = useState(defaultDate);
  const [endTime, setEndTime] = useState('10:00');
  const [allDay, setAllDay] = useState(false);
  const [generateMeet, setGenerateMeet] = useState(false);
  const [attendees, setAttendees] = useState<{ email: string; name: string }[]>([]);
  const [newAttendeeEmail, setNewAttendeeEmail] = useState('');

  const addAttendee = () => {
    if (!newAttendeeEmail.trim() || !newAttendeeEmail.includes('@')) return;
    if (attendees.some(a => a.email === newAttendeeEmail.trim())) return;
    setAttendees(prev => [...prev, { email: newAttendeeEmail.trim(), name: '' }]);
    setNewAttendeeEmail('');
  };

  const removeAttendee = (email: string) => {
    setAttendees(prev => prev.filter(a => a.email !== email));
  };

  const handleSubmit = async () => {
    if (!title.trim()) {
      setError('Title is required');
      return;
    }
    if (!currentUser) return;

    setIsSaving(true);
    setError(null);

    try {
      const startUtc = allDay
        ? `${startDate}T00:00:00.000Z`
        : new Date(`${startDate}T${startTime}`).toISOString();
      const endUtc = allDay
        ? `${endDate}T23:59:59.999Z`
        : new Date(`${endDate}T${endTime}`).toISOString();

      await createCalendarEvent(
        calendar.org_id,
        {
          calendar_id: calendar.id,
          title: title.trim(),
          description: description.trim() || null,
          location: location.trim() || null,
          start_at_utc: startUtc,
          end_at_utc: endUtc,
          all_day: allDay,
          timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
          attendees,
          generate_meet: generateMeet,
          google_connection_id: googleCalendarConnectionIdForCreate(googleAccounts, googleConnectionId),
        },
        currentUser
      );

      if (showAccountPicker(msAccounts) && outlookConnectionId) {
        try {
          await createOutlookCalendarEvent({
            summary: title.trim(),
            startTime: startUtc,
            endTime: endUtc,
            description: description.trim() || null,
            attendees: attendees.map((a) => a.email),
            connectionId: outlookConnectionId,
          });
        } catch (outlookErr) {
          onSuccess();
          setError(`Event saved, but adding it to Outlook failed: ${outlookErr instanceof Error ? outlookErr.message : 'unknown error'}`);
          return;
        }
      }

      onSuccess();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create event');
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <Portal><div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />
      <div className="relative w-full max-w-lg mx-4 bg-hud-bg-mid rounded-xl border border-hud-bg-elev shadow-2xl max-h-[90dvh] overflow-y-auto">
        <div className="flex items-center justify-between p-4 border-b border-hud-bg-card">
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 rounded-lg bg-blue-500/20 flex items-center justify-center">
              <CalendarDays className="w-4 h-4 text-blue-400" />
            </div>
            <h3 className="text-lg font-semibold text-white">New Event</h3>
          </div>
          <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-hud-bg-card transition-colors">
            <X className="w-5 h-5 text-hud-cream-dim" />
          </button>
        </div>

        {error && (
          <div className="mx-4 mt-4 p-3 rounded-lg bg-hud-plum/10 border border-hud-plum/30">
            <p className="text-sm text-hud-plum/40">{error}</p>
          </div>
        )}

        <div className="p-4 space-y-4">
          <div>
            <label className="block text-sm font-medium text-hud-cream-soft mb-1">Title</label>
            <input
              type="text"
              value={title}
              onChange={e => setTitle(e.target.value)}
              placeholder="Meeting name..."
              className="w-full px-3 py-2 rounded-lg bg-hud-bg-card border border-hud-bg-elev text-white placeholder-hud-cream-dim text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
              autoFocus
            />
          </div>

          {calendars && calendars.length > 1 && (
            <div>
              <label className="block text-sm font-medium text-hud-cream-soft mb-1">Calendar</label>
              <select
                value={selectedCalendarId}
                onChange={e => setSelectedCalendarId(e.target.value)}
                className="w-full px-3 py-2 rounded-lg bg-hud-bg-card border border-hud-bg-elev text-white text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              >
                {calendars.map(c => (
                  <option key={c.id} value={c.id}>{c.name}</option>
                ))}
              </select>
            </div>
          )}

          <div className="flex items-center gap-3">
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={allDay}
                onChange={e => setAllDay(e.target.checked)}
                className="rounded border-hud-cream-mute bg-hud-bg-card text-blue-500 focus:ring-blue-500"
              />
              <span className="text-sm text-hud-cream-soft">All day</span>
            </label>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-sm font-medium text-hud-cream-soft mb-1">Start Date</label>
              <input
                type="date"
                value={startDate}
                onChange={e => { setStartDate(e.target.value); if (e.target.value > endDate) setEndDate(e.target.value); }}
                className="w-full px-3 py-2 rounded-lg bg-hud-bg-card border border-hud-bg-elev text-white text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>
            {!allDay && (
              <div>
                <label className="block text-sm font-medium text-hud-cream-soft mb-1">Start Time</label>
                <input
                  type="time"
                  value={startTime}
                  onChange={e => setStartTime(e.target.value)}
                  className="w-full px-3 py-2 rounded-lg bg-hud-bg-card border border-hud-bg-elev text-white text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              </div>
            )}
            <div>
              <label className="block text-sm font-medium text-hud-cream-soft mb-1">End Date</label>
              <input
                type="date"
                value={endDate}
                onChange={e => setEndDate(e.target.value)}
                min={startDate}
                className="w-full px-3 py-2 rounded-lg bg-hud-bg-card border border-hud-bg-elev text-white text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>
            {!allDay && (
              <div>
                <label className="block text-sm font-medium text-hud-cream-soft mb-1">End Time</label>
                <input
                  type="time"
                  value={endTime}
                  onChange={e => setEndTime(e.target.value)}
                  className="w-full px-3 py-2 rounded-lg bg-hud-bg-card border border-hud-bg-elev text-white text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              </div>
            )}
          </div>

          <div>
            <label className="block text-sm font-medium text-hud-cream-soft mb-1">
              <MapPin className="w-3.5 h-3.5 inline mr-1" />
              Location
            </label>
            <input
              type="text"
              value={location}
              onChange={e => setLocation(e.target.value)}
              placeholder="Add location..."
              className="w-full px-3 py-2 rounded-lg bg-hud-bg-card border border-hud-bg-elev text-white placeholder-hud-cream-dim text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>

          <div className="flex items-center gap-3">
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={generateMeet}
                onChange={e => setGenerateMeet(e.target.checked)}
                className="rounded border-hud-cream-mute bg-hud-bg-card text-blue-500 focus:ring-blue-500"
              />
              <Video className="w-3.5 h-3.5 text-hud-cream-dim" />
              <span className="text-sm text-hud-cream-soft">Add Google Meet</span>
            </label>
          </div>

          <GoogleAccountSelect
            accounts={googleAccounts}
            value={googleConnectionId}
            onChange={setPickedGoogle}
            label="Google calendar account"
            compact={false}
          />

          <MicrosoftAccountSelect
            accounts={msAccounts}
            value={outlookConnectionId}
            onChange={setPickedOutlook}
            label="Add to Outlook calendar"
            noneLabel="Don't add to Outlook"
            compact={false}
          />

          <div>
            <label className="block text-sm font-medium text-hud-cream-soft mb-1">Description</label>
            <textarea
              value={description}
              onChange={e => setDescription(e.target.value)}
              rows={2}
              placeholder="Add description..."
              className="w-full px-3 py-2 rounded-lg bg-hud-bg-card border border-hud-bg-elev text-white placeholder-hud-cream-dim text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 resize-none"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-hud-cream-soft mb-1">
              <Users className="w-3.5 h-3.5 inline mr-1" />
              Attendees
            </label>
            {attendees.length > 0 && (
              <div className="space-y-1 mb-2">
                {attendees.map(att => (
                  <div key={att.email} className="flex items-center justify-between px-2 py-1 rounded bg-hud-bg-card">
                    <span className="text-sm text-hud-cream-soft">{att.email}</span>
                    <button onClick={() => removeAttendee(att.email)} className="p-0.5 hover:text-hud-plum text-hud-cream-mute">
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                ))}
              </div>
            )}
            <div className="flex gap-2">
              <input
                type="email"
                value={newAttendeeEmail}
                onChange={e => setNewAttendeeEmail(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && (e.preventDefault(), addAttendee())}
                placeholder="email@example.com"
                className="flex-1 px-3 py-1.5 rounded-lg bg-hud-bg-card border border-hud-bg-elev text-white placeholder-hud-cream-dim text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
              <button
                onClick={addAttendee}
                className="px-3 py-1.5 rounded-lg bg-hud-bg-elev text-hud-cream-soft text-sm hover:bg-hud-cream-mute transition-colors"
              >
                <Plus className="w-4 h-4" />
              </button>
            </div>
          </div>
        </div>

        <div className="flex items-center justify-end gap-2 p-4 border-t border-hud-bg-card">
          <button
            onClick={onClose}
            className="px-4 py-2 rounded-lg bg-hud-bg-card text-hud-cream-soft text-sm hover:bg-hud-bg-elev transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={handleSubmit}
            disabled={isSaving || !title.trim()}
            className="flex items-center gap-1.5 px-4 py-2 rounded-lg bg-blue-600 text-white text-sm font-medium hover:bg-blue-700 transition-colors disabled:opacity-50"
          >
            {isSaving && <Loader2 className="w-4 h-4 animate-spin" />}
            Create Event
          </button>
        </div>
      </div>
    </div></Portal>
  );
}
