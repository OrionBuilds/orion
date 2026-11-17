/**
 * Bounce (NDR) detection for Microsoft mail.
 *
 * Graph's /me/sendMail answers 202 as soon as Exchange ACCEPTS a message, so "sent" never meant
 * "delivered". When Exchange later fails delivery (for example 550 5.7.708 on a tenant in the
 * high-risk delivery pool) the only trace is an "Undeliverable" message dropped in the mailbox's
 * own Inbox - which the contact-only sync used to skip silently. This turns that message into
 * a structured result the sync can surface.
 */
import type { ParsedGraphMessage } from "./ms-mail.ts";

export interface Ndr {
  /** Enhanced status code, e.g. "5.7.708"; null when the body has none. */
  code: string | null;
  /** Addresses the failed message was addressed to (best effort, max 10). */
  recipients: string[];
  /** One line from the NDR explaining the failure. */
  reason: string;
  /** True for tenant/IP level blocks (5.7.7xx, "traffic not accepted") rather than a bad recipient. */
  tenantBlock: boolean;
}

const SENDER = /^(postmaster|mailer-daemon|microsoftexchange[0-9a-f]*)@/i;
const SUBJECT = /^\s*(undeliverable|delivery status notification|mail delivery failed|returned mail)/i;
const CODE = /\b([45]\.\d{1,3}\.\d{1,3})\b/;
const EMAIL = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;

export function parseNdr(p: Pick<ParsedGraphMessage, "fromEmail" | "subject" | "body">, mailbox = ""): Ndr | null {
  if (!SENDER.test(p.fromEmail) && !SUBJECT.test(p.subject)) return null;
  const code = CODE.exec(p.body)?.[1] ?? null;
  // A real NDR carries a status code or says it could not be delivered; a human "Undeliverable" subject alone is not enough.
  if (!code && !/couldn'?t be delivered|was not delivered|delivery has failed|undeliverable/i.test(p.body)) return null;
  const me = mailbox.toLowerCase();
  const recipients = [...new Set((p.body.match(EMAIL) ?? []).map((e) => e.toLowerCase()))]
    .filter((e) => e !== me && !SENDER.test(e) && !/^(microsoftexchange|postmaster|mailer-daemon)/i.test(e)).slice(0, 10);
  const line = p.body.split(/\r?\n/).map((l) => l.trim()).find((l) => code && l.includes(code)) ??
    p.body.split(/\r?\n/).map((l) => l.trim()).find((l) => /couldn'?t be delivered|not delivered|failed/i.test(l)) ?? p.subject;
  const tenantBlock = /^5\.7\.7\d\d$/.test(code ?? "") || /traffic not accepted|high risk|block(ed)? list|restricted/i.test(p.body);
  return { code, recipients, reason: line.slice(0, 300), tenantBlock };
}

export function ndrNotification(n: Ndr, userId: string, externalId: string) {
  const to = n.recipients.length ? n.recipients.join(", ") : "a recipient";
  return {
    user_id: userId,
    type: "email_delivery_failed",
    title: n.tenantBlock ? "Microsoft is blocking your outgoing email" : "An email you sent was not delivered",
    body: n.tenantBlock
      ? `Delivery to ${to} failed (${n.code ?? "blocked"}). This is a block on the Microsoft 365 tenant, not on the recipient. Contact Microsoft support.`
      : `Delivery to ${to} failed${n.code ? ` (${n.code})` : ""}: ${n.reason}`,
    link: "/conversations",
    metadata: { external_id: externalId, code: n.code, recipients: n.recipients, tenant_block: n.tenantBlock },
  };
}
