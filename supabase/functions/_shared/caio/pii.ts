/**
 * PII / secret scanner for interview material (CAIO automation). Pure. It reports COUNTS per type, never the matched text,
 * so a flag can be stored and shown without copying the sensitive value anywhere. The same predicates guard extracted values.
 */

export type PiiType = "ssn" | "account_number" | "card_number" | "secret";
export interface PiiFlag { type: PiiType; count: number }

const SSN_RE = /(?<![\d-])\d{3}-\d{2}-\d{4}(?![\d-])/g;
// 9 digits (US bank routing / SSN without dashes) or 12-17 digits (account-like); optional single space/dash groups of 4 are the card path.
const NINE_RE = /(?<![\d.,-])\d{9}(?![\d.,-]|\d)/g;
const LONG_RE = /(?<![\d.,-])\d{12,17}(?![\d]|[.,]\d)/g;
const CARD_CAND_RE = /(?<![\d-])\d(?:[ -]?\d){12,18}(?![\d-])/g;
// Port of caio_has_secret (migration 20261105100000): \m \M word boundaries become \b.
const SECRET_RE = /(-----BEGIN [A-Z ]*PRIVATE KEY-----|\bAKIA[0-9A-Z]{16}\b|\bsk-[A-Za-z0-9_-]{20,}|\bgh[pousr]_[A-Za-z0-9]{30,}|\bxox[abprs]-[A-Za-z0-9-]{10,}|\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}|(password|passwd|secret|api[_-]?key|access[_-]?token)\s*[:=]\s*['"]?[A-Za-z0-9/+_.-]{12,})/gi;

export function luhnValid(digits: string): boolean {
  if (!/^\d{13,19}$/.test(digits)) return false;
  let sum = 0, dbl = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let n = digits.charCodeAt(i) - 48;
    if (dbl) { n *= 2; if (n > 9) n -= 9; }
    sum += n; dbl = !dbl;
  }
  return sum % 10 === 0;
}

const count = (text: string, re: RegExp) => (text.match(new RegExp(re.source, re.flags)) ?? []).length;

/** Card-like = a 13-19 digit run (spaces/dashes allowed between digits) that passes the Luhn check. */
function cardMatches(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(new RegExp(CARD_CAND_RE.source, CARD_CAND_RE.flags))) {
    const digits = m[0].replace(/[ -]/g, "");
    if (luhnValid(digits)) out.push(digits);
  }
  return out;
}

export function hasSecret(text: string): boolean {
  return new RegExp(SECRET_RE.source, SECRET_RE.flags.replace("g", "")).test(text);
}

/** Counts of sensitive-looking strings. Card-like numbers are not double counted as account numbers. */
export function scanPii(text: string): PiiFlag[] {
  const t = text ?? "";
  const cards = cardMatches(t);
  const cardSet = new Set(cards);
  const flags: PiiFlag[] = [];
  const ssn = count(t, SSN_RE);
  if (ssn) flags.push({ type: "ssn", count: ssn });
  let acct = count(t, NINE_RE);
  for (const m of t.matchAll(new RegExp(LONG_RE.source, LONG_RE.flags))) if (!cardSet.has(m[0])) acct++;
  if (acct) flags.push({ type: "account_number", count: acct });
  if (cards.length) flags.push({ type: "card_number", count: cards.length });
  const secrets = count(t, SECRET_RE);
  if (secrets) flags.push({ type: "secret", count: secrets });
  return flags;
}

/** True when a short extracted value looks like an SSN, an account/card number or a secret (such a value is never stored). */
export function looksSensitive(value: string): boolean {
  return scanPii(value).length > 0;
}

/** Plain-language summary for the owner ("2 SSN-like, 1 account number-like"); never includes values. */
export function describeFlags(flags: PiiFlag[]): string {
  const label: Record<PiiType, string> = { ssn: "SSN-like", account_number: "account-number-like", card_number: "card-number-like", secret: "secret-like" };
  return flags.map((f) => `${f.count} ${label[f.type]}`).join(", ");
}
