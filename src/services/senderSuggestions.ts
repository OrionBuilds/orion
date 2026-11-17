/**
 * mail_sender_suggestions: someone wrote in from an address that is not on any contact, and their display
 * name is exactly one contact's name. Until a person confirms it, mail from that address is not stored or
 * handled. Accepting adds the address to the contact (contact_emails); their mail is then pulled in.
 */
import { supabase } from '../lib/supabase';

export interface SenderSuggestion {
  id: string;
  email: string;
  display_name: string | null;
  contact_id: string;
  contact_name: string;
  company: string | null;
  last_subject: string | null;
  message_count: number;
  last_seen_at: string;
}

type Row = Omit<SenderSuggestion, 'contact_name' | 'company'> & {
  contact: { first_name: string | null; last_name: string | null; company: string | null } | null;
};

/** PostgREST / Postgres codes for "this table or function is not there": the feature's migration is not applied yet. */
const NOT_THERE = new Set(['PGRST205', 'PGRST202', '42P01', '42883']);
const notThere = (e: { code?: string } | null) => !!e?.code && NOT_THERE.has(e.code);

/** Pure: what to show for one suggestion. */
export function suggestionText(s: Pick<SenderSuggestion, 'contact_name' | 'display_name' | 'email' | 'company' | 'last_subject' | 'message_count'>): { title: string; detail: string } {
  const who = s.contact_name || s.display_name || 'Someone';
  const subject = (s.last_subject ?? '').trim();
  const parts = [
    s.company || null,
    s.message_count > 1 ? `${s.message_count} emails` : null,
    subject ? `"${subject.length > 60 ? `${subject.slice(0, 59)}…` : subject}"` : null,
  ].filter(Boolean);
  return { title: `${who} wrote from ${s.email}`, detail: parts.length ? parts.join(' · ') : 'Not on their contact yet' };
}

/** Open suggestions, most recent first. Empty before the feature's migration is applied. */
export async function listSenderSuggestions(orgId: string, limit = 3): Promise<SenderSuggestion[]> {
  const { data, error } = await supabase
    .from('mail_sender_suggestions')
    .select('id, email, display_name, contact_id, last_subject, message_count, last_seen_at, contact:contacts(first_name, last_name, company)')
    .eq('organization_id', orgId)
    .eq('status', 'pending')
    .order('last_seen_at', { ascending: false })
    .limit(limit);
  if (error) {
    if (notThere(error)) return [];
    throw error;
  }
  return ((data ?? []) as unknown as Row[]).map(({ contact, ...s }) => ({
    ...s,
    contact_name: `${contact?.first_name ?? ''} ${contact?.last_name ?? ''}`.trim(),
    company: contact?.company ?? null,
  }));
}

/** Accept (add the address to the contact) or ignore (never ask about this address again). */
export async function resolveSenderSuggestion(id: string, accept: boolean): Promise<void> {
  const { error } = await supabase.rpc('resolve_sender_suggestion', { p_id: id, p_accept: accept });
  if (error) throw error;
}
