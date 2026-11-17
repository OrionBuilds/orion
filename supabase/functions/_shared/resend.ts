/**
 * Shared Resend helper (replaces the former SendGrid helper).
 *
 * All platform outbound email flows through `sendResendEmail`, using
 * platform-wide env credentials (RESEND_API_KEY, RESEND_FROM_EMAIL,
 * RESEND_FROM_NAME).
 *
 * One key per sending domain. Resend keys are scoped to the team (and
 * optionally the domain) they were created in, so an address on another
 * domain needs its own key. Convention, resolved by `resolveResendApiKey`:
 *
 *   RESEND_API_KEY                         default key (any domain not listed below)
 *   RESEND_API_KEY__EXAMPLE_COM            key for *.example.com senders
 *   RESEND_API_KEY__MAIL_EXAMPLE_ORG       key for mail.example.org senders (exact wins over parent)
 *
 * The suffix is the domain upper-cased with every non-alphanumeric character
 * replaced by `_`; the exact sending domain is tried first, then each parent
 * down to the registrable domain. `RESEND_WEBHOOK_SECRET__<DOMAIN>` follows the
 * same rule for the Svix secret of that team's webhook (resend-webhook tries
 * every configured secret).
 *
 * Resend API reference: https://resend.com/docs/api-reference/emails/send-email
 */

/** Minimal env reader so the resolvers can be tested without touching Deno.env. */
export interface EnvReader {
  get(name: string): string | undefined;
}

export interface ResendKey {
  apiKey: string;
  /** "RESEND_API_KEY" or the per-domain variable name, for logs (never the value). */
  label: string;
}

/** Domain of an address ("a@b.c" -> "b.c"); a bare domain is returned as-is. */
export function resendDomainOf(addressOrDomain: string | null | undefined): string | null {
  if (!addressOrDomain) return null;
  const s = String(addressOrDomain).trim().toLowerCase();
  const inner = /<([^>]+)>/.exec(s)?.[1] ?? s;
  const at = inner.lastIndexOf("@");
  const domain = (at >= 0 ? inner.slice(at + 1) : inner).trim();
  return /^[a-z0-9.-]+\.[a-z0-9-]+$/.test(domain) ? domain : null;
}

/** Candidate env names for a domain, most specific first (mail.x.com -> MAIL_X_COM, X_COM). */
export function resendEnvNamesFor(prefix: string, domain: string): string[] {
  const labels = domain.toLowerCase().split(".").filter(Boolean);
  const names: string[] = [];
  for (let i = 0; i <= labels.length - 2; i++) {
    const suffix = labels.slice(i).join(".").toUpperCase().replace(/[^A-Z0-9]/g, "_");
    names.push(`${prefix}__${suffix}`);
  }
  return names;
}

/**
 * The Resend key to use for a sender: the most specific `RESEND_API_KEY__<DOMAIN>`
 * for the address's domain or a parent, else `RESEND_API_KEY`. Null when none is set.
 */
export function resolveResendApiKey(
  addressOrDomain: string | null | undefined,
  env: EnvReader = Deno.env,
): ResendKey | null {
  const domain = resendDomainOf(addressOrDomain);
  if (domain) {
    for (const name of resendEnvNamesFor("RESEND_API_KEY", domain)) {
      const v = env.get(name)?.trim();
      if (v) return { apiKey: v, label: name };
    }
  }
  const def = env.get("RESEND_API_KEY")?.trim();
  return def ? { apiKey: def, label: "RESEND_API_KEY" } : null;
}

/** Every configured key (default + per-domain), for listing/validating domains across teams. */
export function listResendApiKeys(envObj: Record<string, string> = Deno.env.toObject()): ResendKey[] {
  const keys: ResendKey[] = [];
  const seen = new Set<string>();
  const push = (label: string, v: string | undefined) => {
    const apiKey = v?.trim();
    if (!apiKey || seen.has(apiKey)) return;
    seen.add(apiKey);
    keys.push({ apiKey, label });
  };
  push("RESEND_API_KEY", envObj.RESEND_API_KEY);
  for (const name of Object.keys(envObj).filter((k) => k.startsWith("RESEND_API_KEY__")).sort()) push(name, envObj[name]);
  return keys;
}

/** Every configured Svix webhook secret (default + per-domain), tried in turn by resend-webhook. */
export function listResendWebhookSecrets(envObj: Record<string, string> = Deno.env.toObject()): string[] {
  const out: string[] = [];
  const push = (v: string | undefined) => {
    const s = v?.trim();
    if (s && !out.includes(s)) out.push(s);
  };
  push(envObj.RESEND_WEBHOOK_SECRET);
  for (const name of Object.keys(envObj).filter((k) => k.startsWith("RESEND_WEBHOOK_SECRET__")).sort()) push(envObj[name]);
  return out;
}

export const RESEND_SEND_URL = "https://api.resend.com/emails";
const RESEND_API_BASE = "https://api.resend.com";

export interface ResendAttachment {
  filename: string;
  /** base64-encoded content (or a UTF-8 string for text parts like .ics) */
  content: string;
  contentType?: string;
}

export interface SendResendEmailOptions {
  apiKey: string;
  from: string;
  fromName?: string;
  /** One address, or several (Resend accepts up to 50). */
  to: string | string[];
  toName?: string;
  subject: string;
  html?: string;
  text?: string;
  replyTo?: string;
  cc?: string[];
  bcc?: string[];
  /**
   * Kept for source-compatibility with the old SendGrid helper. Resend has no
   * per-message open/click tracking API (it's configured per-domain — see
   * updateResendDomainTracking / resend-domains `set-tracking`), so these flags
   * are accepted but ignored.
   */
  trackOpens?: boolean;
  trackClicks?: boolean;
  /** Mapped to Resend tags (sanitized). */
  categories?: string[];
  customHeaders?: Record<string, string>;
  /** Mapped to Resend tags (sanitized name/value). */
  customArgs?: Record<string, string>;
  attachments?: ResendAttachment[];
}

export interface SendResendEmailResult {
  ok: boolean;
  status: number;
  messageId?: string;
  error?: string;
}

/** Resend tag names/values may only contain ASCII letters, numbers, `_` or `-` (<=256 chars). */
function sanitizeTag(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 256);
}

function buildTags(
  categories?: string[],
  customArgs?: Record<string, string>,
): Array<{ name: string; value: string }> | undefined {
  const tags: Array<{ name: string; value: string }> = [];
  const seen = new Set<string>();
  const push = (name: string, value: string) => {
    const n = sanitizeTag(name);
    const v = sanitizeTag(value) || "1";
    if (!n || seen.has(n) || tags.length >= 10) return;
    seen.add(n);
    tags.push({ name: n, value: v });
  };
  for (const c of categories ?? []) {
    if (c) push(c, "1");
  }
  for (const [k, val] of Object.entries(customArgs ?? {})) {
    if (k) push(k, String(val ?? ""));
  }
  return tags.length > 0 ? tags : undefined;
}

/**
 * Send a single transactional email via Resend.
 *
 * Resend returns 200 with a JSON body `{ id }` on success; we surface `id`
 * as `messageId` so callers can persist it as `external_id` for the webhook.
 */
export async function sendResendEmail(
  opts: SendResendEmailOptions,
): Promise<SendResendEmailResult> {
  if (!opts.html && !opts.text) {
    return { ok: false, status: 400, error: "Email body required (html or text)" };
  }
  if (!opts.from) return { ok: false, status: 400, error: "Missing 'from' address" };
  const toList = (Array.isArray(opts.to) ? opts.to : [opts.to]).filter(Boolean);
  if (toList.length === 0) return { ok: false, status: 400, error: "Missing 'to' address" };

  const payload: Record<string, unknown> = {
    from: opts.fromName ? `${opts.fromName} <${opts.from}>` : opts.from,
    to: toList,
    subject: opts.subject,
  };
  if (opts.html) payload.html = opts.html;
  if (opts.text) payload.text = opts.text;
  if (opts.replyTo) payload.reply_to = opts.replyTo;
  if (opts.cc && opts.cc.length > 0) payload.cc = opts.cc;
  if (opts.bcc && opts.bcc.length > 0) payload.bcc = opts.bcc;
  if (opts.customHeaders && Object.keys(opts.customHeaders).length > 0) {
    payload.headers = { ...opts.customHeaders };
  }
  if (opts.attachments && opts.attachments.length > 0) {
    payload.attachments = opts.attachments.map((a) => ({
      filename: a.filename,
      content: a.content,
      ...(a.contentType ? { content_type: a.contentType } : {}),
    }));
  }
  const tags = buildTags(opts.categories, opts.customArgs);
  if (tags) payload.tags = tags;

  let response: Response;
  try {
    response = await fetch(RESEND_SEND_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${opts.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Resend request failed";
    return { ok: false, status: 0, error: message };
  }

  if (!response.ok) {
    let errorMessage = `Resend API error ${response.status}`;
    try {
      const data = await response.json();
      if (typeof data?.message === "string") errorMessage = data.message;
      else if (typeof data?.name === "string") errorMessage = data.name;
    } catch {
      try {
        const text = await response.text();
        if (text) errorMessage = text;
      } catch {
        // ignore
      }
    }
    return { ok: false, status: response.status, error: errorMessage };
  }

  let messageId: string | undefined;
  try {
    const data = await response.json();
    if (typeof data?.id === "string") messageId = data.id;
  } catch {
    // ignore — success without a parseable body
  }
  return { ok: true, status: response.status, messageId };
}

/**
 * Read Resend credentials from platform-wide env vars. Returns null if the
 * required keys are missing — callers should record a failed-status message
 * row rather than throwing.
 *
 * `forAddress` picks the per-domain key for that sender (see the header);
 * without it, or when no per-domain key matches, the default key is used.
 */
export function getResendEnvCreds(forAddress?: string | null): {
  apiKey: string;
  /** Which env var supplied apiKey ("RESEND_API_KEY" or RESEND_API_KEY__<DOMAIN>). */
  keyLabel: string;
  fromEmail: string;
  fromName: string | null;
  webhookSecret: string | null;
} | null {
  const key = resolveResendApiKey(forAddress ?? null);
  const fromEmail = Deno.env.get("RESEND_FROM_EMAIL");
  if (!key || !fromEmail) return null;
  return {
    apiKey: key.apiKey,
    keyLabel: key.label,
    fromEmail,
    fromName: Deno.env.get("RESEND_FROM_NAME") ?? null,
    webhookSecret: Deno.env.get("RESEND_WEBHOOK_SECRET") ?? null,
  };
}

/**
 * Parse a "Display Name <addr@domain>" (or bare "addr@domain") sender string
 * into Resend's `from` + `fromName`, falling back to the platform default
 * sender (creds.fromEmail / creds.fromName) for any missing part.
 */
export function resolveResendFrom(
  from: string,
  creds: { fromEmail: string; fromName: string | null },
): { from: string; fromName?: string } {
  const m = from.match(/^\s*"?([^"<]+?)"?\s*<\s*([^>]+?)\s*>\s*$/);
  const parsed: { email: string; name?: string } = m
    ? { name: m[1].trim(), email: m[2].trim() }
    : { email: from.trim() };
  return {
    // Any address on the verified domain (e.g. mail.example.com) can send;
    // fall back to the platform default sender.
    from: parsed.email || creds.fromEmail,
    fromName: parsed.name ?? creds.fromName ?? undefined,
  };
}

/**
 * Convert raw attachments (string or bytes) into Resend attachments with
 * base64-encoded content. Returns undefined for a missing/empty list.
 */
export function toResendAttachments(
  attachments?: Array<{ filename: string; content: string | Uint8Array; contentType?: string }>,
): ResendAttachment[] | undefined {
  if (!attachments || attachments.length === 0) return undefined;
  return attachments.map((a) => ({
    filename: a.filename,
    content: toBase64Content(a.content),
    contentType: a.contentType,
  }));
}

function toBase64Content(content: string | Uint8Array): string {
  if (typeof content === "string") {
    return btoa(unescape(encodeURIComponent(content)));
  }
  let bin = "";
  for (let i = 0; i < content.length; i++) bin += String.fromCharCode(content[i]);
  return btoa(bin);
}

async function resendGet(
  apiKey: string,
  path: string,
): Promise<{ ok: boolean; status: number; data?: unknown; error?: string }> {
  try {
    const response = await fetch(`${RESEND_API_BASE}${path}`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (!response.ok) {
      let err = `Resend API error ${response.status}`;
      try {
        const data = await response.json();
        if (typeof data?.message === "string") err = data.message;
      } catch {
        // ignore
      }
      return { ok: false, status: response.status, error: err };
    }
    const data = await response.json().catch(() => null);
    return { ok: true, status: response.status, data };
  } catch (e) {
    const message = e instanceof Error ? e.message : "Resend request failed";
    return { ok: false, status: 0, error: message };
  }
}

/** Validate the Resend API key by listing domains (200 = valid). */
export async function validateResendCredentials(
  apiKey: string,
): Promise<{ valid: boolean; status: number; error?: string }> {
  const result = await resendGet(apiKey, "/domains");
  if (!result.ok) return { valid: false, status: result.status, error: result.error };
  return { valid: true, status: result.status };
}

export interface ResendDomain {
  id: string;
  name: string;
  status: string; // "verified" | "pending" | "not_started" | "failure" | "temporary_failure"
  records?: Array<Record<string, unknown>>;
}

/** List Resend sending domains. */
export async function listResendDomains(
  apiKey: string,
): Promise<{ ok: boolean; domains: ResendDomain[]; error?: string }> {
  const result = await resendGet(apiKey, "/domains");
  if (!result.ok) return { ok: false, domains: [], error: result.error };
  const data = result.data as { data?: ResendDomain[] } | ResendDomain[];
  const arr = Array.isArray(data) ? data : data?.data ?? [];
  return { ok: true, domains: arr };
}

/** Full domain object (GET /domains/:id, POST /domains). Tracking flags appear on newer API versions. */
export interface ResendDomainDetail extends ResendDomain {
  region?: string;
  open_tracking?: boolean;
  click_tracking?: boolean;
}

async function resendSend(
  apiKey: string,
  method: "POST" | "PATCH" | "DELETE",
  path: string,
  body?: unknown,
): Promise<{ ok: boolean; status: number; data?: unknown; error?: string }> {
  try {
    const response = await fetch(`${RESEND_API_BASE}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const data = await response.json().catch(() => null);
    if (!response.ok) {
      const d = data as { message?: string; name?: string } | null;
      return { ok: false, status: response.status, error: d?.message ?? d?.name ?? `Resend API error ${response.status}` };
    }
    return { ok: true, status: response.status, data };
  } catch (e) {
    return { ok: false, status: 0, error: e instanceof Error ? e.message : "Resend request failed" };
  }
}

/** POST /domains — register a sending domain; the response carries the DNS records to publish. */
export async function createResendDomain(
  apiKey: string,
  name: string,
): Promise<{ ok: boolean; status: number; domain?: ResendDomainDetail; error?: string }> {
  const r = await resendSend(apiKey, "POST", "/domains", { name });
  return r.ok ? { ok: true, status: r.status, domain: r.data as ResendDomainDetail } : { ok: false, status: r.status, error: r.error };
}

/** GET /domains/:id */
export async function getResendDomain(
  apiKey: string,
  id: string,
): Promise<{ ok: boolean; status: number; domain?: ResendDomainDetail; error?: string }> {
  const r = await resendGet(apiKey, `/domains/${encodeURIComponent(id)}`);
  return r.ok ? { ok: true, status: r.status, domain: r.data as ResendDomainDetail } : { ok: false, status: r.status, error: r.error };
}

/** POST /domains/:id/verify — asks Resend to re-check DNS (async on Resend's side). */
export async function verifyResendDomain(
  apiKey: string,
  id: string,
): Promise<{ ok: boolean; status: number; error?: string }> {
  const r = await resendSend(apiKey, "POST", `/domains/${encodeURIComponent(id)}/verify`);
  return { ok: r.ok, status: r.status, error: r.error };
}

/** PATCH /domains/:id — Resend open/click tracking is configured per domain. */
export async function updateResendDomainTracking(
  apiKey: string,
  id: string,
  tracking: { openTracking: boolean; clickTracking: boolean },
): Promise<{ ok: boolean; status: number; error?: string }> {
  const r = await resendSend(apiKey, "PATCH", `/domains/${encodeURIComponent(id)}`, {
    open_tracking: tracking.openTracking,
    click_tracking: tracking.clickTracking,
  });
  return { ok: r.ok, status: r.status, error: r.error };
}

/** Map Resend's domain status onto email_domain_status ('pending' | 'verified' | 'failed'). */
export function mapResendDomainStatus(status: string | undefined): "pending" | "verified" | "failed" {
  if (status === "verified") return "verified";
  if (status === "failure" || status === "failed" || status === "temporary_failure") return "failed";
  return "pending";
}

export interface StoredDnsRecord {
  type: string;
  host: string;
  value: string;
  valid: boolean;
  record?: string;
  priority?: number;
  ttl?: string;
  status?: string;
}

/** Map Resend `records` ({record,name,type,value,status,priority,ttl}) to the stored/UI shape. */
export function mapResendRecords(records: Array<Record<string, unknown>> | undefined): StoredDnsRecord[] {
  return (records ?? []).map((r) => {
    const out: StoredDnsRecord = {
      type: String(r.type ?? ""),
      host: String(r.name ?? r.host ?? ""),
      value: String(r.value ?? ""),
      valid: r.status === "verified" || r.valid === true,
    };
    if (typeof r.record === "string") out.record = r.record;
    if (typeof r.priority === "number") out.priority = r.priority;
    if (r.ttl !== undefined && r.ttl !== null) out.ttl = String(r.ttl);
    if (typeof r.status === "string") out.status = r.status;
    return out;
  });
}

export interface ResendEmailStatus {
  id: string;
  to: string[];
  from: string;
  subject: string;
  /** Resend's own view: "delivered" | "bounced" | "complained" | "sent" | "queued" | … */
  last_event?: string;
  created_at?: string;
}

/**
 * Look up ONE sent message by its Resend id.
 *
 * Exists because a send that Resend ACCEPTS is not a send that arrived, and the OS could not tell
 * the two apart. On 2026-08-03 a contract signature request returned a message id and was recorded
 * as sent, the recipient never saw it, and nothing anywhere could say whether it had been delivered,
 * bounced, or filed as spam — the signature-email path writes to neither `messages` nor
 * `email_test_logs`, so the Resend webhook had no row to attach delivery events to.
 *
 * This asks Resend directly, which is the only source of truth once a message has left.
 */
export async function getResendEmail(
  apiKey: string,
  emailId: string,
): Promise<{ ok: boolean; email?: ResendEmailStatus; error?: string }> {
  const result = await resendGet(apiKey, `/emails/${encodeURIComponent(emailId)}`);
  if (!result.ok) return { ok: false, error: result.error };
  return { ok: true, email: result.data as ResendEmailStatus };
}

/**
 * Verify a Resend (Svix) webhook signature.
 *
 * Resend signs webhooks with Svix: HMAC-SHA256 over `${id}.${timestamp}.${body}`
 * using the base64 secret (after the `whsec_` prefix). The `svix-signature`
 * header is a space-separated list of `v1,<base64sig>` entries; a match on any
 * passes. A ±5-minute timestamp tolerance guards against replay.
 */
export async function verifyResendWebhookSignature(
  rawBody: string,
  svixId: string,
  svixTimestamp: string,
  svixSignature: string,
  secret: string,
): Promise<boolean> {
  try {
    if (!svixId || !svixTimestamp || !svixSignature || !secret) return false;

    // Replay guard: timestamp within 5 minutes.
    const ts = Number(svixTimestamp);
    if (!Number.isFinite(ts)) return false;
    const nowSec = Math.floor(Date.now() / 1000);
    if (Math.abs(nowSec - ts) > 300) return false;

    const secretBytes = base64ToBytes(secret.replace(/^whsec_/, ""));
    const key = await crypto.subtle.importKey(
      "raw",
      secretBytes,
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const signedContent = `${svixId}.${svixTimestamp}.${rawBody}`;
    const macBuf = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(signedContent));
    const expected = bytesToBase64(new Uint8Array(macBuf));

    // svix-signature: "v1,<sig> v1,<sig2> ..."
    for (const part of svixSignature.split(" ")) {
      const [, sig] = part.split(",");
      if (sig && timingSafeEqual(sig, expected)) return true;
    }
    return false;
  } catch {
    return false;
  }
}

function base64ToBytes(b64: string): Uint8Array<ArrayBuffer> {
  const bin = atob(b64);
  const out = new Uint8Array(new ArrayBuffer(bin.length));
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function bytesToBase64(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
