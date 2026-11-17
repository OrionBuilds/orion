import { useState, useEffect, useMemo } from 'react';
import {
  X,
  Loader2,
  Clock,
  Calendar as CalendarIcon,
  User as UserIcon,
  AlertCircle,
  ArrowLeft,
  ArrowRight,
  Check,
  Mail,
  Bell,
} from 'lucide-react';
import type { Calendar, AppointmentType, Appointment, AvailabilitySlot, User } from '../../../types';
import { getAppointmentTypes } from '../../../services/appointmentTypes';
import { getAvailableSlots } from '../../../services/availability';
import { updateAppointment } from '../../../services/appointments';
import { useAuth } from '../../../contexts/AuthContext';
import { addDays, formatDateString, formatTimeRange } from '../../../utils/calendarViewUtils';
import { Portal } from '../../shared/Portal';

interface EditAppointmentModalProps {
  calendar: Calendar;
  appointment: Appointment;
  onClose: () => void;
  onSuccess: () => void;
}

type EditStep = 'edit' | 'confirm';

interface ChangeItem {
  label: string;
  from: string;
  to: string;
}

export function EditAppointmentModal({
  calendar,
  appointment,
  onClose,
  onSuccess,
}: EditAppointmentModalProps) {
  const { user: currentUser } = useAuth();
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [step, setStep] = useState<EditStep>('edit');

  const [appointmentTypes, setAppointmentTypes] = useState<AppointmentType[]>([]);
  const [availableSlots, setAvailableSlots] = useState<AvailabilitySlot[]>([]);
  const [isLoadingSlots, setIsLoadingSlots] = useState(false);

  const [selectedTypeId, setSelectedTypeId] = useState<string>(appointment.appointment_type_id);
  const [selectedDate, setSelectedDate] = useState<string>(
    appointment.start_at_utc.split('T')[0]
  );
  const [selectedSlot, setSelectedSlot] = useState<AvailabilitySlot | null>(null);
  const [selectedUserId, setSelectedUserId] = useState<string>(
    appointment.assigned_user_id || ''
  );
  const [notes, setNotes] = useState(appointment.notes || '');
  const [keepOriginalTime, setKeepOriginalTime] = useState(true);

  const originalDate = useMemo(() => appointment.start_at_utc.split('T')[0], [appointment]);
  const originalTimeDisplay = useMemo(
    () => formatTimeRange(appointment.start_at_utc, appointment.end_at_utc),
    [appointment]
  );

  const selectedType = useMemo(
    () => appointmentTypes.find((t) => t.id === selectedTypeId),
    [appointmentTypes, selectedTypeId]
  );

  const originalType = useMemo(
    () => appointmentTypes.find((t) => t.id === appointment.appointment_type_id),
    [appointmentTypes, appointment.appointment_type_id]
  );

  const slotsForSelectedDate = useMemo(() => {
    if (!selectedDate) return [];
    return availableSlots.filter((slot) => slot.start.startsWith(selectedDate));
  }, [availableSlots, selectedDate]);

  const eligibleUsers = useMemo(() => {
    if (keepOriginalTime) {
      if (calendar.type === 'user') {
        return calendar.owner ? [calendar.owner] : [];
      }
      return calendar.members?.map((m) => m.user).filter(Boolean) as User[] || [];
    }
    if (!selectedSlot) return [];
    if (calendar.type === 'user') {
      return calendar.owner ? [calendar.owner] : [];
    }
    return (
      calendar.members
        ?.filter((m) => selectedSlot.eligible_user_ids.includes(m.user_id))
        .map((m) => m.user)
        .filter(Boolean) || []
    ) as User[];
  }, [selectedSlot, calendar, keepOriginalTime]);

  const isCurrentUserAvailable = useMemo(() => {
    if (keepOriginalTime) return true;
    if (!selectedSlot || !selectedUserId) return true;
    return selectedSlot.eligible_user_ids.includes(selectedUserId);
  }, [selectedSlot, selectedUserId, keepOriginalTime]);

  const contactName = useMemo(() => {
    if (appointment.contact) {
      return `${appointment.contact.first_name} ${appointment.contact.last_name}`;
    }
    return appointment.answers?.name || appointment.notes || 'Guest';
  }, [appointment]);

  const hasChanges = useMemo(() => {
    const typeChanged = selectedTypeId !== appointment.appointment_type_id;
    const notesChanged = notes !== (appointment.notes || '');
    const userChanged = selectedUserId !== (appointment.assigned_user_id || '');
    const timeChanged = !keepOriginalTime && selectedSlot !== null;
    return typeChanged || notesChanged || userChanged || timeChanged;
  }, [selectedTypeId, notes, selectedUserId, keepOriginalTime, selectedSlot, appointment]);

  const changes = useMemo((): ChangeItem[] => {
    const items: ChangeItem[] = [];

    if (selectedTypeId !== appointment.appointment_type_id) {
      items.push({
        label: 'Appointment Type',
        from: originalType?.name || 'Unknown',
        to: selectedType?.name || 'Unknown',
      });
    }

    if (!keepOriginalTime && selectedSlot) {
      const newDate = new Date(selectedSlot.start).toLocaleDateString('en-US', {
        weekday: 'long',
        year: 'numeric',
        month: 'long',
        day: 'numeric',
      });
      const oldDate = new Date(appointment.start_at_utc).toLocaleDateString('en-US', {
        weekday: 'long',
        year: 'numeric',
        month: 'long',
        day: 'numeric',
      });
      const newTime = formatTimeRange(selectedSlot.start, selectedSlot.end);

      if (newDate !== oldDate || newTime !== originalTimeDisplay) {
        items.push({
          label: 'Date & Time',
          from: `${oldDate}, ${originalTimeDisplay}`,
          to: `${newDate}, ${newTime}`,
        });
      }
    }

    if (selectedUserId !== (appointment.assigned_user_id || '')) {
      const oldUser = appointment.assigned_user?.name || 'Unassigned';
      const newUser = eligibleUsers.find((u) => u.id === selectedUserId)?.name || 'Unassigned';
      items.push({
        label: 'Assigned To',
        from: oldUser,
        to: newUser,
      });
    }

    if (notes !== (appointment.notes || '')) {
      items.push({
        label: 'Notes',
        from: appointment.notes || '(empty)',
        to: notes || '(empty)',
      });
    }

    return items;
  }, [
    selectedTypeId,
    selectedSlot,
    selectedUserId,
    notes,
    keepOriginalTime,
    appointment,
    originalType,
    selectedType,
    originalTimeDisplay,
    eligibleUsers,
  ]);

  useEffect(() => {
    const loadInitialData = async () => {
      try {
        setIsLoading(true);
        const types = await getAppointmentTypes(calendar.id);
        setAppointmentTypes(types.filter((t) => t.active));
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load data');
      } finally {
        setIsLoading(false);
      }
    };

    loadInitialData();
  }, [calendar.id]);

  useEffect(() => {
    if (keepOriginalTime) {
      setAvailableSlots([]);
      setSelectedSlot(null);
      return;
    }

    const loadSlots = async () => {
      if (!selectedTypeId || !selectedDate) {
        setAvailableSlots([]);
        return;
      }

      try {
        setIsLoadingSlots(true);
        const startDate = selectedDate;
        const endDate = formatDateString(addDays(new Date(selectedDate), 7));

        const slots = await getAvailableSlots({
          calendarId: calendar.id,
          appointmentTypeId: selectedTypeId,
          startDate,
          endDate,
          visitorTimezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        });

        setAvailableSlots(slots);
        setSelectedSlot(null);
      } catch (err) {
        console.error('Failed to load slots:', err);
      } finally {
        setIsLoadingSlots(false);
      }
    };

    loadSlots();
  }, [calendar.id, selectedTypeId, selectedDate, keepOriginalTime]);

  useEffect(() => {
    if (!keepOriginalTime && selectedSlot && !isCurrentUserAvailable) {
      if (eligibleUsers.length === 1 && eligibleUsers[0]) {
        setSelectedUserId(eligibleUsers[0].id);
      } else {
        setSelectedUserId('');
      }
    }
  }, [selectedSlot, eligibleUsers, keepOriginalTime, isCurrentUserAvailable]);

  const handleReviewChanges = () => {
    if (!hasChanges) {
      setError('No changes have been made');
      return;
    }
    if (!keepOriginalTime && !selectedSlot) {
      setError('Please select a new time slot');
      return;
    }
    if (!keepOriginalTime && selectedSlot && !isCurrentUserAvailable && !selectedUserId) {
      setError('Please select an available team member for this time slot');
      return;
    }
    setError(null);
    setStep('confirm');
  };

  const handleConfirmSave = async () => {
    if (!currentUser) return;

    try {
      setIsSaving(true);
      setError(null);

      const updates: {
        assigned_user_id?: string | null;
        start_at_utc?: string;
        end_at_utc?: string;
        notes?: string | null;
      } = {};

      if (notes !== (appointment.notes || '')) {
        updates.notes = notes || null;
      }

      if (selectedUserId !== (appointment.assigned_user_id || '')) {
        updates.assigned_user_id = selectedUserId || null;
      }

      if (!keepOriginalTime && selectedSlot) {
        updates.start_at_utc = selectedSlot.start;
        updates.end_at_utc = selectedSlot.end;
      }

      await updateAppointment(appointment.id, updates, currentUser);
      onSuccess();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update appointment');
      setStep('edit');
    } finally {
      setIsSaving(false);
    }
  };

  const formatSlotTime = (slot: AvailabilitySlot) => {
    const start = new Date(slot.start);
    return start.toLocaleTimeString('en-US', {
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
    });
  };

  if (isLoading) {
    return (
      <Portal><div className="fixed inset-0 z-50 flex items-center justify-center">
        <div className="absolute inset-0 bg-black/60" onClick={onClose} />
        <div className="relative bg-hud-bg-mid rounded-xl border border-hud-bg-elev p-8">
          <Loader2 className="w-8 h-8 animate-spin text-hud-gold" />
        </div>
      </div></Portal>
    );
  }

  if (step === 'confirm') {
    return (
      <Portal><div className="fixed inset-0 z-50 flex items-center justify-center">
        <div className="absolute inset-0 bg-black/60" onClick={onClose} />

        <div className="relative bg-hud-bg-mid rounded-xl border border-hud-bg-elev w-full max-w-lg mx-4 shadow-2xl">
          <div className="flex items-center justify-between p-4 border-b border-hud-bg-elev">
            <div className="flex items-center gap-3">
              <button
                onClick={() => setStep('edit')}
                className="p-1 rounded hover:bg-hud-bg-card transition-colors"
              >
                <ArrowLeft className="w-5 h-5 text-hud-cream-dim" />
              </button>
              <h2 className="text-lg font-semibold text-white">Confirm Changes</h2>
            </div>
            <button
              onClick={onClose}
              className="p-2 rounded-lg hover:bg-hud-bg-card transition-colors"
            >
              <X className="w-5 h-5 text-hud-cream-dim" />
            </button>
          </div>

          <div className="p-6 space-y-6">
            {error && (
              <div className="p-3 rounded-lg bg-hud-plum/10 border border-hud-plum/20 flex items-center gap-2 text-hud-plum text-sm">
                <AlertCircle className="w-4 h-4 flex-shrink-0" />
                {error}
              </div>
            )}

            <div className="bg-hud-bg-card/50 rounded-lg p-4 border border-hud-bg-elev">
              <p className="text-sm text-hud-cream-dim mb-2">Appointment for</p>
              <p className="text-white font-medium">{contactName}</p>
              {appointment.contact?.email && (
                <p className="text-sm text-hud-cream-dim">{appointment.contact.email}</p>
              )}
            </div>

            <div className="space-y-4">
              <p className="text-sm font-medium text-hud-cream-soft">Changes to be applied:</p>
              {changes.map((change, index) => (
                <div key={index} className="bg-hud-bg-card rounded-lg p-4 border border-hud-bg-elev">
                  <p className="text-sm font-medium text-hud-gold-soft mb-2">{change.label}</p>
                  <div className="flex items-start gap-3">
                    <div className="flex-1">
                      <p className="text-xs text-hud-cream-mute mb-1">From</p>
                      <p className="text-sm text-hud-cream-dim line-through">{change.from}</p>
                    </div>
                    <ArrowRight className="w-4 h-4 text-hud-cream-mute mt-4 flex-shrink-0" />
                    <div className="flex-1">
                      <p className="text-xs text-hud-cream-mute mb-1">To</p>
                      <p className="text-sm text-white">{change.to}</p>
                    </div>
                  </div>
                </div>
              ))}
            </div>

            <div className="bg-hud-rust/10 border border-hud-rust/20 rounded-lg p-4">
              <div className="flex items-start gap-3">
                <Bell className="w-5 h-5 text-hud-rust flex-shrink-0 mt-0.5" />
                <div>
                  <p className="text-sm font-medium text-hud-rust mb-1">Notifications will be sent</p>
                  <div className="text-sm text-hud-cream-dim space-y-1">
                    {appointment.contact?.email && (
                      <p className="flex items-center gap-2">
                        <Mail className="w-3 h-3" />
                        Contact: {appointment.contact.email}
                      </p>
                    )}
                    {selectedUserId && eligibleUsers.find((u) => u.id === selectedUserId) && (
                      <p className="flex items-center gap-2">
                        <UserIcon className="w-3 h-3" />
                        Assigned: {eligibleUsers.find((u) => u.id === selectedUserId)?.name}
                      </p>
                    )}
                  </div>
                </div>
              </div>
            </div>
          </div>

          <div className="p-4 border-t border-hud-bg-elev bg-hud-bg-card/50 flex items-center justify-end gap-3">
            <button
              type="button"
              onClick={() => setStep('edit')}
              disabled={isSaving}
              className="px-4 py-2 rounded-lg text-hud-cream-soft hover:text-white hover:bg-hud-bg-elev transition-colors disabled:opacity-50"
            >
              Go Back
            </button>
            <button
              onClick={handleConfirmSave}
              disabled={isSaving}
              className="px-4 py-2 rounded-lg bg-gradient-to-r from-hud-gold to-hud-teal text-white font-medium hover:from-hud-gold-deep hover:to-hud-teal transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
            >
              {isSaving ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <Check className="w-4 h-4" />
              )}
              Confirm Changes
            </button>
          </div>
        </div>
      </div></Portal>
    );
  }

  return (
    <Portal><div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/60" onClick={onClose} />

      <div className="relative bg-hud-bg-mid rounded-xl border border-hud-bg-elev w-full max-w-lg mx-4 shadow-2xl max-h-[90dvh] flex flex-col">
        <div className="flex items-center justify-between p-4 border-b border-hud-bg-elev flex-shrink-0">
          <h2 className="text-lg font-semibold text-white">Edit Appointment</h2>
          <button
            onClick={onClose}
            className="p-2 rounded-lg hover:bg-hud-bg-card transition-colors"
          >
            <X className="w-5 h-5 text-hud-cream-dim" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto">
          <div className="p-6 space-y-6">
            {error && (
              <div className="p-3 rounded-lg bg-hud-plum/10 border border-hud-plum/20 flex items-center gap-2 text-hud-plum text-sm">
                <AlertCircle className="w-4 h-4 flex-shrink-0" />
                {error}
              </div>
            )}

            <div className="bg-hud-bg-card/50 rounded-lg p-4 border border-hud-bg-elev">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-full bg-gradient-to-br from-hud-gold to-hud-teal flex items-center justify-center text-white font-semibold flex-shrink-0">
                  {contactName[0]?.toUpperCase() || '?'}
                </div>
                <div>
                  <p className="text-white font-medium">{contactName}</p>
                  <p className="text-sm text-hud-cream-dim">
                    Current: {new Date(appointment.start_at_utc).toLocaleDateString('en-US', {
                      month: 'short',
                      day: 'numeric',
                    })}, {originalTimeDisplay}
                  </p>
                </div>
              </div>
            </div>

            <div>
              <label className="block text-sm font-medium text-hud-cream-soft mb-2">
                Appointment Type
              </label>
              <select
                value={selectedTypeId}
                onChange={(e) => {
                  setSelectedTypeId(e.target.value);
                  if (!keepOriginalTime) {
                    setSelectedSlot(null);
                  }
                }}
                className="w-full px-4 py-2 rounded-lg bg-hud-bg-card border border-hud-bg-elev text-white focus:outline-none focus:ring-2 focus:ring-hud-gold"
              >
                {appointmentTypes.map((type) => (
                  <option key={type.id} value={type.id}>
                    {type.name} ({type.duration_minutes} min)
                  </option>
                ))}
              </select>
            </div>

            <div className="space-y-3">
              <label className="block text-sm font-medium text-hud-cream-soft">
                Date & Time
              </label>
              <div className="flex items-center gap-3">
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="radio"
                    checked={keepOriginalTime}
                    onChange={() => setKeepOriginalTime(true)}
                    className="w-4 h-4 text-hud-gold bg-hud-bg-card border-hud-cream-mute focus:ring-hud-gold focus:ring-offset-hud-bg-mid"
                  />
                  <span className="text-sm text-hud-cream-soft">Keep current time</span>
                </label>
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="radio"
                    checked={!keepOriginalTime}
                    onChange={() => setKeepOriginalTime(false)}
                    className="w-4 h-4 text-hud-gold bg-hud-bg-card border-hud-cream-mute focus:ring-hud-gold focus:ring-offset-hud-bg-mid"
                  />
                  <span className="text-sm text-hud-cream-soft">Reschedule</span>
                </label>
              </div>

              {!keepOriginalTime && (
                <div className="space-y-4 pt-2">
                  <div>
                    <label className="block text-sm font-medium text-hud-cream-dim mb-2">
                      <CalendarIcon className="w-4 h-4 inline mr-1" />
                      New Date
                    </label>
                    <input
                      type="date"
                      value={selectedDate}
                      onChange={(e) => setSelectedDate(e.target.value)}
                      min={formatDateString(new Date())}
                      className="w-full px-4 py-2 rounded-lg bg-hud-bg-card border border-hud-bg-elev text-white focus:outline-none focus:ring-2 focus:ring-hud-gold"
                    />
                  </div>

                  <div>
                    <label className="block text-sm font-medium text-hud-cream-dim mb-2">
                      <Clock className="w-4 h-4 inline mr-1" />
                      Available Times
                    </label>
                    {isLoadingSlots ? (
                      <div className="flex items-center gap-2 text-hud-cream-dim text-sm">
                        <Loader2 className="w-4 h-4 animate-spin" />
                        Loading available times...
                      </div>
                    ) : slotsForSelectedDate.length === 0 ? (
                      <p className="text-sm text-hud-cream-dim italic">
                        No available times for this date. Try another date.
                      </p>
                    ) : (
                      <div className="grid grid-cols-4 gap-2 max-h-40 overflow-y-auto">
                        {slotsForSelectedDate.map((slot) => (
                          <button
                            key={slot.start}
                            type="button"
                            onClick={() => setSelectedSlot(slot)}
                            className={`px-3 py-2 rounded-lg text-sm font-medium transition-colors ${
                              selectedSlot?.start === slot.start
                                ? 'bg-hud-gold text-hud-bg-deep'
                                : 'bg-hud-bg-card border border-hud-bg-elev text-hud-cream-soft hover:border-hud-cream-mute'
                            }`}
                          >
                            {formatSlotTime(slot)}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>

                  {selectedSlot && !isCurrentUserAvailable && (
                    <div className="p-3 rounded-lg bg-hud-rust/10 border border-hud-rust/20 text-hud-rust text-sm">
                      <AlertCircle className="w-4 h-4 inline mr-2" />
                      The currently assigned user is not available at this time. Please select a different team member.
                    </div>
                  )}
                </div>
              )}
            </div>

            {calendar.type === 'team' && eligibleUsers.length > 0 && (
              <div>
                <label className="block text-sm font-medium text-hud-cream-soft mb-2">
                  <UserIcon className="w-4 h-4 inline mr-1" />
                  Assigned To
                </label>
                <select
                  value={selectedUserId}
                  onChange={(e) => setSelectedUserId(e.target.value)}
                  className="w-full px-4 py-2 rounded-lg bg-hud-bg-card border border-hud-bg-elev text-white focus:outline-none focus:ring-2 focus:ring-hud-gold"
                >
                  <option value="">Unassigned</option>
                  {eligibleUsers.map((user) =>
                    user ? (
                      <option key={user.id} value={user.id}>
                        {user.name}
                        {!keepOriginalTime && selectedSlot && !selectedSlot.eligible_user_ids.includes(user.id)
                          ? ' (unavailable)'
                          : ''}
                      </option>
                    ) : null
                  )}
                </select>
              </div>
            )}

            <div>
              <label className="block text-sm font-medium text-hud-cream-soft mb-2">
                Notes
              </label>
              <textarea
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                rows={3}
                placeholder="Add any notes about this appointment..."
                className="w-full px-4 py-2 rounded-lg bg-hud-bg-card border border-hud-bg-elev text-white placeholder-hud-cream-dim focus:outline-none focus:ring-2 focus:ring-hud-gold resize-none"
              />
            </div>
          </div>
        </div>

        <div className="p-4 border-t border-hud-bg-elev bg-hud-bg-card/50 flex items-center justify-end gap-3 flex-shrink-0">
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2 rounded-lg text-hud-cream-soft hover:text-white hover:bg-hud-bg-elev transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={handleReviewChanges}
            disabled={!hasChanges}
            className="px-4 py-2 rounded-lg bg-gradient-to-r from-hud-gold to-hud-teal text-white font-medium hover:from-hud-gold-deep hover:to-hud-teal transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
          >
            Review Changes
            <ArrowRight className="w-4 h-4" />
          </button>
        </div>
      </div>
    </div></Portal>
  );
}
