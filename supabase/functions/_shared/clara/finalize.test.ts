import { assertEquals } from "jsr:@std/assert@1";
import { FakeSupabase, asClient } from "../testing/fake-supabase.ts";
import { ensureSession, patchSession, updateLearned, appendTurn, getSession } from "./call-state.ts";
import { finalizeInboundCall, type FinalizeDeps } from "./finalize.ts";
import type { NotifyRequest } from "./notify.ts";

function setup(opts: { knownContact?: string } = {}) {
  const f = new FakeSupabase({}, {
    unique: { clara_call_sessions: [["call_sid"]], call_logs: [["twilio_call_sid"]] },
    rpc: { find_contact_id_by_phone: () => opts.knownContact ?? null },
  });
  const notes: NotifyRequest[] = [], booked: unknown[] = [];
  const d: FinalizeDeps = {
    env: { get: (k: string) => ({ SUPABASE_URL: "https://x.supabase.co" })[k] },
    notify: (r) => { notes.push(r); return Promise.resolve("sms"); },
    bookOwnerSlot: (e) => { booked.push(e); return Promise.resolve(true); },
    agentUserId: "clara-user", sleep: () => Promise.resolve(),
  };
  return { f, db: asClient(f), d, notes, booked };
}
const start = (db: ReturnType<typeof setup>["db"], line: "business" | "work" = "business") =>
  ensureSession(db, { callSid: "CA1", orgId: "o", direction: "inbound", from: "+15550001111", to: "+18135550142" }).then(() => patchSession(db, "CA1", { line }));

Deno.test("a call that learned nothing creates no contact, conversation or notification", async () => {
  const s = setup();
  await start(s.db);
  assertEquals(await finalizeInboundCall(s.db, "CA1", "qualified", s.d), "finalized");
  assertEquals([s.f.rows("contacts").length, s.f.rows("conversations").length, s.f.rows("messages").length, s.notes.length], [0, 0, 0, 0]);
});

Deno.test("a business-line lead from an unknown number creates no contact or thread, but still notifies once", async () => {
  const s = setup();
  await start(s.db);
  await appendTurn(s.db, "CA1", { role: "caller", text: "I need help with automation", at: "t" });
  await appendTurn(s.db, "CA1", { role: "clara", text: "Happy to help. Your name?", at: "t" });
  await updateLearned(s.db, "CA1", { callerName: "Ann Lee", company: "Acme", need: "automation", email: "ann@acme.com" });
  await finalizeInboundCall(s.db, "CA1", "qualified", s.d);
  // Contacts come from bookings, forms or manual entry, never from a call.
  assertEquals([s.f.rows("contacts").length, s.f.rows("conversations").length, s.f.rows("messages").length], [0, 0, 0]);
  assertEquals(s.notes.map((n) => [n.kind, n.priority]), [["lead.inbound_call", "normal"]]);
});

Deno.test("a known caller's call is written into their existing thread with the transcript", async () => {
  const s = setup({ knownContact: "c-known" });
  await start(s.db);
  await appendTurn(s.db, "CA1", { role: "caller", text: "I need help with automation", at: "t" });
  await appendTurn(s.db, "CA1", { role: "clara", text: "Happy to help. Your name?", at: "t" });
  await updateLearned(s.db, "CA1", { callerName: "Ann Lee", need: "automation" });
  await finalizeInboundCall(s.db, "CA1", "qualified", s.d);
  const msgs = s.f.rows("messages");
  assertEquals(msgs.map((m) => m.message_type), ["call_event", "call_transcript"]);
  assertEquals(String(msgs[1].body).includes("Clara: Happy to help"), true);
  assertEquals(s.f.rows("conversations")[0].assigned_user_id, "clara-user");
  assertEquals(s.f.rows("call_logs")[0].conversation_id, s.f.rows("conversations")[0].id);
});

Deno.test("finalizing twice (voice webhook + status callback race) logs and notifies once", async () => {
  const s = setup();
  await start(s.db);
  await updateLearned(s.db, "CA1", { callerName: "Ann", need: "x" });
  assertEquals(await finalizeInboundCall(s.db, "CA1", "qualified", s.d), "finalized");
  assertEquals(await finalizeInboundCall(s.db, "CA1", "qualified", s.d), "already");
  assertEquals([s.f.rows("messages").length, s.notes.length], [0, 1]);
});

Deno.test("a known caller keeps their existing contact; asking for a person is critical", async () => {
  const s = setup({ knownContact: "existing-contact" });
  await start(s.db);
  await updateLearned(s.db, "CA1", { need: "speak to someone" });
  await finalizeInboundCall(s.db, "CA1", "wants-human", s.d);
  assertEquals(s.f.rows("contacts").length, 0);
  assertEquals(s.f.rows("conversations")[0].contact_id, "existing-contact");
  assertEquals(s.notes[0].priority, "critical");
});

Deno.test("work line: books the agreed slot on the owner's calendar, texts only when it matters", async () => {
  const s = setup({ knownContact: "c9" });
  await start(s.db, "work");
  await patchSession(s.db, "CA1", { profile: { kind: "client", name: "Pat" }, offeredSlots: ["2026-10-21T14:00:00Z"] });
  await updateLearned(s.db, "CA1", { callerName: "Pat", need: "kickoff", bookSlot: "2026-10-21T14:00:00Z" });
  await finalizeInboundCall(s.db, "CA1", "qualified", s.d);
  assertEquals(s.booked.length, 1);
  assertEquals((s.booked[0] as { startISO: string }).startISO, "2026-10-21T14:00:00.000Z");
  assertEquals(s.notes.length, 0); // routine client message with a booking -> brief, not a text
  assertEquals(String(s.f.rows("messages")[0].body).includes("I booked a call with you"), true);
});

Deno.test("work line: an urgent client is texted with the callback number", async () => {
  const s = setup({ knownContact: "c9" });
  await start(s.db, "work");
  await patchSession(s.db, "CA1", { profile: { kind: "client", name: "Pat" } });
  await updateLearned(s.db, "CA1", { need: "our site is down right now", callback: "+15559998888" });
  await finalizeInboundCall(s.db, "CA1", "qualified", s.d);
  assertEquals(s.notes[0].kind, "work_line.call");
  assertEquals(s.notes[0].text.includes("Call back on +15559998888"), true);
  assertEquals((await getSession(s.db, "CA1"))!.finalized, true);
});
