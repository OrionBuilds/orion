import { supabase } from '../lib/supabase';
import type { AvailabilityRule, DaySchedule, DateOverride, TimeRange } from '../types';

export interface CreateAvailabilityRuleData {
  calendar_id: string;
  user_id?: string | null;
  timezone: string;
  rules: DaySchedule;
  overrides?: DateOverride[];
}

export interface UpdateAvailabilityRuleData {
  timezone?: string;
  rules?: DaySchedule;
  overrides?: DateOverride[];
}

export async function getAvailabilityRule(
  calendarId: string,
  userId?: string | null
): Promise<AvailabilityRule | null> {
  let query = supabase
    .from('availability_rules')
    .select('*')
    .eq('calendar_id', calendarId);

  if (userId) {
    query = query.eq('user_id', userId);
  } else {
    query = query.is('user_id', null);
  }

  const { data, error } = await query.maybeSingle();
  if (error) throw error;
  return data;
}

export async function getCalendarAvailabilityRules(
  calendarId: string
): Promise<AvailabilityRule[]> {
  const { data, error } = await supabase
    .from('availability_rules')
    .select('*')
    .eq('calendar_id', calendarId);

  if (error) throw error;
  return data || [];
}

export async function createAvailabilityRule(
  organizationId: string,
  ruleData: CreateAvailabilityRuleData
): Promise<AvailabilityRule> {
  const { data, error } = await supabase
    .from('availability_rules')
    .insert({
      org_id: organizationId,
      calendar_id: ruleData.calendar_id,
      user_id: ruleData.user_id || null,
      timezone: ruleData.timezone,
      rules: ruleData.rules,
      overrides: ruleData.overrides || [],
    })
    .select()
    .single();

  if (error) throw error;
  return data;
}

export async function updateAvailabilityRule(
  id: string,
  updates: UpdateAvailabilityRuleData
): Promise<AvailabilityRule> {
  const { data, error } = await supabase
    .from('availability_rules')
    .update(updates)
    .eq('id', id)
    .select()
    .single();

  if (error) throw error;
  return data;
}

export async function upsertAvailabilityRule(
  organizationId: string,
  ruleData: CreateAvailabilityRuleData
): Promise<AvailabilityRule> {
  const existing = await getAvailabilityRule(ruleData.calendar_id, ruleData.user_id);

  if (existing) {
    return updateAvailabilityRule(existing.id, {
      timezone: ruleData.timezone,
      rules: ruleData.rules,
      overrides: ruleData.overrides,
    });
  }

  return createAvailabilityRule(organizationId, ruleData);
}

export async function addDateOverride(
  ruleId: string,
  override: DateOverride
): Promise<AvailabilityRule> {
  const { data: current } = await supabase
    .from('availability_rules')
    .select('overrides')
    .eq('id', ruleId)
    .single();

  const overrides = (current?.overrides as DateOverride[]) || [];
  const existingIndex = overrides.findIndex((o) => o.date === override.date);

  if (existingIndex >= 0) {
    overrides[existingIndex] = override;
  } else {
    overrides.push(override);
  }

  const { data, error } = await supabase
    .from('availability_rules')
    .update({ overrides })
    .eq('id', ruleId)
    .select()
    .single();

  if (error) throw error;
  return data;
}

export async function removeDateOverride(
  ruleId: string,
  date: string
): Promise<AvailabilityRule> {
  const { data: current } = await supabase
    .from('availability_rules')
    .select('overrides')
    .eq('id', ruleId)
    .single();

  const overrides = ((current?.overrides as DateOverride[]) || []).filter(
    (o) => o.date !== date
  );

  const { data, error } = await supabase
    .from('availability_rules')
    .update({ overrides })
    .eq('id', ruleId)
    .select()
    .single();

  if (error) throw error;
  return data;
}

export function getDefaultSchedule(): DaySchedule {
  const defaultRange: TimeRange[] = [{ start: '09:00', end: '17:00' }];
  return {
    monday: defaultRange,
    tuesday: defaultRange,
    wednesday: defaultRange,
    thursday: defaultRange,
    friday: defaultRange,
    saturday: [],
    sunday: [],
  };
}

// A curated shortlist pinned to the top of the picker (friendly US-first labels).
const PINNED_TIMEZONES: { value: string; label: string }[] = [
  { value: 'America/New_York', label: 'Eastern Time (ET)' },
  { value: 'America/Chicago', label: 'Central Time (CT)' },
  { value: 'America/Denver', label: 'Mountain Time (MT)' },
  { value: 'America/Los_Angeles', label: 'Pacific Time (PT)' },
  { value: 'America/Phoenix', label: 'Arizona (MST)' },
  { value: 'America/Anchorage', label: 'Alaska (AKT)' },
  { value: 'Pacific/Honolulu', label: 'Hawaii (HST)' },
  { value: 'UTC', label: 'UTC' },
];

// Current UTC offset for a zone, formatted "UTC-04:00" — used to label the full list.
function tzOffsetLabel(tz: string): string {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      timeZoneName: 'shortOffset',
    }).formatToParts(new Date());
    const name = parts.find((p) => p.type === 'timeZoneName')?.value ?? '';
    return name.replace('GMT', 'UTC');
  } catch {
    return '';
  }
}

/**
 * Full IANA timezone list for the availability picker. The eight curated zones
 * are pinned at the top; every remaining IANA zone follows, alphabetical, each
 * labeled with its current UTC offset. Falls back to just the pinned list on the
 * rare runtime without Intl.supportedValuesOf.
 */
export function getCommonTimezones(): { value: string; label: string }[] {
  let all: string[] = [];
  try {
    // @ts-expect-error supportedValuesOf is newer than the lib target here
    all = (Intl.supportedValuesOf?.('timeZone') as string[]) ?? [];
  } catch {
    all = [];
  }
  if (all.length === 0) return PINNED_TIMEZONES;

  const pinnedValues = new Set(PINNED_TIMEZONES.map((t) => t.value));
  const rest = all
    .filter((tz) => !pinnedValues.has(tz))
    .map((tz) => {
      const off = tzOffsetLabel(tz);
      return { value: tz, label: off ? `${tz.replace(/_/g, ' ')} (${off})` : tz.replace(/_/g, ' ') };
    });
  return [...PINNED_TIMEZONES, ...rest];
}
