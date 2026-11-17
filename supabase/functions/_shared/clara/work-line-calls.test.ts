import { assertEquals } from "jsr:@std/assert@1";
import type { CallState } from "./types.ts";
import { didLine, importantCallText, missedTransferHead, planWorkLineCall } from "./work-line-calls.ts";

const st = (o: Partial<CallState> = {}): CallState => ({ fromE164: "+15550001111", turns: [], learned: {}, line: "work", ...o });

Deno.test("a stranger's routine message isn't worth a text; a VIP's message is", () => {
  const stranger = st({ learned: { callerName: "Bo", need: "pricing question" }, profile: { kind: "unknown" } });
  assertEquals(planWorkLineCall(stranger, "qualified").important, false);
  const vip = st({ learned: { callerName: "Pat", need: "contract" }, profile: { kind: "vip", name: "Pat" } });
  assertEquals(planWorkLineCall(vip, "qualified").important, true);
});

Deno.test("a message-only VIP is always reported, and the owner is told he was never rung", () => {
  const s = st({ learned: { need: "hello" }, profile: { kind: "vip", name: "Mom", tier: "message_only" } });
  const p = planWorkLineCall(s, "qualified");
  assertEquals([p.vipOutcome, p.important], ["message_only", true]);
  assertEquals(importantCallText(p, s).includes("never rang you"), true);
});

Deno.test("a missed transfer says the truth about the owner's phone, per reason", () => {
  assertEquals(missedTransferHead("Ann", "declined"), "You passed on Ann's call, so I took a message.");
  assertEquals(missedTransferHead("Ann", "voicemail").includes("voicemail picked up"), true);
  const s = st({ learned: { need: "down" }, transferTried: true, transferAccepted: false, transferOutcome: "no-answer", profile: { kind: "client" } });
  const p = planWorkLineCall(s, "qualified");
  assertEquals([p.missedTransfer, p.transferOutcome, p.important], [true, "no-answer", true]);
});

Deno.test("a caller who left while holding is not texted about again; a booking replaces the callback", () => {
  const left = st({ learned: { need: "x" }, transferTried: true, transferOutcome: "caller-left", profile: { kind: "vip", name: "V" } });
  assertEquals(planWorkLineCall(left, "qualified").important, false);
  const b = st({ learned: { bookSlot: "2026-10-21T14:00:00Z" }, offeredSlots: ["2026-10-21T14:00:00Z"] });
  const p = planWorkLineCall(b, "qualified");
  assertEquals([p.bookSlot, p.callback], ["2026-10-21T14:00:00Z", false]);
  assertEquals(planWorkLineCall(st({ learned: { bookSlot: "2026-10-22T14:00:00Z" }, offeredSlots: [] }), "qualified").bookSlot, undefined); // never an un-offered slot
  assertEquals(didLine(p, b, "qualified", "Wednesday 10:00 AM"), "I booked a call with you for Wednesday 10:00 AM.");
  assertEquals(didLine(planWorkLineCall(st(), "qualified"), st(), "qualified", null), "They hung up before leaving a message.");
});
