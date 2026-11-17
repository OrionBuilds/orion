/**
 * Client-email triage (ported from CLARA's clientEmailTriage.ts) — Clara is the SOLE handler of
 * inbound client email. For each new email from a known client she:
 *   1. screens it as untrusted input (not a robot; DMARC must pass; prompt-injection screen; the body
 *      is DATA, never instructions),
 *   2. hands any engineering/site/SEO work to FRIDAY as a request tagged requested_by:'client' (so
 *      FRIDAY applies CLIENT authority and scope gates, never owner trust), with a sanitized summary,
 *   3. sends a short acknowledgement in-thread as Clara (owner CC'd),
 *   4. tells the owner what happened, including any hand-off that FAILED.
 * The mail may have arrived in Clara's own mailbox or in one of the owner's (Microsoft or Google): each message
 * is read through the mailbox it arrived in. Mail in anyone else's mailbox is left to them.
 * Paid ads / marketing asks are not offered: they become a task for the OWNER and the client is not
 * told FRIDAY has it. Kill switch: CLARA_CLIENT_TRIAGE=off.
 *
 * Nothing is marked handled before the work is done. Failures retry up to MAX_ATTEMPTS, then give up
 * loudly: the owner is told at once (not in a digest) to reply by hand.
 */
import type { SupabaseClient } from "npm:@supabase/supabase-js@2";
import type { Env } from "./phones.ts";
import type { NotifyRequest } from "./notify.ts";
import { type Headers, automatedReason, dmarcPassed, isPaidAdsOrMarketing, redactAddress, stripQuotedReply } from "./mail-filters.ts";
import { detectPromptInjection } from "./injection.ts";

export const MAX_PER_RUN = 5;
export const MAX_ATTEMPTS = 3;
export const MAX_ACKS_PER_CONTACT_PER_DAY = 3;
const WINDOW_DAYS = 3;

export const triageEnabled = (env: Env) => (env.get("CLARA_CLIENT_TRIAGE") ?? "on").trim().toLowerCase() !== "off";

/** `dispute`: the client is contesting an invoice or charge (amount, service, chargeback threat). Disputes are never acknowledged by Clara. */
export interface TriagePlan { tasks: { summary: string }[]; ownerAsk?: string; reply: string; dispute?: { note: string } }

/** Pure: model JSON -> plan. A "FRIDAY task" that is really paid-ads work becomes the owner ask. */
export function normalizeTriagePlan(j: { tasks?: unknown; owner_ask?: unknown; reply?: unknown; dispute?: unknown; dispute_summary?: unknown }): TriagePlan | null {
  const raw = Array.isArray(j.tasks) ? (j.tasks as { summary?: unknown }[]) : [];
  const valid = raw.filter((t) => typeof t.summary === "string" && t.summary.trim()).map((t) => t.summary as string);
  const tasks = valid.filter((s) => !isPaidAdsOrMarketing(s)).slice(0, 4).map((summary) => ({ summary: summary.trim() }));
  const asks = [typeof j.owner_ask === "string" ? j.owner_ask.trim() : "", ...valid.filter(isPaidAdsOrMarketing).map((s) => s.trim())].filter(Boolean);
  const reply = typeof j.reply === "string" ? j.reply.trim() : "";
  // A dispute is for the owner alone: the model may leave the (unused) acknowledgement empty and it must still be raised.
  if (!reply && j.dispute !== true) return null;
  // Only the model's explicit `true` raises a dispute. The flag can only HOLD reminders; nothing in this module clears one.
  const dispute = j.dispute === true ? { note: (typeof j.dispute_summary === "string" ? j.dispute_summary.trim() : "").slice(0, 300) || "Client disputes an invoice (see email)." } : undefined;
  return { tasks, reply, ...(asks.length ? { ownerAsk: asks.join("; ").slice(0, 300) } : {}), ...(dispute ? { dispute } : {}) };
}

interface MsgRow {
  id: string; organization_id: string; contact_id: string; subject: string | null; body: string; sent_at: string;
  metadata: { graph_message_id?: string; gmail_message_id?: string; from_email?: string; thread_id?: string } | null;
  mailbox_connection_id?: string | null; mailbox_google_connection_id?: string | null; mailbox_email?: string | null;
}

/** Where a stored message lives: which provider's mailbox it arrived in, and who to answer. */
export interface MailRef {
  provider: "microsoft" | "google";
  /** microsoft_oauth_master.id / google_oauth_master.id; null on rows stored before mailboxes were tracked. */
  connectionId: string | null;
  mailboxEmail: string | null;
  from: string;
  subject: string;
}

/** Pure: the provider message id and mailbox of a stored inbound email, or null when the row names neither. */
export function mailRefOf(m: Pick<MsgRow, "subject" | "metadata" | "mailbox_connection_id" | "mailbox_google_connection_id" | "mailbox_email">): { id: string; ref: MailRef } | null {
  const from = (m.metadata?.from_email ?? "").toLowerCase();
  const base = { mailboxEmail: m.mailbox_email?.toLowerCase() ?? null, from, subject: (m.subject ?? "").slice(0, 200) };
  if (!from) return null;
  if (m.metadata?.graph_message_id) return { id: m.metadata.graph_message_id, ref: { provider: "microsoft", connectionId: m.mailbox_connection_id ?? null, ...base } };
  if (m.metadata?.gmail_message_id) return { id: m.metadata.gmail_message_id, ref: { provider: "google", connectionId: m.mailbox_google_connection_id ?? null, ...base } };
  return null;
}

export interface TriageDeps {
  env: Env;
  orgId: string;
  now: Date;
  /** Owner's own addresses: mail from them is never client mail. */
  ownerEmails: string[];
  /** More addresses that are us, looked up once per run (every connected mailbox, every OS user). Optional. */
  internalEmails?: () => Promise<string[]>;
  /** False when the message sits in a mailbox Clara does not answer for (another user's): it is left alone. Optional = every mailbox. */
  handles?: (ref: MailRef) => Promise<boolean>;
  /** The message's internet headers, read from the mailbox it arrived in (`ref`). */
  fetchHeaders: (messageId: string, ref?: MailRef) => Promise<Headers>;
  plan: (i: { clientName: string; subject: string; body: string; history: string }) => Promise<TriagePlan | null>;
  sendAck: (messageId: string, text: string, ref?: MailRef) => Promise<void>;
  /** Hand work to FRIDAY. Returns false when it could not be queued. */
  handOff: (r: { title: string; body: string; source: Record<string, unknown> }) => Promise<boolean>;
  addOwnerTask: (title: string, details: string) => Promise<boolean>;
  /** Put the contact's open invoices on dispute hold (reminders stop). Returns how many were held. Optional: absent in older callers/tests. */
  markDisputed?: (contactId: string, note: string) => Promise<number>;
  notify: (r: NotifyRequest) => Promise<unknown>;
  /** File a finished message into the Archive folder (inbox zero, Clara's own mailbox only). Best-effort; never blocks triage. */
  archive?: (messageId: string, ref?: MailRef) => Promise<void>;
}

export interface TriageResult { handled: number; skipped: number; failed: number; acked: number; tasks: number; disputes: number }

async function recordState(db: SupabaseClient, orgId: string, id: string, status: "handled" | "skipped" | "failed" | "gave_up", outcome: string, attempts?: number, archive?: () => Promise<void>) {
  // Terminal outcomes leave the inbox (inbox zero); a retryable failure stays put. A failed move is not a failure of triage.
  if (archive && (status === "handled" || status === "skipped")) await archive().catch((e) => console.warn("[triage] archive failed:", (e as Error).message));
  await db.from("clara_email_triage").upsert(
    { message_id: id, organization_id: orgId, status, outcome: outcome.slice(0, 300), ...(attempts !== undefined ? { attempts } : {}), updated_at: new Date().toISOString() },
    { onConflict: "message_id" },
  );
}

export async function runClientEmailTriage(db: SupabaseClient, d: TriageDeps): Promise<TriageResult> {
  const res: TriageResult = { handled: 0, skipped: 0, failed: 0, acked: 0, tasks: 0, disputes: 0 };
  if (!triageEnabled(d.env)) return res;
  const since = new Date(d.now.getTime() - WINDOW_DAYS * 86_400_000).toISOString();
  const { data: msgs } = await db.from("messages").select("id, organization_id, contact_id, subject, body, sent_at, metadata, mailbox_connection_id, mailbox_google_connection_id, mailbox_email")
    .eq("organization_id", d.orgId).eq("channel", "email").eq("direction", "inbound").gte("sent_at", since).order("sent_at").limit(60);
  const { data: states } = await db.from("clara_email_triage").select("message_id, status, attempts, outcome").eq("organization_id", d.orgId);
  const state = new Map(((states ?? []) as { message_id: string; status: string; attempts: number; outcome: string | null }[]).map((s) => [s.message_id, s]));

  const ours = new Set(d.ownerEmails);
  if (d.internalEmails) for (const e of await d.internalEmails().catch(() => [] as string[])) ours.add(e.trim().toLowerCase());

  let worked = 0;
  for (const m of (msgs ?? []) as MsgRow[]) {
    if (worked >= MAX_PER_RUN) break;
    const st = state.get(m.id);
    if (st && st.status !== "failed") continue; // handled / skipped / gave_up: done
    const attempts = st?.attempts ?? 0;
    const at = mailRefOf(m);
    if (!at) { await recordState(db, d.orgId, m.id, "skipped", "no mailbox reference"); res.skipped++; continue; }
    const { id: gid, ref } = at;
    const from = ref.from;
    if (ours.has(from)) { await recordState(db, d.orgId, m.id, "skipped", "owner's own mail"); res.skipped++; continue; }
    if (d.handles && !(await d.handles(ref).catch(() => true))) { await recordState(db, d.orgId, m.id, "skipped", "another user's mailbox"); res.skipped++; continue; }
    worked++;
    const arch = d.archive ? () => d.archive!(gid, ref) : undefined;
    // Carried across this attempt's failure path so a hand-off made now is never repeated by the retry.
    let handedOff: string | null = st?.outcome?.startsWith("handed-off") ? st.outcome : null;

    const { data: c } = await db.from("contacts").select("first_name, last_name, company, status").eq("id", m.contact_id).maybeSingle();
    const contact = c as { first_name: string | null; last_name: string | null; company: string | null; status: string } | null;
    if (!contact || contact.status !== "active") { await recordState(db, d.orgId, m.id, "skipped", "contact inactive"); res.skipped++; continue; }
    const clientName = contact.company || `${contact.first_name ?? ""} ${contact.last_name ?? ""}`.trim() || redactAddress(from);
    const subject = (m.subject ?? "").slice(0, 200);

    try {
      let headers: Headers;
      try { headers = await d.fetchHeaders(gid, ref); } catch (e) { throw new Error(`headers unavailable: ${(e as Error).message}`); }
      const auto = automatedReason({ from, subject, headers });
      if (auto) { await recordState(db, d.orgId, m.id, "skipped", `automated: ${auto}`, undefined, arch); res.skipped++; continue; }
      if (!dmarcPassed(headers)) {
        await d.notify({ kind: "client.email.spoof", priority: "normal", text: `Email claiming to be ${clientName} failed DMARC — not replying. Check it manually.`, dedupeKey: `spoof:${m.id}` });
        await recordState(db, d.orgId, m.id, "skipped", "DMARC failed"); res.skipped++; continue;
      }

      const body = stripQuotedReply(m.body ?? "");
      const inj = detectPromptInjection(body, d.env);
      const { data: prior } = await db.from("messages").select("sent_at, body, direction, metadata").eq("contact_id", m.contact_id).eq("channel", "email").lt("sent_at", m.sent_at).order("sent_at", { ascending: false }).limit(6);
      const history = ((prior ?? []) as { sent_at: string; body: string; direction: string; metadata: { thread_id?: string } | null }[])
        .filter((p) => p.metadata?.thread_id && p.metadata.thread_id === m.metadata?.thread_id).reverse()
        .map((p) => `[${p.sent_at}] ${p.direction === "inbound" ? clientName : "Clara"}: ${stripQuotedReply(p.body ?? "").slice(0, 800)}`).join("\n");
      const plan = inj.hardBlock ? null : await d.plan({ clientName, subject, body, history });
      if (!plan) {
        await d.notify({ kind: "client.email.review", priority: "normal", text: `${clientName} emailed "${subject.slice(0, 80)}"${inj.hardBlock ? " (flagged suspicious, screened)" : ""}: I couldn't auto-triage it; take a look.`, dedupeKey: `review:${m.id}` });
        await recordState(db, d.orgId, m.id, "skipped", inj.hardBlock ? "injection screened" : "no plan"); res.skipped++; continue;
      }

      // A disputed invoice is a conversation for the owner: no acknowledgement, no hand-off, reminders held, owner told loudly.
      if (plan.dispute) {
        // A failed hold must NOT be reported as handled: the error reaches the retry path below.
        const held = d.markDisputed ? await d.markDisputed(m.contact_id, plan.dispute.note) : 0;
        await d.notify({
          kind: "client.email.dispute", priority: "critical", category: "revenue",
          text: `${clientName} looks to be disputing an invoice ("${subject.slice(0, 80)}"): ${plan.dispute.note} I did NOT reply and handed nothing off. ${held > 0 ? `${held} open invoice(s) are now on dispute hold, so reminders stopped.` : "I found no open invoice to hold."} Please answer them directly.`,
          dedupeKey: `dispute:${m.id}`,
        });
        await recordState(db, d.orgId, m.id, "handled", "dispute-escalated", undefined, arch);
        res.handled++; res.disputes++;
        continue;
      }

      // Hand-offs happen once: a retry after a failed acknowledgement must not duplicate them.
      const already = st?.outcome?.startsWith("handed-off") ?? false;
      const failures: string[] = [];
      let made = 0;
      if (!already) {
        for (const t of plan.tasks) {
          const ok = await d.handOff({
            title: `Client ${clientName} — ${t.summary}`.slice(0, 300),
            body: `${t.summary}\n\n(From a client email "${subject}" received ${m.sent_at}. Summary only: the client's raw text is intentionally not included.)`,
            source: { channel: "email", requested_by: "client", contact_id: m.contact_id, message_id: m.id, client_name: clientName, subject },
          }).catch(() => false);
          if (ok) made++; else failures.push(t.summary.slice(0, 60));
        }
        let ownerFailed = false;
        if (plan.ownerAsk) {
          const ok = await d.addOwnerTask(`${clientName}: ${plan.ownerAsk}`.slice(0, 200), `Client email "${subject}" asked about paid ads/marketing, which we no longer offer. Your call how to answer.`).catch(() => false);
          if (ok) made++; else ownerFailed = true;
        }
        if (ownerFailed) {
          // Never tell the client the owner has it when his task isn't on the list.
          await d.notify({ kind: "client.email.review", priority: "critical", category: "revenue", text: `${clientName} emailed "${subject.slice(0, 80)}" about paid ads/marketing: I couldn't add it to your list, so I haven't replied to them. Please answer directly.`, dedupeKey: `review:${m.id}` });
          await recordState(db, d.orgId, m.id, "skipped", "owner task unconfirmed, left for owner"); res.skipped++; continue;
        }
        res.tasks += made;
        if (made > 0 || plan.tasks.length === 0) {
          handedOff = `handed-off:${made}`;
          await recordState(db, d.orgId, m.id, "failed", handedOff, attempts); // checkpoint
        }
      }

      // Governor: a client mailing in a loop must not trigger an acknowledgement loop.
      const dayAgo = new Date(d.now.getTime() - 86_400_000).toISOString();
      const { data: recent } = await db.from("messages").select("id").eq("contact_id", m.contact_id).eq("channel", "email").eq("direction", "inbound").gte("sent_at", dayAgo);
      const ids = ((recent ?? []) as { id: string }[]).map((r) => r.id);
      let acksToday = 0;
      if (ids.length) {
        const { data: acked } = await db.from("clara_email_triage").select("message_id").in("message_id", ids).eq("outcome", "acknowledged");
        acksToday = ((acked ?? []) as unknown[]).length;
      }
      // Someone already wrote back in this thread after the client did (the owner by hand, or an acknowledgement
      // of a later message): a second "got it" would be noise. The work above is still handed off.
      const { data: later } = await db.from("messages").select("id, metadata").eq("contact_id", m.contact_id).eq("channel", "email").eq("direction", "outbound").gt("sent_at", m.sent_at).limit(20);
      const thread = m.metadata?.thread_id;
      const answered = !!thread && ((later ?? []) as { metadata: { thread_id?: string } | null }[]).some((o) => o.metadata?.thread_id === thread);
      let acknowledged = false;
      if (!answered && acksToday < MAX_ACKS_PER_CONTACT_PER_DAY) {
        await d.sendAck(gid, plan.reply, ref);
        acknowledged = true; res.acked++;
      }

      const agents = made > 0 || already ? " Work handed to FRIDAY." : "";
      const failNote = failures.length ? ` Hand-off FAILED for: ${failures.join("; ")}.` : "";
      await d.notify({
        kind: "client.email.handled", priority: failNote ? "normal" : "low",
        text: `${acknowledged ? "Acknowledged" : answered ? "Did not acknowledge (already answered in the thread)" : "Did not acknowledge (daily cap)"} ${clientName} re "${subject.slice(0, 80)}".${agents}${failNote}`, dedupeKey: `handled:${m.id}`,
      });
      await recordState(db, d.orgId, m.id, "handled", acknowledged ? "acknowledged" : "handled-no-ack", undefined, arch);
      res.handled++;
    } catch (e) {
      const next = attempts + 1;
      const gaveUp = next >= MAX_ATTEMPTS;
      await recordState(db, d.orgId, m.id, gaveUp ? "gave_up" : "failed", handedOff ?? `error: ${String(e).slice(0, 150)}`, next);
      // The last failure is the one the owner must act on: it reaches him at once. A retry is only worth the digest.
      await d.notify({
        kind: "client.email.failed", priority: gaveUp ? "critical" : "low", ...(gaveUp ? { category: "revenue" as const } : {}),
        text: `${clientName} emailed "${subject.slice(0, 80)}": I couldn't process it (${String((e as Error).message).slice(0, 120)}).${gaveUp ? " Giving up; please reply by hand." : " I'll retry."}`,
        dedupeKey: `failed:${m.id}:${gaveUp ? "final" : next}`,
      }).catch(() => {});
      res.failed++;
    }
  }
  return res;
}
