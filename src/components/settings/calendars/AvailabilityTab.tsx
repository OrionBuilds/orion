import { useState, useEffect } from 'react';
import { CalendarDays, Plus, Trash2, Copy, Clock, X, Check, Users, User, Ban } from 'lucide-react';
import { useAuth } from '../../../contexts/AuthContext';
import { getCalendars } from '../../../services/calendars';
import {
  getAvailabilityRule,
  upsertAvailabilityRule,
  getDefaultSchedule,
  getCommonTimezones,
} from '../../../services/availabilityRules';
import { getBlockedSlots, createBlockedSlot, deleteBlockedSlot } from '../../../services/blockedSlots';
import type { Calendar, DaySchedule, DateOverride, TimeRange, AvailabilityRule, BlockedSlot } from '../../../types';
import { canManageAvailability } from '../../../utils/calendarPermissions';
import { Portal } from '../../shared/Portal';

// Convert a wall-clock date+time in an IANA timezone to a UTC ISO string.
// Intl gives us the zone's offset at the guessed instant; subtract it to land on UTC.
function tzOffsetMs(utcDate: Date, tz: string): number {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const map: Record<string, string> = {};
  for (const p of dtf.formatToParts(utcDate)) map[p.type] = p.value;
  const asUTC = Date.UTC(+map.year, +map.month - 1, +map.day, +map.hour, +map.minute, +map.second);
  return asUTC - utcDate.getTime();
}
function wallTimeToUtcISO(dateStr: string, timeStr: string, tz: string): string {
  const [y, mo, d] = dateStr.split('-').map(Number);
  const [h, mi] = timeStr.split(':').map(Number);
  const guess = Date.UTC(y, mo - 1, d, h || 0, mi || 0);
  const offset = tzOffsetMs(new Date(guess), tz);
  return new Date(guess - offset).toISOString();
}
function formatBlockedRange(startUtc: string, endUtc: string, allDay: boolean, tz: string): string {
  const dateFmt = new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short', month: 'short', day: 'numeric' });
  const timeFmt = new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', minute: '2-digit' });
  const start = new Date(startUtc);
  if (allDay) return `${dateFmt.format(start)} · All day`;
  return `${dateFmt.format(start)} · ${timeFmt.format(start)}–${timeFmt.format(new Date(endUtc))}`;
}

const DAYS = [
  { key: 'monday' as const, label: 'Monday' },
  { key: 'tuesday' as const, label: 'Tuesday' },
  { key: 'wednesday' as const, label: 'Wednesday' },
  { key: 'thursday' as const, label: 'Thursday' },
  { key: 'friday' as const, label: 'Friday' },
  { key: 'saturday' as const, label: 'Saturday' },
  { key: 'sunday' as const, label: 'Sunday' },
];

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
  const displayHours = hours % 12 || 12;
  return `${displayHours}:${minutes.toString().padStart(2, '0')} ${period}`;
}

interface MemberScheduleSelector {
  userId: string | null;
  name: string;
}

export function AvailabilityTab() {
  const { user } = useAuth();
  const [calendars, setCalendars] = useState<Calendar[]>([]);
  const [selectedCalendarId, setSelectedCalendarId] = useState('');
  const [selectedMemberId, setSelectedMemberId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [rule, setRule] = useState<AvailabilityRule | null>(null);
  const [timezone, setTimezone] = useState('America/New_York');
  const [schedule, setSchedule] = useState<DaySchedule>(getDefaultSchedule());
  const [overrides, setOverrides] = useState<DateOverride[]>([]);
  const [showAddOverride, setShowAddOverride] = useState(false);
  const [newOverride, setNewOverride] = useState({ date: '', endDate: '', available: false, ranges: [] as TimeRange[] });
  const [hasChanges, setHasChanges] = useState(false);
  const [memberRuleStatus, setMemberRuleStatus] = useState<Record<string, boolean>>({});
  const [blockedSlots, setBlockedSlots] = useState<BlockedSlot[]>([]);
  const [showAddBlocked, setShowAddBlocked] = useState(false);
  const [savingBlocked, setSavingBlocked] = useState(false);
  const [newBlocked, setNewBlocked] = useState({ title: '', date: '', startTime: '09:00', endTime: '17:00', allDay: false });

  useEffect(() => {
    loadCalendars();
  }, [user]);

  useEffect(() => {
    if (selectedCalendarId) {
      const calendar = calendars.find((c) => c.id === selectedCalendarId);
      const isTeam = calendar?.type === 'team';
      if (!isTeam) {
        setSelectedMemberId(null);
      }
      loadAvailability(selectedCalendarId, isTeam ? selectedMemberId : null);
    }
  }, [selectedCalendarId, selectedMemberId]);

  useEffect(() => {
    if (selectedCalendarId) {
      checkMemberRuleStatuses();
    }
  }, [selectedCalendarId]);

  useEffect(() => {
    loadBlockedSlots();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedCalendarId, user]);

  const loadCalendars = async () => {
    if (!user?.organization_id) return;

    try {
      setLoading(true);
      const calendarsData = await getCalendars(user.organization_id);
      const manageableCalendars = calendarsData.filter((cal) => canManageAvailability(user, cal));
      setCalendars(manageableCalendars);
      if (manageableCalendars.length > 0 && !selectedCalendarId) {
        setSelectedCalendarId(manageableCalendars[0].id);
      }
    } catch (error) {
      console.error('Failed to load calendars:', error);
    } finally {
      setLoading(false);
    }
  };

  const checkMemberRuleStatuses = async () => {
    const calendar = calendars.find((c) => c.id === selectedCalendarId);
    if (!calendar?.members?.length) return;

    const statuses: Record<string, boolean> = {};
    for (const member of calendar.members) {
      const r = await getAvailabilityRule(selectedCalendarId, member.user_id);
      statuses[member.user_id] = !!r;
    }
    setMemberRuleStatus(statuses);
  };

  const loadAvailability = async (calendarId: string, userId: string | null) => {
    try {
      const ruleData = await getAvailabilityRule(calendarId, userId);
      if (ruleData) {
        setRule(ruleData);
        setTimezone(ruleData.timezone);
        setSchedule(ruleData.rules as DaySchedule);
        setOverrides((ruleData.overrides as DateOverride[]) || []);
      } else {
        setRule(null);
        setTimezone('America/New_York');
        setSchedule(getDefaultSchedule());
        setOverrides([]);
      }
      setHasChanges(false);
    } catch (error) {
      console.error('Failed to load availability:', error);
    }
  };

  const handleDayToggle = (day: keyof DaySchedule) => {
    const currentRanges = schedule[day];
    setSchedule({
      ...schedule,
      [day]: currentRanges.length > 0 ? [] : [{ start: '09:00', end: '17:00' }],
    });
    setHasChanges(true);
  };

  const handleAddTimeRange = (day: keyof DaySchedule) => {
    const currentRanges = schedule[day];
    const lastRange = currentRanges[currentRanges.length - 1];
    const newStart = lastRange ? lastRange.end : '09:00';
    const newEnd = '17:00';

    setSchedule({
      ...schedule,
      [day]: [...currentRanges, { start: newStart, end: newEnd }],
    });
    setHasChanges(true);
  };

  const handleRemoveTimeRange = (day: keyof DaySchedule, index: number) => {
    setSchedule({
      ...schedule,
      [day]: schedule[day].filter((_, i) => i !== index),
    });
    setHasChanges(true);
  };

  const handleTimeChange = (
    day: keyof DaySchedule,
    index: number,
    field: 'start' | 'end',
    value: string
  ) => {
    setSchedule({
      ...schedule,
      [day]: schedule[day].map((range, i) =>
        i === index ? { ...range, [field]: value } : range
      ),
    });
    setHasChanges(true);
  };

  // Copy Monday's hours to every day of the week (days without hours become available).
  const handleCopyToAllDays = () => {
    const mondaySchedule = schedule.monday;
    if (mondaySchedule.length === 0) return;
    const copy = () => mondaySchedule.map((range) => ({ ...range }));
    setSchedule({
      ...schedule,
      tuesday: copy(),
      wednesday: copy(),
      thursday: copy(),
      friday: copy(),
      saturday: copy(),
      sunday: copy(),
    });
    setHasChanges(true);
  };

  // Expand [date .. endDate] into one calendar-date string per day, inclusive.
  // The engine matches overrides by exact date, so a range becomes N per-day rows.
  const datesInRange = (start: string, end: string): string[] => {
    const out: string[] = [];
    const d = new Date(start + 'T00:00:00');
    const last = new Date(end + 'T00:00:00');
    if (isNaN(d.getTime()) || isNaN(last.getTime()) || last < d) return [start];
    // Cap at ~1 year of days as a runaway guard.
    for (let i = 0; i < 366 && d <= last; i++) {
      out.push(d.toISOString().slice(0, 10));
      d.setDate(d.getDate() + 1);
    }
    return out;
  };

  const handleAddOverride = () => {
    if (!newOverride.date) return;

    const dates =
      newOverride.endDate && newOverride.endDate >= newOverride.date
        ? datesInRange(newOverride.date, newOverride.endDate)
        : [newOverride.date];

    const newRows: DateOverride[] = dates.map((date) => ({
      date,
      available: newOverride.available,
      ranges: newOverride.available ? newOverride.ranges : undefined,
    }));

    const newDateSet = new Set(dates);
    setOverrides([...overrides.filter((o) => !newDateSet.has(o.date)), ...newRows]);
    setNewOverride({ date: '', endDate: '', available: false, ranges: [] });
    setShowAddOverride(false);
    setHasChanges(true);
  };

  const handleRemoveOverride = (date: string) => {
    setOverrides(overrides.filter((o) => o.date !== date));
    setHasChanges(true);
  };

  const loadBlockedSlots = async () => {
    if (!user || !selectedCalendarId) {
      setBlockedSlots([]);
      return;
    }
    try {
      const slots = await getBlockedSlots(user.organization_id, { calendarId: selectedCalendarId });
      setBlockedSlots(slots);
    } catch {
      setBlockedSlots([]);
    }
  };

  const handleAddBlocked = async () => {
    if (!user || !selectedCalendarId || !newBlocked.date || !newBlocked.title.trim()) return;
    setSavingBlocked(true);
    try {
      const startUtc = newBlocked.allDay
        ? wallTimeToUtcISO(newBlocked.date, '00:00', timezone)
        : wallTimeToUtcISO(newBlocked.date, newBlocked.startTime, timezone);
      // All-day blocks span to the start of the next day; timed blocks use the end time.
      const nextDay = new Date(newBlocked.date + 'T00:00:00');
      nextDay.setDate(nextDay.getDate() + 1);
      const endUtc = newBlocked.allDay
        ? wallTimeToUtcISO(nextDay.toISOString().slice(0, 10), '00:00', timezone)
        : wallTimeToUtcISO(newBlocked.date, newBlocked.endTime, timezone);

      await createBlockedSlot(
        {
          calendar_id: selectedCalendarId,
          user_id: selectedMemberId || null,
          title: newBlocked.title.trim(),
          start_at_utc: startUtc,
          end_at_utc: endUtc,
          all_day: newBlocked.allDay,
        },
        user
      );
      setNewBlocked({ title: '', date: '', startTime: '09:00', endTime: '17:00', allDay: false });
      setShowAddBlocked(false);
      await loadBlockedSlots();
    } catch (err) {
      console.error('Failed to add blocked time:', err);
    } finally {
      setSavingBlocked(false);
    }
  };

  const handleRemoveBlocked = async (id: string) => {
    if (!user) return;
    try {
      await deleteBlockedSlot(id, user);
      setBlockedSlots((prev) => prev.filter((b) => b.id !== id));
    } catch (err) {
      console.error('Failed to remove blocked time:', err);
    }
  };

  const handleSave = async () => {
    if (!user || !selectedCalendarId) return;

    setSaving(true);
    try {
      await upsertAvailabilityRule(user.organization_id, {
        calendar_id: selectedCalendarId,
        user_id: selectedMemberId || null,
        timezone,
        rules: schedule,
        overrides,
      });
      setHasChanges(false);

      if (selectedMemberId) {
        setMemberRuleStatus((prev) => ({ ...prev, [selectedMemberId]: true }));
      }
    } catch (error) {
      console.error('Failed to save availability:', error);
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <div className="w-8 h-8 border-2 border-hud-gold border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  if (calendars.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-16 text-center">
        <div className="w-16 h-16 bg-hud-bg-card rounded-full flex items-center justify-center mb-4">
          <CalendarDays className="w-8 h-8 text-hud-cream-mute" />
        </div>
        <h3 className="text-lg font-medium text-white mb-2">No calendars to manage</h3>
        <p className="text-hud-cream-dim max-w-md">
          You don't have permission to manage availability for any calendars.
        </p>
      </div>
    );
  }

  const selectedCalendar = calendars.find((c) => c.id === selectedCalendarId);
  const isTeamCalendar = selectedCalendar?.type === 'team';
  const isCollective = selectedCalendar?.settings?.assignment_mode === 'collective';
  const members = selectedCalendar?.members || [];

  const memberScheduleOptions: MemberScheduleSelector[] = [
    { userId: null, name: isCollective ? 'Default (fallback schedule)' : 'Calendar Schedule' },
    ...members.map((m) => ({
      userId: m.user_id,
      name: m.user?.name || `Member ${m.user_id.slice(0, 6)}`,
    })),
  ];

  const scheduleSectionTitle = selectedMemberId
    ? `${memberScheduleOptions.find((o) => o.userId === selectedMemberId)?.name || 'Member'} Schedule`
    : isTeamCalendar
    ? isCollective
      ? 'Default Schedule (fallback if no individual schedule set)'
      : 'Team Schedule'
    : 'Weekly Schedule';

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div className="flex items-center gap-3 flex-wrap">
          <select
            value={selectedCalendarId}
            onChange={(e) => {
              setSelectedCalendarId(e.target.value);
              setSelectedMemberId(null);
            }}
            className="px-4 py-2 bg-hud-bg-card border border-hud-bg-elev rounded-lg text-white focus:outline-none focus:ring-2 focus:ring-hud-gold"
          >
            {calendars.map((cal) => (
              <option key={cal.id} value={cal.id}>
                {cal.name}
              </option>
            ))}
          </select>

          {selectedCalendar && (
            <span className="text-sm text-hud-cream-dim flex items-center gap-1">
              {selectedCalendar.type === 'user' ? (
                <><User className="w-3.5 h-3.5" /> User Calendar</>
              ) : (
                <><Users className="w-3.5 h-3.5" /> Team Calendar{isCollective ? ' · Collective' : ''}</>
              )}
            </span>
          )}
        </div>

        {hasChanges && (
          <button
            onClick={handleSave}
            disabled={saving}
            className="px-4 py-2 bg-gradient-to-r from-hud-gold to-hud-teal text-white rounded-lg font-medium hover:from-hud-gold-deep hover:to-hud-teal transition-all disabled:opacity-50 flex items-center gap-2"
          >
            {saving ? (
              <>
                <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
                Saving...
              </>
            ) : (
              <>
                <Check className="w-4 h-4" />
                Save Changes
              </>
            )}
          </button>
        )}
      </div>

      {isTeamCalendar && members.length > 0 && (
        <div className="bg-hud-bg-card/50 rounded-xl border border-hud-bg-elev p-4">
          <div className="flex items-center gap-2 mb-3">
            <Users className="w-4 h-4 text-hud-cream-dim" />
            <h3 className="text-sm font-medium text-white">
              {isCollective ? 'Per-Member Schedules' : 'Member Schedules'}
            </h3>
            {isCollective && (
              <span className="text-xs text-hud-rust bg-hud-rust/10 border border-hud-rust/20 px-2 py-0.5 rounded-full ml-auto">
                Availability is intersected — all must be free
              </span>
            )}
          </div>

          <p className="text-xs text-hud-cream-dim mb-3">
            {isCollective
              ? 'Set individual schedules for each member. A booking slot only appears when every active member is available.'
              : 'Optionally set per-member schedules. Members without individual schedules use the team calendar schedule.'}
          </p>

          <div className="flex flex-wrap gap-2">
            <button
              onClick={() => setSelectedMemberId(null)}
              className={`flex items-center gap-2 px-3 py-1.5 rounded-lg text-sm font-medium transition-all border ${
                selectedMemberId === null
                  ? 'bg-hud-gold/20 border-hud-gold text-hud-gold-soft'
                  : 'bg-hud-bg-elev border-hud-cream-mute text-hud-cream-soft hover:border-hud-cream-mute'
              }`}
            >
              <CalendarDays className="w-3.5 h-3.5" />
              {isCollective ? 'Default' : 'Team Default'}
            </button>

            {members.map((member) => {
              const hasRule = memberRuleStatus[member.user_id];
              const isSelected = selectedMemberId === member.user_id;
              return (
                <button
                  key={member.user_id}
                  onClick={() => setSelectedMemberId(member.user_id)}
                  className={`flex items-center gap-2 px-3 py-1.5 rounded-lg text-sm font-medium transition-all border ${
                    isSelected
                      ? 'bg-hud-gold/20 border-hud-gold text-hud-gold-soft'
                      : 'bg-hud-bg-elev border-hud-cream-mute text-hud-cream-soft hover:border-hud-cream-mute'
                  }`}
                >
                  <div className="w-5 h-5 rounded-full bg-hud-cream-mute flex items-center justify-center text-xs text-white shrink-0">
                    {(member.user?.name || 'U').charAt(0).toUpperCase()}
                  </div>
                  <span>{member.user?.name || 'Member'}</span>
                  {hasRule && !isSelected && (
                    <span className="w-1.5 h-1.5 rounded-full bg-hud-emerald shrink-0" />
                  )}
                </button>
              );
            })}
          </div>
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="lg:col-span-2 space-y-4">
          <div className="bg-hud-bg-card/50 rounded-xl border border-hud-bg-elev p-4">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-white font-medium">{scheduleSectionTitle}</h3>
              <div className="flex items-center gap-3">
                <select
                  value={timezone}
                  onChange={(e) => {
                    setTimezone(e.target.value);
                    setHasChanges(true);
                  }}
                  className="px-3 py-1.5 bg-hud-bg-elev border border-hud-cream-mute rounded text-white text-sm focus:outline-none focus:ring-1 focus:ring-hud-gold"
                >
                  {getCommonTimezones().map((tz) => (
                    <option key={tz.value} value={tz.value}>
                      {tz.label}
                    </option>
                  ))}
                </select>
                <button
                  onClick={handleCopyToAllDays}
                  disabled={schedule.monday.length === 0}
                  title="Copy Monday's hours to every day of the week"
                  className="text-hud-gold-soft hover:text-hud-gold-soft text-sm flex items-center gap-1 whitespace-nowrap shrink-0 disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  <Copy className="w-3 h-3" />
                  Copy to all
                </button>
              </div>
            </div>

            <div className="space-y-3">
              {DAYS.map((day) => {
                const dayRanges = schedule[day.key];
                const isAvailable = dayRanges.length > 0;

                return (
                  <div key={day.key} className="flex items-start gap-4 py-2 border-b border-hud-bg-elev/50 last:border-0">
                    <div className="w-24 pt-2">
                      <label className="flex items-center gap-2 cursor-pointer">
                        <input
                          type="checkbox"
                          checked={isAvailable}
                          onChange={() => handleDayToggle(day.key)}
                          className="w-4 h-4 rounded border-hud-cream-mute bg-hud-bg-elev text-hud-gold focus:ring-hud-gold"
                        />
                        <span className={`text-sm font-medium ${isAvailable ? 'text-white' : 'text-hud-cream-mute'}`}>
                          {day.label}
                        </span>
                      </label>
                    </div>

                    <div className="flex-1">
                      {!isAvailable ? (
                        <span className="text-hud-cream-mute text-sm pt-2 block">Unavailable</span>
                      ) : (
                        <div className="space-y-2">
                          {dayRanges.map((range, index) => (
                            <div key={index} className="flex items-center gap-2">
                              <select
                                value={range.start}
                                onChange={(e) => handleTimeChange(day.key, index, 'start', e.target.value)}
                                className="px-2 py-1.5 bg-hud-bg-elev border border-hud-cream-mute rounded text-white text-sm focus:outline-none focus:ring-1 focus:ring-hud-gold"
                              >
                                {TIME_OPTIONS.map((time) => (
                                  <option key={time} value={time}>
                                    {formatTime(time)}
                                  </option>
                                ))}
                              </select>
                              <span className="text-hud-cream-dim">to</span>
                              <select
                                value={range.end}
                                onChange={(e) => handleTimeChange(day.key, index, 'end', e.target.value)}
                                className="px-2 py-1.5 bg-hud-bg-elev border border-hud-cream-mute rounded text-white text-sm focus:outline-none focus:ring-1 focus:ring-hud-gold"
                              >
                                {TIME_OPTIONS.map((time) => (
                                  <option key={time} value={time}>
                                    {formatTime(time)}
                                  </option>
                                ))}
                              </select>
                              <button
                                onClick={() => handleRemoveTimeRange(day.key, index)}
                                className="p-1 text-hud-cream-dim hover:text-hud-plum"
                              >
                                <Trash2 className="w-4 h-4" />
                              </button>
                            </div>
                          ))}
                          <button
                            onClick={() => handleAddTimeRange(day.key)}
                            className="text-hud-gold-soft hover:text-hud-gold-soft text-sm flex items-center gap-1"
                          >
                            <Plus className="w-3 h-3" />
                            Add hours
                          </button>
                        </div>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>

        <div className="space-y-4">
          <div className="bg-hud-bg-card/50 rounded-xl border border-hud-bg-elev p-4">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-white font-medium">Date Overrides</h3>
              <button
                onClick={() => setShowAddOverride(true)}
                className="text-hud-gold-soft hover:text-hud-gold-soft text-sm flex items-center gap-1"
              >
                <Plus className="w-4 h-4" />
                Add
              </button>
            </div>

            {overrides.length === 0 ? (
              <p className="text-hud-cream-mute text-sm">No date overrides configured</p>
            ) : (
              <div className="space-y-2">
                {overrides
                  .sort((a, b) => a.date.localeCompare(b.date))
                  .map((override) => (
                    <div
                      key={override.date}
                      className="flex items-center justify-between p-2 bg-hud-bg-elev/50 rounded"
                    >
                      <div>
                        <span className="text-white text-sm">
                          {new Date(override.date + 'T00:00:00').toLocaleDateString('en-US', {
                            weekday: 'short',
                            month: 'short',
                            day: 'numeric',
                          })}
                        </span>
                        <span
                          className={`ml-2 text-xs px-1.5 py-0.5 rounded ${
                            override.available
                              ? 'bg-hud-emerald/20 text-hud-emerald'
                              : 'bg-hud-plum/20 text-hud-plum'
                          }`}
                        >
                          {override.available ? 'Custom Hours' : 'Closed'}
                        </span>
                      </div>
                      <button
                        onClick={() => handleRemoveOverride(override.date)}
                        className="p-1 text-hud-cream-dim hover:text-hud-plum"
                      >
                        <Trash2 className="w-3 h-3" />
                      </button>
                    </div>
                  ))}
              </div>
            )}
          </div>

          <div className="bg-hud-bg-card/50 rounded-xl border border-hud-bg-elev p-4">
            <div className="flex items-center justify-between mb-1">
              <h3 className="text-white font-medium flex items-center gap-2">
                <Ban className="w-4 h-4 text-hud-plum" /> Blocked Time
              </h3>
              <button
                onClick={() => setShowAddBlocked(true)}
                className="text-hud-gold-soft hover:text-hud-gold-soft text-sm flex items-center gap-1"
              >
                <Plus className="w-4 h-4" />
                Add
              </button>
            </div>
            <p className="text-xs text-hud-cream-mute mb-3">
              One-off times this calendar is unavailable (holidays, PTO, meetings). Removed from bookable slots immediately.
            </p>

            {blockedSlots.length === 0 ? (
              <p className="text-hud-cream-mute text-sm">No blocked time</p>
            ) : (
              <div className="space-y-2">
                {blockedSlots.map((b) => (
                  <div key={b.id} className="flex items-center justify-between p-2 bg-hud-bg-elev/50 rounded">
                    <div className="min-w-0">
                      <span className="text-white text-sm block truncate">{b.title}</span>
                      <span className="text-xs text-hud-cream-mute">
                        {formatBlockedRange(b.start_at_utc, b.end_at_utc, b.all_day, timezone)}
                      </span>
                    </div>
                    <button
                      onClick={() => handleRemoveBlocked(b.id)}
                      className="p-1 text-hud-cream-dim hover:text-hud-plum flex-shrink-0"
                      aria-label="Remove blocked time"
                    >
                      <Trash2 className="w-3 h-3" />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>

          {!hasChanges && (
            <div className="bg-hud-bg-card/50 rounded-xl border border-hud-bg-elev p-4">
              <p className="text-xs text-hud-cream-mute">
                {isTeamCalendar && isCollective
                  ? 'For collective calendars, set individual schedules per member. Slots appear only when all active members are free simultaneously.'
                  : isTeamCalendar
                  ? 'Members without individual schedules inherit this team schedule.'
                  : 'Changes are applied immediately after saving.'}
              </p>
            </div>
          )}
        </div>
      </div>

      {showAddOverride && (
        <>
          <Portal><div className="fixed inset-0 bg-black/50 z-50" onClick={() => setShowAddOverride(false)} /></Portal>
          <Portal><div className="fixed inset-0 flex items-center justify-center z-50 p-4">
            <div
              className="bg-hud-bg-mid rounded-xl border border-hud-bg-elev w-full max-w-md"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="flex items-center justify-between px-6 py-4 border-b border-hud-bg-elev">
                <h2 className="text-lg font-semibold text-white">Add Date Override</h2>
                <button
                  onClick={() => setShowAddOverride(false)}
                  className="p-1 text-hud-cream-dim hover:text-white rounded"
                >
                  <X className="w-5 h-5" />
                </button>
              </div>

              <div className="p-6 space-y-4">
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block text-sm font-medium text-hud-cream-soft mb-2">Start date</label>
                    <input
                      type="date"
                      value={newOverride.date}
                      onChange={(e) => setNewOverride({ ...newOverride, date: e.target.value })}
                      min={new Date().toISOString().split('T')[0]}
                      className="w-full px-3 py-2 bg-hud-bg-card border border-hud-bg-elev rounded-lg text-white focus:outline-none focus:ring-2 focus:ring-hud-gold"
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-hud-cream-soft mb-2">
                      End date <span className="text-hud-cream-mute font-normal">(optional)</span>
                    </label>
                    <input
                      type="date"
                      value={newOverride.endDate}
                      onChange={(e) => setNewOverride({ ...newOverride, endDate: e.target.value })}
                      min={newOverride.date || new Date().toISOString().split('T')[0]}
                      className="w-full px-3 py-2 bg-hud-bg-card border border-hud-bg-elev rounded-lg text-white focus:outline-none focus:ring-2 focus:ring-hud-gold"
                    />
                  </div>
                </div>
                {newOverride.endDate && newOverride.endDate >= newOverride.date && newOverride.date && (
                  <p className="text-xs text-hud-cream-mute -mt-1">
                    Applies to every day from {newOverride.date} through {newOverride.endDate}.
                  </p>
                )}

                <div>
                  <label className="block text-sm font-medium text-hud-cream-soft mb-2">Type</label>
                  <div className="flex gap-3">
                    <button
                      type="button"
                      onClick={() => setNewOverride({ ...newOverride, available: false, ranges: [] })}
                      className={`flex-1 p-3 rounded-lg border-2 transition-all ${
                        !newOverride.available
                          ? 'border-hud-plum bg-hud-plum/10'
                          : 'border-hud-bg-elev bg-hud-bg-card'
                      }`}
                    >
                      <X className={`w-5 h-5 mx-auto mb-1 ${!newOverride.available ? 'text-hud-plum' : 'text-hud-cream-dim'}`} />
                      <span className={`text-sm ${!newOverride.available ? 'text-hud-plum' : 'text-hud-cream-dim'}`}>
                        Closed
                      </span>
                    </button>
                    <button
                      type="button"
                      onClick={() =>
                        setNewOverride({
                          ...newOverride,
                          available: true,
                          ranges: [{ start: '09:00', end: '17:00' }],
                        })
                      }
                      className={`flex-1 p-3 rounded-lg border-2 transition-all ${
                        newOverride.available
                          ? 'border-hud-gold bg-hud-gold/10'
                          : 'border-hud-bg-elev bg-hud-bg-card'
                      }`}
                    >
                      <Clock className={`w-5 h-5 mx-auto mb-1 ${newOverride.available ? 'text-hud-gold-soft' : 'text-hud-cream-dim'}`} />
                      <span className={`text-sm ${newOverride.available ? 'text-hud-gold-soft' : 'text-hud-cream-dim'}`}>
                        Custom Hours
                      </span>
                    </button>
                  </div>
                </div>

                {newOverride.available && (
                  <div>
                    <label className="block text-sm font-medium text-hud-cream-soft mb-2">Hours</label>
                    {newOverride.ranges.map((range, index) => (
                      <div key={index} className="flex items-center gap-2 mb-2">
                        <select
                          value={range.start}
                          onChange={(e) => {
                            const newRanges = [...newOverride.ranges];
                            newRanges[index] = { ...newRanges[index], start: e.target.value };
                            setNewOverride({ ...newOverride, ranges: newRanges });
                          }}
                          className="flex-1 px-2 py-1.5 bg-hud-bg-elev border border-hud-cream-mute rounded text-white text-sm"
                        >
                          {TIME_OPTIONS.map((time) => (
                            <option key={time} value={time}>
                              {formatTime(time)}
                            </option>
                          ))}
                        </select>
                        <span className="text-hud-cream-dim">to</span>
                        <select
                          value={range.end}
                          onChange={(e) => {
                            const newRanges = [...newOverride.ranges];
                            newRanges[index] = { ...newRanges[index], end: e.target.value };
                            setNewOverride({ ...newOverride, ranges: newRanges });
                          }}
                          className="flex-1 px-2 py-1.5 bg-hud-bg-elev border border-hud-cream-mute rounded text-white text-sm"
                        >
                          {TIME_OPTIONS.map((time) => (
                            <option key={time} value={time}>
                              {formatTime(time)}
                            </option>
                          ))}
                        </select>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              <div className="px-6 py-4 border-t border-hud-bg-elev flex justify-end gap-3">
                <button
                  onClick={() => setShowAddOverride(false)}
                  className="px-4 py-2 text-hud-cream-soft hover:text-white transition-colors"
                >
                  Cancel
                </button>
                <button
                  onClick={handleAddOverride}
                  disabled={!newOverride.date}
                  className="px-4 py-2 bg-gradient-to-r from-hud-gold to-hud-teal text-white rounded-lg font-medium hover:from-hud-gold-deep hover:to-hud-teal transition-all disabled:opacity-50"
                >
                  Add Override
                </button>
              </div>
            </div>
          </div></Portal>
        </>
      )}

      {showAddBlocked && (
        <>
          <Portal><div className="fixed inset-0 bg-black/50 z-50" onClick={() => setShowAddBlocked(false)} /></Portal>
          <Portal><div className="fixed inset-0 flex items-center justify-center z-50 p-4">
            <div
              className="bg-hud-bg-mid rounded-xl border border-hud-bg-elev w-full max-w-md"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="flex items-center justify-between px-6 py-4 border-b border-hud-bg-elev">
                <h2 className="text-lg font-semibold text-white">Block Time</h2>
                <button
                  onClick={() => setShowAddBlocked(false)}
                  className="p-1 text-hud-cream-dim hover:text-white rounded"
                >
                  <X className="w-5 h-5" />
                </button>
              </div>

              <div className="p-6 space-y-4">
                <div>
                  <label className="block text-sm font-medium text-hud-cream-soft mb-2">Title</label>
                  <input
                    type="text"
                    value={newBlocked.title}
                    onChange={(e) => setNewBlocked({ ...newBlocked, title: e.target.value })}
                    placeholder="e.g. Holiday, PTO, Team offsite"
                    className="w-full px-3 py-2 bg-hud-bg-card border border-hud-bg-elev rounded-lg text-white focus:outline-none focus:ring-2 focus:ring-hud-gold"
                  />
                </div>

                <div>
                  <label className="block text-sm font-medium text-hud-cream-soft mb-2">Date</label>
                  <input
                    type="date"
                    value={newBlocked.date}
                    onChange={(e) => setNewBlocked({ ...newBlocked, date: e.target.value })}
                    min={new Date().toISOString().split('T')[0]}
                    className="w-full px-3 py-2 bg-hud-bg-card border border-hud-bg-elev rounded-lg text-white focus:outline-none focus:ring-2 focus:ring-hud-gold"
                  />
                </div>

                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={newBlocked.allDay}
                    onChange={(e) => setNewBlocked({ ...newBlocked, allDay: e.target.checked })}
                    className="w-4 h-4 rounded border-hud-cream-mute bg-hud-bg-elev text-hud-gold focus:ring-hud-gold"
                  />
                  <span className="text-sm text-hud-cream-dim">All day</span>
                </label>

                {!newBlocked.allDay && (
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="block text-sm font-medium text-hud-cream-soft mb-2">From</label>
                      <select
                        value={newBlocked.startTime}
                        onChange={(e) => setNewBlocked({ ...newBlocked, startTime: e.target.value })}
                        className="w-full px-3 py-2 bg-hud-bg-card border border-hud-bg-elev rounded-lg text-white focus:outline-none focus:ring-2 focus:ring-hud-gold"
                      >
                        {TIME_OPTIONS.map((t) => (
                          <option key={t} value={t}>{formatTime(t)}</option>
                        ))}
                      </select>
                    </div>
                    <div>
                      <label className="block text-sm font-medium text-hud-cream-soft mb-2">To</label>
                      <select
                        value={newBlocked.endTime}
                        onChange={(e) => setNewBlocked({ ...newBlocked, endTime: e.target.value })}
                        className="w-full px-3 py-2 bg-hud-bg-card border border-hud-bg-elev rounded-lg text-white focus:outline-none focus:ring-2 focus:ring-hud-gold"
                      >
                        {TIME_OPTIONS.map((t) => (
                          <option key={t} value={t}>{formatTime(t)}</option>
                        ))}
                      </select>
                    </div>
                  </div>
                )}
                <p className="text-xs text-hud-cream-mute">Times are in the calendar timezone ({timezone}).</p>
              </div>

              <div className="flex items-center justify-end gap-2 px-6 py-4 border-t border-hud-bg-elev">
                <button
                  onClick={() => setShowAddBlocked(false)}
                  className="px-4 py-2 text-hud-cream-dim hover:text-white transition-colors"
                >
                  Cancel
                </button>
                <button
                  onClick={handleAddBlocked}
                  disabled={!newBlocked.date || !newBlocked.title.trim() || savingBlocked || (!newBlocked.allDay && newBlocked.endTime <= newBlocked.startTime)}
                  className="px-4 py-2 bg-gradient-to-r from-hud-gold to-hud-teal text-white rounded-lg font-medium hover:from-hud-gold-deep hover:to-hud-teal transition-all disabled:opacity-50"
                >
                  {savingBlocked ? 'Blocking…' : 'Block Time'}
                </button>
              </div>
            </div>
          </div></Portal>
        </>
      )}
    </div>
  );
}
