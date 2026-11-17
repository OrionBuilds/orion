/**
 * Request building for the SAM.gov Get Opportunities API (v2), per https://open.gsa.gov/api/get-opportunities-public-api/
 *   - postedFrom / postedTo are MANDATORY, MM/dd/yyyy, at most 1 year apart (including a noticeid lookup)
 *   - limit 1..1000, offset is a page index starting at 0
 *   - ptype takes ONE code; typeOfSetAside takes ONE value
 *   - HTTP 404 means "no data found", not an error
 * Dates are Eastern: SAM posts on Eastern days and edge functions run in UTC.
 */
export const SAM_OPPORTUNITIES_URL = "https://api.sam.gov/opportunities/v2/search";
const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_RANGE_DAYS = 364;

/** MM/dd/yyyy for the calendar day `date` falls on in US Eastern. */
export function formatSamDate(date: Date): string {
  const p = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" })
    .formatToParts(date);
  const g = (t: string) => p.find((x) => x.type === t)!.value;
  return `${g("month")}/${g("day")}/${g("year")}`;
}

/** Accepts YYYY-MM-DD (HTML date inputs), an ISO timestamp, or MM/dd/yyyy; returns MM/dd/yyyy or null. */
export function toSamDateFormat(s: string): string | null {
  const v = s.trim();
  if (/^\d{2}\/\d{2}\/\d{4}$/.test(v)) return v;
  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(v);
  return iso ? `${iso[2]}/${iso[3]}/${iso[1]}` : null;
}

function parseSamDate(s: string): number {
  const [mm, dd, yyyy] = s.split("/").map(Number);
  return Date.UTC(yyyy, mm - 1, dd);
}

export class SamRequestError extends Error {}

export interface SamSearchParams {
  keywords?: string; naicsCode?: string; pscCode?: string; setAsideType?: string; state?: string;
  agencyName?: string; procurementType?: string; postedFrom?: string; postedTo?: string; limit?: number; offset?: number;
}

/** Query string for a search. Throws SamRequestError (a user-facing message) for a range SAM would reject. */
export function buildSearchQuery(apiKey: string, p: SamSearchParams, now = new Date()): URLSearchParams {
  const qp = new URLSearchParams();
  qp.set("api_key", apiKey);
  if (p.keywords) qp.set("q", p.keywords);
  if (p.naicsCode) qp.set("ncode", p.naicsCode);
  if (p.pscCode) qp.set("ccode", p.pscCode);
  if (p.setAsideType) qp.set("typeOfSetAside", p.setAsideType);
  if (p.state) qp.set("state", p.state);
  if (p.agencyName) qp.set("organizationName", p.agencyName);
  if (p.procurementType) qp.set("ptype", p.procurementType);

  const to = (p.postedTo && toSamDateFormat(p.postedTo)) || formatSamDate(now);
  const from = (p.postedFrom && toSamDateFormat(p.postedFrom)) || formatSamDate(new Date(now.getTime() - 30 * DAY_MS));
  const span = (parseSamDate(to) - parseSamDate(from)) / DAY_MS;
  if (span < 0) throw new SamRequestError("The 'posted from' date is after the 'posted to' date.");
  if (span > MAX_RANGE_DAYS + 1) throw new SamRequestError("SAM.gov only searches up to 1 year at a time. Narrow the posted date range.");
  qp.set("postedFrom", from);
  qp.set("postedTo", to);
  qp.set("limit", String(Math.min(1000, Math.max(1, Math.floor(p.limit ?? 25)))));
  qp.set("offset", String(Math.max(0, Math.floor(p.offset ?? 0))));
  return qp;
}

/**
 * Date window for a single-notice lookup (noticeid still needs postedFrom/postedTo). With the notice's
 * posted date, a window around it; without, the last year.
 */
export function noticeLookupRange(postedDate: string | null | undefined, now = new Date()): { postedFrom: string; postedTo: string } {
  const t = postedDate ? Date.parse(postedDate) : NaN;
  const today = formatSamDate(now);
  if (!Number.isFinite(t)) return { postedFrom: formatSamDate(new Date(now.getTime() - MAX_RANGE_DAYS * DAY_MS)), postedTo: today };
  const from = new Date(t - 2 * DAY_MS);
  const toMs = Math.min(now.getTime(), t + 300 * DAY_MS);
  return { postedFrom: formatSamDate(from), postedTo: formatSamDate(new Date(toMs)) };
}
