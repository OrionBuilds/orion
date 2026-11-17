import { supabase } from '../lib/supabase';
import { callEdgeFunction, parseEdgeFunctionError } from '../lib/edgeFunction';
import type { GoogleCalendarEvent } from '../types';
import { getMyProviderState, type WorkspaceProvider } from './connectedProvider';
import { showAccountPicker } from '../lib/googleAccounts';

interface GoogleEventFilters {
  startDate?: string;
  endDate?: string;
  userIds?: string[];
  googleCalendarIds?: string[];
}

// Calendar is dual-provider: Google Calendar (google_calendar_events, via google-calendar-sync) and
// Microsoft 365 / Outlook (microsoft_calendar_events, via microsoft-calendar). Reads union both
// mirrors into the GoogleCalendarEvent shape the views consume (tagged with `provider`);
// mutations route by the event's provider; Sync triggers whichever provider(s) the user connected.
async function callCalendarApi(fn: 'google-calendar-sync' | 'microsoft-calendar', action: string, body?: Record<string, unknown>) {
  const response = await callEdgeFunction(fn, { action, ...body });
  if (!response.ok) {
    const err = await response.json().catch(() => ({}));
    const label = fn === 'google-calendar-sync' ? 'Google Calendar' : 'Microsoft Calendar';
    throw new Error(parseEdgeFunctionError(err, `${label} API call failed`));
  }
  return response.json();
}

const callMicrosoftCalendarApi = (action: string, body?: Record<string, unknown>) =>
  callCalendarApi('microsoft-calendar', action, body);
const callGoogleCalendarApi = (action: string, body?: Record<string, unknown>) =>
  callCalendarApi('google-calendar-sync', action, body);

interface MsCalendarRow {
  id: string; organization_id: string; user_id: string; graph_event_id: string; ical_uid: string | null;
  title: string | null; location: string | null; start_time: string; end_time: string; all_day: boolean;
  status: string; organizer_email: string | null;
  attendees: { email?: string; name?: string; response?: string }[] | null;
  online_meeting_url: string | null; web_link: string | null;
}

function mapMsEvent(r: MsCalendarRow): GoogleCalendarEvent {
  return {
    id: r.id, org_id: r.organization_id, connection_id: '', user_id: r.user_id, calendar_list_id: '',
    google_calendar_id: 'microsoft', google_event_id: r.graph_event_id, ical_uid: r.ical_uid,
    summary: r.title, description: null, location: r.location,
    start_time: r.start_time, end_time: r.end_time, all_day: r.all_day, timezone: 'UTC',
    recurrence: null, recurring_event_id: null, status: r.status,
    organizer_email: r.organizer_email, organizer_display_name: null, creator_email: r.organizer_email,
    attendees: (r.attendees ?? []).map((a) => ({ email: a.email, displayName: a.name, responseStatus: a.response })),
    event_type: null, visibility: null, transparency: null,
    html_link: r.web_link, hangout_link: r.online_meeting_url, conference_data: null,
    reminders: null, source: null,
    provider: 'microsoft',
  } as GoogleCalendarEvent;
}

function tagGoogle(rows: GoogleCalendarEvent[]): GoogleCalendarEvent[] {
  return rows.map((r) => ({ ...r, provider: 'google' as const }));
}

/** Merge both mirrors by start time. A failing mirror (e.g. table missing) must not hide the other. */
function mergeMirrors(google: GoogleCalendarEvent[], microsoft: GoogleCalendarEvent[]): GoogleCalendarEvent[] {
  return [...google, ...microsoft].sort((a, b) => a.start_time.localeCompare(b.start_time));
}

interface MirrorScope {
  organizationId: string;
  userIds?: string[];
  filters: GoogleEventFilters;
}

async function readGoogleMirror({ organizationId, userIds, filters }: MirrorScope): Promise<GoogleCalendarEvent[]> {
  let query = supabase
    .from('google_calendar_events')
    .select('*')
    .eq('org_id', organizationId)
    .neq('status', 'cancelled')
    .order('start_time', { ascending: true });
  if (userIds) query = query.in('user_id', userIds);
  if (filters.startDate) query = query.gte('end_time', filters.startDate);
  if (filters.endDate) query = query.lte('start_time', filters.endDate);
  if (filters.googleCalendarIds?.length) query = query.in('google_calendar_id', filters.googleCalendarIds);
  const { data, error } = await query;
  if (error) throw error;
  return tagGoogle((data || []) as GoogleCalendarEvent[]);
}

async function readMicrosoftMirror({ organizationId, userIds, filters }: MirrorScope): Promise<GoogleCalendarEvent[]> {
  let query = supabase
    .from('microsoft_calendar_events')
    .select('*')
    .eq('organization_id', organizationId)
    .neq('status', 'cancelled')
    .order('start_time', { ascending: true });
  if (userIds) query = query.in('user_id', userIds);
  if (filters.startDate) query = query.gte('end_time', filters.startDate);
  if (filters.endDate) query = query.lte('start_time', filters.endDate);
  const { data, error } = await query;
  if (error) throw error;
  return ((data || []) as MsCalendarRow[]).map(mapMsEvent);
}

async function readBothMirrors(scope: MirrorScope): Promise<GoogleCalendarEvent[]> {
  const [g, m] = await Promise.allSettled([readGoogleMirror(scope), readMicrosoftMirror(scope)]);
  if (g.status === 'rejected' && m.status === 'rejected') throw m.reason;
  if (g.status === 'rejected') console.warn('Google calendar mirror read failed:', g.reason);
  if (m.status === 'rejected') console.warn('Microsoft calendar mirror read failed:', m.reason);
  return mergeMirrors(g.status === 'fulfilled' ? g.value : [], m.status === 'fulfilled' ? m.value : []);
}

export async function getGoogleCalendarEvents(
  organizationId: string,
  userId: string,
  filters: GoogleEventFilters = {}
): Promise<GoogleCalendarEvent[]> {
  return readBothMirrors({ organizationId, userIds: [userId], filters });
}

export async function getTeamGoogleCalendarEvents(
  organizationId: string,
  userIds: string[],
  filters: GoogleEventFilters = {}
): Promise<GoogleCalendarEvent[]> {
  if (userIds.length === 0) return [];
  return readBothMirrors({ organizationId, userIds, filters });
}

export async function getAllOrgGoogleCalendarEvents(
  organizationId: string,
  filters: GoogleEventFilters = {}
): Promise<GoogleCalendarEvent[]> {
  return readBothMirrors({ organizationId, filters });
}

/**
 * How many mirrored events (both providers) end at or after `fromIso`, at any distance. Lets a list
 * tell "nothing synced at all" apart from "nothing in the days shown". Throws when it cannot tell.
 */
export async function countUpcomingMirrorEvents(
  organizationId: string,
  userIds?: string[],
  fromIso: string = new Date().toISOString()
): Promise<number> {
  const countIn = async (table: 'google_calendar_events' | 'microsoft_calendar_events', orgColumn: string) => {
    let query = supabase
      .from(table)
      .select('id', { count: 'exact', head: true })
      .eq(orgColumn, organizationId)
      .neq('status', 'cancelled')
      .gte('end_time', fromIso);
    if (userIds) query = query.in('user_id', userIds);
    const { count, error } = await query;
    if (error) throw error;
    return count ?? 0;
  };
  const results = await Promise.allSettled([
    countIn('google_calendar_events', 'org_id'),
    countIn('microsoft_calendar_events', 'organization_id'),
  ]);
  const total = results.reduce((sum, r) => sum + (r.status === 'fulfilled' ? r.value : 0), 0);
  const failed = results.find((r): r is PromiseRejectedResult => r.status === 'rejected');
  // A mirror that could not be read may hold events: zero is only an answer when both were read.
  if (failed && total === 0) throw failed.reason;
  return total;
}

/** Runs `fn` for each provider the signed-in user has connected (Microsoft-only users: just Outlook). */
async function forEachConnectedProvider<T>(
  fn: (p: WorkspaceProvider) => Promise<T>
): Promise<T[]> {
  const state = await getMyProviderState();
  // No connection rows readable (or none connected): keep the previous behaviour (Outlook sync,
  // which answers "not connected" itself).
  const providers: WorkspaceProvider[] = state.connected.length ? state.connected : ['microsoft'];
  const results = await Promise.allSettled(providers.map(fn));
  const ok = results.filter((r): r is PromiseFulfilledResult<Awaited<T>> => r.status === 'fulfilled').map((r) => r.value);
  if (ok.length === 0) throw (results[0] as PromiseRejectedResult).reason;
  return ok as T[];
}

/**
 * Runs a Google Calendar sync action: once as today for a single account, once per account
 * (`connection_id`) for users with 2+ so every calendar is refreshed.
 */
async function callGoogleSyncAction(action: string): Promise<Record<string, unknown>[]> {
  const accounts = (await getMyProviderState().catch(() => null))?.accounts.google ?? [];
  if (!showAccountPicker(accounts)) return [await callGoogleCalendarApi(action)];
  // One account failing (e.g. needs reconnect) must not hide the others' results.
  const settled = await Promise.allSettled(accounts.map((a) => callGoogleCalendarApi(action, { connection_id: a.id })));
  const ok = settled.filter((r): r is PromiseFulfilledResult<Record<string, unknown>> => r.status === 'fulfilled').map((r) => r.value);
  if (ok.length === 0) throw (settled[0] as PromiseRejectedResult).reason;
  const failed = settled.flatMap((r, i) => (r.status === 'rejected'
    ? [{ errors: [`${accounts[i].email}: ${r.reason instanceof Error ? r.reason.message : 'sync failed'}`] }]
    : []));
  return [...ok, ...failed];
}

/** Adds up the sync counters of several per-account results (a single result passes through). */
export function mergeSyncResults(results: Record<string, unknown>[], key: 'synced' | 'processed'): { count: number; errors: string[] } {
  let count = 0;
  const errors: string[] = [];
  for (const r of results) {
    const data = ((r.data as Record<string, unknown> | undefined) || r) as Record<string, unknown>;
    count += Number(data[key] ?? (key === 'processed' ? data.synced : 0) ?? 0);
    errors.push(...((data.errors as string[] | undefined) ?? []));
  }
  return { count, errors };
}

export async function syncGoogleCalendar(): Promise<{ synced: number; errors?: string[] }> {
  const parts = await forEachConnectedProvider(async (p) => {
    const results = p === 'google' ? await callGoogleSyncAction('sync') : [await callMicrosoftCalendarApi('sync')];
    const merged = mergeSyncResults(results, 'synced');
    return { synced: merged.count, errors: merged.errors };
  });
  const errors = parts.flatMap((p) => p.errors);
  return { synced: parts.reduce((n, p) => n + p.synced, 0), errors: errors.length ? errors : undefined };
}

export async function triggerIncrementalSync(): Promise<{ processed: number; errors?: string[] }> {
  const parts = await forEachConnectedProvider(async (p) => {
    const results = p === 'google' ? await callGoogleSyncAction('sync-incremental') : [await callMicrosoftCalendarApi('sync')];
    const merged = mergeSyncResults(results, 'processed');
    return { processed: merged.count, errors: merged.errors };
  });
  const errors = parts.flatMap((p) => p.errors);
  return { processed: parts.reduce((n, p) => n + p.processed, 0), errors: errors.length ? errors : undefined };
}

export async function triggerManualSync(): Promise<{ synced: number; errors?: string[] }> {
  return syncGoogleCalendar();
}

export interface ProviderSyncStatus {
  provider: WorkspaceProvider;
  connected: boolean;
  syncEnabled: boolean;
  lastFullSync: string | null;
  lastIncrementalSync: string | null;
  pendingJobs: number;
}

interface GoogleCalendarConnectionRow {
  id: string;
  sync_enabled: boolean | null;
  last_full_sync_at: string | null;
  last_incremental_sync_at: string | null;
}

/**
 * Folds one calendar connection per Google account into a single provider status: connected when
 * any account is, enabled when any account syncs, the latest sync times, pending jobs summed.
 */
export function combineGoogleSyncRows(rows: GoogleCalendarConnectionRow[], pendingJobs: number): ProviderSyncStatus {
  const base: ProviderSyncStatus = { provider: 'google', connected: false, syncEnabled: false, lastFullSync: null, lastIncrementalSync: null, pendingJobs: 0 };
  if (rows.length === 0) return base;
  const latest = (vals: (string | null)[]) => vals.filter((v): v is string => !!v).sort().pop() ?? null;
  return {
    ...base,
    connected: true,
    syncEnabled: rows.some((r) => r.sync_enabled ?? false),
    lastFullSync: latest(rows.map((r) => r.last_full_sync_at)),
    lastIncrementalSync: latest(rows.map((r) => r.last_incremental_sync_at)),
    pendingJobs,
  };
}

async function getGoogleSyncStatus(userId: string): Promise<ProviderSyncStatus> {
  // One calendar connection per Google account.
  const { data } = await supabase
    .from('google_calendar_connections')
    .select('id, sync_enabled, last_full_sync_at, last_incremental_sync_at')
    .eq('user_id', userId);
  const rows = (data || []) as GoogleCalendarConnectionRow[];
  if (rows.length === 0) return combineGoogleSyncRows([], 0);
  const { count } = await supabase
    .from('google_calendar_sync_jobs')
    .select('id', { count: 'exact', head: true })
    .in('connection_id', rows.map((r) => r.id))
    .in('status', ['queued', 'processing']);
  return combineGoogleSyncRows(rows, count || 0);
}

async function getMicrosoftSyncStatus(userId: string): Promise<ProviderSyncStatus> {
  const base: ProviderSyncStatus = { provider: 'microsoft', connected: false, syncEnabled: false, lastFullSync: null, lastIncrementalSync: null, pendingJobs: 0 };
  const { data: state } = await supabase
    .from('outlook_sync_state')
    .select('sync_status, last_sync_at')
    .eq('user_id', userId)
    .maybeSingle();
  if (!state) return base;
  return {
    ...base,
    connected: true,
    syncEnabled: state.sync_status !== 'disabled',
    lastFullSync: state.last_sync_at || null,
    lastIncrementalSync: state.last_sync_at || null,
  };
}

/**
 * Calendar sync status across providers. Top-level fields describe the user's connected
 * provider(s) combined (Microsoft first, as before); `providers` has the per-provider detail.
 */
export async function getSyncStatus(userId: string): Promise<{
  connected: boolean;
  syncEnabled: boolean;
  lastFullSync: string | null;
  lastIncrementalSync: string | null;
  pendingJobs: number;
  providers: ProviderSyncStatus[];
}> {
  const settled = await Promise.allSettled([getMicrosoftSyncStatus(userId), getGoogleSyncStatus(userId)]);
  const providers = settled
    .filter((r): r is PromiseFulfilledResult<ProviderSyncStatus> => r.status === 'fulfilled')
    .map((r) => r.value)
    .filter((p) => p.connected);
  if (providers.length === 0) {
    return { connected: false, syncEnabled: false, lastFullSync: null, lastIncrementalSync: null, pendingJobs: 0, providers: [] };
  }
  const latest = (vals: (string | null)[]) => vals.filter(Boolean).sort().pop() ?? null;
  return {
    connected: true,
    syncEnabled: providers.some((p) => p.syncEnabled),
    lastFullSync: latest(providers.map((p) => p.lastFullSync)),
    lastIncrementalSync: latest(providers.map((p) => p.lastIncrementalSync)),
    pendingJobs: providers.reduce((n, p) => n + p.pendingJobs, 0),
    providers,
  };
}

export async function getSyncLogs(
  connectionId: string,
  limit = 50
): Promise<{ id: string; level: string; message: string; calendar_id: string | null; meta: Record<string, unknown> | null; created_at: string }[]> {
  const { data, error } = await supabase
    .from('calendar_sync_logs')
    .select('id, level, message, calendar_id, meta, created_at')
    .eq('connection_id', connectionId)
    .order('created_at', { ascending: false })
    .limit(limit);

  if (error) throw error;
  return data || [];
}

export async function getEventMap(
  connectionId: string,
  appointmentId?: string
): Promise<{ google_event_id: string; appointment_id: string | null; sync_direction: string; sync_status: string; is_deleted: boolean; last_google_updated_at: string | null; last_crm_updated_at: string | null }[]> {
  let query = supabase
    .from('calendar_event_map')
    .select('google_event_id, appointment_id, sync_direction, sync_status, is_deleted, last_google_updated_at, last_crm_updated_at')
    .eq('connection_id', connectionId)
    .eq('is_deleted', false);

  if (appointmentId) {
    query = query.eq('appointment_id', appointmentId);
  }

  const { data, error } = await query.order('updated_at', { ascending: false }).limit(100);
  if (error) throw error;
  return data || [];
}

/**
 * Which provider owns a mirror row. Callers that have the event pass `provider` (from the event);
 * otherwise look the id up in the Outlook mirror first (the incumbent), then Google.
 */
async function resolveEventTarget(
  id: string,
  provider?: WorkspaceProvider
): Promise<{ provider: WorkspaceProvider; eventId: string }> {
  if (provider !== 'google') {
    const { data } = await supabase
      .from('microsoft_calendar_events')
      .select('graph_event_id')
      .eq('id', id)
      .maybeSingle();
    const graphId = (data as { graph_event_id?: string } | null)?.graph_event_id;
    if (graphId) return { provider: 'microsoft', eventId: graphId };
    if (provider === 'microsoft') return { provider: 'microsoft', eventId: id };
  }
  // google-calendar-sync takes the google_calendar_events row id.
  return { provider: 'google', eventId: id };
}

/**
 * Creates an event on one of the user's Outlook calendars. `connectionId` picks the account
 * (omitted = the primary); the server rejects an account that is not the caller's.
 */
export async function createOutlookCalendarEvent(params: {
  summary: string;
  startTime: string;
  endTime: string;
  description?: string | null;
  attendees?: string[];
  connectionId?: string;
}): Promise<{ id?: string }> {
  const result = await callMicrosoftCalendarApi('create-event', {
    event: {
      summary: params.summary,
      start_time: params.startTime,
      end_time: params.endTime,
      description: params.description || undefined,
      attendees: params.attendees && params.attendees.length > 0 ? params.attendees : undefined,
    },
    ...(params.connectionId ? { connection_id: params.connectionId } : {}),
  });
  return { id: result?.id };
}

/**
 * `connectionId` (Google only): which Google account holds the event. Omitted, the server uses the
 * account that holds it (or the primary), so single-account calls are unchanged.
 */
export async function updateGoogleCalendarEvent(
  eventId: string,
  updates: {
    summary?: string;
    description?: string;
    location?: string;
    start_time?: string;
    end_time?: string;
    all_day?: boolean;
    timezone?: string;
  },
  provider?: WorkspaceProvider,
  connectionId?: string
): Promise<void> {
  const t = await resolveEventTarget(eventId, provider);
  if (t.provider === 'google') await callGoogleCalendarApi('update-event', { eventId: t.eventId, updates, ...(connectionId ? { connection_id: connectionId } : {}) });
  else await callMicrosoftCalendarApi('update-event', { eventId: t.eventId, updates });
}

export async function deleteGoogleCalendarEvent(eventId: string, provider?: WorkspaceProvider, connectionId?: string): Promise<void> {
  const t = await resolveEventTarget(eventId, provider);
  if (t.provider === 'google') await callGoogleCalendarApi('delete-event', { eventId: t.eventId, ...(connectionId ? { connection_id: connectionId } : {}) });
  else await callMicrosoftCalendarApi('delete-event', { eventId: t.eventId });
}

export async function rsvpGoogleCalendarEvent(
  eventId: string,
  response: 'accepted' | 'declined' | 'tentative',
  provider?: WorkspaceProvider,
  connectionId?: string
): Promise<void> {
  const t = await resolveEventTarget(eventId, provider);
  if (t.provider === 'google') await callGoogleCalendarApi('rsvp', { eventId: t.eventId, response, ...(connectionId ? { connection_id: connectionId } : {}) });
  else await callMicrosoftCalendarApi('rsvp', { eventId: t.eventId, response });
}

/** True when the user has a calendar connected on either provider. */
export async function hasGoogleCalendarConnection(userId: string): Promise<boolean> {
  // user_connected_accounts is user-readable (the *_oauth_master tables are service-role-only).
  const { data } = await supabase
    .from('user_connected_accounts')
    .select('provider, status')
    .eq('user_id', userId)
    .in('provider', ['microsoft_365', 'google_workspace', 'google_gmail']);
  if ((data || []).some((r) => (r as { status?: string }).status !== 'error' && (r as { status?: string }).status !== 'disconnected')) return true;
  // Calendar-only Google connections (google-calendar-oauth) don't write a connected-accounts row.
  const { data: cal } = await supabase
    .from('google_calendar_connections')
    .select('id')
    .eq('user_id', userId)
    .limit(1);
  return (cal || []).length > 0;
}
