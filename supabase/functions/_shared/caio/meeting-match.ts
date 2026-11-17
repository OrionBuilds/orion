/**
 * caio-meeting-watch logic: match OS meetings (meeting_transcriptions) to a CAIO engagement by attendee email, create the
 * source for the owner to clear, and notify. Read-only on meeting_transcriptions. A matched meeting NEVER becomes 'ready' on its
 * own: consent is the owner's to attest (the source starts 'needs_review'; the caio_source_before trigger enforces it too).
 */
import type { SupabaseClient } from "npm:@supabase/supabase-js@2";
import { cleanVtt, sha256Hex, processStatusFor } from "./ingest.ts";
import { scanPii } from "./pii.ts";

// deno-lint-ignore no-explicit-any
type Json = Record<string, any>;

export const MAX_PER_RUN = 25;
export const LOOKBACK_DAYS = 60;

/** Lower-case, trim, drop a "+tag" from the local part. Not an address -> "". */
export function normalizeEmail(e: unknown): string {
  const s = typeof e === "string" ? e.trim().toLowerCase().replace(/^mailto:/, "").replace(/^.*<([^>]+)>.*$/, "$1") : "";
  const m = /^([^@\s+]+)(?:\+[^@\s]*)?@([^@\s]+\.[^@\s]+)$/.exec(s);
  return m ? `${m[1]}@${m[2]}` : "";
}

export function participantEmails(participants: unknown, extra: unknown[] = []): Set<string> {
  const out = new Set<string>();
  const list = Array.isArray(participants) ? participants : [];
  for (const p of list) {
    const e = normalizeEmail(typeof p === "string" ? p : (p as Json)?.email);
    if (e) out.add(e);
  }
  for (const x of extra) { const e = normalizeEmail(x); if (e) out.add(e); }
  return out;
}

export interface EngagementEmails { id: string; client: string; emails: Set<string> }

/** The one engagement whose contact attended; two engagements matching is ambiguous -> no match (the owner links it). */
export function matchEngagement(attendees: Set<string>, engagements: EngagementEmails[]): { engagementId: string | null; client?: string; ambiguous?: boolean } {
  const hits = engagements.filter((e) => [...e.emails].some((m) => attendees.has(m)));
  if (hits.length === 1) return { engagementId: hits[0].id, client: hits[0].client };
  return { engagementId: null, ambiguous: hits.length > 1 };
}

export type Notify = (orgId: string, n: { kind: string; text: string; dedupeKey: string }) => Promise<void>;
const short = (s: unknown, n = 80) => String(s ?? "").replace(/\s+/g, " ").trim().slice(0, n) || "Untitled meeting";

export interface WatchResult { orgs: number; linked: number; needsLink: number; notified: number; errors: string[] }

export async function watchMeetings(db: SupabaseClient, o: { now: Date; notify: Notify; cap?: number }): Promise<WatchResult> {
  const res: WatchResult = { orgs: 0, linked: 0, needsLink: 0, notified: 0, errors: [] };
  let budget = o.cap ?? MAX_PER_RUN;
  const { data: engs } = await db.from("caio_engagements").select("id, org_id, client_legal_name, contact_id, status").eq("status", "active");
  const byOrg = new Map<string, Json[]>();
  for (const e of (engs ?? []) as Json[]) byOrg.set(e.org_id, [...(byOrg.get(e.org_id) ?? []), e]);
  const since = new Date(o.now.getTime() - LOOKBACK_DAYS * 86_400_000).toISOString();

  for (const [orgId, list] of byOrg) {
    if (budget <= 0) break;
    res.orgs++;
    const contactIds = list.map((e) => e.contact_id).filter(Boolean);
    const { data: contacts } = contactIds.length ? await db.from("contacts").select("id, email").in("id", contactIds) : { data: [] };
    const emailOf = new Map(((contacts ?? []) as Json[]).map((c) => [c.id, normalizeEmail(c.email)]));
    const engagements: (EngagementEmails & { contactId: string | null })[] = list.map((e) => ({
      id: e.id, client: String(e.client_legal_name || "the client"), contactId: e.contact_id ?? null,
      emails: new Set([emailOf.get(e.contact_id) ?? ""].filter(Boolean)),
    }));

    // meetings with a transcript, newest first, not yet seen by the watcher
    const { data: meetings } = await db.from("meeting_transcriptions").select("id, org_id, meeting_title, meeting_date, participants, transcript_text, contact_id")
      .eq("org_id", orgId).gte("meeting_date", since).order("meeting_date", { ascending: false }).limit(200);
    const recent = ((meetings ?? []) as Json[]).filter((m) => String(m.transcript_text ?? "").trim());
    const { data: seen } = recent.length ? await db.from("caio_meeting_links").select("meeting_transcription_id").in("meeting_transcription_id", recent.map((m) => m.id)) : { data: [] };
    const seenIds = new Set(((seen ?? []) as Json[]).map((s) => s.meeting_transcription_id));
    const fresh = recent.filter((m) => !seenIds.has(m.id)).slice(0, budget);
    budget -= fresh.length;

    for (const m of fresh) {
      try {
        const { data: tc } = await db.from("meeting_transcription_contacts").select("contact_id, participant_email").eq("meeting_transcription_id", m.id);
        const tcRows = (tc ?? []) as Json[];
        const attendees = participantEmails(m.participants, tcRows.map((r) => r.participant_email));
        const linkedContacts = new Set<string>([m.contact_id, ...tcRows.map((r) => r.contact_id)].filter(Boolean));
        // contact-link match counts as an email match for the engagement's contact
        const withContacts = engagements.map((e) => ({ ...e, emails: e.contactId && linkedContacts.has(e.contactId) ? new Set([...e.emails, ...attendees]) : e.emails }));
        const hit = matchEngagement(attendees, withContacts);

        if (!hit.engagementId) {
          const { error } = await db.from("caio_meeting_links").insert({ org_id: orgId, meeting_transcription_id: m.id, state: "needs_link" });
          if (error && error.code !== "23505") throw new Error(error.message);
          res.needsLink++;
          continue;
        }
        const text = cleanVtt(String(m.transcript_text));
        const pii = scanPii(text);
        const hash = await sha256Hex(text);
        const { data: src, error: sErr } = await db.from("caio_sources").insert({
          org_id: orgId, engagement_id: hit.engagementId, kind: "transcript", title: short(m.meeting_title, 160), meeting_transcription_id: m.id,
          text_content: text, text_hash: hash, pii_flags: pii, extraction_status: "pending",
          // consent not attested: never 'ready' here
          process_status: processStatusFor({ pii, consent: false, fromMeeting: true, attested: false }),
        }).select("id").maybeSingle();
        const duplicate = sErr?.code === "23505";
        if (sErr && !duplicate) throw new Error(sErr.message);
        const { error: lErr } = await db.from("caio_meeting_links").insert({
          org_id: orgId, meeting_transcription_id: m.id, engagement_id: hit.engagementId, state: "linked", match_method: "email",
          source_id: (src as Json | null)?.id ?? null, last_error: duplicate ? "duplicate_text" : null,
        });
        if (lErr && lErr.code !== "23505") throw new Error(lErr.message);
        res.linked++;
      } catch (e) {
        res.errors.push(`${String(m.id).slice(0, 8)}: ${(e as Error).message.slice(0, 120)}`);
      }
    }

    // linked meetings: one notice each (they are about a client the owner is working with)
    const { data: pending } = await db.from("caio_meeting_links").select("id, meeting_transcription_id, engagement_id, state, owner_notified_at, source_id").eq("org_id", orgId).is("owner_notified_at", null);
    const rows = (pending ?? []) as Json[];
    for (const l of rows.filter((x) => x.state === "linked").slice(0, MAX_PER_RUN)) {
      const { data: mt } = await db.from("meeting_transcriptions").select("meeting_title").eq("id", l.meeting_transcription_id).maybeSingle();
      const title = short((mt as Json | null)?.meeting_title);
      const eng = engagements.find((e) => e.id === l.engagement_id);
      if (!l.source_id) { await db.from("caio_meeting_links").update({ owner_notified_at: o.now.toISOString() }).eq("id", l.id); continue; }
      const text = `"${title}" looks like a ${eng?.client ?? "client"} interview: confirm you may process it (CAIO > Sources).`;
      try {
        await o.notify(orgId, { kind: "caio.meeting", text, dedupeKey: `caio-meeting:${l.meeting_transcription_id}` });
        await db.from("caio_meeting_links").update({ owner_notified_at: o.now.toISOString() }).eq("id", l.id);
        res.notified++;
      } catch (e) { res.errors.push(`notify: ${(e as Error).message.slice(0, 120)}`); }
    }
    // unmatched meetings are mostly not CAIO work: ONE summary notice per day, never one per meeting
    const unmatched = rows.filter((x) => x.state === "needs_link");
    if (unmatched.length) {
      try {
        await o.notify(orgId, {
          kind: "caio.meeting", dedupeKey: `caio-meetings-unmatched:${o.now.toISOString().slice(0, 10)}`,
          text: `${unmatched.length} recent meeting transcript${unmatched.length === 1 ? "" : "s"} did not match a CAIO client. If any is a client interview, link it in CAIO > Sources; otherwise ignore this.`,
        });
        await db.from("caio_meeting_links").update({ owner_notified_at: o.now.toISOString() }).in("id", unmatched.map((x) => x.id));
        res.notified++;
      } catch (e) { res.errors.push(`notify: ${(e as Error).message.slice(0, 120)}`); }
    }
  }
  return res;
}
