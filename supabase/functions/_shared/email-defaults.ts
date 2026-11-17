/**
 * Org email defaults for every Resend send path.
 *
 * Settings -> Email Services -> Defaults stores, per org (`email_defaults`, keyed by `org_id`):
 *   default_from_address_id -> email_from_addresses row used when a caller gives no sender
 *   default_reply_to        -> Reply-To when neither the caller nor the from address sets one
 *   default_unsubscribe_group_id -> when set, non-transactional mail gets a List-Unsubscribe
 *                              header + footer link, and suppressed recipients are skipped
 *   track_opens / track_clicks -> mirrored onto the Resend DOMAIN (Resend tracks per domain, not
 *                              per message); resend-domains `set-tracking` keeps them in sync
 *
 * `sendOrgEmail` is the one entry point: it resolves sender + reply-to from those defaults, checks
 * `suppressions` (the table email-unsubscribe and resend-webhook write), mints/reuses the
 * recipient's unsubscribe link (a `tracked_links` slug served by email-unsubscribe), and sends via
 * `sendResendEmail`. Pass `transactional: true` for mail the recipient must get regardless of
 * marketing consent (booking confirmations, sign-in codes, signature requests, internal alerts):
 * defaults still apply to from/reply-to, but no unsubscribe link is added and suppressions do not
 * block the send.
 */
import type { SupabaseClient } from "npm:@supabase/supabase-js@2";
import {
  getResendEnvCreds,
  resolveResendFrom,
  sendResendEmail,
  type SendResendEmailOptions,
  type SendResendEmailResult,
} from "./resend.ts";
import { resolveBrandSender, type Brand } from "./brands.ts";

// Accepts any supabase-js client version (callers pin different ones) and the test fake.
/* eslint-disable @typescript-eslint/no-explicit-any */
// deno-lint-ignore no-explicit-any
type Db = SupabaseClient<any, any, any> | { from: (t: string) => any };
/* eslint-enable @typescript-eslint/no-explicit-any */

export interface OrgEmailDefaults {
  /** Default sender (email_defaults.default_from_address_id, else the is_default from address). */
  fromAddressId: string | null;
  fromEmail: string | null;
  fromName: string | null;
  /** reply_to configured on that default from address. */
  fromReplyTo: string | null;
  /** email_defaults.default_reply_to */
  defaultReplyTo: string | null;
  unsubscribeGroup: { id: string; name: string } | null;
  trackOpens: boolean;
  trackClicks: boolean;
}

export const EMPTY_DEFAULTS: OrgEmailDefaults = {
  fromAddressId: null,
  fromEmail: null,
  fromName: null,
  fromReplyTo: null,
  defaultReplyTo: null,
  unsubscribeGroup: null,
  trackOpens: true,
  trackClicks: true,
};

export interface FromAddressRow {
  id: string;
  email: string;
  display_name: string | null;
  reply_to: string | null;
}

export async function loadOrgEmailDefaults(db: Db, orgId: string): Promise<OrgEmailDefaults> {
  const out: OrgEmailDefaults = { ...EMPTY_DEFAULTS };
  if (!orgId) return out;

  const { data: row } = await db
    .from("email_defaults")
    .select("default_from_address_id, default_reply_to, default_unsubscribe_group_id, track_opens, track_clicks")
    .eq("org_id", orgId)
    .maybeSingle();

  const d = row as {
    default_from_address_id: string | null;
    default_reply_to: string | null;
    default_unsubscribe_group_id: string | null;
    track_opens: boolean | null;
    track_clicks: boolean | null;
  } | null;

  if (d) {
    out.defaultReplyTo = d.default_reply_to?.trim() || null;
    out.trackOpens = d.track_opens ?? true;
    out.trackClicks = d.track_clicks ?? true;
  }

  let from: FromAddressRow | null = null;
  if (d?.default_from_address_id) {
    const { data } = await db
      .from("email_from_addresses")
      .select("id, email, display_name, reply_to")
      .eq("id", d.default_from_address_id)
      .eq("org_id", orgId)
      .eq("active", true)
      .maybeSingle();
    from = (data as FromAddressRow | null) ?? null;
  }
  if (!from) {
    const { data } = await db
      .from("email_from_addresses")
      .select("id, email, display_name, reply_to")
      .eq("org_id", orgId)
      .eq("active", true)
      .eq("is_default", true)
      .limit(1)
      .maybeSingle();
    from = (data as FromAddressRow | null) ?? null;
  }
  if (from) {
    out.fromAddressId = from.id;
    out.fromEmail = from.email;
    out.fromName = from.display_name?.trim() || null;
    out.fromReplyTo = from.reply_to?.trim() || null;
  }

  if (d?.default_unsubscribe_group_id) {
    const { data } = await db
      .from("email_unsubscribe_groups")
      .select("id, name")
      .eq("id", d.default_unsubscribe_group_id)
      .eq("org_id", orgId)
      .maybeSingle();
    const g = data as { id: string; name: string } | null;
    if (g) out.unsubscribeGroup = { id: g.id, name: g.name };
  }

  return out;
}

/** True when an active email suppression (unsubscribe / bounce / complaint / manual) exists. */
export async function isEmailSuppressed(db: Db, orgId: string, email: string): Promise<boolean> {
  const key = email.trim().toLowerCase();
  if (!orgId || !key) return false;
  const { data, error } = await db
    .from("suppressions")
    .select("id, expires_at")
    .eq("org_id", orgId)
    .eq("kind", "email")
    .eq("value_key", key)
    .in("channel", ["email", "all"])
    .limit(5);
  if (error) {
    console.error("[email-defaults] suppression lookup failed:", error.message);
    return false;
  }
  const now = Date.now();
  return ((data ?? []) as Array<{ expires_at: string | null }>).some(
    (r) => !r.expires_at || new Date(r.expires_at).getTime() > now,
  );
}

export function functionsBaseUrl(): string {
  return `${(Deno.env.get("SUPABASE_URL") ?? "").replace(/\/+$/, "")}/functions/v1`;
}

export function appBaseUrl(): string {
  return (
    Deno.env.get("APP_BASE_URL") ||
    Deno.env.get("APP_URL") ||
    Deno.env.get("PUBLIC_SITE_URL") ||
    "https://app.example.com"
  ).replace(/\/+$/, "");
}

function randomSlug(): string {
  const bytes = new Uint8Array(6);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export interface UnsubscribeLink {
  slug: string;
  /** RFC 8058 one-click target (POST unsubscribes; GET redirects to the confirm page). */
  oneClickUrl: string;
  /** Human confirm page in the app (footer link). */
  pageUrl: string;
}

/**
 * Reuse (or mint) the recipient's unsubscribe slug for this org. Rows live in `tracked_links`
 * with `metadata.kind = "unsubscribe"` — the same contract email-unsubscribe already serves —
 * plus `confirm: true`, which makes a GET show a confirm page instead of acting immediately
 * (link scanners prefetch GETs; only a POST unsubscribes).
 */
export async function getUnsubscribeLink(
  db: Db,
  orgId: string,
  email: string,
  opts: { contactId?: string | null; groupId?: string | null } = {},
): Promise<UnsubscribeLink | null> {
  const key = email.trim().toLowerCase();
  if (!orgId || !key) return null;
  const toLink = (slug: string): UnsubscribeLink => ({
    slug,
    oneClickUrl: `${functionsBaseUrl()}/email-unsubscribe/${slug}`,
    pageUrl: `${appBaseUrl()}/unsubscribe/${slug}`,
  });

  const { data: existing } = await db
    .from("tracked_links")
    .select("slug")
    .eq("org_id", orgId)
    .eq("is_active", true)
    .contains("metadata", { kind: "unsubscribe", email: key, confirm: true })
    .limit(1)
    .maybeSingle();
  const found = existing as { slug?: string } | null;
  if (found?.slug) return toLink(found.slug);

  for (let attempt = 0; attempt < 2; attempt++) {
    const slug = randomSlug();
    const link = toLink(slug);
    const { error } = await db.from("tracked_links").insert({
      org_id: orgId,
      slug,
      // Required by the table; email-unsubscribe ignores it and acts on metadata.
      destination_url: link.oneClickUrl,
      name: "Email unsubscribe",
      is_active: true,
      contact_id: opts.contactId ?? null,
      metadata: {
        kind: "unsubscribe",
        email: key,
        confirm: true,
        group_id: opts.groupId ?? null,
        source: "email_defaults",
      },
    });
    if (!error) return link;
    if (error.code !== "23505") {
      console.error("[email-defaults] unsubscribe link insert failed:", error.message);
      return null;
    }
  }
  return null;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** Append the unsubscribe footer to an HTML body (inside </body> when present). */
export function appendUnsubscribeHtml(html: string, url: string, senderName?: string | null): string {
  const who = senderName ? ` from ${escapeHtml(senderName)}` : "";
  const footer =
    `<div style="margin-top:24px;padding-top:12px;border-top:1px solid #e5e7eb;` +
    `font-family:Arial,Helvetica,sans-serif;font-size:12px;line-height:1.5;color:#6b7280;text-align:center">` +
    `You are receiving this email${who}. ` +
    `<a href="${escapeHtml(url)}" style="color:#6b7280;text-decoration:underline">Unsubscribe</a>` +
    `</div>`;
  const idx = html.toLowerCase().lastIndexOf("</body>");
  return idx >= 0 ? `${html.slice(0, idx)}${footer}${html.slice(idx)}` : `${html}${footer}`;
}

export function appendUnsubscribeText(text: string, url: string): string {
  return `${text.replace(/\s+$/, "")}\n\n--\nUnsubscribe: ${url}\n`;
}

export interface ResolvedSender {
  from: string;
  fromName?: string;
  replyTo?: string;
}

/**
 * Pure: pick sender + reply-to.
 *   from:     explicit from address row > caller `from` string > org default from > env default
 *   reply-to: caller > the chosen from address's reply_to > email_defaults.default_reply_to
 */
export function resolveSender(
  defaults: OrgEmailDefaults,
  env: { fromEmail: string; fromName: string | null },
  opts: { from?: string; fromName?: string; replyTo?: string; fromRow?: FromAddressRow | null },
): ResolvedSender {
  let from: string;
  let fromName: string | undefined;
  let rowReplyTo: string | null = null;

  if (opts.fromRow) {
    from = opts.fromRow.email;
    fromName = opts.fromName ?? opts.fromRow.display_name ?? defaults.fromName ?? env.fromName ?? undefined;
    rowReplyTo = opts.fromRow.reply_to?.trim() || null;
  } else if (opts.from && opts.from.trim()) {
    const r = resolveResendFrom(opts.from, {
      fromEmail: defaults.fromEmail ?? env.fromEmail,
      fromName: opts.fromName ?? defaults.fromName ?? env.fromName,
    });
    from = r.from;
    fromName = opts.fromName ?? r.fromName;
    if (defaults.fromEmail && from.toLowerCase() === defaults.fromEmail.toLowerCase()) {
      rowReplyTo = defaults.fromReplyTo;
    }
  } else if (defaults.fromEmail) {
    from = defaults.fromEmail;
    fromName = opts.fromName ?? defaults.fromName ?? env.fromName ?? undefined;
    rowReplyTo = defaults.fromReplyTo;
  } else {
    from = env.fromEmail;
    fromName = opts.fromName ?? env.fromName ?? undefined;
  }

  const replyTo = opts.replyTo?.trim() || rowReplyTo || defaults.defaultReplyTo || undefined;
  return { from, fromName: fromName || undefined, replyTo };
}

export interface SendOrgEmailOptions
  extends Omit<SendResendEmailOptions, "apiKey" | "from" | "fromName" | "trackOpens" | "trackClicks"> {
  /** "Name <addr>" or bare address. Omit to use the org default from address. */
  from?: string;
  fromName?: string;
  /** Explicit email_from_addresses row (must belong to the org and be active). */
  fromAddressId?: string | null;
  /** Skip unsubscribe link + suppression block (see module doc). */
  transactional?: boolean;
  /** Override the default unsubscribe group; null disables the link for this send. */
  unsubscribeGroupId?: string | null;
  /**
   * The contact this email goes to. Besides the unsubscribe link, it selects the
   * sender: with no explicit `from` / `fromAddressId`, the contact's brand sender
   * (email_from_addresses.brand) is used instead of the org default.
   */
  contactId?: string | null;
  /** Force a brand's sender (same rule as contactId, without loading the contact). */
  brand?: Brand | null;
  /** Pre-loaded defaults (avoids re-reading them in a loop). */
  defaults?: OrgEmailDefaults;
}

export interface SendOrgEmailResult extends SendResendEmailResult {
  suppressed?: boolean;
  from?: string;
  replyTo?: string;
  unsubscribeUrl?: string | null;
}

export async function sendOrgEmail(
  db: Db,
  orgId: string,
  opts: SendOrgEmailOptions,
): Promise<SendOrgEmailResult> {
  const creds = getResendEnvCreds();
  if (!creds) {
    return { ok: false, status: 503, error: "Resend is not configured (RESEND_API_KEY / RESEND_FROM_EMAIL)" };
  }
  if (!opts.to) return { ok: false, status: 400, error: "Missing 'to' address" };

  const defaults = opts.defaults ?? (await loadOrgEmailDefaults(db, orgId));

  let fromRow: FromAddressRow | null = null;
  if (opts.fromAddressId) {
    const { data } = await db
      .from("email_from_addresses")
      .select("id, email, display_name, reply_to")
      .eq("id", opts.fromAddressId)
      .eq("org_id", orgId)
      .eq("active", true)
      .maybeSingle();
    fromRow = (data as FromAddressRow | null) ?? null;
    if (!fromRow) return { ok: false, status: 404, error: "From address not found or inactive" };
  }

  // Client-facing mail: the contact's brand decides the sender unless the caller named one.
  let brandRow: FromAddressRow | null = null;
  if (!fromRow && !(opts.from && opts.from.trim()) && (opts.brand || opts.contactId)) {
    brandRow = (await resolveBrandSender(db, orgId, { brand: opts.brand, contactId: opts.contactId })).row;
  }
  // Callers often forward the org default display name; a brand sender keeps its own.
  const fromName = brandRow && opts.fromName && opts.fromName === defaults.fromName ? undefined : opts.fromName;

  const sender = resolveSender(defaults, creds, {
    from: opts.from,
    fromName,
    replyTo: opts.replyTo,
    fromRow: fromRow ?? brandRow,
  });

  let html = opts.html;
  let text = opts.text;
  const headers: Record<string, string> = { ...(opts.customHeaders ?? {}) };
  const categories = [...(opts.categories ?? [])];
  let unsubscribeUrl: string | null = null;

  if (!opts.transactional) {
    if (await isEmailSuppressed(db, orgId, opts.to)) {
      return {
        ok: false,
        status: 409,
        suppressed: true,
        error: `${opts.to} has unsubscribed or is suppressed; email not sent`,
        from: sender.from,
      };
    }

    const groupId = opts.unsubscribeGroupId !== undefined ? opts.unsubscribeGroupId : defaults.unsubscribeGroup?.id ?? null;
    const callerHasHeader = Object.keys(headers).some((h) => h.toLowerCase() === "list-unsubscribe");
    if (groupId && !callerHasHeader) {
      const link = await getUnsubscribeLink(db, orgId, opts.to, { contactId: opts.contactId, groupId });
      if (link) {
        unsubscribeUrl = link.pageUrl;
        headers["List-Unsubscribe"] = `<${link.oneClickUrl}>`;
        headers["List-Unsubscribe-Post"] = "List-Unsubscribe=One-Click";
        if (html) html = appendUnsubscribeHtml(html, link.pageUrl, sender.fromName);
        if (text) text = appendUnsubscribeText(text, link.pageUrl);
        const groupName = defaults.unsubscribeGroup?.id === groupId ? defaults.unsubscribeGroup.name : null;
        if (groupName) categories.push(groupName);
      }
    }
  }

  // The key is chosen by the sender's domain (RESEND_API_KEY__<DOMAIN>, else RESEND_API_KEY).
  const sendCreds = getResendEnvCreds(sender.from) ?? creds;
  const result = await sendResendEmail({
    ...opts,
    apiKey: sendCreds.apiKey,
    from: sender.from,
    fromName: sender.fromName,
    replyTo: sender.replyTo,
    html,
    text,
    categories: categories.length > 0 ? categories : undefined,
    customHeaders: Object.keys(headers).length > 0 ? headers : undefined,
  });

  if (!result.ok) console.error(`[sendOrgEmail] Resend ${result.status} from ${sender.from} via ${sendCreds.keyLabel}: ${result.error}`);
  return { ...result, from: sender.from, replyTo: sender.replyTo, unsubscribeUrl };
}
