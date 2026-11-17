import { assertEquals } from "jsr:@std/assert@1";
import { FakeSupabase, asClient } from "../testing/fake-supabase.ts";
import { appendTurn, claimFinalize, ensureSession, getSession, patchSession, updateLearned } from "./call-state.ts";

const mk = () => {
  const f = new FakeSupabase({}, { unique: { clara_call_sessions: [["call_sid"]] } });
  return { f, db: asClient(f) };
};
const i = { callSid: "CA1", orgId: "o", direction: "inbound" as const, from: "+1555", to: "+1666" };

Deno.test("ensureSession is idempotent (webhook retries)", async () => {
  const { f, db } = mk();
  const a = await ensureSession(db, i);
  await appendTurn(db, "CA1", { role: "caller", text: "hi", at: "t" });
  const b = await ensureSession(db, i);
  assertEquals(f.rows("clara_call_sessions").length, 1);
  assertEquals(a.call_sid, b.call_sid);
  assertEquals(b.state.turns.length, 1); // second call did not reset state
});

Deno.test("updateLearned never lets a blank overwrite a good value", async () => {
  const { db } = mk();
  await ensureSession(db, i);
  await updateLearned(db, "CA1", { need: "a quote", callerName: "Ann" });
  await updateLearned(db, "CA1", { need: "  ", company: "Acme" });
  assertEquals((await getSession(db, "CA1"))!.state.learned, { need: "a quote", callerName: "Ann", company: "Acme" });
});

Deno.test("patchSession merges and missing sessions are a no-op", async () => {
  const { db } = mk();
  await ensureSession(db, i);
  await patchSession(db, "CA1", { transferTried: true, line: "work" });
  const s = (await getSession(db, "CA1"))!.state;
  assertEquals([s.transferTried, s.line, s.fromE164], [true, "work", "+1555"]);
  assertEquals(await patchSession(db, "NOPE", { transferTried: true }), null);
});

Deno.test("finalize can be claimed exactly once", async () => {
  const { db } = mk();
  await ensureSession(db, i);
  assertEquals((await claimFinalize(db, "CA1"))?.call_sid, "CA1");
  assertEquals(await claimFinalize(db, "CA1"), null);
});
