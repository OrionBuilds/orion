import { useState } from 'react';
import { useAuth } from '../../contexts/AuthContext';
import { updateCalendar } from '../../services/calendars';
import type { Calendar, AssignmentMode } from '../../types';
import { X, Loader2 } from 'lucide-react';
import { Portal } from '../shared/Portal';

interface CalendarSettingsModalProps {
  calendar: Calendar;
  onClose: () => void;
  onSuccess: () => void;
}

export function CalendarSettingsModal({
  calendar,
  onClose,
  onSuccess,
}: CalendarSettingsModalProps) {
  const { user: currentUser } = useAuth();
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [name, setName] = useState(calendar.name);
  const [assignmentMode, setAssignmentMode] = useState<AssignmentMode>(
    calendar.settings.assignment_mode
  );

  const handleSubmit = async () => {
    if (!currentUser) return;

    try {
      setIsLoading(true);
      setError(null);

      await updateCalendar(
        calendar.id,
        {
          name,
          settings: { assignment_mode: assignmentMode },
        },
        currentUser
      );

      onSuccess();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update calendar');
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <Portal><div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/60" onClick={onClose} />
      <div className="relative bg-hud-bg-mid rounded-xl border border-hud-bg-card w-full max-w-md shadow-2xl">
        <div className="flex items-center justify-between p-4 border-b border-hud-bg-card">
          <h2 className="text-lg font-semibold text-white">Calendar Settings</h2>
          <button
            onClick={onClose}
            className="p-1 rounded-lg hover:bg-hud-bg-card transition-colors"
          >
            <X className="w-5 h-5 text-hud-cream-dim" />
          </button>
        </div>

        <div className="p-4 space-y-4">
          {error && (
            <div className="p-3 rounded-lg bg-hud-plum/10 border border-hud-plum/20 text-hud-plum text-sm">
              {error}
            </div>
          )}

          <div>
            <label className="block text-sm font-medium text-hud-cream-soft mb-1.5">
              Calendar Name
            </label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="w-full px-3 py-2 rounded-lg bg-hud-bg-card border border-hud-bg-elev text-white placeholder-hud-cream-dim focus:outline-none focus:ring-2 focus:ring-hud-gold focus:border-transparent"
            />
          </div>

          {calendar.type === 'team' && (
            <div>
              <label className="block text-sm font-medium text-hud-cream-soft mb-1.5">
                Assignment Mode
              </label>
              <div className="space-y-2">
                <label
                  className={`flex items-start gap-3 p-3 rounded-lg border cursor-pointer transition-colors ${
                    assignmentMode === 'round_robin'
                      ? 'bg-hud-gold/10 border-hud-gold/50'
                      : 'bg-hud-bg-card border-hud-bg-elev hover:border-hud-cream-mute'
                  }`}
                >
                  <input
                    type="radio"
                    checked={assignmentMode === 'round_robin'}
                    onChange={() => setAssignmentMode('round_robin')}
                    className="mt-0.5 border-hud-cream-mute bg-hud-bg-card text-hud-gold focus:ring-hud-gold"
                  />
                  <div>
                    <p className="text-white font-medium">Weighted Round-Robin</p>
                    <p className="text-sm text-hud-cream-dim">
                      Distribute bookings evenly based on member weights
                    </p>
                  </div>
                </label>
                <label
                  className={`flex items-start gap-3 p-3 rounded-lg border cursor-pointer transition-colors ${
                    assignmentMode === 'priority'
                      ? 'bg-hud-gold/10 border-hud-gold/50'
                      : 'bg-hud-bg-card border-hud-bg-elev hover:border-hud-cream-mute'
                  }`}
                >
                  <input
                    type="radio"
                    checked={assignmentMode === 'priority'}
                    onChange={() => setAssignmentMode('priority')}
                    className="mt-0.5 border-hud-cream-mute bg-hud-bg-card text-hud-gold focus:ring-hud-gold"
                  />
                  <div>
                    <p className="text-white font-medium">Priority-Based</p>
                    <p className="text-sm text-hud-cream-dim">
                      Assign to highest priority member who is available
                    </p>
                  </div>
                </label>
              </div>
            </div>
          )}
        </div>

        <div className="flex items-center justify-end gap-3 p-4 border-t border-hud-bg-card">
          <button
            onClick={onClose}
            className="px-4 py-2 rounded-lg text-hud-cream-soft hover:bg-hud-bg-card transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={handleSubmit}
            disabled={isLoading || !name}
            className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-gradient-to-r from-hud-gold to-hud-teal text-white font-medium hover:from-hud-gold-deep hover:to-hud-teal disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            {isLoading && <Loader2 className="w-4 h-4 animate-spin" />}
            Save Changes
          </button>
        </div>
      </div>
    </div></Portal>
  );
}
