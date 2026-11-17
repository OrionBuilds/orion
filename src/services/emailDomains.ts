import { supabase } from '../lib/supabase';
import { fetchEdge } from '../lib/edgeFunction';
import type { EmailDomain, EmailDomainDnsRecord } from '../types';

/**
 * Sending domains live in Resend; `email_domains` (keyed by `org_id`) mirrors them. Every
 * mutation goes through the `resend-domains` edge function, which checks the caller's
 * email.settings.manage permission and holds the Resend key.
 */
const SLUG = 'resend-domains';

/** Accepts both the stored shape ({type,host,value,valid}) and raw Resend records ({name,status}). */
export function normalizeDnsRecords(records: unknown): EmailDomainDnsRecord[] {
  if (!Array.isArray(records)) return [];
  return records.map((r: Record<string, unknown>) => ({
    type: String(r.type ?? ''),
    host: String(r.host ?? r.name ?? ''),
    value: String(r.value ?? ''),
    valid: r.valid === true || r.status === 'verified',
    record: typeof r.record === 'string' ? r.record : undefined,
    priority: typeof r.priority === 'number' ? r.priority : undefined,
    status: typeof r.status === 'string' ? r.status : undefined,
  }));
}

function normalizeDomain(row: EmailDomain): EmailDomain {
  return { ...row, dns_records: normalizeDnsRecords(row.dns_records) };
}

async function callDomains<T>(body: Record<string, unknown>): Promise<T & { error?: string; ok?: boolean }> {
  const response = await fetchEdge(SLUG, { body });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) {
    return { ...result, ok: false, error: result.error || `Request failed (HTTP ${response.status})` };
  }
  return result;
}

export async function getDomains(orgId: string): Promise<EmailDomain[]> {
  const { data, error } = await supabase
    .from('email_domains')
    .select('*')
    .eq('org_id', orgId)
    .order('created_at', { ascending: false });

  if (error) throw error;
  return ((data || []) as EmailDomain[]).map(normalizeDomain);
}

/** Registers the domain in Resend (POST /domains) and stores it with its DNS records. */
export async function addDomain(
  domain: string,
): Promise<{ success: boolean; domain?: EmailDomain; error?: string }> {
  const result = await callDomains<{ domain?: EmailDomain }>({ action: 'create', domain });
  if (result.error || !result.domain) return { success: false, error: result.error || 'Failed to add domain' };
  return { success: true, domain: normalizeDomain(result.domain) };
}

/** Asks Resend to re-check DNS, then refreshes the stored status + records. */
export async function verifyDomain(
  domainId: string,
): Promise<{ success: boolean; valid?: boolean; domain?: EmailDomain; error?: string }> {
  const result = await callDomains<{ valid?: boolean; domain?: EmailDomain }>({ action: 'verify', domainId });
  if (result.error) return { success: false, error: result.error };
  return {
    success: true,
    valid: !!result.valid,
    domain: result.domain ? normalizeDomain(result.domain) : undefined,
  };
}

/** Removes the domain from this list only; it stays registered in Resend. */
export async function deleteDomain(
  domainId: string,
): Promise<{ success: boolean; error?: string }> {
  const result = await callDomains<Record<string, never>>({ action: 'delete', domainId });
  if (result.error) return { success: false, error: result.error };
  return { success: true };
}

export async function syncDomains(): Promise<{ success: boolean; synced?: number; error?: string }> {
  const result = await callDomains<{ inserted?: number; updated?: number }>({ action: 'sync' });
  if (result.error) return { success: false, error: result.error };
  return { success: true, synced: (result.inserted ?? 0) + (result.updated ?? 0) };
}

export interface DomainTracking {
  trackOpens: boolean;
  trackClicks: boolean;
  /** 'resend' when Resend reported the domain settings, else the saved defaults. */
  source: 'resend' | 'defaults';
}

export async function getDomainTracking(): Promise<DomainTracking | null> {
  const result = await callDomains<Partial<DomainTracking>>({ action: 'get-tracking' });
  if (result.error || typeof result.trackOpens !== 'boolean' || typeof result.trackClicks !== 'boolean') return null;
  return { trackOpens: result.trackOpens, trackClicks: result.trackClicks, source: result.source === 'resend' ? 'resend' : 'defaults' };
}

/** PATCHes open/click tracking on the org's Resend domain(s) and saves the flags to email_defaults. */
export async function setDomainTracking(
  trackOpens: boolean,
  trackClicks: boolean,
): Promise<{ success: boolean; warning?: string; error?: string }> {
  const result = await callDomains<{ warning?: string }>({ action: 'set-tracking', trackOpens, trackClicks });
  if (result.error) return { success: false, error: result.error };
  return { success: true, warning: result.warning };
}
