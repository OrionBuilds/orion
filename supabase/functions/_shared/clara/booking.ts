/**
 * Main-business-line booking (ported from CLARA's businessBooking.ts).
 *
 * Same backend as the website chat and voice widget: the OS booking-api on the discovery-call
 * calendar, so a phone booking and a web booking can never collide. A few real open times are
 * fetched once at call setup, Clara may only offer those, and the one the caller picks comes back
 * as learned.bookSlot. booking-api re-checks the slot server-side, so a slot taken mid-call is a
 * 409, never a double booking.
 */
import type { BusinessBooking, CallState } from "./types.ts";
import type { Env } from "./phones.ts";

export interface BookableSlot { start: string; end: string }

type F = typeof fetch;
/** No built-in calendar: set CLARA_BOOKING_CALENDAR_ID and CLARA_BOOKING_TYPE_ID. */
const DEFAULT_CALENDAR_ID = "";
const DEFAULT_TYPE_ID = "";

/** Twilio drops a call webhook after 15 s; a turn that books must answer well inside that. */
export const BOOKING_TURN_DEADLINE_MS = 11_000;
/** Past this the booking is "uncertain" (it may have landed), never "failed". */
export const BOOKING_POST_TIMEOUT_MS = 12_000;

export const bookingTz = (env: Env) => env.get("CLARA_BOOKING_TZ")?.trim() || "America/New_York";
const calendarId = (env: Env) => env.get("CLARA_BOOKING_CALENDAR_ID")?.trim() || DEFAULT_CALENDAR_ID;
const typeId = (env: Env) => env.get("CLARA_BOOKING_TYPE_ID")?.trim() || DEFAULT_TYPE_ID;
const bookingApi = (env: Env) => {
  const url = env.get("SUPABASE_URL")?.trim();
  return url ? `${url.replace(/\/+$/, "")}/functions/v1/booking-api` : null;
};

/** On unless CLARA_BUSINESS_BOOKING=off. */
export const businessBookingEnabled = (env: Env) =>
  (env.get("CLARA_BUSINESS_BOOKING") ?? "on").trim().toLowerCase() !== "off" && bookingApi(env) !== null;

/** A slot as spoken: in the BOOKING calendar's timezone, with the zone named so nobody agrees to the wrong hour. */
export function speakBookingSlot(iso: string, tz = "America/New_York"): string {
  const when = new Date(iso).toLocaleString("en-US", { timeZone: tz, weekday: "long", hour: "numeric", minute: "2-digit" });
  let zone = "";
  try {
    zone = new Intl.DateTimeFormat("en-US", { timeZone: tz, timeZoneName: "longGeneric" }).formatToParts(new Date(iso)).find((p) => p.type === "timeZoneName")?.value ?? "";
  } catch { /* older ICU: bare time */ }
  return zone ? `${when} ${zone}` : when;
}

const ymd = (d: Date, tz: string) => new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);

/**
 * Up to n slots a caller can choose between: the earliest on each of the next distinct days first
 * ("tomorrow morning or Thursday" is a real choice), then next-earliest to fill. Within 7 days only:
 * "Monday, 9:00 AM" is ambiguous further out.
 */
export function pickSpread(slots: BookableSlot[], n: number, now: Date, tz = "America/New_York"): BookableSlot[] {
  const horizon = now.getTime() + 7 * 86_400_000;
  const usable = slots
    .filter((s) => { const t = Date.parse(s.start); return Number.isFinite(t) && t > now.getTime() && t <= horizon && Date.parse(s.end) > t; })
    .sort((a, b) => Date.parse(a.start) - Date.parse(b.start));
  const picked: BookableSlot[] = [];
  const days = new Set<string>();
  for (const s of usable) {
    if (picked.length >= n) break;
    const day = ymd(new Date(s.start), tz);
    if (days.has(day)) continue;
    days.add(day);
    picked.push(s);
  }
  for (const s of usable) {
    if (picked.length >= n) break;
    if (!picked.includes(s)) picked.push(s);
  }
  return picked.sort((a, b) => Date.parse(a.start) - Date.parse(b.start));
}

/** Open times for the main line from the same availability engine the website uses. [] on any failure. */
export async function businessSlots(env: Env, n = 3, f: F = fetch, now = new Date()): Promise<BookableSlot[]> {
  const api = bookingApi(env);
  if (!api) return [];
  const tz = bookingTz(env);
  const qs = new URLSearchParams({
    calendar_id: calendarId(env), type_id: typeId(env),
    start_date: ymd(now, tz), end_date: ymd(new Date(now.getTime() + 8 * 86_400_000), tz), timezone: tz,
  });
  try {
    const r = await f(`${api}/availability?${qs}`, {
      headers: { Authorization: `Bearer ${env.get("SUPABASE_ANON_KEY") ?? ""}` },
      signal: AbortSignal.timeout(4_000),
    });
    if (!r.ok) return [];
    const j = (await r.json().catch(() => ({}))) as { slots?: Array<{ start?: unknown; end?: unknown }> };
    const slots = (j.slots ?? []).flatMap((s) => (typeof s.start === "string" && typeof s.end === "string" ? [{ start: s.start, end: s.end }] : []));
    return pickSpread(slots, n, now, tz);
  } catch {
    return [];
  }
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Normalizes a spoken/typed email; "jane at acme dot com" is rejected rather than guessed. */
export function cleanEmail(raw: string | undefined): string | undefined {
  const e = (raw ?? "").trim().replace(/\s+/g, "").replace(/\.$/, "").toLowerCase();
  return EMAIL_RE.test(e) ? e : undefined;
}

export type BookResult =
  | { ok: true; meetLink?: string; appointmentId?: string }
  | { ok: false; taken: boolean; error: string; uncertain?: true };

export async function bookBusinessSlot(
  env: Env,
  input: { slot: BookableSlot; name?: string; email?: string; phone: string; notes?: string },
  f: F = fetch,
  timeoutMs = BOOKING_POST_TIMEOUT_MS,
): Promise<BookResult> {
  const api = bookingApi(env);
  if (!api) return { ok: false, taken: false, error: "booking not configured (SUPABASE_URL)" };
  const answers: Record<string, string> = { name: input.name?.trim() || "Phone caller", phone: input.phone };
  if (input.email) answers.email = input.email;
  if (input.notes?.trim()) answers.notes = input.notes.trim().slice(0, 1_000);
  try {
    const r = await f(`${api}/book`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${env.get("SUPABASE_ANON_KEY") ?? ""}` },
      body: JSON.stringify({
        calendar_id: calendarId(env), appointment_type_id: typeId(env),
        start_utc: input.slot.start, end_utc: input.slot.end, visitor_timezone: bookingTz(env), answers,
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const j = (await r.json().catch(() => ({}))) as { success?: boolean; error?: string; appointment?: { id?: string; google_meet_link?: string | null } };
    if (r.ok && j.success) return { ok: true, appointmentId: j.appointment?.id, meetLink: j.appointment?.google_meet_link ?? undefined };
    // A 2xx that doesn't confirm may still have created the appointment: never report that as a failure.
    if (r.ok && j.success !== false && !j.error) return { ok: false, taken: false, uncertain: true, error: `booking-api ${r.status} without confirmation` };
    return { ok: false, taken: r.status === 409, error: (j.error || `booking-api ${r.status}`).slice(0, 200) };
  } catch (e) {
    // Timed out or dropped after the request went out: booking-api may well have committed it.
    return { ok: false, taken: false, uncertain: true, error: `no response from booking-api: ${String(e).slice(0, 160)}` };
  }
}

/**
 * What the call has agreed to, if anything is ready to book. Only a slot Clara actually offered
 * (with its exact end, which booking-api requires) can be booked; `requireEmail` holds the booking
 * mid-call until the caller has given an email so the invite reaches them.
 */
export function pendingBooking(state: CallState, opts: { requireEmail: boolean }): { slot: BookableSlot; email?: string } | null {
  if (state.line === "work" || state.booking) return null;
  const start = state.learned.bookSlot?.trim();
  if (!start || !state.offeredSlots?.includes(start)) return null;
  const end = state.offeredSlotEnds?.[start];
  if (!end) return null;
  const email = cleanEmail(state.learned.email);
  if (opts.requireEmail && !email) return null;
  return { slot: { start, end }, email };
}

export async function bookReady(env: Env, state: CallState, p: { slot: BookableSlot; email?: string }, f: F = fetch): Promise<BusinessBooking> {
  const l = state.learned;
  const notes = [
    "Booked by Clara on the main phone line.",
    l.company ? `Company: ${l.company}` : "",
    l.need ? `Need: ${l.need}` : "",
    l.timeline ? `Timeline: ${l.timeline}` : "",
  ].filter(Boolean).join("\n");
  const r = await bookBusinessSlot(env, { slot: p.slot, name: l.callerName, email: p.email, phone: state.fromE164, notes }, f);
  return r.ok
    ? { start: p.slot.start, status: "booked", emailed: Boolean(p.email), meetLink: r.meetLink, appointmentId: r.appointmentId }
    : { start: p.slot.start, status: r.uncertain ? "uncertain" : r.taken ? "slot-taken" : "failed", error: r.error };
}

/** What the caller hears when a mid-call booking didn't simply succeed. */
export function bookingFallbackLine(status: BusinessBooking["status"], hangup: boolean): string {
  const end = hangup ? "Thanks for calling." : "Is there anything else I can help with?";
  if (status === "pending") return `I'm locking that time in now, and the team will confirm it with you shortly. ${end}`;
  if (status === "slot-taken") return `I'm sorry — that time was just taken. I'll have the team reach out to find another time that works. ${end}`;
  if (status === "uncertain") return `I've sent that time through, and the team will confirm it with you shortly. ${end}`;
  return `I couldn't lock that time in just now — I'll have the team confirm a time with you. ${end}`;
}
