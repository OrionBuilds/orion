/**
 * Lead-magnet submissions from the business website (envelope `kind: "lead_magnet"`, formName "lead-magnet").
 *
 * A visitor gave a name + email + consent to download a free guide. This is NOT an assessment or an
 * inquiry: no opportunity is opened and nobody is notified. We (1) upsert the contact (brand
 * SITE_LEAD_BRAND) tagged `lead-magnet` + `lead-magnet:<slug>`, (2) record the submission once per
 * envelope id, with attribution + consent, and (3) have Clara email the signed download link.
 *
 * Failure rules: the email can fail without failing the webhook. The outcome is stored on the
 * submission (`payload._result.email`) and a timeline row is written; a webhook replay of an envelope
 * whose email did not go out retries the send, a replay after success sends nothing.
 */
import { addContactTimeline, findSubmissionByKey, recordFormSubmission, splitName, upsertContactByEmail, type Db } from "./lead-intake.ts";
import type { getUnsubscribeLink } from "./email-defaults.ts";
import { DEFAULT_REPLY_TO, SITE_BRAND, sendSiteMail, siteOwner, type EmailResult, type SendSiteEmail } from "./site-mail.ts";
import { SITE_HOST, SITE_URL } from "./site-envelope.ts";

type Row = Record<string, unknown>;
export type SendLeadMagnetEmail = SendSiteEmail;
export { DEFAULT_REPLY_TO };

export interface LeadMagnetEnvelope {
  id: string;
  receivedAt: string;
  source: { path: string; userAgent?: string; referer?: string };
  contact: { name: string; email: string };
  consent: { accepted: boolean; version: string; acceptedAt: string };
  delivery: { slug: string; title: string; url: string; expiresAt: string };
}

export interface LeadMagnetDeps {
  sendEmail: SendLeadMagnetEmail;
  orgId: string;
  actorUserId: string;
  unsubscribeLink?: typeof getUnsubscribeLink;
  replyTo?: string;
  timeoutMs?: number;
}

export const LEAD_MAGNET_FORM_SLUG = "sr-lead-magnet";
const FALLBACK_FORM_SLUG = "sr-contact";
const SITE_HOSTS = new Set([SITE_HOST, `www.${SITE_HOST}`]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SLUG = /^[a-z0-9][a-z0-9-]{0,79}$/;

const str = (v: unknown, max = 500): string => (typeof v === "string" ? v.trim().slice(0, max) : "");
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

export function isObjectWithKind(v: unknown, kind: string): boolean {
  return isObj(v) && v.kind === kind;
}

export function parseLeadMagnetEnvelope(raw: unknown): { ok: true; value: LeadMagnetEnvelope } | { ok: false; error: string } {
  if (!isObj(raw)) return { ok: false, error: "body must be a JSON object" };
  const id = str(raw.id, 64);
  if (!UUID.test(id)) return { ok: false, error: "id must be a UUID" };
  if (raw.kind !== "lead_magnet" || str(raw.formName, 80) !== "lead-magnet") return { ok: false, error: "not a lead-magnet envelope" };
  if (!isObj(raw.contact)) return { ok: false, error: "contact block required" };
  const email = str(raw.contact.email, 200).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return { ok: false, error: "contact.email invalid" };
  const name = str(raw.contact.name, 200);
  if (!name) return { ok: false, error: "contact.name required" };
  const d = isObj(raw.delivery) ? raw.delivery : {};
  const slug = str(d.slug, 80);
  if (!SLUG.test(slug)) return { ok: false, error: "delivery.slug invalid" };
  const title = str(d.title, 200);
  if (!title) return { ok: false, error: "delivery.title required" };
  // The link goes into an email from Clara: only ever a link on the site itself.
  let url: URL;
  try { url = new URL(str(d.url, 1000)); } catch { return { ok: false, error: "delivery.url invalid" }; }
  if (url.protocol !== "https:" || !SITE_HOSTS.has(url.hostname)) return { ok: false, error: `delivery.url must be an https link on ${SITE_HOST}` };
  const source = isObj(raw.source) ? raw.source : {};
  const consent = isObj(raw.consent) ? raw.consent : {};
  return {
    ok: true,
    value: {
      id,
      receivedAt: str(raw.receivedAt, 40) || new Date().toISOString(),
      source: { path: str(source.path, 300), userAgent: str(source.userAgent, 300) || undefined, referer: str(source.referer, 300) || undefined },
      contact: { name, email },
      consent: { accepted: consent.accepted === true, version: str(consent.version, 40), acceptedAt: str(consent.acceptedAt, 40) },
      delivery: { slug, title, url: url.toString(), expiresAt: str(d.expiresAt, 40) },
    },
  };
}

/** `?utm_*` and `ref=` from the landing path. */
export function attributionFromPath(path: string): Record<string, string> {
  const q = path.indexOf("?");
  const out: Record<string, string> = {};
  if (q < 0) return out;
  for (const [k, v] of new URLSearchParams(path.slice(q + 1))) {
    const key = k.toLowerCase();
    if ((key.startsWith("utm_") || key === "ref") && v && Object.keys(out).length < 12) out[key] = v.slice(0, 200);
  }
  return out;
}

export function buildLeadMagnetEmail(i: { firstName: string; title: string; url: string; slug: string; unsubscribeUrl: string | null }): { subject: string; text: string } {
  const lines = [
    `Hi ${i.firstName || "there"},`,
    "",
    `Here is your copy of "${i.title}", a free guide from ${Deno.env.get("OWNER_NAME")?.trim() || siteOwner() || SITE_HOST}:`,
    "",
    i.url,
    "",
    `The link works for 7 days. If it has expired, open the guide page (${SITE_URL}/resources/${i.slug}) and it can send you a new one.`,
    "",
    `Reply to this email if you have a question and it will reach ${siteOwner() || "our team"}.`,
    "",
    "Clara",
    siteOwner() ? `${siteOwner()}'s assistant (I'm an AI assistant)` : "I'm an AI assistant",
  ];
  if (i.unsubscribeUrl) lines.push("", `Don't want emails like this? Unsubscribe: ${i.unsubscribeUrl}`);
  return { subject: `Your copy of ${i.title}`, text: lines.join("\n") };
}


async function tagContact(db: Db, orgId: string, contactId: string, slug: string): Promise<void> {
  for (const name of ["lead-magnet", `lead-magnet:${slug}`]) {
    let { data: tag } = await db.from("tags").select("id").eq("organization_id", orgId).eq("name", name).maybeSingle();
    if (!tag) {
      const ins = await db.from("tags").insert({ organization_id: orgId, name }).select("id").single();
      tag = ins.data;
      if (!tag) { // lost a race to another request: read it back
        tag = (await db.from("tags").select("id").eq("organization_id", orgId).eq("name", name).maybeSingle()).data;
      }
    }
    if (!tag) { console.warn(`[lead-magnet] tag ${name} unavailable`); continue; }
    const { error } = await db.from("contact_tags").upsert({ contact_id: contactId, tag_id: tag.id }, { onConflict: "contact_id,tag_id" });
    if (error) console.warn(`[lead-magnet] tag ${name} not applied:`, error.message);
  }
}

function sendEmailOnce(db: Db, deps: LeadMagnetDeps, env: LeadMagnetEnvelope, contactId: string, prevAttempts: number): Promise<EmailResult> {
  const { firstName } = splitName(env.contact.name);
  return sendSiteMail(db, deps, {
    to: env.contact.email, toName: env.contact.name, contactId, prevAttempts,
    category: "lead-magnet", args: { magnet: env.delivery.slug },
    build: (unsubscribeUrl) => buildLeadMagnetEmail({ firstName, title: env.delivery.title, url: env.delivery.url, slug: env.delivery.slug, unsubscribeUrl }),
  });
}

async function saveEmailResult(db: Db, submissionId: string, payload: Row, email: EmailResult): Promise<void> {
  const result = { ...((payload._result as Row | undefined) ?? {}), email };
  const { error } = await db.from("form_submissions").update({ payload: { ...payload, _result: result } }).eq("id", submissionId);
  if (error) console.error("[lead-magnet] could not record email result:", error.message);
}

export async function processLeadMagnet(db: Db, deps: LeadMagnetDeps, env: LeadMagnetEnvelope, idHeader: string | null): Promise<Row> {
  const key = `site:${idHeader || env.id}`;
  const seen = await findSubmissionByKey(db, key);
  if (seen) {
    const prev = ((seen.payload?._result as Row | undefined)?.email ?? null) as EmailResult | null;
    // Retry a failed send, or one stuck "pending" (the function died between recording and sending).
    const stuck = prev?.status === "pending" && Date.now() - new Date(prev.at).getTime() > 5 * 60_000;
    if (!seen.contact_id || !prev || (prev.status !== "failed" && !stuck)) {
      return { duplicate: true, ref: seen.id, id: seen.id, contact_id: seen.contact_id, email: prev?.status ?? "unknown" };
    }
    const retry = await sendEmailOnce(db, deps, env, seen.contact_id, prev.attempts);
    await saveEmailResult(db, seen.id, seen.payload, retry);
    if (retry.status === "failed") console.error(`[lead-magnet] retry failed for ${seen.id}: ${retry.error}`);
    return { duplicate: true, retried: true, ref: seen.id, id: seen.id, contact_id: seen.contact_id, email: retry.status };
  }

  const { firstName, lastName } = splitName(env.contact.name);
  const contact = await upsertContactByEmail(db, deps.orgId, { email: env.contact.email, firstName, lastName }, { source: `web_form_${LEAD_MAGNET_FORM_SLUG}`, brand: SITE_BRAND });
  await tagContact(db, deps.orgId, contact.id, env.delivery.slug);

  // The migration seeds the lead-magnet form; until it is applied use the contact form's row rather than 5xx.
  const { data: forms } = await db.from("forms").select("id, public_slug").eq("organization_id", deps.orgId).in("public_slug", [LEAD_MAGNET_FORM_SLUG, FALLBACK_FORM_SLUG]);
  const rows = (forms ?? []) as { id: string; public_slug: string }[];
  const form = rows.find((f) => f.public_slug === LEAD_MAGNET_FORM_SLUG) ?? rows[0];
  if (!form) throw new Error("no forms row for lead-magnet (or sr-contact)");

  const attribution = { landing_page: env.source.path || undefined, referrer: env.source.referer || undefined, user_agent: env.source.userAgent || undefined, site: SITE_HOST, consent_version: env.consent.version || undefined, ...attributionFromPath(env.source.path) };
  // Record first, then send: a concurrent or replayed delivery then finds the row and does not send again.
  const consented = env.consent.accepted;
  const pending: EmailResult = consented
    ? { status: "pending", attempts: 0, at: new Date().toISOString() }
    : { status: "skipped", attempts: 0, at: new Date().toISOString(), error: "consent not accepted" };
  const payload: Row = { ...env, _site: SITE_HOST, _result: { contact_id: contact.id, contact_created: contact.created, email: pending } };
  const submission = await recordFormSubmission(db, deps.orgId, {
    formId: form.id, contactId: contact.id, payload, attribution, idempotencyKey: key,
  });
  if (submission.duplicate) return { duplicate: true, ref: submission.id, id: submission.id, contact_id: contact.id };
  const email = consented ? await sendEmailOnce(db, deps, env, contact.id, 0) : pending;
  if (consented) await saveEmailResult(db, submission.id, payload, email);

  await addContactTimeline(db, contact.id, "lead_magnet_requested", {
    slug: env.delivery.slug, title: env.delivery.title, submission_id: submission.id, site: SITE_HOST,
    consent_version: env.consent.version, consent_accepted_at: env.consent.acceptedAt, attribution: attributionFromPath(env.source.path),
    email_status: email.status, ...(email.error ? { email_error: email.error } : {}),
  }, deps.actorUserId);
  if (email.status === "failed") console.error(`[lead-magnet] email to contact ${contact.id} failed (submission ${submission.id}): ${email.error}`);
  return { ref: submission.id, id: submission.id, contact_id: contact.id, email: email.status };
}
