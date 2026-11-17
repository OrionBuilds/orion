import { assertEquals } from "jsr:@std/assert@1";
import {
  classifyCaller, classifyEventReason, decideVipGreeting, firstFreeSlot, isWorkLineCall, pickOpenSlots,
  transferConnected, transferOutcomeFromDial, triageUrgency, urgencySignals, vipBlocksLiveTransfer, whoLabel, whisperText,
} from "./work-line.ts";

const env = (m: Record<string, string>) => ({ get: (k: string) => m[k] });

Deno.test("work line is recognised by To number or forwarded-from", () => {
  const e = env({ CLARA_WORKLINE_NUMBER: "+18135550199", OWNER_WORK_PHONE: "+18135550001" });
  assertEquals(isWorkLineCall({ To: "(813) 555-0199" }, e), true);
  assertEquals(isWorkLineCall({ To: "+18135550142", ForwardedFrom: "+18135550001" }, e), true);
  assertEquals(isWorkLineCall({ To: "+18135550142" }, e), false);
});

Deno.test("urgency: strangers only get through for emergencies, VIPs for any signal", () => {
  assertEquals(triageUrgency({ kind: "unknown", text: "can you call me back about pricing" }).urgent, false);
  assertEquals(triageUrgency({ kind: "unknown", text: "urgent, our site is down" }).urgent, true);
  assertEquals(triageUrgency({ kind: "vip", text: "need to ask something today" }).urgent, true);
  assertEquals(triageUrgency({ kind: "client", text: "invoice question" }).urgent, true);
  assertEquals(triageUrgency({ kind: "lead", text: "site down", wantsOwner: false }).urgent, false);
  assertEquals(urgencySignals("is Jordan available", "Jordan").includes("asked-for-owner"), true);
});

Deno.test("classifyCaller maps tags/stage to a relationship", () => {
  const c = (tags: string[], stage?: string) => classifyCaller({ contact: { name: "A", tags, stage } }).kind;
  assertEquals(c(["family"]), "personal");
  assertEquals(c(["vendor"]), "vendor");
  assertEquals(c(["Customer"]), "client");
  assertEquals(c([], "Won"), "client");
  assertEquals(c([]), "lead");
  assertEquals(classifyCaller({}).kind, "unknown");
  assertEquals(classifyCaller({ putThrough: { name: "Mom" } }).kind, "vip");
});

Deno.test("VIP greeting: message-only never rings; busy calendar declines with a safe phrase; free holds", () => {
  assertEquals(decideVipGreeting("Pat", "message_only", null).outcome, "message_only");
  const busy = decideVipGreeting("Pat", "transfer", { summary: "Dentist w/ Dr. Smith" });
  assertEquals(busy.outcome, "vip_blocked_calendar");
  if (busy.outcome === "vip_blocked_calendar") {
    assertEquals(busy.reasonKind, "appointment");
    assertEquals(busy.greeting.includes("Smith"), false); // never leaks the event title
  }
  assertEquals(decideVipGreeting("Pat", "transfer", null).outcome, "hold");
  assertEquals(classifyEventReason("Client XYZ kickoff"), "meeting");
  assertEquals(vipBlocksLiveTransfer({ tier: "message_only" }, undefined), true);
  assertEquals(vipBlocksLiveTransfer({ tier: "transfer" }, "meeting"), true);
  assertEquals(vipBlocksLiveTransfer({ tier: "transfer" }, undefined), false);
});

Deno.test("transfer outcome mapping", () => {
  assertEquals(transferConnected("completed", true), true);
  assertEquals(transferConnected("completed", false), false);
  assertEquals(transferOutcomeFromDial("completed"), "no-reply");
  assertEquals(transferOutcomeFromDial("no-answer"), "no-answer");
});

Deno.test("who label and whisper text", () => {
  assertEquals(whoLabel({ callerName: "Ann", company: "Acme" }, undefined, "+1555"), "Ann (Acme)");
  assertEquals(whoLabel({}, undefined, "+1555"), "+1555");
  assertEquals(whisperText({ learned: { need: "a quote" }, fromE164: "+1555", line: "work" }).startsWith("Work call from an unrecognized number"), true);
});

Deno.test("open slots land in weekday business hours, avoid busy time, and are spaced out", () => {
  // Monday 2026-10-19 12:00 UTC = 8:00 ET; +2h => 10:00 ET search start.
  const now = new Date("2026-10-19T12:00:00Z");
  const busy = [{ start: "2026-10-19T14:00:00Z", end: "2026-10-19T15:00:00Z" }]; // 10-11 ET busy
  const first = firstFreeSlot(busy, new Date(now.getTime() + 2 * 3_600_000), new Date(now.getTime() + 86_400_000));
  assertEquals(first?.toISOString(), "2026-10-19T15:00:00.000Z"); // 11:00 ET
  const slots = pickOpenSlots(busy, 3, now);
  assertEquals(slots.length, 3);
  for (const s of slots) {
    const d = new Date(s);
    const h = Number(new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "numeric", hour12: false }).format(d));
    const wd = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", weekday: "short" }).format(d);
    assertEquals(h >= 9 && h < 17 && wd !== "Sat" && wd !== "Sun", true, s);
  }
  // Weekend-only window yields nothing.
  assertEquals(firstFreeSlot([], new Date("2026-10-24T14:00:00Z"), new Date("2026-10-25T23:00:00Z")), null);
});
