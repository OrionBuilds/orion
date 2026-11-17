/**
 * One plain-text send as Clara for website visitors (lead-magnet delivery, contact acknowledgement).
 * Goes through the existing sendOrgEmail with the SITE_LEAD_BRAND brand (its sender row). Never throws:
 * the outcome comes back as a value so a failed email can never fail the webhook.
 */
import type { Db } from "./lead-intake.ts";
import { getUnsubscribeLink, type SendOrgEmailOptions, type SendOrgEmailResult } from "./email-defaults.ts";
import { brandFromEnv } from "./brands.ts";

export type SendSiteEmail = (db: Db, orgId: string, o: SendOrgEmailOptions) => Promise<SendOrgEmailResult>;

export interface EmailResult { status: "pending" | "sent" | "failed" | "suppressed" | "skipped"; attempts: number; at: string; message_id?: string; error?: string }

/** The owner's own mailbox (SITE_LEAD_REPLY_TO); Clara's sender address is not one the owner reads. Empty = no reply-to. */
export const DEFAULT_REPLY_TO = Deno.env.get("SITE_LEAD_REPLY_TO")?.trim() ?? "";

/** Brand that website leads and their emails are sent as (SITE_LEAD_BRAND, else the default brand). */
export const SITE_BRAND = brandFromEnv("SITE_LEAD_BRAND");

/** Who the website's emails say they reach: OWNER_FIRST_NAME, else "our team". */
export const siteOwner = () => Deno.env.get("OWNER_FIRST_NAME")?.trim() || "";

export interface SiteMailDeps {
  sendEmail: SendSiteEmail;
  orgId: string;
  unsubscribeLink?: typeof getUnsubscribeLink;
  replyTo?: string;
  /** Give up waiting after this long (default 2500 ms, under the site sink's 5 s budget). */
  timeoutMs?: number;
}

export const DEFAULT_SEND_TIMEOUT_MS = 2500;

export async function sendSiteMail(
  db: Db,
  deps: SiteMailDeps,
  m: { to: string; toName: string; contactId: string; category: string; args: Record<string, string>; prevAttempts?: number;
       build: (unsubscribeUrl: string | null) => { subject: string; text: string } },
): Promise<EmailResult> {
  const at = new Date().toISOString();
  const attempts = (m.prevAttempts ?? 0) + 1;
  try {
    const link = await (deps.unsubscribeLink ?? getUnsubscribeLink)(db, deps.orgId, m.to, { contactId: m.contactId }).catch(() => null);
    const mail = m.build(link?.pageUrl ?? null);
    const timeoutMs = deps.timeoutMs ?? DEFAULT_SEND_TIMEOUT_MS;
    let timer: number | undefined;
    const deadline = new Promise<"timeout">((resolve) => { timer = setTimeout(() => resolve("timeout"), timeoutMs); });
    const sending = deps.sendEmail(db, deps.orgId, {
      to: m.to,
      toName: m.toName,
      brand: SITE_BRAND, // Clara's sender (email_from_addresses.brand = SITE_LEAD_BRAND)
      contactId: m.contactId,
      replyTo: deps.replyTo || DEFAULT_REPLY_TO || undefined,
      subject: mail.subject,
      text: mail.text, // text only: nothing for an open-tracking pixel or click rewriting to attach to
      unsubscribeGroupId: null, // the unsubscribe link is minted above so it is always in the body
      customHeaders: link ? { "List-Unsubscribe": `<${link.oneClickUrl}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" } : undefined,
      categories: [m.category],
      customArgs: m.args,
    });
    sending.catch(() => {}); // if the deadline wins, a late rejection must not be unhandled
    const res = await Promise.race([sending, deadline]).finally(() => clearTimeout(timer));
    if (res === "timeout") return { status: "failed", attempts, at, error: `no answer from the mail provider after ${timeoutMs} ms (it may still have been sent)` };
    if (res.ok) return { status: "sent", attempts, at, message_id: res.messageId };
    if (res.suppressed) return { status: "suppressed", attempts, at };
    return { status: "failed", attempts, at, error: `${res.status}: ${res.error ?? "send failed"}`.slice(0, 300) };
  } catch (e) {
    return { status: "failed", attempts, at, error: (e instanceof Error ? e.message : String(e)).slice(0, 300) };
  }
}
