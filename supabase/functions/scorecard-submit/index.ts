/**
 * scorecard-submit — public lead capture for the AI & Compliance Readiness
 * Scorecard (hosted on the business website, SITE_URL/ai-readiness-scorecard).
 *
 * Why not form-submit: results are gated behind a work email, the score must be
 * recomputed server-side from the raw answers (never trusted from the client),
 * an Opportunity is opened ONLY for hot bands (and reused on retake), and the
 * results email carries the industry one-pager as an attachment — none of which
 * the generic form mapper can express. CRM writes mirror clara-web-responder's
 * `capture_lead` (the canonical "create a lead" logic). A `forms` row with slug
 * `ai-readiness-scorecard` still exists so every attempt lands in
 * form_submissions and shows in the OS Forms module.
 *
 * Contract (must match the site's app/ai-readiness-scorecard/useScorecardSubmit.ts):
 *   POST { first_name, last_name, email, industry, answers[12], content_version?,
 *          phone?, sms_consent?, sms_consent_text?,   // optional SMS opt-in (TCPA): phone stored only with consent
 *          _honeypot?, _idempotency_key, landing_page?, referrer?, utm_* }
 *   200  { success, score, band, area_scores{AreaId:n}, weakest_area, contact_id,
 *          opportunity_id|null, pdf_url, email_sent, duplicate? }
 *   400 / 405 / 429 / 500 { error }
 */

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2";
import { corsHeaders, jsonResponse } from "../_shared/cors.ts";
import { escapeHtml } from "../_shared/html.ts";
import { getResendEnvCreds, type ResendAttachment } from "../_shared/resend.ts";
import { sendOrgEmail } from "../_shared/email-defaults.ts";
import {
  AREAS,
  AREA_MAX,
  BANDS,
  INDUSTRY_IDS,
  MAX_SCORE,
  SCORECARD_CONTENT_VERSION,
  VERTICALS,
  isIndustryId,
  pdfUrlFor,
  scoreAnswers,
  validateAnswers,
  type AreaId,
  type BandId,
  type ScoreResult,
  type Vertical,
} from "../_shared/scorecard.ts";
import { BOOK_URL, dripTokens, SCORECARD_URL } from "../_shared/scorecardDrip.ts";

// ── Constants (set these env vars to your org's ids; empty = not configured) ────────
const ORG_ID = Deno.env.get("SCORECARD_ORG_ID") ?? "00000000-0000-0000-0000-000000000001";
const FORM_SLUG = "ai-readiness-scorecard";
/** contacts.source (create only) · opportunities.source · tag name */
const SOURCE = "readiness-scorecard";
const LEAD_PIPELINE_ID = Deno.env.get("CLARA_LEAD_PIPELINE_ID") ?? ""; // Inbound
const LEAD_STAGE_ID = Deno.env.get("CLARA_LEAD_STAGE_ID") ?? ""; // New Lead
const LEAD_DEPARTMENT_ID = Deno.env.get("CLARA_LEAD_DEPARTMENT_ID") ?? ""; // Sales
const LEAD_OWNER_USER_ID = Deno.env.get("CLARA_LEAD_OWNER_ID") ?? ""; // owner / assignee
/**
 * Actor for created_by / timeline user_id: the System Administrator, not the owner
 * (would falsify their activity stats) and not Clara (would pollute her funnel).
 * The website did this, unattended.
 */
const SYSTEM_USER_ID = Deno.env.get("SCORECARD_ACTOR_USER_ID") ?? "";
const DEFAULT_RATE_LIMIT_PER_IP = 5; // per hour; forms.settings.rateLimitPerIp overrides
const REPLY_TO = Deno.env.get("BUSINESS_INFO_EMAIL")?.trim() || undefined;
/** Name and sign-off on the results email (BUSINESS_NAME, OWNER_FIRST_NAME). */
const BUSINESS = Deno.env.get("BUSINESS_NAME")?.trim() || "Our Company";
const SIGNER = Deno.env.get("OWNER_FIRST_NAME")?.trim() || "The team";
const MAX_BODY_BYTES = 16 * 1024;
const PDF_FETCH_TIMEOUT_MS = 8_000;
const PDF_MAX_BYTES = 8 * 1024 * 1024;

// ── Work-email gate ───────────────────────────────────────────────────────────
// First-label check catches outlook.co.uk / yahoo.fr / hotmail.it without
// enumerating TLDs; the full-domain set covers providers whose first label is a
// generic word.
const FREE_MAIL_LABELS = new Set([
  "gmail", "googlemail", "yahoo", "ymail", "rocketmail", "outlook", "hotmail", "live", "msn",
  "icloud", "me", "mac", "aol", "proton", "protonmail", "pm", "gmx", "zoho", "zohomail", "yandex",
  "mail", "email", "fastmail", "hey", "tutanota", "tuta", "duck", "inbox",
  "mailinator", "guerrillamail", "yopmail", "10minutemail", "temp-mail", "tempmail", "sharklasers",
  "dispostable", "trashmail", "comcast", "att", "verizon", "sbcglobal", "bellsouth", "cox", "charter",
]);
const FREE_MAIL_DOMAINS = new Set([
  "mail.com", "email.com", "pm.me", "me.com", "mac.com", "duck.com", "hey.com", "proton.me", "tuta.io",
]);
const WORK_EMAIL_ERROR =
  "Please use your work email address. Personal email domains (Gmail, Outlook, Yahoo, iCloud, etc.) aren't accepted.";

function validateWorkEmail(
  raw: unknown,
): { ok: true; email: string; domain: string } | { ok: false; error: string } {
  const email = String(raw ?? "").trim().toLowerCase();
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) {
    return { ok: false, error: "Please enter a valid email address." };
  }
  const domain = email.slice(email.indexOf("@") + 1);
  const firstLabel = domain.split(".")[0];
  if (FREE_MAIL_DOMAINS.has(domain) || FREE_MAIL_LABELS.has(firstLabel)) {
    return { ok: false, error: WORK_EMAIL_ERROR };
  }
  return { ok: true, email, domain };
}

// ── SMS opt-in (TCPA) ─────────────────────────────────────────────────────────
// Phone is stored ONLY when the checkbox was ticked. US-default E.164; 10 digits → +1.
function normalizePhone(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const digits = raw.replace(/\D/g, "");
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  if (digits.length >= 11 && digits.length <= 15 && raw.trim().startsWith("+")) return `+${digits}`;
  return null;
}
const SMS_CONSENT_TEXT_DEFAULT =
  `Text me the results too — 4 messages max from Clara at ${BUSINESS}, reply STOP anytime. Msg & data rates may apply.`;

// ── Small helpers ─────────────────────────────────────────────────────────────
type Supa = SupabaseClient;
type Json = Record<string, unknown>;

function bad(error: string, status = 400): Response {
  return jsonResponse({ error }, status);
}

function str(v: unknown, max: number): string {
  return typeof v === "string" ? v.trim().slice(0, max) : "";
}

function extractAttribution(req: Request, body: Json) {
  const url = new URL(req.url);
  const pick = (k: string) => (typeof body[k] === "string" ? (body[k] as string).slice(0, 500) : undefined);
  return {
    utm_source: pick("utm_source") || url.searchParams.get("utm_source") || undefined,
    utm_medium: pick("utm_medium") || url.searchParams.get("utm_medium") || undefined,
    utm_campaign: pick("utm_campaign") || url.searchParams.get("utm_campaign") || undefined,
    utm_term: pick("utm_term") || url.searchParams.get("utm_term") || undefined,
    utm_content: pick("utm_content") || url.searchParams.get("utm_content") || undefined,
    referrer: pick("referrer") || req.headers.get("referer") || undefined,
    landing_page: pick("landing_page") || undefined,
    ip_address: req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || req.headers.get("cf-connecting-ip") || undefined,
    user_agent: req.headers.get("user-agent") || undefined,
  };
}

/** Chunked base64 (String.fromCharCode.apply on the whole buffer would overflow the stack). */
function bytesToBase64(bytes: Uint8Array): string {
  let bin = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + CHUNK)));
  }
  return btoa(bin);
}

// ── CRM writes (mirror clara-web-responder toolCaptureLead) ──────────────────
async function findOrCreateContact(
  sb: Supa,
  p: { firstName: string; lastName: string; email: string; phone?: string | null },
): Promise<{ id: string; created: boolean }> {
  // .limit(1) + maybeSingle so a pre-existing duplicate email can't 500 the lead.
  const { data: existing } = await sb
    .from("contacts")
    .select("id, first_name, last_name, phone")
    .eq("organization_id", ORG_ID)
    .eq("email", p.email)
    .eq("status", "active")
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();

  if (existing) {
    // Gap-fill only. Never touch source / owner / department on a curated contact.
    const upd: Json = {};
    if (!existing.first_name && p.firstName) upd.first_name = p.firstName;
    if (!existing.last_name && p.lastName) upd.last_name = p.lastName;
    if (!existing.phone && p.phone) upd.phone = p.phone; // consented phone only (caller guarantees)
    if (Object.keys(upd).length) {
      const { error } = await sb.from("contacts").update(upd).eq("id", existing.id);
      if (error) console.warn("[scorecard-submit] contact gap-fill failed:", error.message);
    }
    return { id: existing.id as string, created: false };
  }

  const { data: created, error } = await sb
    .from("contacts")
    .insert({
      organization_id: ORG_ID,
      department_id: LEAD_DEPARTMENT_ID,
      owner_id: LEAD_OWNER_USER_ID,
      status: "active",
      first_name: p.firstName,
      last_name: p.lastName,
      email: p.email,
      phone: p.phone ?? null,
      source: SOURCE,
      created_by_user_id: SYSTEM_USER_ID,
    })
    .select("id")
    .single();
  if (error || !created) throw new Error(`contact insert failed: ${error?.message ?? "no row"}`);
  return { id: created.id as string, created: true };
}

async function applyTagAndFields(sb: Supa, contactId: string, v: Vertical, r: ScoreResult, smsConsent: boolean): Promise<void> {
  const [{ data: tag }, { data: cfs }] = await Promise.all([
    sb.from("tags").select("id").eq("organization_id", ORG_ID).eq("name", SOURCE).maybeSingle(),
    sb.from("custom_fields").select("id, field_key").eq("organization_id", ORG_ID).eq("scope", "contact")
      .in("field_key", ["industry", "readiness_score", "readiness_band", "sms_consent"]),
  ]);

  if (tag?.id) {
    const { error } = await sb.from("contact_tags").upsert(
      { contact_id: contactId, tag_id: tag.id },
      { onConflict: "contact_id,tag_id" },
    );
    if (error) console.warn("[scorecard-submit] tag upsert failed:", error.message);
  } else {
    console.warn("[scorecard-submit] tag 'readiness-scorecard' not seeded — run the migration");
  }

  const cfId = (k: string) => (cfs ?? []).find((c: { field_key: string }) => c.field_key === k)?.id as string | undefined;
  const rows: Json[] = [];
  const industryId = cfId("industry");
  const scoreId = cfId("readiness_score");
  const bandId = cfId("readiness_band");
  if (industryId) rows.push({ contact_id: contactId, custom_field_id: industryId, value: v.industryFieldValue });
  if (scoreId) rows.push({ contact_id: contactId, custom_field_id: scoreId, value: r.score });
  if (bandId) rows.push({ contact_id: contactId, custom_field_id: bandId, value: r.band });
  // Only ever SET consent; a later un-ticked retake must not revoke an earlier opt-in.
  const consentId = cfId("sms_consent");
  if (smsConsent && consentId) rows.push({ contact_id: contactId, custom_field_id: consentId, value: true });
  if (!industryId || !scoreId || !bandId) {
    console.warn("[scorecard-submit] missing custom field ids:", { industryId, scoreId, bandId });
  }
  if (rows.length) {
    const { error } = await sb.from("contact_custom_field_values").upsert(rows, { onConflict: "contact_id,custom_field_id" });
    if (error) console.error("[scorecard-submit] custom field upsert failed:", error.message);
  }
}

async function upsertOpportunity(
  sb: Supa,
  contactId: string,
  who: string,
  v: Vertical,
  r: ScoreResult,
): Promise<{ id: string; created: boolean } | null> {
  if (!BANDS[r.band].hot) return null; // foundation_first → contact only

  const areaLine = AREAS.map((a) => `${a.name} ${r.area_scores[a.id]}/${AREA_MAX}`).join(" · ");
  const weakestName = AREAS.find((a) => a.id === r.weakest_area)?.name ?? r.weakest_area;
  const description =
    `AI & Compliance Readiness Scorecard — ${v.name} (${v.fw})\n` +
    `Score ${r.score}/${MAX_SCORE} · ${BANDS[r.band].title}\n${areaLine}\n` +
    `Weakest area: ${weakestName}\nSuggested start: ${v.first}\nLatest attempt: ${new Date().toISOString()}`;
  const name = `${who} — ${v.name} readiness ${r.score}/${MAX_SCORE}`.slice(0, 120);

  const { data: open } = await sb
    .from("opportunities")
    .select("id")
    .eq("org_id", ORG_ID)
    .eq("contact_id", contactId)
    .eq("status", "open")
    .eq("source", SOURCE)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (open?.id) {
    const { error } = await sb.from("opportunities").update({ name, description }).eq("id", open.id);
    if (error) console.warn("[scorecard-submit] opp update failed:", error.message);
    await sb.from("opportunity_timeline_events").insert({
      org_id: ORG_ID,
      opportunity_id: open.id,
      contact_id: contactId,
      event_type: "scorecard_retaken",
      summary: `Scorecard retaken: ${r.score}/${MAX_SCORE} (${BANDS[r.band].title})`,
      payload: { source: SOURCE, score: r.score, band: r.band, area_scores: r.area_scores },
      actor_user_id: SYSTEM_USER_ID,
    }).then(({ error }) => { if (error) console.warn("[scorecard-submit] opp timeline (retake) failed:", error.message); });
    return { id: open.id as string, created: false };
  }

  const { data: opp, error } = await sb
    .from("opportunities")
    .insert({
      org_id: ORG_ID,
      contact_id: contactId,
      pipeline_id: LEAD_PIPELINE_ID,
      stage_id: LEAD_STAGE_ID,
      assigned_user_id: LEAD_OWNER_USER_ID,
      department_id: LEAD_DEPARTMENT_ID,
      value_amount: 0,
      currency: "USD",
      status: "open",
      source: SOURCE,
      name,
      description,
      created_by: SYSTEM_USER_ID,
    })
    .select("id")
    .single();
  if (error || !opp) {
    console.error("[scorecard-submit] opp insert failed:", error?.message);
    return null;
  }

  await sb.from("opportunity_timeline_events").insert({
    org_id: ORG_ID,
    opportunity_id: opp.id,
    contact_id: contactId,
    event_type: "created_from_scorecard",
    summary: `Auto-created from AI Readiness Scorecard (${r.score}/${MAX_SCORE}, ${BANDS[r.band].title})`,
    payload: { source: SOURCE, score: r.score, band: r.band, industry: v.id },
    actor_user_id: SYSTEM_USER_ID,
  }).then(({ error: e }) => { if (e) console.warn("[scorecard-submit] opp timeline failed:", e.message); });

  // NOTE: no manual event_outbox `opportunity_created` here — a DB trigger already emits it on
  // insert (verified 2026-09-05); a second row would double-fire the "New lead" notification.

  return { id: opp.id as string, created: true };
}

// ── Results email ─────────────────────────────────────────────────────────────
interface EmailView {
  firstName: string;
  v: Vertical;
  r: ScoreResult;
  pdfUrl: string;
  pdfAttached: boolean;
}

async function fetchPdfAttachment(url: string, filename: string): Promise<ResendAttachment | null> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), PDF_FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers: { Accept: "application/pdf" } });
    if (!res.ok) { console.warn(`[scorecard-submit] pdf ${url} -> ${res.status}`); return null; }
    const ct = res.headers.get("content-type") ?? "";
    if (!ct.includes("pdf") && !ct.includes("octet-stream")) {
      console.warn(`[scorecard-submit] pdf ${url} unexpected content-type ${ct}`);
      return null;
    }
    const buf = new Uint8Array(await res.arrayBuffer());
    if (buf.byteLength === 0 || buf.byteLength > PDF_MAX_BYTES) {
      console.warn(`[scorecard-submit] pdf ${url} size ${buf.byteLength} out of range`);
      return null;
    }
    return { filename, content: bytesToBase64(buf), contentType: "application/pdf" };
  } catch (e) {
    console.warn("[scorecard-submit] pdf fetch failed:", e instanceof Error ? e.message : String(e));
    return null;
  } finally {
    clearTimeout(t);
  }
}

// Band-specific email copy. {industry} / {weakest} are substituted at send time.
// Voice matches the landing page: plain, short, no pitch. Keep claims computable from the score.
interface BandEmailCopy {
  subject: (first: string, score: number) => string;
  intro: string;
  nextHeading: string;
  next: readonly string[];
  ps: string;
}
const BAND_EMAIL: Record<BandId, BandEmailCopy> = {
  build_ready: {
    subject: (first, score) => `${first}, you scored ${score}/${MAX_SCORE} — you're build-ready`,
    intro:
      "Your controls are already carrying most of the weight. That changes the question from \"can we use AI here\" to \"which workflow first\" — and for {industry}, the answer is below.",
    nextHeading: "What to do this week",
    next: [
      "Send the control map to whoever owns {weakest}. It's the lowest cell on your map, and it's the one an auditor would ask about first.",
      "Read the attached one-pager. It's the {industry} boundary on a single page — the version your auditor will recognize.",
      "Book 30 minutes and bring the workflow you'd pick first. We'll scope it live.",
    ],
    ps: "Results are saved to this email address. Re-score anytime at " + SCORECARD_URL + " — most teams do after the first sprint.",
  },
  sprint_ready: {
    subject: (first, score) => `${first}, ${score}/${MAX_SCORE} — one workflow can go live in 30 days`,
    intro:
      "This is the most common result, and the most useful one. One workflow can go live inside 30 days, and the gaps on your control map get closed as part of the same sprint — not as a prerequisite for it.",
    nextHeading: "What to do this week",
    next: [
      "Start with {weakest}. It's the lowest cell on your map, and it's usually a two-week fix.",
      "Read the attached one-pager. It's the {industry} boundary on a single page, including where we'd start.",
      "Book 30 minutes and bring your shortlist. We'll pick the workflow that fits inside the sprint.",
    ],
    ps: "Results are saved to this email address. Re-score anytime at " + SCORECARD_URL + " — most teams do after the first sprint.",
  },
  foundation_first: {
    subject: (first, score) => `${first}, ${score}/${MAX_SCORE} — here's the first control to fix`,
    intro:
      "Read this as a map, not a verdict. Two or three control areas need work before AI should touch regulated data — but the first one is usually a 30-day fix, and closing it proves the pattern for the rest.",
    nextHeading: "What to do this month",
    next: [
      "Fix {weakest} first. Nothing else on the map matters until it's in place.",
      "Read the attached one-pager. The \"inside the boundary\" section is the checklist for that fix.",
      "When it's done, re-score. If you want a second set of eyes on it before then, the call below is 30 minutes and free.",
    ],
    ps: "Results are saved to this email address. Re-score anytime at " + SCORECARD_URL + ".",
  },
};
const fillCopy = (t: string, v: Vertical, weakest: string) =>
  t.replaceAll("{industry}", v.name).replaceAll("{weakest}", weakest.toLowerCase());

function buildResultsHtml({ firstName, v, r, pdfUrl, pdfAttached }: EmailView): string {
  const band = BANDS[r.band];
  const copy = BAND_EMAIL[r.band];
  const weakestName = AREAS.find((a) => a.id === r.weakest_area)?.name ?? r.weakest_area;
  const cell = (id: AreaId) => {
    const area = AREAS.find((a) => a.id === id)!;
    const ok = r.area_ok[id];
    const s = r.area_scores[id];
    return `<td width="33%" valign="top" style="padding:4px;">
      <div style="border-radius:10px;padding:12px 14px;background:${ok ? "#0b2a2e" : "#2a1e0b"};border:1px solid ${ok ? "#0e7490" : "#b45309"};">
        <div style="font-size:13px;font-weight:600;color:#f8fafc;">${escapeHtml(area.name)}</div>
        <div style="font-size:12px;color:${ok ? "#22d3ee" : "#fbbf24"};">${ok ? "Ready" : "Needs attention"} · ${s}/${AREA_MAX}</div>
      </div></td>`;
  };
  const li = (x: string) => `<li style="margin:0 0 6px;color:#cbd5e1;font-size:14px;line-height:1.5;">${escapeHtml(x)}</li>`;
  const ids = AREAS.map((a) => a.id);

  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Your AI Readiness Score</title></head>
<body style="margin:0;padding:0;background:#020617;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;">Your control map, the ${escapeHtml(v.name)} one-pager, and where we'd start.</div>
<table width="100%" cellpadding="0" cellspacing="0" role="presentation" style="background:#020617;padding:32px 12px;"><tr><td align="center">
<table width="100%" cellpadding="0" cellspacing="0" role="presentation" style="max-width:600px;">
  <tr><td style="padding:0 8px 16px;">
    <span style="font-size:13px;font-weight:700;color:#f8fafc;letter-spacing:.02em;">${escapeHtml(BUSINESS)}</span></td></tr>
  <tr><td style="background:#0f172a;border:1px solid #1e293b;border-radius:14px;padding:32px 28px;">
    <p style="margin:0 0 6px;font-size:12px;font-weight:600;color:#22d3ee;letter-spacing:.08em;text-transform:uppercase;">${escapeHtml(v.name)} · ${escapeHtml(v.fw)}</p>
    <h1 style="margin:0 0 14px;font-size:22px;color:#f8fafc;line-height:1.3;">Hi ${escapeHtml(firstName)}, here's your AI &amp; Compliance Readiness Score</h1>
    <p style="margin:0 0 22px;font-size:15px;color:#cbd5e1;line-height:1.6;">${escapeHtml(fillCopy(copy.intro, v, weakestName))}</p>
    <table cellpadding="0" cellspacing="0" role="presentation" style="margin-bottom:20px;"><tr>
      <td style="padding-right:20px;vertical-align:middle;"><span style="font-size:56px;font-weight:800;line-height:1;color:#22d3ee;">${r.score}</span><span style="font-size:18px;color:#64748b;">/${MAX_SCORE}</span></td>
      <td style="vertical-align:middle;"><div style="font-size:18px;font-weight:700;color:#f8fafc;margin-bottom:4px;">${escapeHtml(band.title)}</div>
        <div style="font-size:14px;color:#94a3b8;line-height:1.5;">${escapeHtml(band.description)}</div></td></tr></table>
    <p style="margin:0 0 8px;font-size:12px;font-weight:600;color:#64748b;letter-spacing:.08em;text-transform:uppercase;">Control map</p>
    <table width="100%" cellpadding="0" cellspacing="0" role="presentation"><tr>${cell(ids[0])}${cell(ids[1])}${cell(ids[2])}</tr><tr>${cell(ids[3])}${cell(ids[4])}${cell(ids[5])}</tr></table>
    <p style="margin:14px 0 24px;font-size:14px;color:#94a3b8;">Weakest area: <strong style="color:#f8fafc;">${escapeHtml(weakestName)}</strong>. That's the first control we'd map before writing any code.</p>
    <h3 style="margin:0 0 8px;font-size:15px;color:#22d3ee;">Could go live in 30 days</h3><ul style="margin:0 0 18px;padding-left:18px;">${v.can.map(li).join("")}</ul>
    <h3 style="margin:0 0 8px;font-size:15px;color:#fbbf24;">Not yet, and why</h3><ul style="margin:0 0 18px;padding-left:18px;">${v.not.map(li).join("")}</ul>
    <div style="border-left:4px solid #06b6d4;background:#0b1730;border-radius:0 10px 10px 0;padding:12px 16px;margin:0 0 24px;">
      <div style="font-size:13px;font-weight:700;color:#f8fafc;margin-bottom:4px;">Where we'd start</div>
      <div style="font-size:14px;color:#cbd5e1;line-height:1.5;">${escapeHtml(v.first)}</div></div>
    <h3 style="margin:0 0 8px;font-size:15px;color:#f8fafc;">${escapeHtml(copy.nextHeading)}</h3>
    <ol style="margin:0 0 24px;padding-left:20px;">${copy.next.map((x) => `<li style="margin:0 0 8px;color:#cbd5e1;font-size:14px;line-height:1.55;">${escapeHtml(fillCopy(x, v, weakestName))}</li>`).join("")}</ol>
    <table cellpadding="0" cellspacing="0" role="presentation" style="margin:0 auto 20px;"><tr><td style="border-radius:10px;background-color:#06b6d4;background:linear-gradient(90deg,#06b6d4,#3b82f6);">
      <a href="${BOOK_URL}" style="display:inline-block;padding:14px 24px;font-size:15px;font-weight:700;color:#020617;text-decoration:none;">Book a 30-minute scoping call</a></td></tr></table>
    <p style="margin:0;font-size:13px;color:#94a3b8;line-height:1.6;text-align:center;">
      ${pdfAttached ? `Your ${escapeHtml(v.name)} one-pager is attached.` : `Your ${escapeHtml(v.name)} one-pager:`}
      <a href="${escapeHtml(pdfUrl)}" style="color:#22d3ee;text-decoration:underline;">${pdfAttached ? "Download a copy" : "Download the PDF"}</a>.</p>
    <p style="margin:26px 0 0;font-size:14px;color:#cbd5e1;line-height:1.6;">Over the next week I'll send three short emails: the fastest fix for ${escapeHtml(weakestName.toLowerCase())}, what a 30-day build actually looked like for a team in your industry, and then a straight question about whether it's worth a conversation. No sequence after that.</p>
    <p style="margin:14px 0 0;font-size:14px;color:#cbd5e1;line-height:1.6;">Reply to this email and a person answers.<br>— ${escapeHtml(SIGNER)}, ${escapeHtml(BUSINESS)}</p>
    <p style="margin:14px 0 0;font-size:13px;color:#94a3b8;line-height:1.6;"><strong style="color:#cbd5e1;">P.S.</strong> ${escapeHtml(copy.ps)}</p>
  </td></tr>
  <tr><td style="padding:18px 8px 0;font-size:11px;color:#475569;line-height:1.6;">
    ${escapeHtml(BUSINESS)}<br>
    This scorecard is general guidance, not legal or assessment advice. Reply to this email to reach a human.</td></tr>
</table></td></tr></table></body></html>`;
}

function buildResultsText({ firstName, v, r, pdfUrl }: EmailView): string {
  const band = BANDS[r.band];
  const copy = BAND_EMAIL[r.band];
  const weakestName = AREAS.find((a) => a.id === r.weakest_area)?.name ?? r.weakest_area;
  const areaLines = AREAS.map((a) => {
    const s = r.area_scores[a.id];
    return `  ${a.name.padEnd(18, ".")} ${s}/${AREA_MAX}  ${r.area_ok[a.id] ? "Ready" : "Needs attention"}`;
  }).join("\n");
  return [
    `Hi ${firstName},`,
    ``,
    fillCopy(copy.intro, v, weakestName),
    ``,
    `Your AI & Compliance Readiness Score (${v.name} · ${v.fw}): ${r.score}/${MAX_SCORE} — ${band.title}`,
    band.description,
    ``,
    `Control map:`,
    areaLines,
    `Weakest area: ${weakestName}. That's the first control we'd map before writing any code.`,
    ``,
    `Could go live in 30 days:`,
    ...v.can.map((x) => `  - ${x}`),
    `Not yet, and why:`,
    ...v.not.map((x) => `  - ${x}`),
    `Where we'd start: ${v.first}`,
    ``,
    `${copy.nextHeading}:`,
    ...copy.next.map((x, i) => `  ${i + 1}. ${fillCopy(x, v, weakestName)}`),
    ``,
    `Book a 30-minute scoping call: ${BOOK_URL}`,
    `${v.name} one-pager (PDF): ${pdfUrl}`,
    ``,
    `Over the next week I'll send three short emails: the fastest fix for ${weakestName.toLowerCase()}, what a 30-day build actually looked like for a team in your industry, and then a straight question about whether it's worth a conversation. No sequence after that.`,
    ``,
    `Reply to this email and a person answers.`,
    `— ${SIGNER}, ${BUSINESS}`,
    ``,
    `P.S. ${copy.ps}`,
    ``,
    BUSINESS,
    `General guidance, not legal or assessment advice. Reply to this email to reach a human.`,
  ].join("\n");
}

async function sendResultsEmail(
  sb: Supa,
  contactId: string | null,
  view: EmailView & { email: string; lastName: string },
): Promise<boolean> {
  const creds = getResendEnvCreds();
  if (!creds) {
    console.error("[scorecard-submit] Resend creds missing (RESEND_API_KEY / RESEND_FROM_EMAIL); skipping results email");
    return false;
  }
  const filename = `${BUSINESS.replace(/[^A-Za-z0-9]+/g, "-")}-AI-Readiness-${view.v.name.replace(/[^A-Za-z0-9]+/g, "-").replace(/^-|-$/g, "")}.pdf`;
  const attachment = await fetchPdfAttachment(view.pdfUrl, filename);
  const full = { ...view, pdfAttached: !!attachment };
  const subject = BAND_EMAIL[view.r.band].subject(view.firstName, view.r.score);
  // Org Defaults (from, unsubscribe group -> link + suppression check); REPLY_TO stays explicit.
  const res = await sendOrgEmail(sb, ORG_ID, {
    contactId,
    to: view.email,
    toName: `${view.firstName} ${view.lastName}`.trim(),
    replyTo: REPLY_TO,
    subject,
    html: buildResultsHtml(full),
    text: buildResultsText(full),
    attachments: attachment ? [attachment] : undefined,
    categories: ["readiness-scorecard"],
    customArgs: { band: view.r.band, industry: view.v.id },
  });
  if (!res.ok) console.error("[scorecard-submit] resend failed:", res.status, res.error);
  return res.ok;
}

// ── Handler ───────────────────────────────────────────────────────────────────
Deno.serve(async (req: Request): Promise<Response> => {
  if (req.method === "OPTIONS") return new Response(null, { status: 200, headers: corsHeaders });
  if (req.method !== "POST") return bad("Method not allowed", 405);

  try {
    // 1. Body
    const len = Number(req.headers.get("content-length") ?? 0);
    if (len > MAX_BODY_BYTES) return bad("Request body too large");
    let body: Json;
    try {
      body = (await req.json()) as Json;
    } catch {
      return bad("Invalid JSON body");
    }
    if (!body || typeof body !== "object") return bad("Invalid JSON body");
    if (body.data && typeof body.data === "object") body = { ...body, ...(body.data as Json) };

    // 2. Validation
    // Accept first_name/last_name (the site's shape) or a legacy single `name`.
    let firstName = str(body.first_name, 120);
    let lastName = str(body.last_name, 120);
    if (!firstName && typeof body.name === "string") {
      const parts = body.name.trim().split(/\s+/);
      firstName = (parts[0] ?? "").slice(0, 120);
      lastName = parts.slice(1).join(" ").slice(0, 120);
    }
    if (!firstName) return bad("Name is required");

    const emailCheck = validateWorkEmail(body.email);
    if (!emailCheck.ok) return bad(emailCheck.error);
    const { email, domain } = emailCheck;

    if (!isIndustryId(body.industry)) return bad(`industry must be one of: ${INDUSTRY_IDS.join(", ")}`);
    const vertical = VERTICALS[body.industry];

    const answersCheck = validateAnswers(body.answers);
    if (!answersCheck.ok) return bad(answersCheck.error);
    const { answers } = answersCheck;

    // SMS opt-in. Consent without a valid phone is a 400 (the client enforces this too);
    // a phone without consent is dropped on the floor — never stored.
    const smsConsent = body.sms_consent === true;
    let phone: string | null = null;
    if (smsConsent) {
      phone = normalizePhone(body.phone);
      if (!phone) return bad("Enter a valid mobile number to receive texts, or untick the text option.");
    }
    const smsConsentText = smsConsent ? (str(body.sms_consent_text, 300) || SMS_CONSENT_TEXT_DEFAULT) : null;

    const contentVersion = typeof body.content_version === "number" ? body.content_version : null;
    if (contentVersion !== null && contentVersion !== SCORECARD_CONTENT_VERSION) {
      console.warn(`[scorecard-submit] content_version mismatch: client ${contentVersion}, server ${SCORECARD_CONTENT_VERSION}`);
    }

    // 3. Score (pure; authoritative)
    const result = scoreAnswers(answers);
    const pdfUrl = pdfUrlFor(vertical.id);
    const who = `${firstName} ${lastName}`.trim();

    // 4. Honeypot — success-shaped 200, zero side effects. Fabricated contact_id so it isn't a tell.
    if (typeof body._honeypot === "string" && body._honeypot.trim()) {
      console.warn("[scorecard-submit] honeypot tripped");
      return jsonResponse({
        success: true,
        score: result.score,
        band: result.band,
        area_scores: result.area_scores,
        weakest_area: result.weakest_area,
        contact_id: crypto.randomUUID(),
        opportunity_id: null,
        pdf_url: pdfUrl,
        email_sent: true,
      });
    }

    const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

    // 5. Form record (submissions + rate-limit ledger live here)
    const { data: form } = await supabase
      .from("forms")
      .select("id, settings")
      .eq("organization_id", ORG_ID)
      .eq("public_slug", FORM_SLUG)
      .eq("status", "published")
      .maybeSingle();
    if (!form) {
      console.error("[scorecard-submit] forms row missing — apply the seed migration");
      return bad("Scorecard is not configured", 500);
    }
    const settings = (form.settings ?? {}) as Json;

    // 6. Idempotency replay
    const idemKey = str(body._idempotency_key, 200) || null;
    if (idemKey) {
      const { data: prior } = await supabase
        .from("form_submissions")
        .select("id, contact_id, payload")
        .eq("form_id", form.id)
        .eq("idempotency_key", idemKey)
        .order("submitted_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (prior) {
        const p = (prior.payload ?? {}) as Json;
        const pr = (p.result ?? {}) as Json;
        return jsonResponse({
          success: true,
          duplicate: true,
          score: p.score ?? result.score,
          band: p.band ?? result.band,
          area_scores: p.area_scores ?? result.area_scores,
          weakest_area: p.weakest_area ?? result.weakest_area,
          contact_id: prior.contact_id ?? pr.contact_id ?? null,
          opportunity_id: pr.opportunity_id ?? null,
          pdf_url: pdfUrl,
          email_sent: Boolean(pr.email_sent),
          submission_id: prior.id,
        });
      }
    }

    // 7. Rate limit per IP (fail-open on query error, like form-submit)
    const attribution = extractAttribution(req, body);
    const limit = typeof settings.rateLimitPerIp === "number" ? settings.rateLimitPerIp : DEFAULT_RATE_LIMIT_PER_IP;
    if (attribution.ip_address && limit > 0) {
      const since = new Date(Date.now() - 60 * 60 * 1000).toISOString();
      const { count, error: rlErr } = await supabase
        .from("form_submissions")
        .select("id", { count: "exact", head: true })
        .eq("form_id", form.id)
        .eq("attribution->>ip_address", attribution.ip_address)
        .gte("submitted_at", since);
      if (!rlErr && (count ?? 0) >= limit) {
        console.warn(`[scorecard-submit] rate limit: ${attribution.ip_address} ${count} in 1h`);
        return bad("Too many attempts from this network. Please try again in an hour.", 429);
      }
    }

    // 8. Submission row FIRST — a later CRM failure still leaves an auditable attempt.
    const payload: Json = {
      first_name: firstName,
      last_name: lastName,
      email,
      email_domain: domain,
      industry: vertical.id,
      industry_name: vertical.name,
      answers,
      content_version: contentVersion,
      score: result.score,
      band: result.band,
      band_title: BANDS[result.band].title,
      area_scores: result.area_scores,
      weakest_area: result.weakest_area,
      source: SOURCE,
      // Flat drip tokens (weakest, pain, proof, role, trigger, framework_short, links…) so CLARA's
      // scorecard_sms_drip_candidates() can fill her texts straight from this row.
      ...dripTokens(firstName, vertical, result),
      sms_consent: smsConsent,
      phone: phone ?? undefined,
      sms_consent_text: smsConsentText ?? undefined,
      sms_consent_at: smsConsent ? new Date().toISOString() : undefined,
    };
    const { data: submission, error: subErr } = await supabase
      .from("form_submissions")
      .insert({
        organization_id: ORG_ID,
        form_id: form.id,
        contact_id: null,
        payload,
        attribution,
        processed_status: "pending",
        idempotency_key: idemKey,
      })
      .select("id")
      .single();
    if (subErr || !submission) {
      console.error("[scorecard-submit] submission insert failed:", subErr?.message);
      return bad("Failed to save submission", 500);
    }
    const submissionId = submission.id as string;

    // 9. Contact
    let contact: { id: string; created: boolean };
    try {
      contact = await findOrCreateContact(supabase, { firstName, lastName, email, phone });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error("[scorecard-submit]", msg);
      await supabase.from("form_submissions").update({ processed_status: "failed", error: msg }).eq("id", submissionId);
      return bad("Failed to save contact", 500);
    }

    // 10–11. Tag, custom fields, timeline (log-and-continue)
    await applyTagAndFields(supabase, contact.id, vertical, result, smsConsent).catch((e) =>
      console.error("[scorecard-submit] tag/fields:", e instanceof Error ? e.message : e)
    );
    await supabase.from("contact_timeline").insert({
      contact_id: contact.id,
      user_id: SYSTEM_USER_ID,
      event_type: "scorecard_completed",
      event_data: {
        source: SOURCE,
        industry: vertical.id,
        industry_name: vertical.name,
        score: result.score,
        band: result.band,
        band_title: BANDS[result.band].title,
        area_scores: result.area_scores,
        weakest_area: result.weakest_area,
        submission_id: submissionId,
        form_id: form.id,
        contact_created: contact.created,
      },
    }).then(({ error: e }) => { if (e) console.warn("[scorecard-submit] contact_timeline failed:", e.message); });
    if (smsConsent && phone) {
      // TCPA record: what they agreed to, when, from where. CLARA's drip requires this event.
      await supabase.from("contact_timeline").insert({
        contact_id: contact.id,
        user_id: SYSTEM_USER_ID,
        event_type: "sms_consent_captured",
        event_data: {
          source: SOURCE,
          phone,
          text: smsConsentText,
          ip_address: attribution.ip_address ?? null,
          user_agent: attribution.user_agent ?? null,
          submission_id: submissionId,
        },
      }).then(({ error: e }) => { if (e) console.warn("[scorecard-submit] sms_consent timeline failed:", e.message); });
    }

    // 12. Opportunity (hot bands only, deduped)
    const opp = await upsertOpportunity(supabase, contact.id, who, vertical, result).catch((e) => {
      console.error("[scorecard-submit] opportunity:", e instanceof Error ? e.message : e);
      return null;
    });

    // 13. Mark processed
    await supabase
      .from("form_submissions")
      .update({
        contact_id: contact.id,
        processed_status: "processed",
        payload: { ...payload, result: { contact_id: contact.id, opportunity_id: opp?.id ?? null, pdf_url: pdfUrl } },
      })
      .eq("id", submissionId);

    // 14. Outbox → notification-dispatcher ("New form submission"). Score goes in form_name on purpose:
    //     the dispatcher only prints form_name / name / email / phone.
    await supabase.from("event_outbox").insert({
      org_id: ORG_ID,
      event_type: "form_submitted",
      contact_id: contact.id,
      entity_type: "form_submission",
      entity_id: submissionId,
      payload: {
        form_id: form.id,
        submission_id: submissionId,
        contact_id: contact.id,
        form_name: `AI Readiness Scorecard — ${vertical.name} ${result.score}/${MAX_SCORE} (${BANDS[result.band].title})`,
        first_name: firstName,
        last_name: lastName,
        email,
        phone: phone ?? "",
        sms_consent: smsConsent,
        // Drip tokens for the OS follow-up workflow (the owner's emails). workflow-processor flattens
        // payload keys into context_data, so templates use {{weakest}}, {{weakest_fix_1}}, {{pain}}, …
        ...dripTokens(firstName, vertical, result),
        pdf_sent_at: new Date().toISOString(),
      },
    }).then(({ error: e }) => { if (e) console.warn("[scorecard-submit] outbox form_submitted failed:", e.message); });

    // 15. Results email (never fails the request)
    const emailSent = await sendResultsEmail(supabase, contact.id, {
      firstName,
      lastName,
      email,
      v: vertical,
      r: result,
      pdfUrl,
      pdfAttached: false,
    }).catch((e) => {
      console.error("[scorecard-submit] email:", e instanceof Error ? e.message : e);
      return false;
    });

    // 16. Best-effort: record email outcome
    await supabase
      .from("form_submissions")
      .update({
        payload: { ...payload, result: { contact_id: contact.id, opportunity_id: opp?.id ?? null, pdf_url: pdfUrl, email_sent: emailSent } },
      })
      .eq("id", submissionId)
      .then(() => {});

    return jsonResponse({
      success: true,
      score: result.score,
      band: result.band,
      area_scores: result.area_scores,
      weakest_area: result.weakest_area,
      contact_id: contact.id,
      opportunity_id: opp?.id ?? null,
      pdf_url: pdfUrl,
      email_sent: emailSent,
      submission_id: submissionId,
    });
  } catch (err) {
    console.error("[scorecard-submit] unhandled:", err);
    return bad("Internal server error", 500);
  }
});
