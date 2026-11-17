/**
 * Which CRM contact an email address belongs to. A contact has one main address (contacts.email) and any
 * number of further ones (contact_emails): a client who writes from a personal address is still that client.
 * Every mail path (Graph sync, Gmail sync, the outbound log) resolves a counterpart through here, so they
 * agree on who a message is from.
 */
import type { SupabaseClient } from "npm:@supabase/supabase-js@2";

export interface MailContact { id: string; department_id: string | null; first_name: string | null; last_name: string | null }

const COLS = "id, department_id, first_name, last_name";

/** The active contact for `email` (main address first, then an alternate one), or null. */
export async function findContactByEmail(db: SupabaseClient, orgId: string, email: string): Promise<MailContact | null> {
  const addr = email.trim().toLowerCase();
  if (!addr) return null;
  const { data: main } = await db.from("contacts").select(COLS)
    .eq("organization_id", orgId).ilike("email", addr).eq("status", "active").maybeSingle();
  if (main) return main as MailContact;

  // contact_emails holds lowercased addresses, unique per organization. (Absent before its migration: no row.)
  const { data: alt } = await db.from("contact_emails").select("contact_id")
    .eq("organization_id", orgId).eq("email", addr).limit(1).maybeSingle();
  const contactId = (alt as { contact_id?: string } | null)?.contact_id;
  if (!contactId) return null;
  const { data: owner } = await db.from("contacts").select(COLS)
    .eq("organization_id", orgId).eq("id", contactId).eq("status", "active").maybeSingle();
  return (owner as MailContact | null) ?? null;
}
