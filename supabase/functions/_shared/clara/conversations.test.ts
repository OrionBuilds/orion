import { assertEquals } from "jsr:@std/assert@1";
import { FakeSupabase, asClient } from "../testing/fake-supabase.ts";
import { applyCallStatus, durationText, findOrCreateConversation, insertMessage, resolveContactByPhone, upsertCallLog } from "./conversations.ts";

const mk = (seed: Record<string, Record<string, unknown>[]> = {}, matched: string | null = null) => {
  const f = new FakeSupabase(seed, { unique: { call_logs: [["twilio_call_sid"]] }, rpc: { find_contact_id_by_phone: () => matched } });
  return { f, db: asClient(f) };
};

Deno.test("known caller is matched; an unknown number never creates a contact", async () => {
  assertEquals(await resolveContactByPhone(mk({}, "c1").db, "o", "+1555"), { id: "c1", created: false });
  const { f, db } = mk();
  assertEquals(await resolveContactByPhone(db, "o", "+1555"), null);
  assertEquals(f.rows("contacts").length, 0);
});

Deno.test("conversation: reuses the open thread across channels, assigns only if unassigned", async () => {
  const { f, db } = mk({ conversations: [{ id: "cv1", organization_id: "o", contact_id: "c1", status: "open", last_message_at: "2026-01-01", assigned_user_id: null }] });
  const r = await findOrCreateConversation(db, { orgId: "o", contactId: "c1", channel: "voice", assignedUserId: "clara" });
  assertEquals(r, { id: "cv1", created: false });
  assertEquals(f.rows("conversations")[0].assigned_user_id, "clara");
  await findOrCreateConversation(db, { orgId: "o", contactId: "c1", channel: "voice", assignedUserId: "someone-else" });
  assertEquals(f.rows("conversations")[0].assigned_user_id, "clara"); // not stolen

  const n = await findOrCreateConversation(db, { orgId: "o", contactId: "c2", channel: "voice" });
  assertEquals(n.created, true);
  assertEquals(f.rows("conversations").find((c) => c.contact_id === "c2")!.channel, "voice");
});

Deno.test("messages bump the thread's last_message_at; duplicate SIDs are swallowed", async () => {
  const f = new FakeSupabase({ conversations: [{ id: "cv1" }] }, { unique: { messages: [["external_id"]] } });
  const db = asClient(f);
  const base = { orgId: "o", conversationId: "cv1", contactId: "c1", channel: "sms" as const, direction: "inbound" as const, body: "hi", messageType: "text", externalId: "SM1", at: "2026-10-20T00:00:00Z" };
  assertEquals(typeof await insertMessage(db, base) !== "undefined", true);
  assertEquals(f.rows("conversations")[0].last_message_at, "2026-10-20T00:00:00Z");
  assertEquals(await insertMessage(db, base), null); // redelivery
  assertEquals(f.rows("messages").length, 1);
});

Deno.test("call_logs: one row per SID; status writes real columns", async () => {
  const { f, db } = mk();
  const c = { orgId: "o", callSid: "CA1", direction: "inbound" as const, from: "+1", to: "+2" };
  await upsertCallLog(db, c);
  await upsertCallLog(db, { ...c, conversationId: "cv1", contactId: "c1", line: "work" });
  assertEquals(f.rows("call_logs").length, 1);
  assertEquals(f.rows("call_logs")[0].conversation_id, "cv1");
  await applyCallStatus(db, "CA1", "completed", 134, "human");
  const row = f.rows("call_logs")[0];
  assertEquals([row.status, row.duration, row.answered_by, typeof row.ended_at], ["completed", 134, "human", "string"]);
  assertEquals("duration_seconds" in row, false);
  await applyCallStatus(db, "CA1", "in-progress", null);
  assertEquals(durationText(134), "2m 14s");
});
