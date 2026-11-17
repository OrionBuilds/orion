import { supabase } from '../lib/supabase';
import type { EmailUnsubscribeGroup } from '../types';

async function getOrgId(): Promise<string | null> {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return null;
  const { data: userRow } = await supabase
    .from('users')
    .select('organization_id')
    .eq('id', user.id)
    .maybeSingle();
  return (userRow?.organization_id as string | undefined) ?? null;
}

export async function getUnsubscribeGroups(orgId: string): Promise<EmailUnsubscribeGroup[]> {
  const { data, error } = await supabase
    .from('email_unsubscribe_groups')
    .select('*')
    .eq('org_id', orgId)
    .order('created_at', { ascending: false });

  if (error) throw error;
  return data || [];
}

export async function createUnsubscribeGroup(
  name: string,
  description?: string,
): Promise<{ success: boolean; group?: EmailUnsubscribeGroup; error?: string }> {
  const orgId = await getOrgId();
  if (!orgId) return { success: false, error: 'No organization' };

  const { data, error } = await supabase
    .from('email_unsubscribe_groups')
    .insert({
      org_id: orgId,
      name,
      description: description ?? null,
      provider_group_id: null,
    })
    .select()
    .single();

  if (error) return { success: false, error: error.message };
  return { success: true, group: data as EmailUnsubscribeGroup };
}

export async function updateUnsubscribeGroup(
  groupId: string,
  updates: { name?: string; description?: string },
): Promise<{ success: boolean; error?: string }> {
  const { error } = await supabase
    .from('email_unsubscribe_groups')
    .update(updates)
    .eq('id', groupId);

  if (error) return { success: false, error: error.message };
  return { success: true };
}

export async function setDefaultUnsubscribeGroup(
  groupId: string,
): Promise<{ success: boolean; error?: string }> {
  const orgId = await getOrgId();
  if (!orgId) return { success: false, error: 'No organization' };

  return markDefaultUnsubscribeGroup(orgId, groupId, true);
}

/**
 * Keep `email_unsubscribe_groups.is_default` and `email_defaults.default_unsubscribe_group_id`
 * (what the send paths read) pointing at the same group. Both tables are keyed by org_id.
 */
export async function markDefaultUnsubscribeGroup(
  orgId: string,
  groupId: string | null,
  writeDefaults: boolean,
): Promise<{ success: boolean; error?: string }> {
  const { error: clearErr } = await supabase
    .from('email_unsubscribe_groups')
    .update({ is_default: false })
    .eq('org_id', orgId)
    .eq('is_default', true);
  if (clearErr) return { success: false, error: clearErr.message };

  if (groupId) {
    const { error } = await supabase
      .from('email_unsubscribe_groups')
      .update({ is_default: true })
      .eq('id', groupId)
      .eq('org_id', orgId);
    if (error) return { success: false, error: error.message };
  }

  if (writeDefaults) {
    const { error } = await supabase
      .from('email_defaults')
      .upsert({ org_id: orgId, default_unsubscribe_group_id: groupId }, { onConflict: 'org_id' });
    if (error) return { success: false, error: error.message };
  }
  return { success: true };
}

export async function deleteUnsubscribeGroup(
  groupId: string,
): Promise<{ success: boolean; error?: string }> {
  const { error } = await supabase.from('email_unsubscribe_groups').delete().eq('id', groupId);
  if (error) return { success: false, error: error.message };
  return { success: true };
}

/**
 * No-op under Resend. Resend exposes no suppression-list API; unsubscribes,
 * hard bounces and complaints land in the `suppressions` table instead
 * (email-unsubscribe, resend-webhook). The default group switches the
 * List-Unsubscribe header + footer link on for outbound mail. Retained (empty)
 * so the UnsubscribeGroupsTab keeps compiling.
 */
export async function fetchSendgridSuppressions(
  _type: 'bounces' | 'blocks' | 'invalid_emails' | 'spam_reports' | 'unsubscribes',
): Promise<{ success: boolean; items?: Array<{ email: string; reason?: string }>; error?: string }> {
  return { success: true, items: [] };
}

/** Backwards-compat shim — Resend has no provider-side unsubscribe-group sync. */
export async function syncUnsubscribeGroups(): Promise<{ success: boolean; synced?: number; error?: string }> {
  return { success: true, synced: 0 };
}
