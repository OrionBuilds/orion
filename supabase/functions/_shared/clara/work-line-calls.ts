/**
 * The end of a call on the owner's work line: pure planning (ported from CLARA's workLineCalls.ts).
 * What to tell the owner, what to log, and whether to book a slot, decided before any side effect.
 */
import type { CallState, DeclineReasonKind, TransferOutcome } from "./types.ts";
import { triageUrgency, vipBlockedWhyPhrase, whoLabel } from "./work-line.ts";

export type LeadReason = "qualified" | "wants-human" | "capped" | "blocked" | "transferred";

export interface WorkLineCallPlan {
  who: string;
  need?: string;
  urgent: boolean;
  missedTransfer: boolean;
  /** Why the transfer didn't connect. Unset when none was tried, or when it connected. */
  transferOutcome?: Exclude<TransferOutcome, "connected">;
  /** The owner was never rung at all: a tiered VIP blocked by his calendar or by tier. */
  vipOutcome?: "vip_blocked_calendar" | "message_only";
  vipReasonKind?: DeclineReasonKind;
  important: boolean;
  bookSlot?: string;
  callback: boolean;
}

export const vipBlockedDid = (who: string, kind: DeclineReasonKind) =>
  `I took a message for ${who} — I didn't ring you because you were ${vipBlockedWhyPhrase(kind)}.`;

export const messageOnlyDid = (who: string) =>
  `I took a message for ${who} — he's on your message-only list, so I never rang you.`;

/** What to tell the owner about a transfer that didn't connect: the truth about his own phone. */
export function missedTransferHead(who: string, outcome: WorkLineCallPlan["transferOutcome"]): string {
  switch (outcome) {
    case "declined": return `You passed on ${who}'s call, so I took a message.`;
    case "voicemail": return `Your voicemail picked up when I tried to put ${who} through, so I kept them with me and took a message.`;
    case "no-reply": return `I texted you about ${who}'s call but didn't hear back in time, so I took a message.`;
    case "no-answer": return `I tried to put ${who} through to you but your phone didn't answer, so I took a message.`;
    case "caller-left": return `${who} hung up while I was checking whether you could take the call.`;
    default: return `I tried to put ${who} through to you but couldn't reach you.`;
  }
}

export function missedTransferDid(outcome: WorkLineCallPlan["transferOutcome"]): string {
  switch (outcome) {
    case "declined": return "I tried to put them through, you passed, so I took a message.";
    case "voicemail": return "I tried to put them through, your voicemail answered, so I took a message.";
    case "no-reply": return "I texted you about the call, didn't hear back in time, so I took a message.";
    case "no-answer": return "I tried to put them through, your phone didn't answer, so I took a message.";
    case "caller-left": return "They hung up while I was checking whether you could take the call.";
    default: return "I tried to put them through, you didn't pick up, so I took a message.";
  }
}

export function planWorkLineCall(state: CallState, reason: LeadReason, first = "the owner"): WorkLineCallPlan {
  const l = state.learned;
  const kind = state.profile?.kind ?? "unknown";
  const text = [l.need, l.timeline, ...state.turns.filter((t) => t.role === "caller").map((t) => t.text)].filter(Boolean).join(" ");
  const { urgent } = triageUrgency({ kind, text, wantsOwner: reason === "wants-human", first });
  const missedTransfer = Boolean(state.transferTried) && !state.transferAccepted;
  const transferOutcome = missedTransfer && state.transferOutcome !== "connected" ? state.transferOutcome : undefined;
  const bookSlot = l.bookSlot && state.offeredSlots?.includes(l.bookSlot) ? l.bookSlot : undefined;
  const learnedAnything = Object.keys(l).length > 0;
  const vipOutcome: WorkLineCallPlan["vipOutcome"] = state.vipBusyReason
    ? "vip_blocked_calendar"
    : state.profile?.tier === "message_only" ? "message_only" : undefined;
  return {
    who: whoLabel(l, state.profile, state.fromE164),
    need: l.need,
    urgent,
    missedTransfer,
    transferOutcome,
    vipOutcome,
    vipReasonKind: state.vipBusyReason,
    // A caller who hung up while holding was already texted about live; the brief still lists
    // them, the end-of-call text doesn't repeat it.
    important: Boolean(vipOutcome) || (reason !== "transferred" && reason !== "blocked" && transferOutcome !== "caller-left" &&
      (urgent || missedTransfer || (kind === "vip" && learnedAnything))),
    bookSlot,
    callback: reason !== "transferred" && reason !== "blocked" && !bookSlot,
  };
}

/** The text the owner gets: plain words, no codes, the number to call back on. */
export function importantCallText(plan: WorkLineCallPlan, state: CallState): string {
  const l = state.learned;
  const head = plan.vipOutcome === "vip_blocked_calendar"
    ? vipBlockedDid(plan.who, plan.vipReasonKind ?? "meeting")
    : plan.vipOutcome === "message_only"
    ? messageOnlyDid(plan.who)
    : plan.missedTransfer
    ? missedTransferHead(plan.who, plan.transferOutcome)
    : `${plan.who} called your work phone${plan.urgent ? " and it sounds urgent" : ""}.`;
  return [head, plan.need ? `They need: ${plan.need}.` : "", l.timeline ? `Timing: ${l.timeline}.` : "", `Call back on ${l.callback || state.fromE164}.`]
    .filter(Boolean).join(" ").replace(/\.\./g, ".");
}

/** One-line "what Clara did" for the conversation log and the brief. */
export function didLine(plan: WorkLineCallPlan, state: CallState, reason: LeadReason, booked: string | null): string {
  return reason === "transferred" ? "I put them through to you."
    : plan.vipOutcome === "vip_blocked_calendar" ? vipBlockedDid(plan.who, plan.vipReasonKind ?? "meeting")
    : plan.vipOutcome === "message_only" ? messageOnlyDid(plan.who)
    : booked ? `I booked a call with you for ${booked}.`
    : plan.missedTransfer ? missedTransferDid(plan.transferOutcome)
    : Object.keys(state.learned).length ? "I took a message." : "They hung up before leaving a message.";
}
