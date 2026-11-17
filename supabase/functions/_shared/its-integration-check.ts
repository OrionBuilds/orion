import { SupabaseClient } from "npm:@supabase/supabase-js@2";
import { getUserProviders } from "./provider.ts";

/** Pure: any connected Google account that may send mail (several accounts per user; one is enough). */
export function anyGoogleAccountCanSend(rows: Array<{ granted_scopes?: string[] | null }>): boolean {
  return rows.some((r) => (r.granted_scopes ?? []).some((s) => s.includes('gmail.send') || s.includes('gmail.modify')));
}

/** Pure: any Google calendar connection that is still syncing (several accounts per user; one is enough). */
export function anyGoogleCalendarEnabled(rows: Array<{ sync_enabled?: boolean | null }>): boolean {
  return rows.some((r) => r.sync_enabled !== false);
}

interface ITSAction {
  action_id: string;
  type: string;
  module: string;
  payload: Record<string, unknown>;
  depends_on: string | null;
}

interface IntegrationCheckResult {
  valid: ITSAction[];
  invalid: { action_id: string; action_type: string; reason: string }[];
}

const EMAIL_ACTIONS = new Set(['send_email', 'draft_email']);
const CALENDAR_ACTIONS = new Set(['create_event', 'update_event', 'cancel_event']);
const SMS_ACTIONS = new Set(['send_sms']);

export async function validateIntegrationState(
  actions: ITSAction[],
  context: { userId: string; orgId: string; supabase: SupabaseClient }
): Promise<IntegrationCheckResult> {
  const valid: ITSAction[] = [];
  const invalid: { action_id: string; action_type: string; reason: string }[] = [];

  const needsGmail = actions.some((a) => EMAIL_ACTIONS.has(a.type));
  const needsCalendar = actions.some((a) => CALENDAR_ACTIONS.has(a.type));
  const needsSms = actions.some((a) => SMS_ACTIONS.has(a.type));

  let gmailConnected = false;
  let calendarConnected = false;
  let smsConfigured = false;

  // Microsoft 365 covers both mail and calendar (one Graph connection); Google is checked per
  // service below. Either provider makes the action executable — assistant-chat routes by provider.
  const microsoftConnected = (needsGmail || needsCalendar)
    ? (await getUserProviders(context.supabase, context.userId)).includes('microsoft')
    : false;

  if (needsGmail && microsoftConnected) gmailConnected = true;
  if (needsCalendar && microsoftConnected) calendarConnected = true;

  if (needsGmail && !gmailConnected) {
    // a user may have several Google accounts: it is enough that one of them can send
    const { data } = await context.supabase
      .from('google_oauth_master')
      .select('id, granted_scopes')
      .eq('user_id', context.userId);

    gmailConnected = anyGoogleAccountCanSend(data ?? []);
  }

  if (needsCalendar && !calendarConnected) {
    const { data } = await context.supabase
      .from('google_calendar_connections')
      .select('id, sync_enabled')
      .eq('user_id', context.userId);

    calendarConnected = anyGoogleCalendarEnabled(data ?? []);
  }

  if (needsSms) {
    const { data } = await context.supabase
      .from('phone_numbers')
      .select('id')
      .eq('org_id', context.orgId)
      .eq('status', 'active')
      .limit(1);

    smsConfigured = !!data && data.length > 0;
  }

  for (const action of actions) {
    if (EMAIL_ACTIONS.has(action.type) && !gmailConnected) {
      invalid.push({
        action_id: action.action_id,
        action_type: action.type,
        reason: 'No email account is connected. Connect Google Workspace or Microsoft 365 in Settings > Profile > Connected Accounts.',
      });
      continue;
    }

    if (CALENDAR_ACTIONS.has(action.type) && !calendarConnected) {
      invalid.push({
        action_id: action.action_id,
        action_type: action.type,
        reason: 'No calendar is connected. Connect Google Workspace or Microsoft 365 in Settings > Profile > Connected Accounts.',
      });
      continue;
    }

    if (SMS_ACTIONS.has(action.type) && !smsConfigured) {
      invalid.push({
        action_id: action.action_id,
        action_type: action.type,
        reason: 'No active phone number configured. Please set up phone in Settings.',
      });
      continue;
    }

    valid.push(action);
  }

  return { valid, invalid };
}
