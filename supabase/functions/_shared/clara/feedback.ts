/**
 * "How'd we do?" capture (ported from FRIDAY's feedback.ts). FRIDAY appends the ask to a client's
 * delivered-work email; this reads the client's reply from the synced mailbox in the OS.
 *
 * The parse is DETERMINISTIC (a digit 1-5, or a narrow word map on short replies). No model ever
 * judges sentiment. A score of 3 or less tells the owner right away; 4-5 waits for the brief.
 * The ask line is the marker: an outbound email carrying it opens a 14-day window in which the next
 * inbound email from that contact that parses as a score is recorded, once.
 */
import type { SupabaseClient } from "npm:@supabase/supabase-js@2";
import type { NotifyRequest } from "./notify.ts";

export const FEEDBACK_ASK_MARKER = "how'd we do on this one";
export const FEEDBACK_WINDOW_DAYS = 14;

const DIGIT_RE = /^\s*([1-5])\s*(?:\/\s*5)?\b/;
// Negatives FIRST: "not great" contains "great", and an unhappy client must never be scored a 5.
const WORD_MAP: Array<[RegExp, number]> = [
  [/\b(disappointed|poor|unhappy|not (great|good|happy)|bad)\b/i, 2],
  [/\b(amazing|fantastic|awesome|excellent|love(d)? it|great)\b/i, 5],
  [/\b(good|solid|happy|nice work)\b/i, 4],
  [/\b(okay|ok|fine|decent)\b/i, 3],
];

/** Digit wins; the word map only fires on SHORT replies (a long email containing "great" is conversation). */
export function parseFeedbackScore(text: string): { score: number; via: "digit" | "word" } | null {
  const t = stripQuoted(text ?? "").trim();
  if (!t) return null;
  const d = t.match(DIGIT_RE);
  if (d) return { score: Number(d[1]), via: "digit" };
  if (t.length <= 120) for (const [re, score] of WORD_MAP) if (re.test(t)) return { score, via: "word" };
  return null;
}

/** Only what the client typed: drop "On <date>, X wrote:" history and ">" quotes. */
export function stripQuoted(text: string): string {
  const cut = text.search(/\n\s*(On .{5,120} wrote:|-{2,}\s*Original Message\s*-{2,}|From:\s.+\nSent:)/i);
  const head = cut >= 0 ? text.slice(0, cut) : text;
  return head.split("\n").filter((l) => !l.trim().startsWith(">")).join("\n");
}

interface Msg { id: string; contact_id: string; direction: string; channel: string; body: string; sent_at: string }

export async function captureFeedbackReplies(
  db: SupabaseClient, d: { orgId: string; now: Date; notify: (r: NotifyRequest) => Promise<unknown> },
): Promise<{ recorded: number }> {
  const since = new Date(d.now.getTime() - FEEDBACK_WINDOW_DAYS * 86_400_000).toISOString();
  const { data: out } = await db.from("messages").select("id, contact_id, direction, channel, body, sent_at")
    .eq("organization_id", d.orgId).eq("channel", "email").eq("direction", "outbound").ilike("body", `%${FEEDBACK_ASK_MARKER}%`).gte("sent_at", since).limit(100);
  const asks = new Map<string, string>(); // contact -> earliest ask time inside the window
  for (const m of (out ?? []) as Msg[]) {
    if (!asks.has(m.contact_id) || m.sent_at < asks.get(m.contact_id)!) asks.set(m.contact_id, m.sent_at);
  }
  let recorded = 0;
  for (const [contactId, askedAt] of asks) {
    const { data: done } = await db.from("contact_timeline").select("event_data").eq("contact_id", contactId).eq("event_type", "feedback").limit(50);
    const seen = new Set(((done ?? []) as { event_data: { message_id?: string; asked_at?: string } }[]).map((r) => r.event_data?.asked_at));
    if (seen.has(askedAt)) continue; // this ask already got its answer
    const { data: ins } = await db.from("messages").select("id, contact_id, direction, channel, body, sent_at")
      .eq("contact_id", contactId).eq("channel", "email").eq("direction", "inbound").gte("sent_at", askedAt).order("sent_at").limit(10);
    for (const m of (ins ?? []) as Msg[]) {
      const parsed = parseFeedbackScore(m.body);
      if (!parsed) continue;
      const { data: c } = await db.from("contacts").select("first_name, last_name, company").eq("id", contactId).maybeSingle();
      const who = c ? `${(c as { first_name: string | null }).first_name ?? ""} ${(c as { last_name: string | null }).last_name ?? ""}`.trim() : "A client";
      await db.from("contact_timeline").insert({
        contact_id: contactId, event_type: "feedback",
        event_data: { score: parsed.score, via: parsed.via, text: stripQuoted(m.body).trim().slice(0, 500), message_id: m.id, asked_at: askedAt },
      });
      await d.notify({
        kind: "client.feedback", priority: parsed.score <= 3 ? "critical" : "normal", category: parsed.score <= 3 ? "revenue" : undefined,
        text: `${who} rated us ${parsed.score}/5${stripQuoted(m.body).trim().length > 3 ? `: "${stripQuoted(m.body).trim().replace(/\s+/g, " ").slice(0, 200)}"` : "."}${parsed.score <= 3 ? " Worth a personal follow-up." : ""}`,
        dedupeKey: `feedback:${m.id}`,
      }).catch(() => {});
      recorded++;
      break;
    }
  }
  return { recorded };
}
