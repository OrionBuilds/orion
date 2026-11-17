import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { restGet, restPost, restPatch, restDelete } from '../helpers/rest-client.js';
import { callEdgeFunction, callEdgeRoute } from '../helpers/edge-client.js';
import {
  calendarSyncRoute,
  connectRoute,
  providerParam,
  resolveWorkspaceProvider,
  type RequestedProvider,
} from '../helpers/workspace-provider.js';
import { toolResult, toolError } from '../helpers/tool-utils.js';

export function registerCalendarsTools(server: McpServer): void {
  server.tool(
    'calendars_list',
    'List calendars',
    {},
    async () => {
      try {
        const data = await restGet('calendars', { order: 'name.asc' });
        return toolResult(data);
      } catch (e) {
        return toolError(e);
      }
    },
  );

  server.tool(
    'appointments_list',
    'List appointments in a date range. Filter by calendar_id, status, contact_id.',
    {
      calendar_id: z.string().optional(),
      contact_id: z.string().optional(),
      status: z.string().optional(),
      start_date: z.string().optional().describe('ISO date, gte filter'),
      end_date: z.string().optional().describe('ISO date, lte filter'),
      order: z.string().optional(),
      limit: z.number().optional(),
    },
    async (params) => {
      try {
        const filters: Record<string, string> = {};
        if (params.calendar_id) filters['calendar_id'] = `eq.${params.calendar_id}`;
        if (params.contact_id) filters['contact_id'] = `eq.${params.contact_id}`;
        if (params.status) filters['status'] = params.status;
        if (params.start_date) filters['start_at_utc'] = `gte.${params.start_date}`;
        if (params.end_date) filters['end_time'] = `lte.${params.end_date}`;
        const data = await restGet('appointments', {
          select: '*,contact:contacts(id,first_name,last_name,email),calendar:calendars(id,name)',
          filters,
          order: params.order || 'start_at_utc.asc',
          limit: params.limit || 50,
        });
        return toolResult(data);
      } catch (e) {
        return toolError(e);
      }
    },
  );

  server.tool(
    'appointments_get',
    'Get appointment detail',
    { id: z.string() },
    async ({ id }) => {
      try {
        const data = await restGet('appointments', {
          select: '*,contact:contacts(*),calendar:calendars(*)',
          filters: { id: `eq.${id}` },
          accept: 'application/vnd.pgrst.object+json',
        });
        return toolResult(data);
      } catch (e) {
        return toolError(e);
      }
    },
  );

  server.tool(
    'appointments_create',
    'Create an appointment',
    {
      calendar_id: z.string(),
      title: z.string(),
      start_time: z.string(),
      end_time: z.string(),
      contact_id: z.string().optional(),
      description: z.string().optional(),
      status: z.string().optional(),
      appointment_type_id: z.string().optional(),
      organization_id: z.string().optional(),
    },
    async (params) => {
      try {
        const data = await restPost('appointments', params, 'return=representation');
        return toolResult(data);
      } catch (e) {
        return toolError(e);
      }
    },
  );

  server.tool(
    'appointments_update',
    'Update an appointment',
    {
      id: z.string(),
      title: z.string().optional(),
      start_time: z.string().optional(),
      end_time: z.string().optional(),
      status: z.string().optional(),
      description: z.string().optional(),
    },
    async ({ id, ...body }) => {
      try {
        const data = await restPatch('appointments', { id: `eq.${id}` }, body, 'return=representation');
        return toolResult(data);
      } catch (e) {
        return toolError(e);
      }
    },
  );

  server.tool(
    'appointments_delete',
    'Delete/cancel an appointment',
    { id: z.string() },
    async ({ id }) => {
      try {
        await restDelete('appointments', { id: `eq.${id}` });
        return toolResult({ success: true });
      } catch (e) {
        return toolError(e);
      }
    },
  );

  server.tool(
    'availability_rules_list',
    'List availability rules for a calendar',
    { calendar_id: z.string() },
    async ({ calendar_id }) => {
      try {
        const data = await restGet('availability_rules', {
          filters: { calendar_id: `eq.${calendar_id}` },
          order: 'day_of_week.asc',
        });
        return toolResult(data);
      } catch (e) {
        return toolError(e);
      }
    },
  );

  server.tool(
    'availability_rules_create',
    'Create an availability rule',
    {
      calendar_id: z.string(),
      day_of_week: z.number().describe('0=Sunday, 6=Saturday'),
      start_time: z.string().describe('HH:MM format'),
      end_time: z.string().describe('HH:MM format'),
      is_available: z.boolean().optional(),
    },
    async (params) => {
      try {
        const data = await restPost('availability_rules', params, 'return=representation');
        return toolResult(data);
      } catch (e) {
        return toolError(e);
      }
    },
  );

  server.tool(
    'availability_rules_update',
    'Update an availability rule',
    {
      id: z.string(),
      start_time: z.string().optional(),
      end_time: z.string().optional(),
      is_available: z.boolean().optional(),
    },
    async ({ id, ...body }) => {
      try {
        const data = await restPatch('availability_rules', { id: `eq.${id}` }, body, 'return=representation');
        return toolResult(data);
      } catch (e) {
        return toolError(e);
      }
    },
  );

  server.tool(
    'availability_rules_delete',
    'Delete an availability rule',
    { id: z.string() },
    async ({ id }) => {
      try {
        await restDelete('availability_rules', { id: `eq.${id}` });
        return toolResult({ success: true });
      } catch (e) {
        return toolError(e);
      }
    },
  );

  server.tool(
    'booking_api',
    'Public booking API. Actions: getAvailability, createBooking, reschedule ({ token, new_start_utc, new_end_utc }), cancel ({ token, reason }). Pass action and action-specific params in payload.',
    {
      action: z.string(),
      payload: z.record(z.unknown()).optional(),
    },
    async ({ action, payload }) => {
      try {
        const data = await callEdgeFunction('booking-api', { action, ...payload });
        return toolResult(data);
      } catch (e) {
        return toolError(e);
      }
    },
  );

  // Calendar pull for the CALLER's own connection: google-calendar-sync (Google) or
  // microsoft-calendar 'sync' (Outlook). Both accept a user JWT.
  const calendarSyncSchema = {
    incremental: z.boolean().optional().describe('Google only: incremental (sync-token) pull instead of a full window sync'),
    connection_id: z.string().optional().describe('Ignored (kept for compatibility): the sync always targets the caller\'s own connection'),
    direction: z.string().optional().describe('Ignored (kept for compatibility)'),
    provider: providerParam,
  };
  const calendarSyncHandler = async ({ incremental, provider }: { incremental?: boolean; provider?: RequestedProvider }) => {
    try {
      const p = await resolveWorkspaceProvider(provider);
      const data = await callEdgeRoute(calendarSyncRoute(p, !!incremental));
      return toolResult({ provider: p, ...(typeof data === 'object' && data !== null ? data : { result: data }) });
    } catch (e) {
      return toolError(e);
    }
  };
  server.tool('calendar_sync', "Pull the caller's Google or Outlook calendar into the OS mirror (whichever is connected).", calendarSyncSchema, calendarSyncHandler);
  server.tool('google_calendar_sync', 'Legacy alias of calendar_sync (Google or Outlook by connected provider).', calendarSyncSchema, calendarSyncHandler);

  server.tool(
    'google_calendar_oauth',
    'Start connecting the caller\'s calendar: Google Workspace or Microsoft 365. Returns an authUrl to open.',
    {
      action: z.string().optional().describe('start (only supported action)'),
      redirect_uri: z.string().optional().describe('Google: app origin to return to after consent'),
      provider: providerParam,
    },
    async ({ redirect_uri, provider }) => {
      try {
        const p = provider === 'google' || provider === 'microsoft' ? provider
          : await resolveWorkspaceProvider(provider).catch(() => 'google' as const);
        const data = await callEdgeRoute(connectRoute(p, { appOrigin: redirect_uri }));
        return toolResult({ provider: p, ...(data as object) });
      } catch (e) {
        return toolError(e);
      }
    },
  );

  server.tool(
    'calendars_get',
    'Get a calendar with its members and appointment types',
    { id: z.string() },
    async ({ id }) => {
      try {
        const data = await restGet('calendars', {
          select: '*,members:calendar_members(*),appointment_types(*)',
          filters: { id: `eq.${id}` },
          accept: 'application/vnd.pgrst.object+json',
        });
        return toolResult(data);
      } catch (e) {
        return toolError(e);
      }
    },
  );

  server.tool(
    'calendars_create',
    'Create a calendar',
    {
      org_id: z.string(),
      type: z.string().describe('e.g. user, team, department, round_robin'),
      name: z.string(),
      slug: z.string(),
      department_id: z.string().optional(),
      owner_user_id: z.string().optional(),
      settings: z.record(z.unknown()).optional(),
      active: z.boolean().optional(),
    },
    async (params) => {
      try {
        const data = await restPost('calendars', params, 'return=representation');
        return toolResult(data);
      } catch (e) {
        return toolError(e);
      }
    },
  );

  server.tool(
    'calendars_update',
    'Update a calendar',
    {
      id: z.string(),
      name: z.string().optional(),
      slug: z.string().optional(),
      department_id: z.string().optional(),
      owner_user_id: z.string().optional(),
      settings: z.record(z.unknown()).optional(),
      active: z.boolean().optional(),
    },
    async ({ id, ...body }) => {
      try {
        const data = await restPatch('calendars', { id: `eq.${id}` }, body, 'return=representation');
        return toolResult(data);
      } catch (e) {
        return toolError(e);
      }
    },
  );

  server.tool(
    'calendars_delete',
    'Delete a calendar',
    { id: z.string() },
    async ({ id }) => {
      try {
        await restDelete('calendars', { id: `eq.${id}` });
        return toolResult({ success: true });
      } catch (e) {
        return toolError(e);
      }
    },
  );

  server.tool(
    'appointment_types_list',
    'List appointment (booking) types for a calendar',
    { calendar_id: z.string() },
    async ({ calendar_id }) => {
      try {
        const data = await restGet('appointment_types', {
          filters: { calendar_id: `eq.${calendar_id}` },
          order: 'created_at.asc',
        });
        return toolResult(data);
      } catch (e) {
        return toolError(e);
      }
    },
  );

  server.tool(
    'appointment_types_get',
    'Get an appointment type with its calendar',
    { id: z.string() },
    async ({ id }) => {
      try {
        const data = await restGet('appointment_types', {
          select: '*,calendar:calendars(*)',
          filters: { id: `eq.${id}` },
          accept: 'application/vnd.pgrst.object+json',
        });
        return toolResult(data);
      } catch (e) {
        return toolError(e);
      }
    },
  );

  server.tool(
    'appointment_types_create',
    'Create an appointment (booking) type',
    {
      org_id: z.string(),
      calendar_id: z.string(),
      name: z.string(),
      slug: z.string(),
      description: z.string().optional(),
      duration_minutes: z.number(),
      location_type: z.string().optional().describe('e.g. in_person, phone, google_meet, custom'),
      location_value: z.record(z.unknown()).optional(),
      questions: z.array(z.unknown()).optional(),
      slot_interval_minutes: z.number().optional(),
      buffer_before_minutes: z.number().optional(),
      buffer_after_minutes: z.number().optional(),
      min_notice_minutes: z.number().optional(),
      booking_window_days: z.number().optional(),
      max_per_day: z.number().optional(),
      generate_google_meet: z.boolean().optional(),
      active: z.boolean().optional(),
    },
    async (params) => {
      try {
        const data = await restPost('appointment_types', params, 'return=representation');
        return toolResult(data);
      } catch (e) {
        return toolError(e);
      }
    },
  );

  server.tool(
    'appointment_types_update',
    'Update an appointment type',
    {
      id: z.string(),
      name: z.string().optional(),
      slug: z.string().optional(),
      description: z.string().optional(),
      duration_minutes: z.number().optional(),
      location_type: z.string().optional(),
      location_value: z.record(z.unknown()).optional(),
      questions: z.array(z.unknown()).optional(),
      slot_interval_minutes: z.number().optional(),
      buffer_before_minutes: z.number().optional(),
      buffer_after_minutes: z.number().optional(),
      min_notice_minutes: z.number().optional(),
      booking_window_days: z.number().optional(),
      max_per_day: z.number().optional(),
      generate_google_meet: z.boolean().optional(),
      active: z.boolean().optional(),
    },
    async ({ id, ...body }) => {
      try {
        const data = await restPatch('appointment_types', { id: `eq.${id}` }, body, 'return=representation');
        return toolResult(data);
      } catch (e) {
        return toolError(e);
      }
    },
  );

  server.tool(
    'appointment_types_delete',
    'Delete an appointment type',
    { id: z.string() },
    async ({ id }) => {
      try {
        await restDelete('appointment_types', { id: `eq.${id}` });
        return toolResult({ success: true });
      } catch (e) {
        return toolError(e);
      }
    },
  );

  server.tool(
    'blocked_slots_list',
    'List blocked-off time slots. Filter by calendar_id, user_id, or a date range on start_at_utc.',
    {
      calendar_id: z.string().optional(),
      user_id: z.string().optional(),
      start_date: z.string().optional().describe('ISO datetime, gte filter on start_at_utc'),
      end_date: z.string().optional().describe('ISO datetime, lte filter on start_at_utc'),
      limit: z.number().optional(),
    },
    async (params) => {
      try {
        const filters: Record<string, string> = {};
        if (params.calendar_id) filters['calendar_id'] = `eq.${params.calendar_id}`;
        if (params.user_id) filters['user_id'] = `eq.${params.user_id}`;
        if (params.start_date) filters['start_at_utc'] = `gte.${params.start_date}`;
        if (params.end_date) filters['start_at_utc'] = `lte.${params.end_date}`;
        const data = await restGet('blocked_slots', {
          select: '*,calendar:calendars(id,name,slug,type)',
          filters,
          order: 'start_at_utc.asc',
          limit: params.limit || 100,
        });
        return toolResult(data);
      } catch (e) {
        return toolError(e);
      }
    },
  );

  server.tool(
    'blocked_slots_create',
    'Create a blocked time slot on a calendar',
    {
      org_id: z.string(),
      calendar_id: z.string(),
      title: z.string(),
      start_at_utc: z.string(),
      end_at_utc: z.string(),
      user_id: z.string().optional(),
      all_day: z.boolean().optional(),
      recurring: z.boolean().optional(),
      recurrence_rule: z.string().optional(),
      created_by: z.string().optional(),
    },
    async (params) => {
      try {
        const data = await restPost('blocked_slots', params, 'return=representation');
        return toolResult(data);
      } catch (e) {
        return toolError(e);
      }
    },
  );

  server.tool(
    'blocked_slots_update',
    'Update a blocked time slot',
    {
      id: z.string(),
      title: z.string().optional(),
      start_at_utc: z.string().optional(),
      end_at_utc: z.string().optional(),
      all_day: z.boolean().optional(),
      recurring: z.boolean().optional(),
      recurrence_rule: z.string().optional(),
    },
    async ({ id, ...body }) => {
      try {
        const data = await restPatch('blocked_slots', { id: `eq.${id}` }, body, 'return=representation');
        return toolResult(data);
      } catch (e) {
        return toolError(e);
      }
    },
  );

  server.tool(
    'blocked_slots_delete',
    'Delete a blocked time slot',
    { id: z.string() },
    async ({ id }) => {
      try {
        await restDelete('blocked_slots', { id: `eq.${id}` });
        return toolResult({ success: true });
      } catch (e) {
        return toolError(e);
      }
    },
  );

  server.tool(
    'google_calendar_connections_list',
    'List calendar connections visible to the caller: Google (google_calendar_connections) and/or Microsoft 365 (user_connected_accounts microsoft_365 rows).',
    { limit: z.number().optional(), provider: z.enum(['google', 'microsoft', 'all']).optional().describe('Default: all') },
    async ({ limit, provider }) => {
      try {
        const want = provider ?? 'all';
        const out: Record<string, unknown> = {};
        if (want !== 'microsoft') {
          out.google = await restGet('google_calendar_connections', {
            select: 'id,org_id,user_id,email,sync_enabled,selected_calendar_ids,created_at,updated_at',
            order: 'created_at.desc',
            limit: limit || 50,
          });
        }
        if (want !== 'google') {
          out.microsoft = await restGet('user_connected_accounts', {
            select: 'id,user_id,provider,provider_account_email,status,connected_at,last_synced_at',
            filters: { provider: 'eq.microsoft_365' },
            order: 'connected_at.desc',
            limit: limit || 50,
          });
        }
        return toolResult(out);
      } catch (e) {
        return toolError(e);
      }
    },
  );
}
