import { assertEquals } from "jsr:@std/assert@1";
import { FakeSupabase, asClient } from "../testing/fake-supabase.ts";
import { ensureCallConversation, isAllowedRecordingUrl, processRecording, repairRecording, type RecordingDeps } from "./recordings.ts";

const REC = "https://api.twilio.com/2010-04-01/Accounts/AC1/Recordings/RE1";
const params = { CallSid: "CA1", RecordingUrl: REC, RecordingStatus: "completed", RecordingDuration: "134" };

function setup(callLog: Record<string, unknown> | null, over: Partial<RecordingDeps> = {}) {
  const f = new FakeSupabase({ call_logs: callLog ? [callLog] : [], conversations: [{ id: "cv1" }] });
  const calls: string[] = [];
  const d: RecordingDeps = {
    download: (u) => { calls.push(`dl:${u}`); return Promise.resolve(new Uint8Array([1, 2, 3])); },
    upload: (p) => { calls.push(`up:${p}`); return Promise.resolve(); },
    transcribe: () => Promise.resolve({ text: " Hello, this is Ann. " }),
    sleep: () => Promise.resolve(),
    ...over,
  };
  return { f, db: asClient(f), d, calls };
}
const linked = { twilio_call_sid: "CA1", organization_id: "o", conversation_id: "cv1", contact_id: "c1" };

Deno.test("only Twilio's recording host is ever fetched", () => {
  assertEquals(isAllowedRecordingUrl(REC), true);
  for (const bad of ["https://evil.example/x", "http://api.twilio.com/x", "https://api.twilio.com.evil.io/x", "not a url"]) assertEquals(isAllowedRecordingUrl(bad), false, bad);
});

Deno.test("happy path stores audio, transcript and a conversation message", async () => {
  const s = setup(linked);
  const r = await processRecording(s.db, params, s.d);
  assertEquals(r, { ok: true, path: "o/CA1.mp3", transcript: "done", messageLogged: true });
  assertEquals(s.calls, [`dl:${REC}.mp3`, "up:o/CA1.mp3"]);
  const log = s.f.rows("call_logs")[0];
  assertEquals([log.recording_path, log.recording_duration_seconds, log.transcript, log.transcript_status], ["o/CA1.mp3", 134, "Hello, this is Ann.", "done"]);
  const m = s.f.rows("messages")[0];
  assertEquals([m.message_type, String(m.body).startsWith("Call recording transcript:")], ["call_recording", true]);
});

Deno.test("a forged host, an unknown call, or a non-completed status does nothing", async () => {
  const s = setup(linked);
  assertEquals((await processRecording(s.db, { ...params, RecordingUrl: "https://evil.example/r" }, s.d)).ok, false);
  assertEquals((await processRecording(s.db, { ...params, RecordingStatus: "in-progress" }, s.d)).ok, false);
  assertEquals(s.calls, []);
  const none = setup(null);
  assertEquals(await processRecording(none.db, params, none.d), { ok: false, reason: "unknown-call" });
});

Deno.test("transcription failure never loses the recording", async () => {
  const s = setup(linked, { transcribe: () => Promise.resolve({ error: "quota" }) });
  const r = await processRecording(s.db, params, s.d);
  assertEquals(r.ok && r.transcript, "failed");
  assertEquals(s.f.rows("call_logs")[0].recording_path, "o/CA1.mp3");
  assertEquals(String(s.f.rows("messages")[0].body), "Call recording saved (no speech transcribed).");
});

Deno.test("a recorded call from an unknown number keeps its recording but creates no contact or thread", async () => {
  const s = setup({ ...linked, conversation_id: null, contact_id: null, from_number: "+15550001111", to_number: "+18135550142", direction: "inbound" });
  (s.f as unknown as { opts: { rpc?: Record<string, unknown> } }).opts.rpc = { find_contact_id_by_phone: () => null };
  const r = await processRecording(s.db, params, s.d);
  assertEquals(r.ok && r.messageLogged, false);
  assertEquals(s.f.rows("contacts").length, 0);
  assertEquals(s.f.rows("call_logs")[0].conversation_id, null);
  assertEquals(s.f.rows("messages").length, 0);
  assertEquals(s.f.rows("call_logs")[0].recording_path, "o/CA1.mp3");
});

Deno.test("a recorded call from a known contact gets a thread and a Play message", async () => {
  const s = setup({ ...linked, conversation_id: null, contact_id: null, from_number: "+15550001111", to_number: "+18135550142", direction: "inbound" });
  (s.f as unknown as { opts: { rpc?: Record<string, unknown> } }).opts.rpc = { find_contact_id_by_phone: () => "c-known" };
  const r = await processRecording(s.db, params, s.d);
  assertEquals(r.ok && r.messageLogged, true);
  const log = s.f.rows("call_logs")[0];
  assertEquals([log.contact_id, log.conversation_id !== null], ["c-known", true]);
  assertEquals(s.f.rows("messages").map((m) => m.message_type).sort(), ["call_event", "call_recording"]);
});

Deno.test("an existing contact with that number is used, not duplicated", async () => {
  const f = new FakeSupabase({
    call_logs: [{ twilio_call_sid: "CA9", organization_id: "o", conversation_id: null, contact_id: null, from_number: "+15550002222", direction: "inbound" }],
    contacts: [{ id: "c-known" }], conversations: [],
  }, { rpc: { find_contact_id_by_phone: () => "c-known" } });
  const r = await ensureCallConversation(asClient(f), "CA9", { seconds: 12 });
  assertEquals(r?.contactId, "c-known");
  assertEquals(f.rows("contacts").length, 1);
});

Deno.test("repairRecording transcribes an old recording from an unknown number without creating a contact", async () => {
  const f = new FakeSupabase({
    call_logs: [{ twilio_call_sid: "CA7", organization_id: "o", conversation_id: null, contact_id: null, from_number: "+15550003333", direction: "inbound", recording_path: "o/CA7.mp3", recording_duration_seconds: 30, transcript: null, transcript_status: "failed" }],
    conversations: [],
  }, { rpc: { find_contact_id_by_phone: () => null } });
  const d = { downloadStored: () => Promise.resolve(new Uint8Array([9])), transcribe: () => Promise.resolve({ text: "  Please call me back.  " }) };
  const a = await repairRecording(asClient(f), "CA7", d);
  assertEquals(a, { ok: true, linked: false, transcript: "done" }); // unknown number: no contact, no thread
  assertEquals(f.rows("call_logs")[0].transcript, "Please call me back.");
  assertEquals(f.rows("contacts").length, 0);
  const again = await repairRecording(asClient(f), "CA7", d);
  assertEquals(again.ok, true);
  assertEquals(f.rows("messages").length, 0);
});

Deno.test("repairRecording keeps the recording playable when transcription fails, and remembers why", async () => {
  const f = new FakeSupabase({
    call_logs: [{ twilio_call_sid: "CA8", organization_id: "o", conversation_id: null, contact_id: null, from_number: "+15550004444", direction: "inbound", recording_path: "o/CA8.mp3", transcript: null, transcript_status: "pending" }],
    conversations: [],
  }, { rpc: { find_contact_id_by_phone: () => null } });
  const r = await repairRecording(asClient(f), "CA8", { downloadStored: () => Promise.resolve(new Uint8Array([1])), transcribe: () => Promise.resolve({ error: "invalid api key" }) });
  assertEquals([r.ok, r.linked, r.transcript], [true, false, "failed"]);
  assertEquals(f.rows("call_logs")[0].transcript_error, "invalid api key");
  assertEquals(f.rows("call_logs")[0].recording_path, "o/CA8.mp3");
});
