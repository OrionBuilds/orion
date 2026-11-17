import { supabase } from '../lib/supabase';
import type { EmailFromAddress } from '../types';

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

export async function getFromAddresses(orgId: string): Promise<EmailFromAddress[]> {
  const { data, error } = await supabase
    .from('email_from_addresses')
    .select(`
      *,
      domain:email_domains(id, domain, status)
    `)
    .eq('org_id', orgId)
    .order('created_at', { ascending: false });

  if (error) throw error;
  return data || [];
}

export async function createFromAddress(
  displayName: string,
  email: string,
  domainId: string,
  replyTo?: string,
): Promise<{ success: boolean; address?: EmailFromAddress; error?: string }> {
  const orgId = await getOrgId();
  if (!orgId) return { success: false, error: 'No organization' };

  // email_from_addresses is keyed by org_id and stores the address in `email`.
  const { data, error } = await supabase
    .from('email_from_addresses')
    .insert({
      org_id: orgId,
      email: email.trim(),
      display_name: displayName,
      domain_id: domainId || null,
      reply_to: replyTo ?? null,
      active: true,
    })
    .select()
    .single();

  if (error) return { success: false, error: error.message };
  return { success: true, address: data as EmailFromAddress };
}

export async function updateFromAddress(
  addressId: string,
  updates: { displayName?: string; replyTo?: string; active?: boolean },
): Promise<{ success: boolean; error?: string }> {
  const patch: Record<string, unknown> = {};
  if (updates.displayName !== undefined) patch.display_name = updates.displayName;
  if (updates.replyTo !== undefined) patch.reply_to = updates.replyTo;
  if (updates.active !== undefined) patch.active = updates.active;

  const { error } = await supabase
    .from('email_from_addresses')
    .update(patch)
    .eq('id', addressId);

  if (error) return { success: false, error: error.message };
  return { success: true };
}

export async function setDefaultFromAddress(
  addressId: string,
): Promise<{ success: boolean; error?: string }> {
  const orgId = await getOrgId();
  if (!orgId) return { success: false, error: 'No organization' };

  return markDefaultFromAddress(orgId, addressId, true);
}

/**
 * Keep `email_from_addresses.is_default` and `email_defaults.default_from_address_id` (what the
 * send paths read first) pointing at the same row.
 */
export async function markDefaultFromAddress(
  orgId: string,
  addressId: string | null,
  writeDefaults: boolean,
): Promise<{ success: boolean; error?: string }> {
  const { error: clearErr } = await supabase
    .from('email_from_addresses')
    .update({ is_default: false })
    .eq('org_id', orgId)
    .eq('is_default', true);
  if (clearErr) return { success: false, error: clearErr.message };

  if (addressId) {
    const { error } = await supabase
      .from('email_from_addresses')
      .update({ is_default: true })
      .eq('id', addressId)
      .eq('org_id', orgId);
    if (error) return { success: false, error: error.message };
  }

  if (writeDefaults) {
    const { error } = await supabase
      .from('email_defaults')
      .upsert({ org_id: orgId, default_from_address_id: addressId }, { onConflict: 'org_id' });
    if (error) return { success: false, error: error.message };
  }
  return { success: true };
}

export async function deleteFromAddress(
  addressId: string,
): Promise<{ success: boolean; error?: string }> {
  const { error } = await supabase.from('email_from_addresses').delete().eq('id', addressId);
  if (error) return { success: false, error: error.message };
  return { success: true };
}

/**
 * No-op under Resend. Resend has no sender-identity API — any address on a
 * verified domain can send — so there is nothing to sync from the provider.
 * Retained so callers (the From Addresses tab) keep compiling.
 */
export async function syncFromAddresses(): Promise<{ success: boolean; synced?: number; error?: string }> {
  return { success: true, synced: 0 };
}
