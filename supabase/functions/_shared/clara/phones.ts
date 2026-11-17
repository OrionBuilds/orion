/**
 * Which numbers are the owner's, and which one to reach him on (ported from CLARA's ownerPhones.ts).
 *
 *   OWNER_PHONE           identifies the owner (kept for compatibility)
 *   OWNER_WORK_PHONE      the work iPhone; forwards to Clara, so it is a LOOP number
 *   OWNER_PERSONAL_PHONE  the personal cell; where owner-bound calls/texts go
 *
 * Identity compares COMPLETE normalized numbers; a suffix match would let +44 689 555 0100
 * pass as +1 689 555 0100.
 */
export type Env = { get(k: string): string | undefined };

const clean = (v: string | undefined | null) => (v ?? "").trim();

/** Last ten digits: for dedupe/display keys only, never identity. */
export function phoneKey(raw: string | undefined | null): string {
  return String(raw ?? "").replace(/\D/g, "").slice(-10);
}

/** E.164 or null. A bare ten-digit number is US (+1); anything else must carry a country code. */
export function normalizeE164(raw: string | undefined | null): string | null {
  const t = String(raw ?? "").trim();
  if (!t || /[a-z]/i.test(t)) return null;
  const d = t.replace(/\D/g, "");
  if (t.startsWith("+")) {
    if (d.startsWith("1")) return d.length === 11 ? `+${d}` : null;
    return d.length >= 8 && d.length <= 15 ? `+${d}` : null;
  }
  if (d.length === 10) return `+1${d}`;
  if (d.length === 11 && d.startsWith("1")) return `+${d}`;
  return null;
}

export function samePhone(a: string | undefined | null, b: string | undefined | null): boolean {
  const na = normalizeE164(a);
  return na !== null && na === normalizeE164(b);
}

/** Every number that identifies the owner. */
export function ownerPhoneSet(env: Env): string[] {
  const out: string[] = [];
  for (const k of ["OWNER_PHONE", "OWNER_PERSONAL_PHONE", "OWNER_WORK_PHONE"]) {
    const p = normalizeE164(clean(env.get(k)));
    if (p && !out.includes(p)) out.push(p);
  }
  return out;
}

export function isOwner(env: Env, from: string | undefined | null): boolean {
  return ownerPhoneSet(env).some((p) => samePhone(p, from));
}

/** Numbers Clara must never ring or text to reach the owner: the work phone and her own lines. */
export function loopNumbers(env: Env): string[] {
  return ["OWNER_WORK_PHONE", "CLARA_WORKLINE_NUMBER", "CLARA_TWILIO_NUMBER"]
    .map((k) => normalizeE164(env.get(k))).filter((p): p is string => p !== null);
}

export function isLoopNumber(env: Env, phone: string | undefined | null): boolean {
  return loopNumbers(env).some((l) => samePhone(l, phone));
}

/** Where to reach the owner: personal cell, else OWNER_PHONE; never a loop number. */
export function ownerDeliveryNumber(env: Env): string | undefined {
  return [env.get("OWNER_PERSONAL_PHONE"), env.get("OWNER_PHONE")]
    .map((p) => normalizeE164(p))
    .find((p): p is string => p !== null && !isLoopNumber(env, p));
}

/** Where a warm transfer may ring: personal cell only (the work phone would loop back to Clara). */
export function transferTarget(env: Env): string | undefined {
  const p = normalizeE164(env.get("OWNER_PERSONAL_PHONE"));
  return p && !isLoopNumber(env, p) ? p : undefined;
}
