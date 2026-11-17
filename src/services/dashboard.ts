import { supabase } from '../lib/supabase';
import { getGoogleCalendarEvents, hasGoogleCalendarConnection } from './googleCalendarEvents';

export interface DashboardStats {
  totalContacts: number;
  openConversations: number;
  unreadConversations: number;
  activeOpportunities: number;
  upcomingAppointments: number;
  nextAppointmentTime: string | null;
}

export interface AssignedConversation {
  id: string;
  contact_id: string;
  status: string;
  unread_count: number;
  last_message_at: string;
  channel?: string;
  contact: {
    id: string;
    first_name: string;
    last_name: string;
    email: string | null;
    phone: string | null;
  };
}

/** An email CLARA flagged as needing the user's attention (a `notifications` row of
 *  type 'email.flagged', written by her triage escalate branch via the OS MCP). */
export interface FlaggedEmail {
  id: string;
  title: string;
  body: string | null;
  link: string | null;
  created_at: string;
  metadata: { from?: string; gmailMessageId?: string } | null;
}

export interface TaskDue {
  id: string;
  title: string;
  due_date: string;
  priority: 'high' | 'medium' | 'low';
  status: string;
  contact_id: string;
  contact: {
    id: string;
    first_name: string;
    last_name: string;
  };
}

// Normalized appointment shape rendered by the dashboard "Upcoming Appointments"
// card. A row is either a real Google Calendar event (source 'google') or an
// internal CRM appointment (source 'crm'). The two feeds are merged + de-duped
// by google_event_id in getMyUpcomingAppointments().
export interface DashboardAppointment {
  id: string;
  source: 'google' | 'crm';
  start_at_utc: string;
  end_at_utc: string | null;
  status: string;
  title: string;
  subtitle: string;
  appointmentId: string | null; // CRM appointment id for /calendars deep-link
  googleEventId: string | null;
  htmlLink: string | null; // Google event link (google-only rows)
  allDay?: boolean;
}

// Internal shape for the CRM half of the merge (mirrors the select below).
interface CrmAppointmentRow {
  id: string;
  start_at_utc: string;
  end_at_utc: string | null;
  status: string;
  contact_id: string | null;
  answers: Record<string, string> | null;
  notes: string | null;
  google_event_id: string | null;
  google_meet_link: string | null;
  contact: { id: string; first_name: string; last_name: string } | null;
  calendar: { id: string; name: string } | null;
  appointment_type: { id: string; name: string } | null;
}

export interface SystemHealthStatus {
  messaging: 'connected' | 'degraded' | 'disconnected';
  calendar: 'connected' | 'degraded' | 'disconnected';
  payments: 'connected' | 'degraded' | 'disconnected';
}

export interface DateRange {
  startDate: string;
  endDate: string;
  label: string;
}

/**
 * Personal-by-default stat counts for the "User" mode dashboard (StatCard row + QueuePanel
 * badges' fallback while `analytics-dashboard` is still loading). Scoped to `userId` unless
 * `orgWide` is explicitly set — the only caller that should ever pass that is a superadmin's
 * System view, which has its own separate SystemDashboard page; the default User dashboard
 * (everyone, superadmins included) must show the signed-in user's own numbers, not the org's.
 */
export async function getDashboardStats(
  organizationId: string,
  userId: string,
  dateRange?: DateRange,
  orgWide = false
): Promise<{ data: DashboardStats | null; error: Error | null }> {
  try {
    const now = new Date().toISOString();

    let contactsQuery = supabase
      .from('contacts')
      .select('id', { count: 'exact', head: true })
      .eq('organization_id', organizationId);
    if (!orgWide) contactsQuery = contactsQuery.eq('owner_id', userId);

    let conversationsQuery = supabase
      .from('conversations')
      .select('id, unread_count', { count: 'exact' })
      .eq('organization_id', organizationId)
      .in('status', ['open', 'pending']);
    if (!orgWide) conversationsQuery = conversationsQuery.eq('assigned_user_id', userId);

    let opportunitiesQuery = supabase
      .from('opportunities')
      .select('id', { count: 'exact', head: true })
      .eq('org_id', organizationId)
      .in('status', ['open', 'qualified', 'proposal']);
    if (!orgWide) opportunitiesQuery = opportunitiesQuery.eq('assigned_user_id', userId);

    let appointmentsQuery = supabase
      .from('appointments')
      .select('id, start_at_utc', { count: 'exact' })
      .eq('org_id', organizationId)
      .gte('start_at_utc', now)
      .in('status', ['scheduled', 'confirmed'])
      .order('start_at_utc', { ascending: true })
      .limit(1);
    if (!orgWide) appointmentsQuery = appointmentsQuery.eq('assigned_user_id', userId);

    const [contactsRes, conversationsRes, opportunitiesRes, appointmentsRes] = await Promise.all([
      contactsQuery,
      conversationsQuery,
      opportunitiesQuery,
      appointmentsQuery,
    ]);

    const unreadCount = conversationsRes.data?.filter((c) => c.unread_count > 0).length || 0;
    const nextAppointment = appointmentsRes.data?.[0];

    return {
      data: {
        totalContacts: contactsRes.count || 0,
        openConversations: conversationsRes.count || 0,
        unreadConversations: unreadCount,
        activeOpportunities: opportunitiesRes.count || 0,
        upcomingAppointments: appointmentsRes.count || 0,
        nextAppointmentTime: nextAppointment?.start_at_utc || null,
      },
      error: null,
    };
  } catch (err) {
    return { data: null, error: err as Error };
  }
}

/**
 * The user's 4 most recent SMS/email conversations (combined), newest first —
 * a jump-back-in shortlist for the dashboard's Conversations tab. Any status
 * (not just open): a thread you replied to an hour ago is exactly what you
 * want to jump back into, whether or not it's still marked open.
 *
 * Includes UNASSIGNED threads, not just ones assigned to the user: inbound
 * SMS/email conversations are created with assigned_user_id null and nothing
 * in the ingest path assigns them, so an assigned-only filter shows an
 * almost-permanently-stale list (one manually-assigned row) while every real
 * recent thread is invisible.
 */
export async function getMyRecentConversations(
  userId: string,
  organizationId: string,
  limit = 4
): Promise<{ data: AssignedConversation[]; error: Error | null }> {
  const { data, error } = await supabase
    .from('conversations')
    .select(`
      id,
      contact_id,
      status,
      unread_count,
      last_message_at,
      channel,
      contact:contacts!conversations_contact_id_fkey(id, first_name, last_name, email, phone)
    `)
    .eq('organization_id', organizationId)
    .or(`assigned_user_id.eq.${userId},assigned_user_id.is.null`)
    .in('channel', ['sms', 'email'])
    .not('last_message_at', 'is', null)
    .order('last_message_at', { ascending: false })
    .limit(limit);

  return {
    data: (data as unknown as AssignedConversation[]) || [],
    error: error ? new Error(error.message) : null,
  };
}

export async function getUserTasksDue(
  userId: string,
  organizationId: string,
  limit = 10
): Promise<{ data: TaskDue[]; error: Error | null }> {
  const { data, error } = await supabase
    .from('contact_tasks')
    .select(`
      id,
      title,
      due_date,
      priority,
      status,
      contact_id,
      contact:contacts!contact_tasks_contact_id_fkey(id, first_name, last_name, organization_id)
    `)
    .eq('assigned_to_user_id', userId)
    .eq('status', 'pending')
    .order('due_date', { ascending: true })
    .limit(limit);

  const filteredData = (data || []).filter(
    (task) => (task.contact as { organization_id?: string })?.organization_id === organizationId
  );

  return {
    data: filteredData as unknown as TaskDue[],
    error: error ? new Error(error.message) : null,
  };
}

/**
 * "Follow-ups" for the My Queue panel: emails CLARA flagged as needing the user's
 * attention — unread `notifications` rows of type 'email.flagged', written by her
 * triage escalate branch through the OS MCP (`notifications_create`).
 */
export async function getFlaggedEmails(
  userId: string,
  limit = 10
): Promise<{ data: FlaggedEmail[]; error: Error | null }> {
  const { data, error } = await supabase
    .from('notifications')
    .select('id, title, body, link, created_at, metadata')
    .eq('user_id', userId)
    .eq('type', 'email.flagged')
    .eq('is_read', false)
    .order('created_at', { ascending: false })
    .limit(limit);

  return {
    data: (data as unknown as FlaggedEmail[]) || [],
    error: error ? new Error(error.message) : null,
  };
}

/** Mark one flagged-email notification handled (read) so it leaves the Follow-ups tab. */
export async function markFlaggedEmailRead(id: string): Promise<void> {
  await supabase.from('notifications').update({ is_read: true }).eq('id', id);
}

/**
 * Upcoming appointments for the LOGGED-IN user, merging two sources:
 *  - their real Google Calendar events (synced mirror table `google_calendar_events`)
 *  - their assigned CRM appointments (`appointments.assigned_user_id`)
 * De-duplicated by google_event_id (a CRM booking synced to Google shows once,
 * rendered with the Google title but deep-linking to the CRM appointment).
 */
export async function getMyUpcomingAppointments(
  userId: string,
  organizationId: string,
  limit = 5
): Promise<{ data: DashboardAppointment[]; googleConnected: boolean; error: Error | null }> {
  const now = new Date().toISOString();
  const FETCH = 20; // headroom before merge/slice

  const crmQuery = supabase
    .from('appointments')
    .select(`
      id,
      start_at_utc,
      end_at_utc,
      status,
      contact_id,
      answers,
      notes,
      google_event_id,
      google_meet_link,
      contact:contacts(id, first_name, last_name),
      calendar:calendars(id, name),
      appointment_type:appointment_types(id, name)
    `)
    .eq('org_id', organizationId)
    .eq('assigned_user_id', userId)
    .gte('start_at_utc', now)
    .in('status', ['scheduled', 'confirmed'])
    .order('start_at_utc', { ascending: true })
    .limit(FETCH);

  const [crmRes, googleEvents, googleConnected] = await Promise.all([
    crmQuery,
    getGoogleCalendarEvents(organizationId, userId, { startDate: now }).catch(() => []),
    hasGoogleCalendarConnection(userId).catch(() => false),
  ]);

  const crmError = crmRes.error ? new Error(crmRes.error.message) : null;
  const crmRows = ((crmRes.data as unknown as CrmAppointmentRow[]) || []);
  const events = (googleEvents || []).slice(0, FETCH);

  // CRM appointments indexed by their google_event_id (for enrich + de-dup).
  const crmByGoogleId = new Map<string, CrmAppointmentRow>();
  for (const a of crmRows) {
    if (a.google_event_id) crmByGoogleId.set(a.google_event_id, a);
  }
  const googleIdSet = new Set(
    events.map((e) => e.google_event_id).filter((id): id is string => !!id)
  );

  const merged: DashboardAppointment[] = [];

  // 1. Every Google Calendar event (real title), enriched with a CRM id when matched.
  for (const ev of events) {
    const matched = ev.google_event_id ? crmByGoogleId.get(ev.google_event_id) : undefined;
    merged.push({
      id: ev.id,
      source: 'google',
      start_at_utc: ev.start_time,
      end_at_utc: ev.end_time ?? null,
      status: ev.status || 'scheduled',
      title: ev.summary?.trim() || '(No title)',
      subtitle: ev.location?.trim() || ev.organizer_display_name?.trim() || 'Google Calendar',
      appointmentId: matched?.id ?? null,
      googleEventId: ev.google_event_id ?? null,
      htmlLink: ev.html_link ?? null,
      allDay: ev.all_day,
    });
  }

  // 2. CRM appointments NOT already represented by a Google event (internal bookings).
  for (const a of crmRows) {
    if (a.google_event_id && googleIdSet.has(a.google_event_id)) continue;
    const linkedName = a.contact ? `${a.contact.first_name} ${a.contact.last_name}`.trim() : '';
    const answerName = a.answers
      ? a.answers['name'] || a.answers['full_name'] || a.answers['your_name'] || ''
      : '';
    const typeName = a.appointment_type?.name || '';
    const calName = a.calendar?.name || '';
    const title = linkedName || answerName || typeName || a.notes?.trim() || 'Appointment';
    merged.push({
      id: a.id,
      source: 'crm',
      start_at_utc: a.start_at_utc,
      end_at_utc: a.end_at_utc ?? null,
      status: a.status,
      title,
      subtitle: [typeName, calName].filter(Boolean).join(' · '),
      appointmentId: a.id,
      googleEventId: a.google_event_id ?? null,
      htmlLink: null,
    });
  }

  merged.sort(
    (x, y) => new Date(x.start_at_utc).getTime() - new Date(y.start_at_utc).getTime()
  );

  return {
    data: merged.slice(0, limit),
    googleConnected,
    error: crmError,
  };
}

export async function getSystemHealthStatus(
  organizationId: string
): Promise<{ data: SystemHealthStatus; error: Error | null }> {
  try {
    const [channelsRes, calendarRes, paymentsRes] = await Promise.all([
      supabase
        .from('channel_configurations')
        .select('id, is_active')
        .eq('organization_id', organizationId)
        .eq('channel_type', 'sms')
        .maybeSingle(),

      // Calendar is Google Workspace or Microsoft 365; the connection row is user-scoped (RLS),
      // so no org filter. Calendar-only Google connections live in google_calendar_connections.
      Promise.all([
        supabase
          .from('user_connected_accounts')
          .select('id')
          .in('provider', ['microsoft_365', 'google_workspace'])
          .limit(1)
          .maybeSingle(),
        supabase
          .from('google_calendar_connections')
          .select('id')
          .eq('org_id', organizationId)
          .limit(1)
          .maybeSingle(),
      ]).then(([accounts, googleCal]) => ({ data: accounts.data ?? googleCal.data ?? null })),

      supabase
        .from('integration_connections')
        .select('id, status')
        .eq('org_id', organizationId)
        .maybeSingle(),
    ]);

    const getMessagingStatus = (data: { is_active?: boolean } | null): SystemHealthStatus['messaging'] => {
      if (!data) return 'disconnected';
      return data.is_active ? 'connected' : 'disconnected';
    };

    const getCalendarStatus = (data: { id?: string } | null): SystemHealthStatus['calendar'] => {
      return data ? 'connected' : 'disconnected';
    };

    const getPaymentsStatus = (data: { status?: string } | null): SystemHealthStatus['payments'] => {
      if (!data) return 'disconnected';
      if (data.status === 'active' || data.status === 'connected') return 'connected';
      if (data.status === 'error' || data.status === 'failed') return 'degraded';
      return 'disconnected';
    };

    return {
      data: {
        messaging: getMessagingStatus(channelsRes.data),
        calendar: getCalendarStatus(calendarRes.data),
        payments: getPaymentsStatus(paymentsRes.data),
      },
      error: null,
    };
  } catch (err) {
    return {
      data: { messaging: 'disconnected', calendar: 'disconnected', payments: 'disconnected' },
      error: err as Error,
    };
  }
}

export function getDateRangePresets(): DateRange[] {
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());

  const formatDate = (d: Date) => d.toISOString();

  return [
    {
      label: 'Today',
      startDate: formatDate(today),
      endDate: formatDate(new Date(today.getTime() + 24 * 60 * 60 * 1000)),
    },
    {
      label: 'Last 7 Days',
      startDate: formatDate(new Date(today.getTime() - 7 * 24 * 60 * 60 * 1000)),
      endDate: formatDate(new Date(today.getTime() + 24 * 60 * 60 * 1000)),
    },
    {
      label: 'Last 30 Days',
      startDate: formatDate(new Date(today.getTime() - 30 * 24 * 60 * 60 * 1000)),
      endDate: formatDate(new Date(today.getTime() + 24 * 60 * 60 * 1000)),
    },
  ];
}

export function getGreeting(): string {
  const hour = new Date().getHours();
  if (hour < 12) return 'Good morning';
  if (hour < 17) return 'Good afternoon';
  return 'Good evening';
}
