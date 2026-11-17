/**
 * Proposal review flags. Pure and dependency-free: it runs in the edge functions AND in the browser
 * (src imports it), so the generator, the send modal and signature-send all apply the same rule.
 *
 * A proposal is a money document: it is never sent while it still carries an unresolved marker or
 * a pricing table whose lines do not add up. A person can acknowledge the flags and send anyway,
 * which is logged; nothing automated does.
 */

export type ReviewFlagKind = "needs_pricing" | "confirm_scope" | "placeholder" | "arithmetic";

export interface ReviewFlag {
  kind: ReviewFlagKind;
  section: string;
  detail: string;
  /** Digest of the text around each marker, so a different marker in the same section is a different flag. */
  fingerprint?: string;
}

export interface ReviewSection {
  title: string;
  content: string;
}

const MARKERS: { kind: ReviewFlagKind; re: RegExp; label: string }[] = [
  { kind: "needs_pricing", re: /NEEDS[\s_-]+PRICING/gi, label: "NEEDS PRICING" },
  { kind: "confirm_scope", re: /CONFIRM[\s_-]+SCOPE/gi, label: "CONFIRM SCOPE" },
  { kind: "placeholder", re: /\[\s*(?:TBD|TBC|TODO|INSERT[^\]]*|PLACEHOLDER)\s*\]|\bTBD\b/gi, label: "placeholder text" },
];

const LABEL_TOTAL = /^\s*(?:grand\s+|annual\s+|total\s+)?(?:total|sum)\b|^\s*total\s+(?:investment|price|fee|cost|project)/i;
// Whole-label match only: service names such as "Tax preparation" or "Paid media management" are line items, not adjustments.
const LABEL_ADJUST = /^\s*(?:sub-?total|discount(?:\s*\(.*\))?|(?:sales\s+)?tax(?:\s*\(.*\))?|gst|vat|credit|deposit|amount\s+paid|paid|balance(?:\s+due)?|less\b.*)\s*:?\s*$/i;

export const stripTags = (html: string) =>
  html.replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();

/** "$1,250.50" -> 1250.5; anything that is not a plain money cell -> null. Ranges, "TBC" and ratios are not numbers. */
export function parseMoney(cell: string): number | null {
  const t = stripTags(cell);
  if (!/\d/.test(t) || /\bto\b|–|—|%/.test(t)) return null;
  // The whole cell must be one amount: "$500/month", "$2,000 one-time" and "$2,000-$3,000" are not plain money.
  const m = t.replace(/(?:AU|NZ|CA|HK|S)\$|USD|AUD|NZD|CAD|GBP|EUR|JPY|SGD|HKD|INR|[$€£¥₹]|,/g, "").trim().match(/^-?\d+(?:\.\d+)?$/);
  if (!m) return null;
  const v = parseFloat(m[0]);
  return Number.isFinite(v) ? v : null;
}

function tableRows(html: string): string[][][] {
  const tables: string[][][] = [];
  for (const t of html.matchAll(/<table[^>]*>([\s\S]*?)<\/table>/gi)) {
    const rows: string[][] = [];
    for (const r of t[1].matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)) {
      const cells = [...r[1].matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)].map((c) => stripTags(c[1]));
      if (cells.length) rows.push(cells);
    }
    if (rows.length) tables.push(rows);
  }
  return tables;
}

// Rounding precision only: no proportional allowance, so a large total cannot hide a real difference.
const near = (a: number, b: number) => Math.abs(a - b) <= 0.01;

// A money table carries a currency token somewhere. The additive-money check is only applied to such
// tables: a plain-number table (e.g. a timeline whose cells are week counts) is not a pricing table and
// must not be flagged for "not adding up". An ISO code may sit directly against its amount ("JPY100"),
// so the code is bounded by a non-letter rather than a word boundary (a digit must not end the match).
const CURRENCY_SOURCE = "(?:AU|NZ|CA|HK|S)\\$|\\b(?:USD|AUD|NZD|CAD|GBP|EUR|JPY|SGD|HKD|INR)(?![A-Za-z])|[$€£¥₹]";
// Symbols map to a canonical currency so "$100" and "USD 100" are treated as the same; distinct symbols
// (AU$ vs $) and distinct ISO codes stay distinct. Used only to detect mixed-currency tables.
const SYMBOL_CURRENCY: Record<string, string> = {
  "$": "USD", "€": "EUR", "£": "GBP", "¥": "JPY", "₹": "INR",
  "AU$": "AUD", "NZ$": "NZD", "CA$": "CAD", "HK$": "HKD", "S$": "SGD",
};
const PRICE_HEADER = /price|cost|amount|total|rate|fee|value/i;
const ISO_CODE = /\b(USD|AUD|NZD|CAD|GBP|EUR|JPY|SGD|HKD|INR)(?![A-Za-z])/;

/** The currency a pricing cell names, or null. Only a cell that is an amount (or a price header) counts, so a line
 *  description such as "JPY migration" is not read as a currency. An ISO code wins over a bare "$" in the same
 *  cell: "CAD $100" is one currency (CAD), not CAD plus USD. */
function cellCurrency(cell: string, isHeader: boolean): string | null {
  const c = cell ?? "";
  if (!(isHeader ? PRICE_HEADER.test(c) : parseMoney(c) !== null)) return null;
  const iso = c.match(ISO_CODE);
  if (iso) return iso[1];
  const sym = c.match(new RegExp(CURRENCY_SOURCE));
  return sym ? (SYMBOL_CURRENCY[sym[0]] ?? sym[0]) : null;
}

/** The set of distinct currencies named in a table's price cells. More than one means its amounts are not additive.
 *  A bare "$" is ambiguous, so when its column header names an ISO currency ("Amount (CAD)") the header qualifies it. */
function currenciesIn(rows: string[][]): Set<string> {
  const found = new Set<string>();
  const headerCode = (rows[0] ?? []).map((h) => (PRICE_HEADER.test(h ?? "") ? (h ?? "").match(ISO_CODE)?.[1] ?? null : null));
  rows.forEach((r, i) => r.forEach((c, col) => {
    let cur = cellCurrency(c, i === 0);
    if (cur === "USD" && i > 0 && headerCode[col] && !ISO_CODE.test(c ?? "") && /^[^A-Za-z]*\$/.test((c ?? "").trim())) cur = headerCode[col];
    if (cur) found.add(cur);
  }));
  return found;
}
const looksLikePricingTable = (rows: string[][]) => currenciesIn(rows).size > 0;

/**
 * Checks one pricing table. Flags (a) qty x unit price rows whose line total differs and (b) a total
 * row that differs from the sum of the line rows. A table with subtotal/discount/tax/deposit rows is
 * not judged (those need business rules), and a table with no total row has nothing to compare.
 */
export function checkTableArithmetic(rows: string[][], section: string): ReviewFlag[] {
  const flags: ReviewFlag[] = [];
  if (rows.length < 3) return flags;
  // Only pricing tables get the additive-money check; a plain-number table is left alone.
  if (!looksLikePricingTable(rows)) return flags;
  // Amounts in different currencies cannot be summed, so a mixed-currency table is not judged — summing
  // e.g. USD and JPY lines would otherwise raise a false mismatch. Converting needs an explicit rate we don't have.
  if (currenciesIn(rows).size > 1) return flags;
  const header = rows[0].map((h) => h.toLowerCase());
  const qtyCol = header.findIndex((h) => /^(qty|quantity|units?|hours?)$/.test(h.trim()));
  const unitCol = header.findIndex((h) => /unit\s*(price|cost|rate)|^(rate|price)$/.test(h.trim()));
  const body = rows.slice(1);

  // Table-wide exclusions come first, before any check: adjustment rows (discount, tax, subtotal, deposit) and
  // lines that are not plain amounts (ranges, "TBC", recurring suffixes) need business rules, so the table is not judged.
  if (body.some((r) => LABEL_ADJUST.test(r[0] ?? ""))) return flags;
  const nonTotal = body.filter((r) => !LABEL_TOTAL.test(r[0] ?? ""));
  if (nonTotal.some((r) => (r[r.length - 1] ?? "").trim() !== "" && parseMoney(r[r.length - 1]) === null)) return flags;

  // A table with no single total row has nothing to compare, so it is not arithmetic-checked at all —
  // including the per-line quantity check, which must not run on its own.
  const totalRows = body.filter((r) => LABEL_TOTAL.test(r[0] ?? ""));
  if (totalRows.length !== 1) return flags;

  if (qtyCol >= 0 && unitCol >= 0) {
    for (const r of body) {
      const total = parseMoney(r[r.length - 1] ?? "");
      const q = parseMoney(r[qtyCol] ?? "");
      const u = parseMoney(r[unitCol] ?? "");
      if (total !== null && q !== null && u !== null && !near(q * u, total) && !LABEL_TOTAL.test(r[0])) {
        flags.push({ kind: "arithmetic", section, detail: `"${r[0].slice(0, 60)}": ${q} x ${u} = ${(q * u).toFixed(2)}, but the line says ${total}` });
      }
    }
  }

  const stated = parseMoney(totalRows[0][totalRows[0].length - 1] ?? "");
  const lines = body.filter((r) => !LABEL_TOTAL.test(r[0] ?? "")).map((r) => parseMoney(r[r.length - 1] ?? ""));
  const nums = lines.filter((v): v is number => v !== null);
  if (stated === null || nums.length < 2) return flags;
  const sum = nums.reduce((a, b) => a + b, 0);
  if (!near(sum, stated)) flags.push({ kind: "arithmetic", section, detail: `lines add up to ${sum.toFixed(2)}, but the total says ${stated}` });
  return flags;
}

/** Small stable string hash (djb2, base 36): enough to tell two contexts apart in an acknowledgment key. */
function digest(text: string): string {
  let h = 5381;
  for (let i = 0; i < text.length; i++) h = ((h * 33) ^ text.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

/** All open flags across a proposal's sections. Empty means nothing to review. */
export function reviewProposalSections(sections: ReviewSection[]): ReviewFlag[] {
  const flags: ReviewFlag[] = [];
  for (const s of sections) {
    const text = stripTags(s.content ?? "");
    const blocks = (s.content ?? "").split(/<\/(?:p|li|td|th|tr|h[1-6]|div|blockquote)>|<br\s*\/?>/i).map(stripTags).filter(Boolean);
    for (const m of MARKERS) {
      const hits = [...text.matchAll(m.re)];
      if (hits.length > 0) {
        // Fingerprint the paragraph/list item/cell each marker sits in, so replacing the marker's surroundings changes
        // the flag's key while an edit elsewhere in the section does not.
        const single = new RegExp(m.re.source, m.re.flags.replace("g", ""));
        const holders = blocks.filter((b) => single.test(b));
        flags.push({ kind: m.kind, section: s.title, detail: `${hits.length} x ${m.label}`, fingerprint: digest(holders.join("\u0001")) });
      }
    }
    for (const rows of tableRows(s.content ?? "")) flags.push(...checkTableArithmetic(rows, s.title));
  }
  return flags;
}

export class ProposalReviewError extends Error {
  constructor(public flags: ReviewFlag[]) {
    super(`This proposal has ${flags.length} unresolved review flag(s). Resolve them or acknowledge them before sending.`);
    this.name = "ProposalReviewError";
  }
}

/** Stable identity of a flag, so an acknowledgment covers exactly the flags the person saw. */
export const flagKey = (f: ReviewFlag) => `${f.kind}|${f.section}|${f.detail}${f.fingerprint ? `|${f.fingerprint}` : ""}`;

/** Flags not covered by what the person acknowledged (anything introduced since they looked). */
export function unacknowledgedFlags(flags: ReviewFlag[], acknowledgedKeys: string[] | undefined): ReviewFlag[] {
  const seen = new Set(acknowledgedKeys ?? []);
  return flags.filter((f) => !seen.has(flagKey(f)));
}
