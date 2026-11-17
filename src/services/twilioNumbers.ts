import { fetchEdge } from '../lib/edgeFunction';
import { supabase } from '../lib/supabase';

export interface PhoneNumberCapabilities {
  sms: boolean;
  mms: boolean;
  voice: boolean;
}

export type TwilioSmsRoute = 'clara' | 'user' | 'external';

export interface TwilioNumber {
  id: string;
  org_id: string;
  phone_number: string;
  twilio_sid: string;
  friendly_name: string | null;
  capabilities: PhoneNumberCapabilities;
  country_code: string | null;
  status: 'active' | 'disabled';

  sms_route: TwilioSmsRoute;
  assigned_user_id: string | null;
  is_default_sms: boolean;
  /** Display name of the AI agent fronting this number (e.g. Clara / Friday). */
  agent_label: string | null;
  /** Cursor for the external-agent Twilio mirror poller. */
  last_mirror_sync_at?: string | null;

  is_default_voice: boolean;

  department_id: string | null;
  webhook_configured: boolean;
  created_at: string;
  updated_at: string;

  // Joined relations
  assigned_user?: { id: string; name: string; email: string } | null;
}

const SLUG = 'twilio-numbers';

/**
 * The Twilio numbers a user is allowed to send SMS from in the Conversations
 * composer. Non-admins may only use numbers routed to them (`sms_route='user'`
 * + `assigned_user_id` = them); admins may use any active SMS-capable number.
 * Always limited to active, SMS-capable numbers.
 */
export function resolveAllowedFromNumbers(
  all: TwilioNumber[],
  userId: string,
  isAdmin: boolean,
): TwilioNumber[] {
  const active = all.filter(
    (n) =>
      n.status === 'active' &&
      n.capabilities?.sms &&
      // Numbers fronted by an external AI agent are mirrored read-only — sending
      // from one would double-respond alongside that agent.
      n.sms_route !== 'external',
  );
  if (isAdmin) return active;
  return active.filter((n) => n.sms_route === 'user' && n.assigned_user_id === userId);
}

/**
 * Pick the default From number for a thread: prefer the number the thread is
 * already on (if the user is allowed to use it), then the user's default SMS
 * number, then the first allowed number. Returns '' when the user has none
 * (the composer treats '' as "blocked — no assigned number").
 */
export function pickDefaultFromNumber(allowed: TwilioNumber[], threadNumber?: string): string {
  if (allowed.length === 0) return '';
  if (threadNumber && allowed.some((n) => n.phone_number === threadNumber)) {
    return threadNumber;
  }
  const def = allowed.find((n) => n.is_default_sms);
  return (def ?? allowed[0]).phone_number;
}

export async function listTwilioNumbers(orgId: string): Promise<TwilioNumber[]> {
  const { data, error } = await supabase
    .from('twilio_numbers')
    .select(
      `*,
       assigned_user:users!twilio_numbers_assigned_user_id_fkey(id, name, email)`,
    )
    .eq('org_id', orgId)
    .order('phone_number');
  if (error) throw new Error(error.message);
  return (data as unknown as TwilioNumber[]) ?? [];
}

export interface SyncTwilioResult {
  ok: boolean;
  inserted: number;
  updated: number;
  unchanged: number;
  total: number;
}

export async function syncTwilioNumbers(orgId: string): Promise<SyncTwilioResult> {
  const response = await fetchEdge(SLUG, { body: { orgId, action: 'sync' } });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error);
  return result;
}

export interface UpdateTwilioAssignmentParams {
  numberId: string;
  patch: Partial<{
    sms_route: TwilioSmsRoute;
    assigned_user_id: string | null;
    agent_label: string | null;
    is_default_sms: boolean;
    is_default_voice: boolean;
    department_id: string | null;
    webhook_configured: boolean;
    friendly_name: string;
    status: 'active' | 'disabled';
  }>;
}

export async function updateTwilioAssignment(
  orgId: string,
  params: UpdateTwilioAssignmentParams,
): Promise<TwilioNumber> {
  const response = await fetchEdge(SLUG, {
    body: { orgId, action: 'update', id: params.numberId, patch: params.patch },
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error);
  return result.row;
}

export async function deleteTwilioNumber(orgId: string, numberId: string): Promise<void> {
  const response = await fetchEdge(SLUG, {
    body: { orgId, action: 'delete', id: numberId },
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error);
}

// ─────────────────────── Super-admin: account-wide importer ───────────────────────

export interface TwilioAccountNumber {
  sid: string;
  phone_number: string;
  friendly_name: string;
  capabilities: PhoneNumberCapabilities;
  country_code: string | null;
  assigned_org_id: string | null;
  assigned_org_name: string | null;
  db_row_id: string | null;
}

/** Super admin only. Returns every number in the platform's Twilio account
 * with its current org assignment (null if unimported). */
export async function listAccountNumbers(): Promise<TwilioAccountNumber[]> {
  const response = await fetchEdge(SLUG, { body: { action: 'account_list' } });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error);
  return (result.numbers as TwilioAccountNumber[]) ?? [];
}

/** Super admin only. Assigns a Twilio SID to an organization (location).
 * Inserts if not yet imported, updates if already imported under another org. */
export async function assignNumberToOrg(sid: string, orgId: string): Promise<void> {
  const response = await fetchEdge(SLUG, {
    body: { action: 'assign', sid, orgId },
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error);
}

/** Super admin only. Removes the org assignment for this Twilio SID. */
export async function unassignNumber(sid: string): Promise<void> {
  const response = await fetchEdge(SLUG, {
    body: { action: 'unassign', sid },
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error);
}
