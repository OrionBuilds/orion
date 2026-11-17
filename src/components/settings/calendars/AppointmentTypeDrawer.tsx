import { useState, useEffect } from 'react';
import { X, Plus, Trash2, GripVertical, Share2 } from 'lucide-react';
import { ShareCalendarModal } from './ShareCalendarModal';
import { durationOptions, locationOptions } from './appointmentTypeOptions';
import { useAuth } from '../../../contexts/AuthContext';
import {
  createAppointmentType,
  updateAppointmentType,
  generateAppointmentTypeSlug,
  getDefaultQuestions,
} from '../../../services/appointmentTypes';
import type { Calendar, AppointmentType, LocationType, AppointmentTypeQuestion } from '../../../types';
import { Portal } from '../../shared/Portal';

interface AppointmentTypeDrawerProps {
  open: boolean;
  onClose: () => void;
  onSave: () => void;
  appointmentType: AppointmentType | null;
  calendar: Calendar | null;
  calendars: Calendar[];
}

const intervalOptions = [15, 30, 60];

export function AppointmentTypeDrawer({
  open,
  onClose,
  onSave,
  appointmentType,
  calendar,
  calendars,
}: AppointmentTypeDrawerProps) {
  const { user } = useAuth();
  const isEditing = !!appointmentType;
  const [shareOpen, setShareOpen] = useState(false);

  const [formData, setFormData] = useState({
    calendar_id: '',
    name: '',
    slug: '',
    description: '',
    duration_minutes: 30,
    slot_interval_minutes: 15,
    buffer_before_minutes: 0,
    buffer_after_minutes: 0,
    min_notice_minutes: 60,
    booking_window_days: 30,
    max_per_day: null as number | null,
    location_type: 'google_meet' as LocationType,
    location_value: {
      phone_number: '',
      address: '',
      custom_link: '',
      instructions: '',
    },
    generate_google_meet: true,
    active: true,
  });

  const [questions, setQuestions] = useState<AppointmentTypeQuestion[]>(getDefaultQuestions());
  // Reminder offsets are edited as a comma-separated "hours before" string, then
  // parsed to number[] on save. Kept as raw text so partial typing doesn't fight
  // the parser (e.g. typing "2" before "24").
  const [reminderText, setReminderText] = useState('24');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  // "24, 1" -> [24, 1]; empty -> []. De-duplicates, keeps positive integers, sorts desc.
  const parseReminderHours = (text: string): number[] => {
    const nums = text
      .split(',')
      .map((s) => parseInt(s.trim(), 10))
      .filter((n) => Number.isFinite(n) && n > 0);
    return Array.from(new Set(nums)).sort((a, b) => b - a);
  };

  useEffect(() => {
    if (open) {
      if (appointmentType) {
        setFormData({
          calendar_id: appointmentType.calendar_id,
          name: appointmentType.name,
          slug: appointmentType.slug,
          description: appointmentType.description || '',
          duration_minutes: appointmentType.duration_minutes,
          slot_interval_minutes: appointmentType.slot_interval_minutes,
          buffer_before_minutes: appointmentType.buffer_before_minutes,
          buffer_after_minutes: appointmentType.buffer_after_minutes,
          min_notice_minutes: appointmentType.min_notice_minutes,
          booking_window_days: appointmentType.booking_window_days,
          max_per_day: appointmentType.max_per_day,
          location_type: appointmentType.location_type,
          location_value: {
            phone_number: appointmentType.location_value?.phone_number || '',
            address: appointmentType.location_value?.address || '',
            custom_link: appointmentType.location_value?.custom_link || '',
            instructions: appointmentType.location_value?.instructions || '',
          },
          generate_google_meet: appointmentType.generate_google_meet,
          active: appointmentType.active,
        });
        setReminderText((appointmentType.reminder_hours_before ?? [24]).join(', '));
        setQuestions(appointmentType.questions || getDefaultQuestions());
      } else {
        setFormData({
          calendar_id: calendar?.id || calendars[0]?.id || '',
          name: '',
          slug: '',
          description: '',
          duration_minutes: 30,
          slot_interval_minutes: 15,
          buffer_before_minutes: 0,
          buffer_after_minutes: 0,
          min_notice_minutes: 60,
          booking_window_days: 30,
          max_per_day: null,
          location_type: 'google_meet',
          location_value: {
            phone_number: '',
            address: '',
            custom_link: '',
            instructions: '',
          },
          generate_google_meet: true,
          active: true,
        });
        setReminderText('24');
        setQuestions(getDefaultQuestions());
      }
      setError('');
    }
  }, [open, appointmentType, calendar, calendars]);

  const handleNameChange = (name: string) => {
    setFormData({
      ...formData,
      name,
      slug: isEditing ? formData.slug : generateAppointmentTypeSlug(name),
    });
  };

  const handleAddQuestion = () => {
    setQuestions([
      ...questions,
      {
        id: `custom-${Date.now()}`,
        label: '',
        type: 'text',
        required: false,
      },
    ]);
  };

  const handleUpdateQuestion = (index: number, updates: Partial<AppointmentTypeQuestion>) => {
    setQuestions(
      questions.map((q, i) => (i === index ? { ...q, ...updates } : q))
    );
  };

  const handleRemoveQuestion = (index: number) => {
    const question = questions[index];
    if (['name', 'email', 'phone'].includes(question.id)) return;
    setQuestions(questions.filter((_, i) => i !== index));
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!user) return;

    setError('');
    setSaving(true);

    try {
      const typeData = {
        calendar_id: formData.calendar_id,
        name: formData.name,
        slug: formData.slug,
        description: formData.description || null,
        duration_minutes: formData.duration_minutes,
        slot_interval_minutes: formData.slot_interval_minutes,
        buffer_before_minutes: formData.buffer_before_minutes,
        buffer_after_minutes: formData.buffer_after_minutes,
        min_notice_minutes: formData.min_notice_minutes,
        booking_window_days: formData.booking_window_days,
        max_per_day: formData.max_per_day,
        reminder_hours_before: parseReminderHours(reminderText),
        location_type: formData.location_type,
        location_value: formData.location_value,
        generate_google_meet: formData.generate_google_meet,
        questions: questions.filter((q) => q.label.trim() || ['name', 'email', 'phone'].includes(q.id)),
      };

      if (isEditing && appointmentType) {
        await updateAppointmentType(
          appointmentType.id,
          { ...typeData, active: formData.active },
          user
        );
      } else {
        await createAppointmentType(user.organization_id, typeData, user);
      }

      onSave();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save appointment type');
    } finally {
      setSaving(false);
    }
  };

  if (!open) return null;

  return (
    <>
      {/* Backdrop and panel share one Portal so the panel stays above its backdrop. */}
      <Portal>
      <div className="fixed inset-0 bg-black/50 z-40" onClick={onClose} />
      <div className="fixed right-0 top-0 bottom-0 w-full max-w-2xl bg-hud-bg-mid border-l border-hud-bg-elev z-50 flex flex-col">
        <div className="flex items-center justify-between px-6 py-4 border-b border-hud-bg-elev">
          <h2 className="text-lg font-semibold text-white">
            {isEditing ? 'Edit Appointment Type' : 'Create Appointment Type'}
          </h2>
          <button
            onClick={onClose}
            className="p-1 text-hud-cream-dim hover:text-white rounded"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="flex-1 overflow-y-auto">
          <div className="p-6 space-y-6">
            {error && (
              <div className="p-3 bg-hud-plum/20 border border-hud-plum/30 rounded-lg text-hud-plum text-sm">
                {error}
              </div>
            )}

            <div className="grid grid-cols-2 gap-4">
              <div className="col-span-2">
                <label className="block text-sm font-medium text-hud-cream-soft mb-2">
                  Name
                </label>
                <input
                  type="text"
                  value={formData.name}
                  onChange={(e) => handleNameChange(e.target.value)}
                  placeholder="e.g. 30 Minute Consultation"
                  className="w-full px-3 py-2 bg-hud-bg-card border border-hud-bg-elev rounded-lg text-white focus:outline-none focus:ring-2 focus:ring-hud-gold"
                  required
                />
              </div>

              <div>
                <div className="flex items-center justify-between mb-2">
                  <label className="block text-sm font-medium text-hud-cream-soft">
                    URL Slug
                  </label>
                  {isEditing && formData.slug && (
                    <button
                      type="button"
                      onClick={() => setShareOpen(true)}
                      className="inline-flex items-center gap-1 text-xs text-hud-gold-soft hover:text-hud-gold-soft font-medium"
                    >
                      <Share2 className="w-3.5 h-3.5" />
                      Share
                    </button>
                  )}
                </div>
                <input
                  type="text"
                  value={formData.slug}
                  onChange={(e) => setFormData({ ...formData, slug: e.target.value })}
                  className="w-full px-3 py-2 bg-hud-bg-card border border-hud-bg-elev rounded-lg text-white focus:outline-none focus:ring-2 focus:ring-hud-gold"
                  required
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-hud-cream-soft mb-2">
                  Calendar
                </label>
                <select
                  value={formData.calendar_id}
                  onChange={(e) => setFormData({ ...formData, calendar_id: e.target.value })}
                  className="w-full px-3 py-2 bg-hud-bg-card border border-hud-bg-elev rounded-lg text-white focus:outline-none focus:ring-2 focus:ring-hud-gold"
                  required
                  disabled={isEditing}
                >
                  {calendars.map((cal) => (
                    <option key={cal.id} value={cal.id}>
                      {cal.name}
                    </option>
                  ))}
                </select>
              </div>

              <div className="col-span-2">
                <label className="block text-sm font-medium text-hud-cream-soft mb-2">
                  Description
                </label>
                <textarea
                  value={formData.description}
                  onChange={(e) => setFormData({ ...formData, description: e.target.value })}
                  rows={2}
                  placeholder="Brief description of this appointment type"
                  className="w-full px-3 py-2 bg-hud-bg-card border border-hud-bg-elev rounded-lg text-white focus:outline-none focus:ring-2 focus:ring-hud-gold resize-none"
                />
              </div>
            </div>

            <div className="border-t border-hud-bg-elev pt-6">
              <h3 className="text-sm font-medium text-white mb-4">Duration & Scheduling</h3>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm text-hud-cream-dim mb-2">Duration</label>
                  <select
                    value={formData.duration_minutes}
                    onChange={(e) => setFormData({ ...formData, duration_minutes: parseInt(e.target.value) })}
                    className="w-full px-3 py-2 bg-hud-bg-card border border-hud-bg-elev rounded-lg text-white focus:outline-none focus:ring-2 focus:ring-hud-gold"
                  >
                    {durationOptions.map((d) => (
                      <option key={d} value={d}>
                        {d} minutes
                      </option>
                    ))}
                  </select>
                </div>

                <div>
                  <label className="block text-sm text-hud-cream-dim mb-2">Slot Interval</label>
                  <select
                    value={formData.slot_interval_minutes}
                    onChange={(e) => setFormData({ ...formData, slot_interval_minutes: parseInt(e.target.value) })}
                    className="w-full px-3 py-2 bg-hud-bg-card border border-hud-bg-elev rounded-lg text-white focus:outline-none focus:ring-2 focus:ring-hud-gold"
                  >
                    {intervalOptions.map((i) => (
                      <option key={i} value={i}>
                        {i} minutes
                      </option>
                    ))}
                  </select>
                </div>

                <div>
                  <label className="block text-sm text-hud-cream-dim mb-2">Buffer Before</label>
                  <input
                    type="number"
                    min="0"
                    value={formData.buffer_before_minutes}
                    onChange={(e) => setFormData({ ...formData, buffer_before_minutes: parseInt(e.target.value) || 0 })}
                    className="w-full px-3 py-2 bg-hud-bg-card border border-hud-bg-elev rounded-lg text-white focus:outline-none focus:ring-2 focus:ring-hud-gold"
                  />
                  <span className="text-xs text-hud-cream-mute">minutes</span>
                </div>

                <div>
                  <label className="block text-sm text-hud-cream-dim mb-2">Buffer After</label>
                  <input
                    type="number"
                    min="0"
                    value={formData.buffer_after_minutes}
                    onChange={(e) => setFormData({ ...formData, buffer_after_minutes: parseInt(e.target.value) || 0 })}
                    className="w-full px-3 py-2 bg-hud-bg-card border border-hud-bg-elev rounded-lg text-white focus:outline-none focus:ring-2 focus:ring-hud-gold"
                  />
                  <span className="text-xs text-hud-cream-mute">minutes</span>
                </div>

                <div>
                  <label className="block text-sm text-hud-cream-dim mb-2">Minimum Notice</label>
                  <input
                    type="number"
                    min="0"
                    value={formData.min_notice_minutes}
                    onChange={(e) => setFormData({ ...formData, min_notice_minutes: parseInt(e.target.value) || 0 })}
                    className="w-full px-3 py-2 bg-hud-bg-card border border-hud-bg-elev rounded-lg text-white focus:outline-none focus:ring-2 focus:ring-hud-gold"
                  />
                  <span className="text-xs text-hud-cream-mute">minutes ahead</span>
                </div>

                <div>
                  <label className="block text-sm text-hud-cream-dim mb-2">Booking Window</label>
                  <input
                    type="number"
                    min="1"
                    value={formData.booking_window_days}
                    onChange={(e) => setFormData({ ...formData, booking_window_days: parseInt(e.target.value) || 30 })}
                    className="w-full px-3 py-2 bg-hud-bg-card border border-hud-bg-elev rounded-lg text-white focus:outline-none focus:ring-2 focus:ring-hud-gold"
                  />
                  <span className="text-xs text-hud-cream-mute">days ahead</span>
                </div>

                <div>
                  <label className="block text-sm text-hud-cream-dim mb-2">Max Per Day</label>
                  <input
                    type="number"
                    min="0"
                    value={formData.max_per_day || ''}
                    onChange={(e) => setFormData({ ...formData, max_per_day: e.target.value ? parseInt(e.target.value) : null })}
                    placeholder="Unlimited"
                    className="w-full px-3 py-2 bg-hud-bg-card border border-hud-bg-elev rounded-lg text-white focus:outline-none focus:ring-2 focus:ring-hud-gold"
                  />
                  <span className="text-xs text-hud-cream-mute">leave empty for unlimited</span>
                </div>
              </div>
            </div>

            <div className="border-t border-hud-bg-elev pt-6">
              <h3 className="text-sm font-medium text-white mb-1">Reminders</h3>
              <p className="text-xs text-hud-cream-mute mb-3">
                Email the visitor before their appointment. Enter one or more times in hours,
                separated by commas — e.g. 24, 1 sends a reminder a day and an hour before. Leave empty for none.
              </p>
              <div className="flex items-center gap-2">
                <input
                  type="text"
                  inputMode="numeric"
                  value={reminderText}
                  onChange={(e) => setReminderText(e.target.value)}
                  placeholder="24, 1"
                  className="w-40 px-3 py-2 bg-hud-bg-card border border-hud-bg-elev rounded-lg text-white focus:outline-none focus:ring-2 focus:ring-hud-gold"
                />
                <span className="text-xs text-hud-cream-mute">hours before</span>
              </div>
              {reminderText.trim() && parseReminderHours(reminderText).length === 0 && (
                <p className="text-xs text-amber-400 mt-2">Enter whole numbers of hours (e.g. 24, 1), or clear the field to turn reminders off.</p>
              )}
            </div>

            <div className="border-t border-hud-bg-elev pt-6">
              <h3 className="text-sm font-medium text-white mb-4">Location</h3>
              <div className="grid grid-cols-5 gap-2 mb-4">
                {locationOptions.map((opt) => {
                  const Icon = opt.icon;
                  return (
                    <button
                      key={opt.value}
                      type="button"
                      onClick={() => setFormData({ ...formData, location_type: opt.value })}
                      className={`p-3 rounded-lg border-2 transition-all flex flex-col items-center gap-1 ${
                        formData.location_type === opt.value
                          ? 'border-hud-gold bg-hud-gold/10'
                          : 'border-hud-bg-elev bg-hud-bg-card hover:border-hud-cream-mute'
                      }`}
                    >
                      <Icon
                        className={`w-5 h-5 ${
                          formData.location_type === opt.value ? 'text-hud-gold-soft' : 'text-hud-cream-dim'
                        }`}
                      />
                      <span
                        className={`text-xs ${
                          formData.location_type === opt.value ? 'text-hud-gold-soft' : 'text-hud-cream-dim'
                        }`}
                      >
                        {opt.label}
                      </span>
                    </button>
                  );
                })}
              </div>

              {formData.location_type === 'phone' && (
                <div>
                  <label className="block text-sm text-hud-cream-dim mb-2">Phone Number</label>
                  <input
                    type="tel"
                    value={formData.location_value.phone_number}
                    onChange={(e) =>
                      setFormData({
                        ...formData,
                        location_value: { ...formData.location_value, phone_number: e.target.value },
                      })
                    }
                    placeholder="+1 (555) 123-4567"
                    className="w-full px-3 py-2 bg-hud-bg-card border border-hud-bg-elev rounded-lg text-white focus:outline-none focus:ring-2 focus:ring-hud-gold"
                  />
                </div>
              )}

              {formData.location_type === 'google_meet' && (
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={formData.generate_google_meet}
                    onChange={(e) => setFormData({ ...formData, generate_google_meet: e.target.checked })}
                    className="w-4 h-4 rounded border-hud-cream-mute bg-hud-bg-elev text-hud-gold focus:ring-hud-gold"
                  />
                  <span className="text-sm text-hud-cream-soft">Auto-generate Google Meet link</span>
                </label>
              )}

              {formData.location_type === 'zoom' && (
                <div>
                  <label className="block text-sm text-hud-cream-dim mb-2">Zoom Link</label>
                  <input
                    type="url"
                    value={formData.location_value.custom_link}
                    onChange={(e) =>
                      setFormData({
                        ...formData,
                        location_value: { ...formData.location_value, custom_link: e.target.value },
                      })
                    }
                    placeholder="https://zoom.us/j/..."
                    className="w-full px-3 py-2 bg-hud-bg-card border border-hud-bg-elev rounded-lg text-white focus:outline-none focus:ring-2 focus:ring-hud-gold"
                  />
                </div>
              )}

              {formData.location_type === 'in_person' && (
                <div>
                  <label className="block text-sm text-hud-cream-dim mb-2">Address</label>
                  <textarea
                    value={formData.location_value.address}
                    onChange={(e) =>
                      setFormData({
                        ...formData,
                        location_value: { ...formData.location_value, address: e.target.value },
                      })
                    }
                    rows={2}
                    placeholder="123 Main St, City, State ZIP"
                    className="w-full px-3 py-2 bg-hud-bg-card border border-hud-bg-elev rounded-lg text-white focus:outline-none focus:ring-2 focus:ring-hud-gold resize-none"
                  />
                </div>
              )}

              {formData.location_type === 'custom' && (
                <div className="space-y-3">
                  <div>
                    <label className="block text-sm text-hud-cream-dim mb-2">Link</label>
                    <input
                      type="url"
                      value={formData.location_value.custom_link}
                      onChange={(e) =>
                        setFormData({
                          ...formData,
                          location_value: { ...formData.location_value, custom_link: e.target.value },
                        })
                      }
                      placeholder="https://..."
                      className="w-full px-3 py-2 bg-hud-bg-card border border-hud-bg-elev rounded-lg text-white focus:outline-none focus:ring-2 focus:ring-hud-gold"
                    />
                  </div>
                  <div>
                    <label className="block text-sm text-hud-cream-dim mb-2">Instructions</label>
                    <textarea
                      value={formData.location_value.instructions}
                      onChange={(e) =>
                        setFormData({
                          ...formData,
                          location_value: { ...formData.location_value, instructions: e.target.value },
                        })
                      }
                      rows={2}
                      placeholder="Additional instructions for attendees"
                      className="w-full px-3 py-2 bg-hud-bg-card border border-hud-bg-elev rounded-lg text-white focus:outline-none focus:ring-2 focus:ring-hud-gold resize-none"
                    />
                  </div>
                </div>
              )}
            </div>

            <div className="border-t border-hud-bg-elev pt-6">
              <div className="flex items-center justify-between mb-4">
                <h3 className="text-sm font-medium text-white">Booking Questions</h3>
                <button
                  type="button"
                  onClick={handleAddQuestion}
                  className="text-hud-gold-soft hover:text-hud-gold-soft text-sm flex items-center gap-1"
                >
                  <Plus className="w-4 h-4" />
                  Add Question
                </button>
              </div>

              <div className="space-y-3">
                {questions.map((question, index) => {
                  const isDefault = ['name', 'email', 'phone'].includes(question.id);
                  return (
                    <div
                      key={question.id}
                      className="flex items-start gap-2 p-3 bg-hud-bg-card rounded-lg border border-hud-bg-elev"
                    >
                      <GripVertical className="w-4 h-4 text-hud-cream-mute mt-2 cursor-move" />
                      <div className="flex-1 space-y-2">
                        <input
                          type="text"
                          value={question.label}
                          onChange={(e) => handleUpdateQuestion(index, { label: e.target.value })}
                          placeholder="Question label"
                          disabled={isDefault}
                          className="w-full px-2 py-1 bg-hud-bg-elev border border-hud-cream-mute rounded text-white text-sm focus:outline-none focus:ring-1 focus:ring-hud-gold disabled:opacity-60"
                        />
                        <div className="flex items-center gap-3">
                          <select
                            value={question.type}
                            onChange={(e) =>
                              handleUpdateQuestion(index, {
                                type: e.target.value as AppointmentTypeQuestion['type'],
                              })
                            }
                            disabled={isDefault}
                            className="px-2 py-1 bg-hud-bg-elev border border-hud-cream-mute rounded text-white text-sm focus:outline-none focus:ring-1 focus:ring-hud-gold disabled:opacity-60"
                          >
                            <option value="text">Text</option>
                            <option value="textarea">Long Text</option>
                            <option value="select">Dropdown</option>
                            <option value="checkbox">Checkbox</option>
                          </select>
                          <label className="flex items-center gap-1 cursor-pointer">
                            <input
                              type="checkbox"
                              checked={question.required}
                              onChange={(e) => handleUpdateQuestion(index, { required: e.target.checked })}
                              disabled={isDefault && question.id !== 'phone'}
                              className="w-3 h-3 rounded border-hud-cream-mute bg-hud-bg-elev text-hud-gold focus:ring-hud-gold"
                            />
                            <span className="text-xs text-hud-cream-dim">Required</span>
                          </label>
                        </div>
                      </div>
                      {!isDefault && (
                        <button
                          type="button"
                          onClick={() => handleRemoveQuestion(index)}
                          className="p-1 text-hud-cream-dim hover:text-hud-plum"
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>

            {isEditing && (
              <div className="border-t border-hud-bg-elev pt-6">
                <label className="flex items-center gap-3 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={formData.active}
                    onChange={(e) => setFormData({ ...formData, active: e.target.checked })}
                    className="w-5 h-5 rounded border-hud-cream-mute bg-hud-bg-elev text-hud-gold focus:ring-hud-gold"
                  />
                  <div>
                    <span className="text-white font-medium">Active</span>
                    <p className="text-hud-cream-dim text-sm">
                      When disabled, this appointment type won't appear on the booking page
                    </p>
                  </div>
                </label>
              </div>
            )}
          </div>
        </form>

        <div className="px-6 py-4 border-t border-hud-bg-elev flex justify-end gap-3">
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2 text-hud-cream-soft hover:text-white transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={handleSubmit}
            disabled={saving}
            className="px-4 py-2 bg-gradient-to-r from-hud-gold to-hud-teal text-white rounded-lg font-medium hover:from-hud-gold-deep hover:to-hud-teal transition-all disabled:opacity-50"
          >
            {saving ? 'Saving...' : isEditing ? 'Save Changes' : 'Create Appointment Type'}
          </button>
        </div>
      </div>

      <ShareCalendarModal
        open={shareOpen}
        onClose={() => setShareOpen(false)}
        calendarName={
          calendars.find((c) => c.id === formData.calendar_id)?.name ||
          calendar?.name ||
          ''
        }
        calendarSlug={
          calendars.find((c) => c.id === formData.calendar_id)?.slug ||
          calendar?.slug ||
          ''
        }
        typeSlug={formData.slug}
      />
      </Portal>
    </>
  );
}
