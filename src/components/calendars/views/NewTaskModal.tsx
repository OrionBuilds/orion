import { useState } from 'react';
import {
  X, Loader2, CheckSquare, Flag,
} from 'lucide-react';
import type { Calendar, TaskPriority } from '../../../types';
import { createCalendarTask } from '../../../services/calendarTasks';
import { useAuth } from '../../../contexts/AuthContext';
import { formatDateString } from '../../../utils/calendarViewUtils';
import { Portal } from '../../shared/Portal';

interface NewTaskModalProps {
  calendar: Calendar;
  calendars?: Calendar[];
  preselectedDate?: Date;
  onClose: () => void;
  onSuccess: () => void;
}

export function NewTaskModal({
  calendar: initialCalendar,
  calendars,
  preselectedDate,
  onClose,
  onSuccess,
}: NewTaskModalProps) {
  const { user: currentUser } = useAuth();
  const [selectedCalendarId, setSelectedCalendarId] = useState(initialCalendar.id);
  const calendar = calendars?.find(c => c.id === selectedCalendarId) || initialCalendar;
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const defaultDate = formatDateString(preselectedDate || new Date());
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [dueDate, setDueDate] = useState(defaultDate);
  const [dueTime, setDueTime] = useState('09:00');
  const [durationMinutes, setDurationMinutes] = useState(30);
  const [priority, setPriority] = useState<TaskPriority>('medium');

  const handleSubmit = async () => {
    if (!title.trim()) {
      setError('Title is required');
      return;
    }
    if (!currentUser) return;

    setIsSaving(true);
    setError(null);

    try {
      const dueUtc = new Date(`${dueDate}T${dueTime}`).toISOString();

      await createCalendarTask(
        calendar.org_id,
        {
          calendar_id: calendar.id,
          title: title.trim(),
          description: description.trim() || null,
          due_at_utc: dueUtc,
          duration_minutes: durationMinutes,
          priority,
        },
        currentUser
      );

      onSuccess();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create task');
    } finally {
      setIsSaving(false);
    }
  };

  const priorityOptions: { value: TaskPriority; label: string; color: string }[] = [
    { value: 'low', label: 'Low', color: 'text-hud-cream-dim' },
    { value: 'medium', label: 'Medium', color: 'text-hud-rust' },
    { value: 'high', label: 'High', color: 'text-hud-plum' },
  ];

  return (
    <Portal><div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />
      <div className="relative w-full max-w-md mx-4 bg-hud-bg-mid rounded-xl border border-hud-bg-elev shadow-2xl max-h-[90dvh] overflow-y-auto">
        <div className="flex items-center justify-between p-4 border-b border-hud-bg-card">
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 rounded-lg bg-hud-rust/20 flex items-center justify-center">
              <CheckSquare className="w-4 h-4 text-hud-rust" />
            </div>
            <h3 className="text-lg font-semibold text-white">New Task</h3>
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
              placeholder="Task name..."
              className="w-full px-3 py-2 rounded-lg bg-hud-bg-card border border-hud-bg-elev text-white placeholder-hud-cream-dim text-sm focus:outline-none focus:ring-2 focus:ring-hud-rust focus:border-transparent"
              autoFocus
            />
          </div>

          {calendars && calendars.length > 1 && (
            <div>
              <label className="block text-sm font-medium text-hud-cream-soft mb-1">Calendar</label>
              <select
                value={selectedCalendarId}
                onChange={e => setSelectedCalendarId(e.target.value)}
                className="w-full px-3 py-2 rounded-lg bg-hud-bg-card border border-hud-bg-elev text-white text-sm focus:outline-none focus:ring-2 focus:ring-hud-rust"
              >
                {calendars.map(c => (
                  <option key={c.id} value={c.id}>{c.name}</option>
                ))}
              </select>
            </div>
          )}

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-sm font-medium text-hud-cream-soft mb-1">Due Date</label>
              <input
                type="date"
                value={dueDate}
                onChange={e => setDueDate(e.target.value)}
                className="w-full px-3 py-2 rounded-lg bg-hud-bg-card border border-hud-bg-elev text-white text-sm focus:outline-none focus:ring-2 focus:ring-hud-rust"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-hud-cream-soft mb-1">Due Time</label>
              <input
                type="time"
                value={dueTime}
                onChange={e => setDueTime(e.target.value)}
                className="w-full px-3 py-2 rounded-lg bg-hud-bg-card border border-hud-bg-elev text-white text-sm focus:outline-none focus:ring-2 focus:ring-hud-rust"
              />
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium text-hud-cream-soft mb-1">Duration (minutes)</label>
            <select
              value={durationMinutes}
              onChange={e => setDurationMinutes(Number(e.target.value))}
              className="w-full px-3 py-2 rounded-lg bg-hud-bg-card border border-hud-bg-elev text-white text-sm focus:outline-none focus:ring-2 focus:ring-hud-rust"
            >
              <option value={15}>15 min</option>
              <option value={30}>30 min</option>
              <option value={45}>45 min</option>
              <option value={60}>1 hour</option>
              <option value={90}>1.5 hours</option>
              <option value={120}>2 hours</option>
            </select>
          </div>

          <div>
            <label className="block text-sm font-medium text-hud-cream-soft mb-1">
              <Flag className="w-3.5 h-3.5 inline mr-1" />
              Priority
            </label>
            <div className="flex gap-2">
              {priorityOptions.map(opt => (
                <button
                  key={opt.value}
                  onClick={() => setPriority(opt.value)}
                  className={`flex-1 px-3 py-2 rounded-lg text-sm font-medium transition-colors border ${
                    priority === opt.value
                      ? opt.value === 'high'
                        ? 'bg-hud-plum/20 text-hud-plum border-hud-plum/40'
                        : opt.value === 'medium'
                        ? 'bg-hud-rust/20 text-hud-rust border-hud-rust/40'
                        : 'bg-hud-cream-mute/30 text-hud-cream-soft border-hud-cream-mute/40'
                      : 'bg-hud-bg-card text-hud-cream-dim border-hud-bg-elev hover:bg-hud-bg-elev'
                  }`}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium text-hud-cream-soft mb-1">Description</label>
            <textarea
              value={description}
              onChange={e => setDescription(e.target.value)}
              rows={2}
              placeholder="Add description..."
              className="w-full px-3 py-2 rounded-lg bg-hud-bg-card border border-hud-bg-elev text-white placeholder-hud-cream-dim text-sm focus:outline-none focus:ring-2 focus:ring-hud-rust resize-none"
            />
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
            className="flex items-center gap-1.5 px-4 py-2 rounded-lg bg-hud-rust text-hud-bg-deep text-sm font-medium hover:bg-hud-rust transition-colors disabled:opacity-50"
          >
            {isSaving && <Loader2 className="w-4 h-4 animate-spin" />}
            Create Task
          </button>
        </div>
      </div>
    </div></Portal>
  );
}
