import { assertEquals } from "jsr:@std/assert@1";
import type { CallState } from "./types.ts";
import { bookBusinessSlot, bookReady, bookingFallbackLine, cleanEmail, pendingBooking, pickSpread } from "./booking.ts";

const env = (m: Record<string, string> = {}) => ({ get: (k: string) => ({ SUPABASE_URL: "https://x.supabase.co", ...m })[k] });
const resp = (body: unknown, status = 200) => Promise.resolve(new Response(JSON.stringify(body), { status }));
const state = (over: Partial<CallState> = {}): CallState => ({
  fromE164: "+15551230000", turns: [], learned: {}, line: "business",
  offeredSlots: ["2026-10-21T14:00:00Z"], offeredSlotEnds: { "2026-10-21T14:00:00Z": "2026-10-21T14:30:00Z" }, ...over,
});

Deno.test("slots spread across distinct days before filling, within 7 days", () => {
  const now = new Date("2026-10-19T12:00:00Z");
  const s = (d: string, h: number) => ({ start: `${d}T${h}:00:00Z`, end: `${d}T${h}:30:00Z` });
  const picked = pickSpread([s("2026-10-20", 14), s("2026-10-20", 15), s("2026-10-21", 14), s("2026-10-23", 14), s("2026-11-30", 14)], 3, now);
  assertEquals(picked.map((p) => p.start.slice(0, 13)), ["2026-10-20T14", "2026-10-21T14", "2026-10-23T14"]);
  assertEquals(pickSpread([s("2026-11-30", 14)], 3, now), []);
});

Deno.test("only an offered slot with an email is bookable mid-call", () => {
  assertEquals(pendingBooking(state(), { requireEmail: true }), null);
  assertEquals(pendingBooking(state({ learned: { bookSlot: "2026-10-21T15:00:00Z", email: "a@b.co" } }), { requireEmail: true }), null); // not offered
  assertEquals(pendingBooking(state({ learned: { bookSlot: "2026-10-21T14:00:00Z" } }), { requireEmail: true }), null); // no email yet
  assertEquals(pendingBooking(state({ learned: { bookSlot: "2026-10-21T14:00:00Z" } }), { requireEmail: false })?.slot.end, "2026-10-21T14:30:00Z");
  assertEquals(pendingBooking(state({ line: "work", learned: { bookSlot: "2026-10-21T14:00:00Z" } }), { requireEmail: false }), null);
  assertEquals(pendingBooking(state({ booking: { start: "x", status: "booked" }, learned: { bookSlot: "2026-10-21T14:00:00Z" } }), { requireEmail: false }), null); // never twice
  assertEquals([cleanEmail(" Jane@Acme.com. "), cleanEmail("jane at acme dot com")], ["jane@acme.com", undefined]);
});

Deno.test("booking outcomes: success, taken (409), uncertain (2xx w/o confirm or timeout), failure", async () => {
  const slot = { start: "2026-10-21T14:00:00Z", end: "2026-10-21T14:30:00Z" };
  const run = (f: typeof fetch) => bookBusinessSlot(env(), { slot, phone: "+1" }, f, 50);
  assertEquals((await run((() => resp({ success: true, appointment: { id: "a1", google_meet_link: "https://meet" } })) as unknown as typeof fetch)), { ok: true, appointmentId: "a1", meetLink: "https://meet" });
  assertEquals((await run((() => resp({ error: "taken" }, 409)) as unknown as typeof fetch)), { ok: false, taken: true, error: "taken" });
  const unc = await run((() => resp({}, 200)) as unknown as typeof fetch);
  assertEquals(unc.ok === false && unc.uncertain, true);
  const boom = await run((() => Promise.reject(new Error("timeout"))) as unknown as typeof fetch);
  assertEquals(boom.ok === false && boom.uncertain, true);
  const fail = await run((() => resp({ error: "bad" }, 500)) as unknown as typeof fetch);
  assertEquals(fail.ok === false && !fail.uncertain && !fail.taken, true);
});

Deno.test("bookReady maps results onto the session's booking record", async () => {
  const p = { slot: { start: "2026-10-21T14:00:00Z", end: "2026-10-21T14:30:00Z" }, email: "a@b.co" };
  const ok = await bookReady(env(), state(), p, (() => resp({ success: true })) as unknown as typeof fetch);
  assertEquals([ok.status, ok.emailed], ["booked", true]);
  const taken = await bookReady(env(), state(), p, (() => resp({ error: "x" }, 409)) as unknown as typeof fetch);
  assertEquals(taken.status, "slot-taken");
  assertEquals(bookingFallbackLine("slot-taken", true).includes("just taken"), true);
});
