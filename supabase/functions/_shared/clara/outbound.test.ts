import { assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import { FakeSupabase, asClient } from "../testing/fake-supabase.ts";
import { type CallRequest, MAX_ATTEMPTS, checkCallable, dialRequest, dueRequests, withinCallingHours } from "./outbound.ts";
import { summarizeOutcome, finishOutbound, type FinishDeps } from "./outbound-finish.ts";
import { handleOutboundTurn, type OutboundVoiceDeps } from "./outbound-voice.ts";
import { ensureSession, updateLearned, appendTurn, getSession } from "./call-state.ts";
import type { NotifyRequest } from "./notify.ts";

const NOON = new Date("2026-10-20T16:00:00Z"); // 12:00 ET
const NIGHT = new Date("2026-10-21T03:00:00Z"); // 23:00 ET
const req = (o: Partial<CallRequest> = {}): CallRequest => ({
  id: "r1", organization_id: "o", requested_by: "owner", kind: "owner_request", contact_id: "c1", name: "Pat Lee", phone_e164: "+15551230001",
  goal: "I'm calling to confirm your appointment tomorrow at 10.", must_confirm: ["Will they attend"], context: null, appointment_id: null, agent_request_id: null,
  not_before: "2026-10-20T00:00:00Z", status: "queued", attempts: 0, last_attempt_at: null, call_sid: null, ...o,
});
const G = { now: NOON, tz: "America/New_York" };
const mk = (seed: Record<string, Record<string, unknown>[]> = {}) => {
  const f = new FakeSupabase({ clara_call_requests: [req() as unknown as Record<string, unknown>], ...seed }, { unique: { clara_call_sessions: [["call_sid"]], call_logs: [["twilio_call_sid"]] } });
  return { f, db: asClient(f) };
};

Deno.test("calling hours: weekday daytime ok; night, early morning and the org's quiet hours are not", () => {
  assertEquals(withinCallingHours(NOON, "America/New_York", undefined), true);
  assertEquals(withinCallingHours(NIGHT, "America/New_York", undefined), false);
  assertEquals(withinCallingHours(new Date("2026-10-20T11:00:00Z"), "America/New_York", undefined), false); // 7am
  assertEquals(withinCallingHours(NOON, "America/New_York", "11:00-13:00"), false);
});

Deno.test("guardrails: opt-outs are blocked forever, hours and recent attempts just wait, limits stop", async () => {
  const { db } = mk({ dnc_numbers: [{ org_id: "o", phone_number: "+15551230001" }] });
  assertEquals(await checkCallable(db, req(), G), { ok: false, reason: "on the opt-out list", retry: false });
  const ok = mk();
  assertEquals((await checkCallable(ok.db, req(), G)).ok, true);
  assertEquals(await checkCallable(ok.db, req(), { ...G, now: NIGHT }), { ok: false, reason: "outside calling hours", retry: true });
  assertEquals(await checkCallable(ok.db, req({ attempts: 1, last_attempt_at: new Date(NOON.getTime() - 3_600_000).toISOString() }), G), { ok: false, reason: "tried recently", retry: true });
  assertEquals(await checkCallable(ok.db, req({ attempts: MAX_ATTEMPTS }), G), { ok: false, reason: "attempt limit reached", retry: false });
  assertEquals(await checkCallable(ok.db, req({ phone_e164: "555" }), G), { ok: false, reason: "invalid number", retry: false });
});

Deno.test("an appointment confirmation needs a still-scheduled future appointment", async () => {
  const r = req({ kind: "confirm_appointment", appointment_id: "a1" });
  const live = mk({ appointments: [{ id: "a1", status: "scheduled", start_at_utc: "2026-10-21T14:00:00Z" }] });
  assertEquals((await checkCallable(live.db, r, G)).ok, true);
  for (const a of [{ id: "a1", status: "canceled", start_at_utc: "2026-10-21T14:00:00Z" }, { id: "a1", status: "scheduled", start_at_utc: "2026-10-19T14:00:00Z" }]) {
    assertEquals((await checkCallable(mk({ appointments: [a] }).db, r, G)).ok, false);
  }
  assertEquals((await checkCallable(mk().db, r, G)).ok, false); // no appointment at all
});

Deno.test("dialing claims the request, passes the request id, and never double-dials", async () => {
  const s = mk();
  const urls: string[] = [];
  const d = { env: { get: () => undefined }, auth: { accountSid: "AC1", authToken: "t" }, fromNumber: "+18135550142", base: "https://x/functions/v1", now: () => NOON, tz: "America/New_York",
    fetch: ((_u: string, init: RequestInit) => { urls.push(String(init.body)); return Promise.resolve(new Response(JSON.stringify({ sid: "CAout" }), { status: 201 })); }) as unknown as typeof fetch };
  assertEquals(await dialRequest(s.db, req(), d), "dialed");
  assertEquals(new URLSearchParams(urls[0]).get("Url"), "https://x/functions/v1/clara-voice-outbound?requestId=r1");
  assertEquals(new URLSearchParams(urls[0]).get("MachineDetection"), "DetectMessageEnd");
  const row = s.f.rows("clara_call_requests")[0];
  assertEquals([row.status, row.attempts, row.call_sid], ["dialing", 1, "CAout"]);
  assertEquals(await dialRequest(s.db, req(), d), "waiting"); // second pass can't claim it
  assertEquals(urls.length, 1);
  assertEquals((await dueRequests(s.db, NOON)).length, 0);
});

Deno.test("a Twilio refusal re-queues for later instead of losing the request", async () => {
  const s = mk();
  const d = { env: { get: () => undefined }, auth: { accountSid: "AC1", authToken: "t" }, fromNumber: "+1", base: "https://x", now: () => NOON, tz: "America/New_York",
    fetch: (() => Promise.resolve(new Response("nope", { status: 400 }))) as unknown as typeof fetch };
  assertEquals(await dialRequest(s.db, req(), d), "failed");
  assertEquals(s.f.rows("clara_call_requests")[0].status, "queued");
});

// ── settlement ──
function finishSetup(rq: Partial<CallRequest> = {}, seed: Record<string, Record<string, unknown>[]> = {}) {
  const s = mk({ ...seed });
  Object.assign(s.f.rows("clara_call_requests")[0], { status: "dialing", attempts: 1, call_sid: "CA1", ...rq });
  const notes: NotifyRequest[] = [];
  const d: FinishDeps = { now: () => NOON, notify: (_o, r) => { notes.push(r); return Promise.resolve("sms"); }, agentUserId: "clara", fromNumber: "+18135550142" };
  return { ...s, notes, d };
}
const talk = async (db: ReturnType<typeof mk>["db"], learned: Record<string, string>) => {
  await ensureSession(db, { callSid: "CA1", orgId: "o", direction: "outbound", from: "+15551230001", to: "+18135550142" });
  await appendTurn(db, "CA1", { role: "business", text: "Yes I'll be there", at: "t" });
  await updateLearned(db, "CA1", learned);
};

Deno.test("a confirmed appointment is noted on the appointment and not escalated to the owner", async () => {
  const s = finishSetup({ kind: "confirm_appointment", appointment_id: "a1", contact_id: "c1" }, { appointments: [{ id: "a1", status: "scheduled", start_at_utc: "2026-10-21T14:00:00Z", internal_notes: null }] });
  await talk(s.db, { confirmed: "yes" });
  assertEquals(await finishOutbound(s.db, "CA1", "conversation", s.d), "finished");
  assertEquals(String(s.f.rows("appointments")[0].internal_notes).startsWith("Confirmed by phone (Clara)"), true);
  assertEquals(s.notes.length, 0);
  assertEquals(s.f.rows("clara_call_requests")[0].status, "completed");
  assertEquals(s.f.rows("messages").map((m) => m.message_type), ["call_event", "call_transcript"]);
});

Deno.test("a reschedule or cancellation is reported to the owner and the appointment is never changed by Clara", async () => {
  const s = finishSetup({ kind: "confirm_appointment", appointment_id: "a1" }, { appointments: [{ id: "a1", status: "scheduled", start_at_utc: "2026-10-21T14:00:00Z" }] });
  await talk(s.db, { confirmed: "reschedule", newTime: "Thursday afternoon" });
  await finishOutbound(s.db, "CA1", "conversation", s.d);
  assertEquals(s.notes[0].text.includes("reschedule") && s.notes[0].text.includes("Thursday afternoon") && s.notes[0].text.includes("unchanged"), true);
  assertEquals(s.f.rows("appointments")[0].status, "scheduled");
});

Deno.test("unanswered calls are retried later, then reported once attempts run out", async () => {
  const first = finishSetup();
  assertEquals(await finishOutbound(first.db, "CA1", "no_answer", first.d), "finished");
  const row = first.f.rows("clara_call_requests")[0];
  assertEquals([row.status, new Date(String(row.not_before)).getTime() > NOON.getTime()], ["queued", true]);
  assertEquals(first.notes.length, 0);
  const last = finishSetup({ attempts: MAX_ATTEMPTS });
  await finishOutbound(last.db, "CA1", "voicemail", last.d);
  assertEquals([last.f.rows("clara_call_requests")[0].status, last.notes.length], ["voicemail", 1]);
});

Deno.test("a clarification call hands the answer to FRIDAY's request and re-queues it", async () => {
  const s = finishSetup({ kind: "clarify", agent_request_id: "ar1", requested_by: "friday" }, { agent_requests: [{ id: "ar1", status: "needs_input", body: "Fix export bug", notified_at: "x", attempt: 2 }] });
  await talk(s.db, { answer: "It's the CSV export, not the PDF" });
  await finishOutbound(s.db, "CA1", "conversation", s.d);
  const ar = s.f.rows("agent_requests")[0];
  assertEquals([ar.status, ar.notified_at, ar.attempt], ["queued", null, 0]);
  assertEquals(String(ar.body).includes("CSV export"), true);
});

Deno.test("'stop calling me' puts the number on the opt-out list; finishing twice does nothing twice", async () => {
  const s = finishSetup();
  await talk(s.db, { optOut: "yes" });
  await finishOutbound(s.db, "CA1", "conversation", s.d);
  assertEquals(s.f.rows("dnc_numbers")[0].phone_number, "+15551230001");
  assertEquals(await finishOutbound(s.db, "CA1", "conversation", s.d), "already");
  assertEquals(await finishOutbound(s.db, "NOPE", "conversation", s.d), "unknown");
  assertEquals(summarizeOutcome(req(), "no_answer", {}), "Pat Lee didn't answer.");
});

// ── the live loop ──
function voice(over: Partial<OutboundVoiceDeps> = {}, rq: Partial<CallRequest> = {}) {
  const s = mk();
  Object.assign(s.f.rows("clara_call_requests")[0], rq);
  const ends: string[] = [], notes: NotifyRequest[] = [];
  const d: OutboundVoiceDeps = {
    db: s.db, env: { get: (k: string) => ({ OWNER_NAME: "Jordan Example" })[k] }, speak: (t) => Promise.resolve(`<Say>${t}</Say>`),
    turn: () => Promise.resolve({ sayText: "Great, see you then.", hangup: true, learnedPatch: { confirmed: "yes" } }),
    finish: (_sid, e) => { ends.push(e); return Promise.resolve(); }, notify: (r) => { notes.push(r); return Promise.resolve(); }, now: () => NOON.getTime(), ...over,
  };
  const input = (params: Record<string, string>, first = false) => ({ params: { CallSid: "CA1", To: "+15551230001", ...params }, request: req(rq), isFirstReply: first, base: "https://x/functions/v1", orgId: "o" });
  return { ...s, d, ends, notes, input };
}

Deno.test("a person answering hears who's calling, that it's an AI, the recording notice and the reason; no recording yet", async () => {
  const v = voice();
  const x = await handleOutboundTurn(v.input({}), v.d);
  assertStringIncludes(x, "This call may be recorded");
  assertStringIncludes(x, "this is Clara, an AI assistant calling on behalf of");
  assertStringIncludes(x, "confirm your appointment");
  assertEquals(x.includes("<Start>"), false);
  assertStringIncludes(x, "requestId=r1&amp;rec=start");
});

Deno.test("a machine gets a short content-free message and the call is settled as voicemail", async () => {
  const v = voice({}, { kind: "confirm_appointment" });
  const x = await handleOutboundTurn(v.input({ AnsweredBy: "machine_end_beep" }), v.d);
  assertStringIncludes(x, "<Hangup/>");
  assertStringIncludes(x, "upcoming appointment");
  assertEquals(/\b10\b|tomorrow/.test(x), false); // no appointment details left on a machine
  assertEquals(v.ends, ["voicemail"]);
});

Deno.test("the first reply starts recording; done settles the call and hangs up; opt-out is recorded", async () => {
  const v = voice();
  await handleOutboundTurn(v.input({}), v.d);
  const x = await handleOutboundTurn(v.input({ SpeechResult: "Yes, I'll be there" }, true), v.d);
  assertStringIncludes(x, "<Start><Recording");
  assertStringIncludes(x, "<Hangup/>");
  assertEquals(v.ends, ["conversation"]);
  assertEquals((await getSession(v.db, "CA1"))!.state.learned.confirmed, "yes");

  const o = voice({ turn: () => Promise.resolve({ sayText: "Sorry, I won't call again.", hangup: true, optOut: true }) });
  await handleOutboundTurn(o.input({}), o.d);
  await handleOutboundTurn(o.input({ SpeechResult: "stop calling me" }, true), o.d);
  assertEquals((await getSession(o.db, "CA1"))!.state.learned.optOut, "yes");
});

Deno.test("a crashed turn apologises, settles the call, and never leaks the error", async () => {
  const v = voice({ turn: () => Promise.reject(new Error("model exploded")) });
  await handleOutboundTurn(v.input({}), v.d);
  const x = await handleOutboundTurn(v.input({ SpeechResult: "hi" }), v.d);
  assertStringIncludes(x, "having trouble on my end");
  assertEquals(x.includes("model exploded"), false);
  assertEquals(v.ends, ["conversation"]);
});

Deno.test("beyond the owner's own asks, only booked clients are called; the owner can ask for anyone", async () => {
  const friday = req({ requested_by: "friday", kind: "clarify", contact_id: "c9" });
  assertEquals((await checkCallable(mk().db, friday, G)), { ok: false, reason: "not a booked client (no appointment or project)", retry: false });
  assertEquals((await checkCallable(mk({ appointments: [{ id: "a", contact_id: "c9" }] }).db, friday, G)).ok, true);
  assertEquals((await checkCallable(mk({ projects: [{ id: "p", contact_id: "c9" }] }).db, friday, G)).ok, true);
  assertEquals((await checkCallable(mk().db, req({ requested_by: "friday", kind: "clarify", contact_id: null }), G)).ok, false);
  assertEquals((await checkCallable(mk().db, req({ requested_by: "owner", contact_id: null }), G)).ok, true); // owner: a restaurant, say
});
