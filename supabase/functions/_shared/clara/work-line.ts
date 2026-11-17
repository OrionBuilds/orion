/**
 * The owner's work line (ported from CLARA's workLine.ts).
 *
 * The work number stays on the owner's phone; calls reach Clara through carrier forwarding to a
 * Twilio number used ONLY for that (CLARA_WORKLINE_NUMBER), so the To number alone says "this is
 * his work phone". On this line she is his assistant, not the company's front desk: she takes a
 * full message, answers common questions, books time on his calendar, and puts an urgent caller
 * through with a whisper he must accept with a key press. She never agrees to money, contracts,
 * pricing or scope.
 *
 * Everything here is pure except callerProfile / openSlots, which take their data sources
 * explicitly so they can be tested without a database.
 */
import type { CallerKind, DeclineReasonKind, PutThroughTier, TransferOutcome } from "./types.ts";
import { type Env, samePhone } from "./phones.ts";
import { esc } from "../twiml.ts";

export const ownerFirst = (env: Env) => env.get("OWNER_FIRST_NAME")?.trim() || "the owner";

export function workLineNumber(env: Env): string | undefined {
  return env.get("CLARA_WORKLINE_NUMBER")?.trim() || undefined;
}

/** True when an inbound call arrived on the work line, or was forwarded from the work phone. */
export function isWorkLineCall(params: { To?: string; ForwardedFrom?: string }, env: Env): boolean {
  const target = workLineNumber(env);
  if (target && samePhone(params.To, target)) return true;
  const work = env.get("OWNER_WORK_PHONE")?.trim();
  return Boolean(work && params.ForwardedFrom && samePhone(params.ForwardedFrom, work));
}

export const workLineGreeting = (env: Env) =>
  `${ownerFirst(env)}'s office, this is Clara, his AI assistant. He can't pick up right now — how can I help?`;

// ── Urgency ─────────────────────────────────────────────────────────────────────────────────

export type UrgencySignal = "deadline" | "broken" | "money" | "complaint" | "asked-for-owner" | "emergency";

function signalTable(first: string): Array<[UrgencySignal, RegExp]> {
  const f = first.replace(/[^\w ]/g, "");
  return [
    ["emergency", /\b(emergency|urgent(ly)?|life or death|asap)\b/i],
    ["deadline", /\b(today|tonight|this (morning|afternoon|evening)|right (now|away)|by (noon|end of (the )?day|eod|close of business|cob|\d{1,2}(:\d{2})?\s*(am|pm)?)|within the hour|in an hour|before (noon|\d))\b/i],
    ["broken", /\b(down|outage|offline|broken|not working|isn'?t working|won'?t (load|work|open)|crash(ed|ing)?|can'?t (log ?in|access|get in)|locked out|error|hacked|breach)\b/i],
    ["money", /\b(payment|pay(ing)?|invoice|wire|refund|charge(d|back)?|billing|overdue|contract|sign(ed|ing)? (the )?(agreement|contract)|purchase order|\$\s?\d)/i],
    ["complaint", /\b(complain(t|ing)?|unhappy|upset|angry|furious|cancel(l?ing)?|disappointed|unacceptable|lawyer|legal action)\b/i],
    ["asked-for-owner", new RegExp(`\\b(speak|talk) (to|with) (${f}|him|the owner)|\\bneed (${f}|him)\\b|\\bget (${f}|him) on\\b|\\bis ${f} (there|available|around)\\b`, "i")],
  ];
}

export function urgencySignals(text: string, first = "the owner"): UrgencySignal[] {
  const t = String(text ?? "");
  return signalTable(first).filter(([, re]) => re.test(t)).map(([s]) => s);
}

export interface UrgencyInput {
  kind: CallerKind;
  /** Everything known about what they need: the learned need plus what they just said. */
  text: string;
  /** The model judged that they want a person now. */
  wantsOwner?: boolean;
  first?: string;
}

/**
 * Who they are plus what they need. Strangers only get through for a stated emergency; the
 * forwarded line is not a way to reach the owner for anyone who rings.
 */
export function triageUrgency(input: UrgencyInput): { urgent: boolean; signals: UrgencySignal[] } {
  const signals = urgencySignals(input.text, input.first);
  if (input.wantsOwner && !signals.includes("asked-for-owner")) signals.push("asked-for-owner");
  const has = (...s: UrgencySignal[]) => s.some((x) => signals.includes(x));
  let urgent = false;
  switch (input.kind) {
    case "vip":
    case "personal":
      urgent = signals.length > 0;
      break;
    case "client":
      urgent = has("emergency", "deadline", "broken", "money", "complaint");
      break;
    case "lead":
      urgent = has("emergency") || (has("deadline") && has("money", "broken"));
      break;
    case "vendor":
      urgent = has("emergency", "broken") || (has("money") && has("deadline"));
      break;
    case "unknown":
      urgent = has("emergency") && has("broken", "deadline", "money");
      break;
  }
  return { urgent, signals };
}

// ── Who is calling ──────────────────────────────────────────────────────────────────────────

export interface ProfileInput {
  /** On the always-put-through list (any tier). */
  putThrough?: { name: string } | null;
  /** The matching CRM contact, if any. */
  contact?: { name: string; company?: string | null; tags: string[]; stage?: string | null } | null;
}

const tagIs = (tags: string[], re: RegExp) => tags.some((t) => re.test(t));

/**
 * Pure: the caller's relationship to the owner. CRM tags stand in for CLARA's old local-contact
 * "relation" field: friend/family -> personal, vip -> vip, vendor/supplier -> vendor,
 * client/customer/active (or a won/active stage) -> client; any other known contact -> lead.
 */
export function classifyCaller(p: ProfileInput): { kind: CallerKind; name?: string; company?: string } {
  const name = p.putThrough?.name || p.contact?.name || undefined;
  const company = p.contact?.company || undefined;
  if (p.putThrough) return { kind: "vip", name, company };
  const c = p.contact;
  if (!c) return { kind: "unknown", name, company };
  if (tagIs(c.tags, /^(friend|family)$/i)) return { kind: "personal", name, company };
  if (tagIs(c.tags, /^vip/i)) return { kind: "vip", name, company };
  if (tagIs(c.tags, /vendor|supplier/i)) return { kind: "vendor", name, company };
  const client = tagIs(c.tags, /client|customer|active/i) || /won|active|onboard|delivery|retainer/i.test(c.stage ?? "");
  return { kind: client ? "client" : "lead", name, company };
}

// ── Calendar ────────────────────────────────────────────────────────────────────────────────

export interface Busy { start: string; end: string }

/** First free slot of `minutes` within business hours (9-17 local to tz, Mon-Fri) in [from, to). */
export function firstFreeSlot(busy: Busy[], from: Date, to: Date, minutes = 30, tz = "America/New_York"): Date | null {
  const step = 30 * 60_000;
  const need = minutes * 60_000;
  const parts = (d: Date) => {
    const f = new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "short", hour: "numeric", hour12: false, minute: "numeric" }).formatToParts(d);
    const g = (t: string) => f.find((p) => p.type === t)!.value;
    return { wd: g("weekday"), h: Number(g("hour")) % 24, m: Number(g("minute")) };
  };
  const start = Math.ceil(from.getTime() / step) * step;
  for (let t = start; t + need <= to.getTime(); t += step) {
    const s = parts(new Date(t));
    const e = parts(new Date(t + need - 1));
    if (s.wd === "Sat" || s.wd === "Sun") continue;
    if (s.h < 9 || e.h >= 17) continue;
    if (e.h < s.h) continue;
    const clash = busy.some((b) => new Date(b.start).getTime() < t + need && new Date(b.end).getTime() > t);
    if (!clash) return new Date(t);
  }
  return null;
}

/** Next open slots over the coming five days, spaced out so three offers aren't back to back. */
export function pickOpenSlots(busy: Busy[], count = 3, now = new Date(), tz = "America/New_York"): string[] {
  const from = new Date(now.getTime() + 2 * 3_600_000);
  const to = new Date(now.getTime() + 5 * 86_400_000);
  const taken = [...busy];
  const out: string[] = [];
  for (let i = 0; i < count; i++) {
    const slot = firstFreeSlot(taken, from, to, 30, tz);
    if (!slot) break;
    out.push(slot.toISOString());
    taken.push({ start: slot.toISOString(), end: new Date(slot.getTime() + 3 * 3_600_000).toISOString() });
  }
  return out;
}

export function speakSlot(iso: string, tz = "America/New_York"): string {
  return new Date(iso).toLocaleString("en-US", { timeZone: tz, weekday: "long", hour: "numeric", minute: "2-digit" });
}

// ── VIP tiers + calendar-aware transfer gating ──────────────────────────────────────────────

/** Pure: which privacy-safe bucket a busy event's title falls into. Defaults to the vaguest, "meeting". */
export function classifyEventReason(title: string | undefined): DeclineReasonKind {
  const t = String(title ?? "").toLowerCase();
  if (t.includes("doctor") || t.includes("dentist") || t.includes("appointment")) return "appointment";
  if (t.includes("ooo") || t.includes("out of office") || t.includes("pto")) return "ooo";
  if (t.includes("travel") || t.includes("flight") || t.includes("driving")) return "travel";
  return "meeting";
}

const reasonFor = (kind: DeclineReasonKind, first: string) => {
  switch (kind) {
    case "appointment": return `${first}'s at an appointment right now`;
    case "ooo": return `${first}'s out of the office today`;
    case "travel": return `${first}'s traveling right now`;
    default: return `${first}'s in a meeting right now`;
  }
};

export function vipBlockedWhyPhrase(kind: DeclineReasonKind): string {
  switch (kind) {
    case "appointment": return "at an appointment";
    case "ooo": return "out of the office";
    case "travel": return "traveling";
    default: return "in a meeting";
  }
}

export const VIP_BUSY_MESSAGE_PROMPT = "Can I take a message, and I'll make sure he gets it as soon as he's free?";

export const messageOnlyGreeting = (name: string, first: string) =>
  `Hi ${name}, it's Clara, ${first}'s AI assistant. He's unavailable to come to the phone — can I take a message for him?`;

export const vipTakeMessageFallback = (first: string) =>
  `Sorry — I didn't quite catch that. Would you like to leave ${first} a message, and I'll make sure he gets it as soon as he's free?`;

export function vipHeadsUpText(who: string, outcome: "message_only" | "vip_blocked_calendar", reasonKind?: DeclineReasonKind): string {
  if (outcome === "message_only") return `${who} called — he's on your message-only list, so I didn't ring you. Taking a message now. — Clara`;
  return `${who} called and you're ${vipBlockedWhyPhrase(reasonKind ?? "meeting")} — I didn't ring you, I'm taking a message now. — Clara`;
}

export type VipGreetingDecision =
  | { outcome: "message_only"; greeting: string; headsUp: string }
  | { outcome: "vip_blocked_calendar"; reasonKind: DeclineReasonKind; greeting: string; headsUp: string }
  | { outcome: "hold" };

/**
 * Pure: the whole put-through decision for a matched VIP. `busy` is the owner's current busy
 * event (null when free, when the calendar check failed open, or when the tier skips the check).
 */
export function decideVipGreeting(name: string, tier: PutThroughTier, busy: { summary?: string } | null, first = "the owner"): VipGreetingDecision {
  if (tier === "message_only") {
    return { outcome: "message_only", greeting: messageOnlyGreeting(name, first), headsUp: vipHeadsUpText(name, "message_only") };
  }
  if (busy) {
    const reasonKind = classifyEventReason(busy.summary);
    return {
      outcome: "vip_blocked_calendar",
      reasonKind,
      greeting: `Hi ${name}, it's Clara, ${first}'s AI assistant. ${reasonFor(reasonKind, first)}. ${VIP_BUSY_MESSAGE_PROMPT}`,
      headsUp: vipHeadsUpText(name, "vip_blocked_calendar", reasonKind),
    };
  }
  return { outcome: "hold" };
}

/** True once a VIP's tier/calendar gate decided this call will never ring the owner. */
export function vipBlocksLiveTransfer(profile: { tier?: PutThroughTier } | undefined, vipBusyReason: DeclineReasonKind | undefined): boolean {
  return profile?.tier === "message_only" || Boolean(vipBusyReason);
}

// ── Warm transfer ───────────────────────────────────────────────────────────────────────────

/**
 * What the owner hears when his cell answers a transfer. He must press 1: a voicemail greeting
 * can't, so a transfer is never bridged into his voicemail.
 */
export function whisperTwiml(opts: { acceptUrl: string; speakXml: string }): string {
  return `<Response><Gather input="dtmf" numDigits="1" timeout="8" action="${esc(opts.acceptUrl)}" method="POST">${opts.speakXml}</Gather><Hangup/></Response>`;
}

export function whisperText(state: { learned: Record<string, string>; fromE164: string; line?: string; profile?: { name?: string; company?: string } } | null): string {
  const l = state?.learned ?? {};
  const name = l.callerName || state?.profile?.name;
  const company = l.company || state?.profile?.company;
  const who = name ? `${name}${company ? ` from ${company}` : ""}` : company || (state ? `an unrecognized number, ${state.fromE164}` : "an inbound caller");
  const label = state?.line === "work" ? "Work call" : "Incoming call";
  return `${label} from ${who}${l.need ? `. They need: ${l.need}` : ""}. Press 1 to take it.`;
}

export const acceptedDigits = (digits: string | undefined) => String(digits ?? "").trim() === "1";

/** A "completed" dial whose whisper he never accepted did not reach him. */
export function transferConnected(dialCallStatus: string, accepted: boolean | undefined): boolean {
  return (dialCallStatus === "completed" || dialCallStatus === "answered") && accepted === true;
}

/** "completed" without a 1 = phone picked up, nobody took it (ignored whisper or voicemail). */
export function transferOutcomeFromDial(dialCallStatus: string): TransferOutcome {
  return dialCallStatus === "completed" || dialCallStatus === "answered" ? "no-reply" : "no-answer";
}

export function whoLabel(learned: Record<string, string>, profile: { name?: string; company?: string } | undefined, from: string): string {
  const name = learned.callerName || profile?.name;
  const company = learned.company || profile?.company;
  if (name) return `${name}${company ? ` (${company})` : ""}`;
  return company ? `someone from ${company}` : from;
}
