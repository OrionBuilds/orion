import { assertEquals } from "jsr:@std/assert@1";
import { FakeSupabase, asClient } from "../testing/fake-supabase.ts";
import type { HoldDeps } from "./hold.ts";
import { handleOwnerSms } from "./owner-sms.ts";

function setup(liveHold = false) {
  const f = new FakeSupabase({ clara_holds: liveHold ? [{ call_sid: "CA1", state: "accepted", who: "Pat", created_at: "2026-10-20", deadline_at: "2099-01-01T00:00:00Z" }] : [] });
  const asked: string[] = [];
  return { db: asClient(f), asked, d: { hold: { now: () => Date.now() } as unknown as HoldDeps, run: (t: string) => { asked.push(t); return Promise.resolve("Done."); } } };
}

Deno.test("a bare 1 or 2 while a caller is on hold is about the hold, never a command", async () => {
  const s = setup(true);
  assertEquals(await handleOwnerSms(s.db, { body: "1" }, s.d), "Already ringing you — pick up and I'll connect you.");
  assertEquals(s.asked, []);
});

Deno.test("with no live hold, everything goes to the owner brain; empty texts do nothing", async () => {
  const s = setup(false);
  assertEquals(await handleOwnerSms(s.db, { body: "1" }, s.d), "Done.");
  assertEquals(await handleOwnerSms(s.db, { body: "email Casey hi" }, s.d), "Done.");
  assertEquals(s.asked, ["1", "email Casey hi"]);
  assertEquals(await handleOwnerSms(s.db, { body: "   " }, s.d), null);
});
