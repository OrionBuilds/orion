import { useState, useEffect } from 'react';
import { getCommonTimezones, getDefaultSchedule } from '../../services/availabilityRules';
import type { AvailabilityRule, DaySchedule, TimeRange } from '../../types';
import { Plus, Trash2, Loader2, Check } from 'lucide-react';

interface AvailabilityEditorProps {
  availability: AvailabilityRule | null;
  onSave: (rules: DaySchedule, timezone: string) => Promise<void>;
  canEdit: boolean;
}

const DAYS = [
  { key: 'monday', label: 'Monday' },
  { key: 'tuesday', label: 'Tuesday' },
  { key: 'wednesday', label: 'Wednesday' },
  { key: 'thursday', label: 'Thursday' },
  { key: 'friday', label: 'Friday' },
  { key: 'saturday', label: 'Saturday' },
  { key: 'sunday', label: 'Sunday' },
] as const;

const TIME_OPTIONS = generateTimeOptions();

function generateTimeOptions(): string[] {
  const options: string[] = [];
  for (let h = 0; h < 24; h++) {
    for (let m = 0; m < 60; m += 15) {
      options.push(`${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}`);
    }
  }
  return options;
}

function formatTime(time: string): string {
  const [hours, minutes] = time.split(':').map(Number);
  const period = hours >= 12 ? 'PM' : 'AM';
  const displayHours = hours === 0 ? 12 : hours > 12 ? hours - 12 : hours;
  return `${displayHours}:${minutes.toString().padStart(2, '0')} ${period}`;
}

export function AvailabilityEditor({ availability, onSave, canEdit }: AvailabilityEditorProps) {
  const [timezone, setTimezone] = useState(availability?.timezone || 'America/New_York');
  const [schedule, setSchedule] = useState<DaySchedule>(
    (availability?.rules as DaySchedule) || getDefaultSchedule()
  );
  const [isSaving, setIsSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (availability) {
      setTimezone(availability.timezone);
      setSchedule(availability.rules as DaySchedule);
    }
  }, [availability]);

  const handleToggleDay = (day: string) => {
    if (!canEdit) return;
    const dayRanges = schedule[day as keyof DaySchedule] || [];
    if (dayRanges.length > 0) {
      setSchedule({ ...schedule, [day]: [] });
    } else {
      setSchedule({ ...schedule, [day]: [{ start: '09:00', end: '17:00' }] });
    }
  };

  const handleAddRange = (day: string) => {
    if (!canEdit) return;
    const dayRanges = schedule[day as keyof DaySchedule] || [];
    setSchedule({
      ...schedule,
      [day]: [...dayRanges, { start: '09:00', end: '17:00' }],
    });
  };

  const handleUpdateRange = (
    day: string,
    index: number,
    field: 'start' | 'end',
    value: string
  ) => {
    if (!canEdit) return;
    const dayRanges = [...(schedule[day as keyof DaySchedule] || [])];
    dayRanges[index] = { ...dayRanges[index], [field]: value };
    setSchedule({ ...schedule, [day]: dayRanges });
  };

  const handleRemoveRange = (day: string, index: number) => {
    if (!canEdit) return;
    const dayRanges = [...(schedule[day as keyof DaySchedule] || [])];
    dayRanges.splice(index, 1);
    setSchedule({ ...schedule, [day]: dayRanges });
  };

  const handleSave = async () => {
    try {
      setIsSaving(true);
      await onSave(schedule, timezone);
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } finally {
      setIsSaving(false);
    }
  };

  const timezones = getCommonTimezones();

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <label className="block text-sm font-medium text-hud-cream-soft mb-1.5">Timezone</label>
          <select
            value={timezone}
            onChange={(e) => setTimezone(e.target.value)}
            disabled={!canEdit}
            className="px-3 py-2 rounded-lg bg-hud-bg-card border border-hud-bg-elev text-white focus:outline-none focus:ring-2 focus:ring-hud-gold focus:border-transparent disabled:opacity-50"
          >
            {timezones.map((tz) => (
              <option key={tz.value} value={tz.value}>
                {tz.label}
              </option>
            ))}
          </select>
        </div>
        {canEdit && (
          <button
            onClick={handleSave}
            disabled={isSaving}
            className={`inline-flex items-center gap-2 px-4 py-2 rounded-lg font-medium transition-colors ${
              saved
                ? 'bg-green-500/20 text-green-400 border border-green-500/30'
                : 'bg-gradient-to-r from-hud-gold to-hud-teal text-white hover:from-hud-gold-deep hover:to-hud-teal'
            }`}
          >
            {isSaving ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : saved ? (
              <>
                <Check className="w-4 h-4" />
                Saved
              </>
            ) : (
              'Save Changes'
            )}
          </button>
        )}
      </div>

      <div className="space-y-2">
        {DAYS.map(({ key, label }) => {
          const dayRanges = schedule[key] || [];
          const isEnabled = dayRanges.length > 0;

          return (
            <div
              key={key}
              className={`p-4 rounded-lg border ${
                isEnabled
                  ? 'bg-hud-bg-card/50 border-hud-bg-elev'
                  : 'bg-hud-bg-card/30 border-hud-bg-elev/50'
              }`}
            >
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <label className="relative inline-flex items-center cursor-pointer">
                    <input
                      type="checkbox"
                      checked={isEnabled}
                      onChange={() => handleToggleDay(key)}
                      disabled={!canEdit}
                      className="sr-only peer"
                    />
                    <div className="w-9 h-5 bg-hud-bg-elev peer-focus:outline-none peer-focus:ring-2 peer-focus:ring-hud-gold rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-hud-cream-soft after:border after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:bg-hud-gold peer-disabled:opacity-50"></div>
                  </label>
                  <span className={`font-medium ${isEnabled ? 'text-white' : 'text-hud-cream-mute'}`}>
                    {label}
                  </span>
                </div>
                {isEnabled && canEdit && (
                  <button
                    onClick={() => handleAddRange(key)}
                    className="text-sm text-hud-gold-soft hover:text-hud-gold-soft"
                  >
                    <Plus className="w-4 h-4" />
                  </button>
                )}
              </div>

              {isEnabled && (
                <div className="mt-3 space-y-2">
                  {dayRanges.map((range, index) => (
                    <div key={index} className="flex items-center gap-2">
                      <select
                        value={range.start}
                        onChange={(e) => handleUpdateRange(key, index, 'start', e.target.value)}
                        disabled={!canEdit}
                        className="px-3 py-1.5 rounded bg-hud-bg-elev border border-hud-cream-mute text-white text-sm focus:outline-none focus:ring-1 focus:ring-hud-gold disabled:opacity-50"
                      >
                        {TIME_OPTIONS.map((time) => (
                          <option key={time} value={time}>
                            {formatTime(time)}
                          </option>
                        ))}
                      </select>
                      <span className="text-hud-cream-mute">to</span>
                      <select
                        value={range.end}
                        onChange={(e) => handleUpdateRange(key, index, 'end', e.target.value)}
                        disabled={!canEdit}
                        className="px-3 py-1.5 rounded bg-hud-bg-elev border border-hud-cream-mute text-white text-sm focus:outline-none focus:ring-1 focus:ring-hud-gold disabled:opacity-50"
                      >
                        {TIME_OPTIONS.map((time) => (
                          <option key={time} value={time}>
                            {formatTime(time)}
                          </option>
                        ))}
                      </select>
                      {canEdit && dayRanges.length > 1 && (
                        <button
                          onClick={() => handleRemoveRange(key, index)}
                          className="p-1 rounded hover:bg-hud-cream-mute text-hud-cream-dim hover:text-hud-plum"
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
