/**
 * "Is this sender one of your contacts?" The mail syncs keep only mail from known contact addresses, so a
 * client writing from an address we have never seen would vanish without a trace. When such a sender's display
 * name is exactly ONE active contact's name, we record a suggestion (mail_sender_suggestions) and the owner is
 * asked to confirm it. Nothing is linked or stored on a name alone: a display name is whatever the sender typed.
 */
import type { SupabaseClient } from "npm:@supabase/supabase-js@2";
import { automatedReason } from "./clara/mail-filters.ts";

export interface UnknownSender {
  orgId: string;
  email: string;
  name: string;
  subject: string;
  /** The mailbox the mail arrived in. */
  mailboxEmail: string;
  sentAt?: string | null;
}

const NAME_PART = /^\p{L}[\p{L}'.-]*$/u;
const domainOf = (e: string) => e.slice(e.lastIndexOf("@") + 1);
/** Shared mailbox providers: two addresses here are not colleagues. */
const FREE_MAIL = new Set(["gmail.com", "googlemail.com", "outlook.com", "hotmail.com", "live.com", "msn.com", "yahoo.com", "icloud.com", "me.com", "aol.com", "proton.me", "protonmail.com"]);

/**
 * Pure: the first and last name to look a sender up by, or null when the display name is not a plain person's
 * name ("Jordan Example", "Example, Jordan"). Only letters, apostrophes, dots and hyphens survive, so the
 * parts are safe to use in a case-insensitive match.
 */
export function senderNameParts(displayName: string, email = ""): { first: string; last: string } | null {
  let name = displayName.replace(/"/g, "").replace(/\s+/g, " ").trim();
  if (!name || name.includes("@") || name.toLowerCase() === email.toLowerCase()) return null;
  const comma = name.split(",");
  if (comma.length === 2 && comma[0].trim() && comma[1].trim()) name = `${comma[1].trim()} ${comma[0].trim()}`;
  const parts = name.split(" ");
  if (parts.length < 2 || parts.length > 4) return null;
  if (!parts.every((p) => NAME_PART.test(p))) return null;
  const first = parts[0], last = parts[parts.length - 1];
  if (first.length < 2 || last.length < 2) return null;
  return { first, last };
}

/**
 * Record (or refresh) a suggestion for an inbox sender who is not a contact. Returns what happened; never
 * throws (a suggestion must not break a mail sync).
 */
export async function suggestSenderAlias(db: SupabaseClient, s: UnknownSender): Promise<"created" | "updated" | "none"> {
  try {
    const email = s.email.trim().toLowerCase();
    const mailbox = s.mailboxEmail.trim().toLowerCase();
    if (!email.includes("@") || email === mailbox) return "none";
    if (domainOf(email) === domainOf(mailbox) && !FREE_MAIL.has(domainOf(email))) return "none"; // a colleague, not a client
    if (automatedReason({ from: email, subject: s.subject ?? "" })) return "none";
    const parts = senderNameParts(s.name ?? "", email);
    if (!parts) return "none";

    const { data: known } = await db.from("mail_sender_suggestions").select("id, status, message_count")
      .eq("organization_id", s.orgId).eq("email", email).limit(1).maybeSingle();
    const prior = known as { id: string; status: string; message_count: number | null } | null;
    const seenAt = s.sentAt ?? new Date().toISOString();
    if (prior) {
      if (prior.status !== "pending") return "none"; // answered once: never ask again
      await db.from("mail_sender_suggestions").update({
        message_count: (prior.message_count ?? 1) + 1, last_seen_at: seenAt, last_subject: (s.subject ?? "").slice(0, 200),
      }).eq("id", prior.id);
      return "updated";
    }

    const { data: matches } = await db.from("contacts").select("id")
      .eq("organization_id", s.orgId).eq("status", "active")
      .ilike("first_name", parts.first).ilike("last_name", parts.last).limit(2);
    const rows = (matches ?? []) as { id: string }[];
    if (rows.length !== 1) return "none"; // nobody, or two people with that name: not ours to guess

    const { error } = await db.from("mail_sender_suggestions").insert({
      organization_id: s.orgId, email, display_name: (s.name ?? "").trim().slice(0, 120), contact_id: rows[0].id,
      mailbox_email: mailbox, last_subject: (s.subject ?? "").slice(0, 200), first_seen_at: seenAt, last_seen_at: seenAt,
      status: "pending", message_count: 1,
    });
    return error ? "none" : "created";
  } catch (e) {
    console.warn("[sender-suggestions]", (e as Error).message);
    return "none";
  }
}
