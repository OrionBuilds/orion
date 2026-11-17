import { assertEquals } from "jsr:@std/assert@1";
import { FakeSupabase, asClient } from "../testing/fake-supabase.ts";
import {
  classifyAnsweredBy, declineOnWhisper, expireHold, getHold, holdText, markBridged, markReturned,
  onCallerLeft, onOwnerAnswered, onOwnerLegEnded, parseHoldReply, startHold, tryHandleHoldReply, type HoldDeps,
} from "./hold.ts";

function setup(over: Partial<HoldDeps> = {}) {
  const f = new FakeSupabase({}, { uniqueWhere: { clara_holds: [(r) => r.state === "waiting" || r.state === "accepted"] } });
  const texts: string[] = [], redirects: string[] = [], patches: unknown[] = [], logs: string[] = [];
  let scheduled: (() => Promise<void>) | null = null;
  const d: HoldDeps = {
    textOwner: (t) => { texts.push(t); return Promise.resolve(true); },
    ringOwner: () => Promise.resolve({ ok: true, sid: "CAowner" }),
    redirect: (_s, url) => { redirects.push(url); return Promise.resolve({ ok: true }); },
    patchSession: (_s, p) => { patches.push(p); return Promise.resolve(null); },
    log: (w) => { logs.push(w); return Promise.resolve(); },
    schedule: (fn) => { scheduled = fn; },
    now: () => Date.parse("2026-10-20T15:00:00Z"),
    first: "Jordan", timeoutMs: 45_000, transferAvailable: true, ...over,
  };
  const input = { callSid: "CA1", orgId: "o", from: "+1555", who: "Pat", need: "contract", vip: true, base: "https://x/functions/v1" };
  return { f, db: asClient(f), d, input, texts, redirects, patches, logs, fire: () => scheduled!() };
}

Deno.test("startHold rings the owner, texts him, schedules expiry, and refuses a second live hold", async () => {
  const s = setup();
  assertEquals(await startHold(s.db, s.input, s.d), { ok: true, queueName: "hold-CA1" });
  assertEquals((await getHold(s.db, "CA1"))!.owner_call_sid, "CAowner");
  assertEquals(s.texts[0].includes("Reply 1 to take it"), true);
  assertEquals(await startHold(s.db, { ...s.input, callSid: "CA2" }, s.d), { ok: false, reason: "busy" });
});

Deno.test("no personal cell configured -> never parks anyone", async () => {
  const s = setup({ transferAvailable: false });
  assertEquals(await startHold(s.db, s.input, s.d), { ok: false, reason: "no-number" });
  assertEquals(s.f.rows("clara_holds").length, 0);
});

Deno.test("failed ring removes the hold so the next caller isn't blocked", async () => {
  const s = setup({ ringOwner: () => Promise.resolve({ ok: false, error: "boom" }) });
  assertEquals(await startHold(s.db, s.input, s.d), { ok: false, reason: "ring-failed" });
  assertEquals(s.f.rows("clara_holds").length, 0);
});

Deno.test("timeout returns the caller once and texts the owner", async () => {
  const s = setup();
  await startHold(s.db, s.input, s.d);
  await s.fire();
  assertEquals(s.redirects.length, 1);
  assertEquals(s.redirects[0].includes("step=return") && s.redirects[0].includes("why=no-reply"), true);
  assertEquals((await getHold(s.db, "CA1"))!.state, "returned");
  await expireHold(s.db, "CA1", s.d); // second firing is a no-op
  assertEquals(s.redirects.length, 1);
});

Deno.test("redirect failure means the caller hung up", async () => {
  const s = setup({ redirect: () => Promise.resolve({ ok: false, error: "404" }) });
  await startHold(s.db, s.input, s.d);
  await s.fire();
  assertEquals((await getHold(s.db, "CA1"))!.state, "caller-left");
});

Deno.test("bridging wins over a late timeout", async () => {
  const s = setup();
  await startHold(s.db, s.input, s.d);
  assertEquals(await markBridged(s.db, "CA1", s.d), true);
  await s.fire();
  assertEquals(s.redirects.length, 0);
  assertEquals((await getHold(s.db, "CA1"))!.outcome, "connected");
});

Deno.test("voicemail never gets the caller; human/unknown get the key-press whisper", async () => {
  const s = setup();
  await startHold(s.db, s.input, s.d);
  assertEquals(await onOwnerAnswered(s.db, "CA1", "human", s.d), { action: "confirm" });
  assertEquals(await onOwnerAnswered(s.db, "CA1", undefined, s.d), { action: "confirm" });
  assertEquals(await onOwnerAnswered(s.db, "CA1", "machine_start", s.d), { action: "hangup", why: "voicemail" });
  assertEquals((await getHold(s.db, "CA1"))!.state, "returned");
  assertEquals(await onOwnerAnswered(s.db, "CA1", "human", s.d), { action: "hangup", why: "not-holding" });
});

Deno.test("pressing 2 on the whisper returns the caller; owner leg ending unbridged returns with the right reason", async () => {
  const a = setup();
  await startHold(a.db, a.input, a.d);
  await declineOnWhisper(a.db, "CA1", a.d);
  assertEquals((await getHold(a.db, "CA1"))!.outcome, "declined");

  const b = setup();
  await startHold(b.db, b.input, b.d);
  await onOwnerLegEnded(b.db, "CA1", "no-answer", b.d);
  assertEquals((await getHold(b.db, "CA1"))!.outcome, "no-answer");
  assertEquals(b.texts.at(-1)!.startsWith("Couldn't reach your cell"), true);
});

Deno.test("caller hanging up while live texts the owner; after return it doesn't", async () => {
  const a = setup();
  await startHold(a.db, a.input, a.d);
  const before = a.texts.length;
  await onCallerLeft(a.db, "CA1", a.d);
  assertEquals(a.texts.length, before + 1);
  assertEquals((await getHold(a.db, "CA1"))!.state, "caller-left");

  const b = setup();
  await startHold(b.db, b.input, b.d);
  await markReturned(b.db, "CA1", "declined", b.d);
  const n = b.texts.length;
  await onCallerLeft(b.db, "CA1", b.d);
  assertEquals(b.texts.length, n);
});

Deno.test("owner text replies: answers while ringing are acknowledged, non-answers pass through", async () => {
  const s = setup();
  assertEquals(await tryHandleHoldReply(s.db, "1", s.d), null); // no live hold
  await startHold(s.db, s.input, s.d);
  assertEquals((await tryHandleHoldReply(s.db, "1", s.d))!.startsWith("Already ringing"), true);
  assertEquals((await tryHandleHoldReply(s.db, "2", s.d))!.includes("just don't pick up"), true);
  assertEquals(await tryHandleHoldReply(s.db, "what's the weather", s.d), null);
});

Deno.test("pure helpers", () => {
  assertEquals(parseHoldReply("Take it."), "take");
  assertEquals(parseHoldReply("take a message"), "pass");
  assertEquals(parseHoldReply("maybe"), null);
  assertEquals(classifyAnsweredBy("machine_end_beep"), "machine");
  assertEquals(classifyAnsweredBy(""), "unknown");
  assertEquals(holdText({ who: "Pat", vip: true }), "Work call holding: Pat (always put through). Reply 1 to take it, 2 to pass. (re: Pat) — Clara");
});
