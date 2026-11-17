/**
 * The submission envelope the business website posts (its `lib/submissions/envelope.ts`),
 * parsed defensively, and its mapping onto an OS lead.
 */
import { displayValue, splitName, trimTo } from "./lead-intake.ts";

/** The website that posts these envelopes (SITE_URL, e.g. https://www.example.com). */
export const SITE_URL = (Deno.env.get("SITE_URL")?.trim() || "https://example.com").replace(/\/+$/, "");
/** Its host without "www.", as shown in lead summaries and stored as attribution.site. */
export const SITE_HOST = new URL(SITE_URL).hostname.replace(/^www\./, "");

export interface SiteAnswer {
  questionId: string;
  label: string;
  type: string;
  value: unknown;
  /** Human-readable form of `value` (option labels instead of values). */
  display: string;
}

export interface SiteEnvelope {
  id: string;
  kind: "assessment" | "contact";
  formName: string;
  schemaVersion: number;
  receivedAt: string;
  source: { path: string; userAgent?: string; referer?: string };
  contact: { name: string; email: string; company: string; role: string };
  consent: { accepted: boolean; version: string; acceptedAt: string };
  answers: SiteAnswer[];
  spam: { honeypotEmpty: boolean; elapsedMs: number };
}

/** envelope.formName → forms.public_slug in the OS (prefixed: public_slug is global and public). */
export const FORM_SLUG_BY_NAME: Record<string, string> = {
  "contact": "sr-contact",
  "assessment-security": "sr-assessment-security",
  "assessment-ai-readiness": "sr-assessment-ai-readiness",
};

export const FORM_LABEL_BY_NAME: Record<string, string> = {
  "contact": "Contact form",
  "assessment-security": "Security Risk Snapshot",
  "assessment-ai-readiness": "AI Readiness Assessment",
};

type ParseResult = { ok: true; value: SiteEnvelope } | { ok: false; error: string };

const str = (v: unknown, max = 500): string => (typeof v === "string" ? v.trim().slice(0, max) : "");
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function parseEnvelope(raw: unknown): ParseResult {
  if (!isObj(raw)) return { ok: false, error: "body must be a JSON object" };
  const id = str(raw.id, 64);
  if (!UUID.test(id)) return { ok: false, error: "id must be a UUID" };
  const kind = raw.kind === "contact" ? "contact" : raw.kind === "assessment" ? "assessment" : null;
  if (!kind) return { ok: false, error: "kind must be assessment or contact" };
  const formName = str(raw.formName, 80);
  if (!(formName in FORM_SLUG_BY_NAME)) return { ok: false, error: `unknown formName: ${formName || "(empty)"}` };
  if (!isObj(raw.contact)) return { ok: false, error: "contact block required" };
  const email = str(raw.contact.email, 200).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return { ok: false, error: "contact.email invalid" };
  const name = str(raw.contact.name, 200);
  if (!name) return { ok: false, error: "contact.name required" };

  const answersRaw = Array.isArray(raw.answers) ? raw.answers : [];
  if (answersRaw.length > 60) return { ok: false, error: "too many answers" };
  const answers: SiteAnswer[] = [];
  for (const a of answersRaw) {
    if (!isObj(a)) continue;
    const questionId = str(a.questionId, 80);
    if (!questionId) continue;
    const value = a.value;
    const okValue = typeof value === "string" || typeof value === "number" ||
      (Array.isArray(value) && value.every((x) => typeof x === "string"));
    if (!okValue) continue;
    answers.push({
      questionId,
      label: str(a.label, 200) || questionId,
      type: str(a.type, 20) || "text",
      value: typeof value === "string" ? value.slice(0, 4000) : value,
      display: str(a.display, 4000) || displayValue(value),
    });
  }

  const source = isObj(raw.source) ? raw.source : {};
  const consent = isObj(raw.consent) ? raw.consent : {};
  const spam = isObj(raw.spam) ? raw.spam : {};
  return {
    ok: true,
    value: {
      id,
      kind,
      formName,
      schemaVersion: typeof raw.schemaVersion === "number" ? raw.schemaVersion : 0,
      receivedAt: str(raw.receivedAt, 40) || new Date().toISOString(),
      source: { path: str(source.path, 300), userAgent: str(source.userAgent, 300) || undefined, referer: str(source.referer, 300) || undefined },
      contact: { name, email, company: str(raw.contact.company, 200), role: str(raw.contact.role, 200) },
      consent: { accepted: consent.accepted === true, version: str(consent.version, 40), acceptedAt: str(consent.acceptedAt, 40) },
      answers,
      spam: { honeypotEmpty: spam.honeypotEmpty !== false, elapsedMs: typeof spam.elapsedMs === "number" ? spam.elapsedMs : 0 },
    },
  };
}

export interface SiteLead {
  slug: string;
  formLabel: string;
  firstName: string;
  lastName: string;
  email: string;
  company: string | null;
  jobTitle: string | null;
  opportunityName: string;
  description: string;
  fields: [string, string][];
  attribution: Record<string, unknown>;
}

export function envelopeToLead(env: SiteEnvelope): SiteLead {
  const { firstName, lastName } = splitName(env.contact.name);
  const formLabel = FORM_LABEL_BY_NAME[env.formName] ?? env.formName;
  const fields: [string, string][] = env.answers
    .map((a) => [a.label, a.display] as [string, string])
    .filter(([, v]) => v !== "");
  const lines = [
    `${formLabel} — ${SITE_HOST}${env.source.path ? ` (${env.source.path})` : ""}`,
    `Name: ${env.contact.name}`,
    `Email: ${env.contact.email}`,
    env.contact.company ? `Company: ${env.contact.company}` : "",
    env.contact.role ? `Role: ${env.contact.role}` : "",
    "",
    ...fields.map(([l, v]) => `${l}: ${v}`),
  ].filter((l, i, arr) => !(l === "" && arr[i - 1] === ""));
  return {
    slug: FORM_SLUG_BY_NAME[env.formName],
    formLabel,
    firstName,
    lastName,
    email: env.contact.email,
    company: env.contact.company || null,
    jobTitle: env.contact.role || null,
    opportunityName: trimTo(`${env.contact.name} — ${formLabel}`, 120),
    description: trimTo(lines.join("\n"), 4000),
    fields,
    attribution: {
      landing_page: env.source.path || undefined,
      referrer: env.source.referer || undefined,
      user_agent: env.source.userAgent || undefined,
      site: SITE_HOST,
      consent_version: env.consent.version || undefined,
      schema_version: env.schemaVersion,
    },
  };
}
