/**
 * Pure helpers that decide whether an inbound email is a HUMAN writing to us, before anything is
 * acknowledged or dispatched on its back (ported from CLARA's mailFilters.ts + emailCommands.dmarcPassed).
 * The inbox is mostly robots (notification bots, lists, calendar invites, bounces); a domain or contact
 * match alone would have Clara acknowledging them and queuing work for them.
 */

/** Lowercased header name -> value. Graph returns [{name,value}]; the last duplicate wins, which for
 *  Authentication-Results is the receiving host's own (the one worth trusting). */
export type Headers = Record<string, string>;

export function headersFromGraph(list: { name?: string; value?: string }[] | undefined): Headers {
  const h: Headers = {};
  for (const x of list ?? []) if (x.name) h[x.name.toLowerCase()] = x.value ?? "";
  return h;
}

/**
 * Headers of a Gmail API message (payload.headers, top of the message first). A receiving host PREPENDS its
 * headers, so the FIRST of a name is the trustworthy one, and Authentication-Results counts only when it carries
 * Google's own authserv-id: anything lower down, or under another id, is text the sender could have written.
 */
export function headersFromGmail(list: { name?: string; value?: string }[] | undefined): Headers {
  const h: Headers = {};
  for (const x of list ?? []) {
    if (!x.name) continue;
    const name = x.name.toLowerCase(), value = x.value ?? "";
    if (name === "authentication-results" && !/^\s*mx\.google\.com\s*;/i.test(value)) continue;
    if (!(name in h)) h[name] = value;
  }
  return h;
}

/** Bare lowercased address out of a From header; a bare address passes through. */
export function senderEmail(from: string): string {
  const m = from.match(/<([^>]+)>/);
  return (m ? m[1] : from).trim().toLowerCase();
}

const AUTOMATED_LOCAL =
  /^(no-?reply|do-?not-?reply|notifications?|notify|alerts?|alerting|mailer-daemon|postmaster|bounces?|newsletter|digest|calendar-notification|system|automated|robot|updates?|billing|receipts?)([+._-]|$)/i;

export interface MailShape {
  from: string;
  subject: string;
  headers?: Headers;
  isCalendarInvite?: boolean;
}

/** Why this message is automated, or null when it looks like a person wrote it. */
export function automatedReason(m: MailShape): string | null {
  const h = m.headers;
  if (h) {
    if ("list-unsubscribe" in h || "list-id" in h || "list-post" in h) return "mailing list";
    if (/^(bulk|list|junk)$/i.test((h["precedence"] ?? "").trim())) return "precedence bulk";
    const auto = (h["auto-submitted"] ?? "").trim().toLowerCase();
    if (auto && auto !== "no") return "auto-submitted";
    if ("x-auto-response-suppress" in h || "x-google-group-id" in h || "x-mailer-daemon" in h) return "automated header";
    if (/^(?:multipart\/report|message\/delivery-status)/i.test(h["content-type"] ?? "")) return "delivery report";
  }
  if (m.isCalendarInvite) return "calendar";
  if (/^(?:invitation|updated invitation|accepted|tentatively accepted|declined|cancell?ed event|reminder):/i.test(m.subject.trim())) return "calendar";
  const local = senderEmail(m.from).split("@")[0] ?? "";
  if (AUTOMATED_LOCAL.test(local)) return `automated sender (${local})`;
  return null;
}

/**
 * True only when the RECEIVING mail host recorded dmarc=pass. Anything else (missing header, fail, none)
 * is false: a forgeable string must not authorize a reply to someone claiming to be a client.
 */
export function dmarcPassed(h: Headers): boolean {
  return /\bdmarc=pass\b/i.test(h["authentication-results"] ?? "");
}

/** `jordan@example.com` -> `j***@example.com`: enough to recognise, not enough to harvest. */
export function redactAddress(email: string): string {
  const e = senderEmail(email);
  const at = e.indexOf("@");
  return at < 1 ? "***" : `${e.slice(0, 1)}***@${e.slice(at + 1)}`;
}

/** Paid ads / marketing are not offered (2026-10-09): such asks go to the owner, never to an agent. */
export const PAID_ADS_MARKETING =
  /\b(paid (ads|advertising|search|social)|ad (budget|spend|campaigns?|copy|creatives?|sets?|accounts?|groups?)|ads campaigns?|(run|running|launch|launching|start|starting|buy|buying|boost|boosting) (some |more |new |our |the )?ads|ppc|adwords|(google|facebook|meta|instagram|linkedin|tiktok|youtube) ads|(email|marketing|drip|social) campaigns?|(monthly|weekly|email) newsletters?|(write|send|draft)(ing)? (a |an |the |our )?newsletters?|social media( posts?| management| ads)?|marketing|influencers?|boost(ed)? posts?|retargeting)\b/i;
export const isPaidAdsOrMarketing = (text: string) => PAID_ADS_MARKETING.test(text);

/** Strip quoted history and forwarded bodies, leaving what the sender typed. A SECURITY boundary: a
 *  third party's quoted text must never reach a model as if the client had said it. */
export function stripQuotedReply(body: string): string {
  const cutters = [
    /^-{2,}\s*Forwarded message\s*-{2,}/im, /^-{2,}\s*Original Message\s*-{2,}/im, /^On .{0,120}\bwrote:\s*$/im,
    /^From:\s.+$/im, /^_{10,}\s*$/m, /^>\s?/m,
  ];
  let cut = body.length;
  for (const re of cutters) { const m = re.exec(body); if (m && m.index < cut) cut = m.index; }
  return body.slice(0, cut).trim();
}
