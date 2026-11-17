/**
 * Post-download follow-up data for the AI & Compliance Readiness Scorecard.
 *
 * Source: 09_PostDownload_Email_and_SMS_Sequence.docx (owner-authored). The WEAKEST_FIX
 * swap table is verbatim from that doc. DRIP_BY_VERTICAL (pain / proof / role / trigger)
 * was drafted from the ICP framework + the published case studies and must be approved
 * by the owner before the sequence goes live — see the go-live checklist in the plan.
 *
 * Consumers:
 *   - scorecard-submit: `dripTokens()` is spread into the `form_submitted` event_outbox payload
 *     so the OS workflow engine can fill `{{first_name}}`, `{{weakest_fix_1}}`, `{{pain}}`, … in
 *     the owner's follow-up emails.
 *   - scorecard_sms_drip_candidates() RPC returns the same tokens back to CLARA for her texts.
 *
 * GO-LIVE PLACEHOLDERS (fill before activating the workflow trigger):
 *   tracked_links.destination_url for slug 'sprint-outline' — the Sprint outline PDF (asset 03).
 *   E3_RESULT — one real, checkable result line for email 3 (empty renders as nothing).
 */
import { AREAS, BANDS, type AreaId, type IndustryId, type ScoreResult, type Vertical, pdfUrlFor } from "./scorecard.ts";
import { SITE_HOST, SITE_URL } from "./site-envelope.ts";

export const BOOK_URL = `${SITE_URL}/schedule-consultation`;
/** Short link Clara texts (fits the 160-char budget); 301s to BOOK_URL via the site's _redirects. */
export const BOOK_SHORT_URL = `${SITE_HOST}/scorecard-call`;
export const SCORECARD_URL = `${SITE_URL}/scorecard`;

/**
 * Asset 03 — Sprint outline. Always a first-party tracked link: SITE_URL/outline 302s (Netlify)
 * to the OS `link-redirect/sprint-outline`, which logs the click per contact (`?c=<contact_id>`) and 302s
 * to `tracked_links.destination_url`. GO-LIVE: point that row at the real PDF the owner supplies.
 */
export const OUTLINE_URL = `${SITE_URL}/outline`;
/** Email 3 "[INSERT one real result]" line. Empty until the owner supplies it; email 3 omits the line when empty. */
export const E3_RESULT = "";

/** Three fixes per weakest area — verbatim from the docx swap table. */
export const WEAKEST_FIX: Record<AreaId, readonly [string, string, string]> = {
  access: [
    "Kill every shared login on the systems in scope this week",
    "Turn on MFA for anyone who can touch the data",
    "Write a one-line role list: who can read, who can change",
  ],
  logging: [
    "Switch audit logging on in the two systems that touch the workflow",
    "Set retention to at least 90 days",
    "Put a monthly 15-minute log review on one person's calendar",
  ],
  data_location: [
    "List every place the workflow's data lives, including inboxes",
    "Move anything sensitive off personal drives and unreviewed SaaS",
    "Label it: PHI, CHD, CUI, consumer report, or none",
  ],
  change_control: [
    "Name one approver for production changes",
    "Keep a running change log, even a shared doc",
    "Snapshot a baseline config so you can tell what changed",
  ],
  failure_handling: [
    "Decide who gets paged when the workflow breaks",
    "Write the manual fallback on one page",
    "Set one alert on the step most likely to fail",
  ],
  vendor_review: [
    "Ask every AI/SaaS vendor for their SOC 2 report or BAA in writing",
    "Confirm where their model runs and whether your data trains it",
    "Add the answers to a one-page vendor register",
  ],
};

export interface DripVerticalCopy {
  /** {PAIN} — the recurring manual workflow, phrased as a noun phrase that follows "how … eats a week every month". */
  pain: string;
  /** {PROOF} — "a team in your industry", grounded in a published case study where one exists. */
  proof: string;
  /** {ROLE} — the title that forwards the Sprint outline to security (S3). Plural is added in copy. */
  role: string;
  /** {TRIGGER} — the date/event in E4's P.S. "if nothing changes by {TRIGGER}". */
  trigger: string;
}

/** DRAFT — the owner approves before go-live. `proof` for government has no published case study yet. */
export const DRIP_BY_VERTICAL: Record<IndustryId, DripVerticalCopy> = {
  construction: {
    pain: "weekly status reporting across active projects",
    proof: "a multi-state specialty contractor running 40+ projects",
    role: "project manager",
    trigger: "next quarter's project reviews",
  },
  healthcare: {
    pain: "prior-auth and referral packet assembly",
    proof: "a multi-specialty healthcare group",
    role: "practice administrator",
    trigger: "your next HIPAA risk assessment",
  },
  finance: {
    pain: "onboarding and underwriting document review",
    proof: "a financial services firm",
    role: "compliance officer",
    trigger: "your next FFIEC exam",
  },
  realestate: {
    pain: "applicant screening and adverse-action notices",
    proof: "a multifamily property management company",
    role: "property manager",
    trigger: "the next fair-housing complaint",
  },
  government: {
    pain: "records-request intake",
    proof: "a public-sector intake team",
    role: "program manager",
    trigger: "the next budget cycle",
  },
  defense: {
    pain: "control evidence collection and SSP upkeep",
    proof: "a DoD subcontractor pursuing CMMC Level 2",
    role: "FSO",
    trigger: "the November 2026 Phase 2 deadline",
  },
};

export interface DripTokens {
  first_name: string;
  vertical: string;
  industry: IndustryId;
  framework: string;
  /** First framework only ("HIPAA / HITECH · SOC 2 · …" → "HIPAA") — reads inline: "{framework_short}-safe". */
  framework_short: string;
  score: number;
  band: string;
  band_title: string;
  weakest_area: AreaId;
  weakest: string;
  weakest_fix_1: string;
  weakest_fix_2: string;
  weakest_fix_3: string;
  pain: string;
  proof: string;
  role: string;
  trigger: string;
  pdf_url: string;
  book_url: string;
  book_short_url: string;
  scorecard_url: string;
  outline_url: string;
  e3_result: string;
}

/** Flat token map for merge fields ({{first_name}}, {{weakest_fix_1}}, …). Lower-cased weakest name reads inline. */
export function dripTokens(firstName: string, v: Vertical, r: ScoreResult): DripTokens {
  const weakest = AREAS.find((a) => a.id === r.weakest_area)?.name ?? r.weakest_area;
  const fixes = WEAKEST_FIX[r.weakest_area];
  const copy = DRIP_BY_VERTICAL[v.id];
  return {
    first_name: firstName,
    vertical: v.name,
    industry: v.id,
    framework: v.fw,
    framework_short: v.fw.split(/[·/]/)[0].trim(),
    score: r.score,
    band: r.band,
    band_title: BANDS[r.band].title,
    weakest_area: r.weakest_area,
    weakest: weakest.toLowerCase(),
    weakest_fix_1: fixes[0],
    weakest_fix_2: fixes[1],
    weakest_fix_3: fixes[2],
    pain: copy.pain,
    proof: copy.proof,
    role: copy.role,
    trigger: copy.trigger,
    pdf_url: pdfUrlFor(v.id),
    book_url: BOOK_URL,
    book_short_url: BOOK_SHORT_URL,
    scorecard_url: SCORECARD_URL,
    outline_url: OUTLINE_URL,
    e3_result: E3_RESULT,
  };
}
