/**
 * AI & Compliance Readiness Scorecard — content + scoring (server copy).
 *
 * MIRROR of the site's app/ai-readiness-scorecard/scorecardData.ts. The site owns
 * the question text (the server only needs `answers[i]` → area floor(i/2)); the
 * server owns the authoritative score. Bump SCORECARD_CONTENT_VERSION in BOTH
 * files whenever copy or scoring changes; the function logs (never rejects) a
 * mismatch sent by the client as `content_version`.
 *
 * Source of record for copy: the approved reference implementation
 * (01_Readiness_Scorecard.html). Do not edit wording without owner sign-off.
 */
import { SITE_URL } from "./site-envelope.ts";

export const SCORECARD_CONTENT_VERSION = 1;
export const QUESTION_COUNT = 12;
export const OPTIONS_PER_QUESTION = 4; // option index 0..3 === score
export const MAX_SCORE = 36;
export const AREA_MAX = 6;
export const AREA_OK_THRESHOLD = 4; // area score >= 4/6 => "ready"

export type AreaId =
  | "access"
  | "logging"
  | "data_location"
  | "change_control"
  | "failure_handling"
  | "vendor_review";

export interface ControlArea {
  id: AreaId;
  name: string;
}

/** Two questions per area, in this order (answers[2i], answers[2i+1]). */
export const AREAS: readonly ControlArea[] = [
  { id: "access", name: "Access" },
  { id: "logging", name: "Logging" },
  { id: "data_location", name: "Data location" },
  { id: "change_control", name: "Change control" },
  { id: "failure_handling", name: "Failure handling" },
  { id: "vendor_review", name: "Vendor review" },
];

export type BandId = "build_ready" | "sprint_ready" | "foundation_first";

export interface Band {
  id: BandId;
  title: string;
  description: string;
  /** Inclusive lower bound on total score */
  min: number;
  /** Hot bands open an Opportunity; the rest stay contact-only. */
  hot: boolean;
}

export const BANDS: Record<BandId, Band> = {
  build_ready: {
    id: "build_ready",
    min: 27,
    hot: true,
    title: "Build-ready",
    description:
      "Your controls are already most of the way there. A full platform or agent build can start with the compliance work running in parallel.",
  },
  sprint_ready: {
    id: "sprint_ready",
    min: 15,
    hot: true,
    title: "Sprint-ready",
    description:
      "One workflow can go live in about 30 days. The gaps below get closed inside the sprint and documented as we go.",
  },
  foundation_first: {
    id: "foundation_first",
    min: 0,
    hot: false,
    title: "Foundation first",
    description:
      "Two or three control areas need work before AI touches regulated data. The good news: a 30-day sprint can fix the first one and prove the pattern.",
  },
};

export type IndustryId =
  | "construction"
  | "healthcare"
  | "finance"
  | "realestate"
  | "government"
  | "defense";

/** Value written to the pre-existing `industry` contact custom field. */
export type IndustryFieldValue =
  | "construction"
  | "healthcare"
  | "finance"
  | "real_estate"
  | "government"
  | "defense";

export interface Vertical {
  id: IndustryId;
  industryFieldValue: IndustryFieldValue;
  name: string;
  fw: string;
  can: readonly string[];
  not: readonly string[];
  first: string;
}

export const VERTICALS: Record<IndustryId, Vertical> = {
  construction: {
    id: "construction",
    industryFieldValue: "construction",
    name: "Construction",
    fw: "SOC 2 · HUD · owner data terms",
    can: [
      "Weekly project status reporting pulled from PM + accounting",
      "RFI, submittal, and change-order follow-up (draft-and-approve)",
      "Plan review and takeoff assist on your own files",
    ],
    not: [
      "Anything on HUD-funded jobs without audit logging and retention",
      "Owner-confidential drawings in a public LLM",
      "Auto-sending cost or schedule commitments",
    ],
    first:
      "Weekly status reporting across all active projects. High friction, low risk, visible to leadership in 30 days.",
  },
  healthcare: {
    id: "healthcare",
    industryFieldValue: "healthcare",
    name: "Healthcare & Life Sciences",
    fw: "HIPAA / HITECH · SOC 2 · 21 CFR Part 11",
    can: [
      "Patient intake, reminders, and follow-up messaging under a BAA",
      "Referral and prior-auth packet assembly from the EHR",
      "Clinical and operational document routing inside the covered environment",
    ],
    not: [
      "PHI in a consumer or non-BAA LLM",
      "Autonomous clinical decisions",
      "Part 11 electronic records without validation",
    ],
    first:
      "Patient communication and follow-up. It touches revenue and staff burnout, and it's the easiest workflow to fence with safeguards.",
  },
  finance: {
    id: "finance",
    industryFieldValue: "finance",
    name: "Finance",
    fw: "SOC 2 · PCI-DSS · FFIEC · GLBA",
    can: [
      "Onboarding and underwriting document completeness checks",
      "KYC / AML and fraud alert triage with an analyst decision",
      "Internal policy and procedure assistant over your own documents",
    ],
    not: [
      "Cardholder data near a general-purpose model",
      "Unexplainable credit decisions",
      "Customer PII in a vendor with no third-party risk review",
    ],
    first:
      "Document processing for onboarding or underwriting. Measurable hours, clear audit trail, human decision never moves.",
  },
  realestate: {
    id: "realestate",
    industryFieldValue: "real_estate",
    name: "Real Estate & Property",
    fw: "FCRA · HUD · state landlord-tenant rules",
    can: [
      "Lease expiration and renewal tracking (draft-and-approve)",
      "Maintenance triage and vendor dispatch",
      "HUD reporting assembly with full audit log",
    ],
    not: [
      "Automated screening decisions",
      "Applicant data in a non-compliant tool",
      "AI-generated denial reasons",
    ],
    first:
      "The FCRA-sequenced screening and adverse-action workflow. Most manual, most error-prone, and the first thing an auditor asks about.",
  },
  government: {
    id: "government",
    industryFieldValue: "government",
    name: "US Government",
    fw: "FedRAMP · NIST 800-53 · StateRAMP · 508",
    can: [
      "Case and records-request intake inside the agency network",
      "Multi-step approvals with audit trails",
      "Internal policy assistant with a 508-accessible interface",
    ],
    not: [
      "Agency data in unauthorized commercial AI services",
      "Citizen-facing decisions without accessibility and appeal paths",
      "Anything classified",
    ],
    first:
      "Records-request or case intake. Visible to leadership, painful for staff, and the audit and accountability controls map cleanly.",
  },
  defense: {
    id: "defense",
    industryFieldValue: "defense",
    name: "Defense Industrial Base",
    fw: "CMMC 2.0 · NIST 800-171 · DFARS 7012",
    can: [
      "Control evidence collection and SSP / POA&M upkeep inside the enclave",
      "DFARS clause and CUI-marking review",
      "Engineering and quality document search with role-based access",
    ],
    not: [
      "CUI in a commercial AI service without FedRAMP Moderate equivalency",
      "AI tools that bypass enclave IAM and logging",
      "Adding AI after the assessment instead of designing it into the boundary",
    ],
    first:
      "Evidence collection and SSP upkeep. It accelerates readiness for the November 2026 Phase 2 deadline and proves AI can live inside the boundary.",
  },
};

export const INDUSTRY_IDS = Object.keys(VERTICALS) as IndustryId[];

export function isIndustryId(v: unknown): v is IndustryId {
  return typeof v === "string" && Object.prototype.hasOwnProperty.call(VERTICALS, v);
}

/** Strict: exactly 12 integers in 0..3. Rejects strings, floats, booleans, sparse arrays. */
export function validateAnswers(
  raw: unknown,
): { ok: true; answers: number[] } | { ok: false; error: string } {
  if (!Array.isArray(raw)) return { ok: false, error: "answers must be an array" };
  if (raw.length !== QUESTION_COUNT) {
    return { ok: false, error: `answers must contain exactly ${QUESTION_COUNT} items` };
  }
  const answers: number[] = [];
  for (let i = 0; i < raw.length; i++) {
    const v = raw[i];
    if (typeof v !== "number" || !Number.isInteger(v) || v < 0 || v >= OPTIONS_PER_QUESTION) {
      return { ok: false, error: `answers[${i}] must be an integer from 0 to ${OPTIONS_PER_QUESTION - 1}` };
    }
    answers.push(v);
  }
  return { ok: true, answers };
}

export interface ScoreResult {
  score: number; // 0..36
  band: BandId;
  area_scores: Record<AreaId, number>; // each 0..6
  area_ok: Record<AreaId, boolean>;
  weakest_area: AreaId; // first minimum, same as the reference (indexOf(min))
}

/** Ported exactly from the reference JS. */
export function scoreAnswers(answers: readonly number[]): ScoreResult {
  const score = answers.reduce((a, b) => a + b, 0);
  const area_scores = {} as Record<AreaId, number>;
  const area_ok = {} as Record<AreaId, boolean>;
  AREAS.forEach((area, ai) => {
    const s = answers[ai * 2] + answers[ai * 2 + 1];
    area_scores[area.id] = s;
    area_ok[area.id] = s >= AREA_OK_THRESHOLD;
  });
  const min = Math.min(...AREAS.map((a) => area_scores[a.id]));
  const weakest_area = AREAS.find((a) => area_scores[a.id] === min)!.id;
  const band: BandId = score >= BANDS.build_ready.min
    ? "build_ready"
    : score >= BANDS.sprint_ready.min
    ? "sprint_ready"
    : "foundation_first";
  return { score, band, area_scores, area_ok, weakest_area };
}

export function pdfUrlFor(industry: IndustryId): string {
  return `${SITE_URL}/downloads/scorecard/${industry}.pdf`;
}
