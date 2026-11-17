/** Shared types for Clara's phone flows (ported from CLARA's call-sessions.ts). */

export type PutThroughTier = "transfer" | "message_only";
export type DeclineReasonKind = "appointment" | "ooo" | "travel" | "meeting";

/** Who a work-line caller is to the owner. "personal" is a friend/family contact: never auto-replied to. */
export type CallerKind = "vip" | "client" | "lead" | "vendor" | "personal" | "unknown";

export type TransferOutcome = "connected" | "declined" | "no-reply" | "voicemail" | "no-answer" | "caller-left";

export type CallStatus = "in-progress" | "goal-met" | "ended" | "voicemail" | "injection-blocked";

export interface CallTurn {
  /** "business": far end of a call Clara PLACED. "caller": far end of one she ANSWERED. */
  role: "clara" | "business" | "caller";
  text: string;
  at: string;
}

export interface BusinessBooking {
  start: string;
  /** "uncertain": booking-api answered 2xx without confirming; it may exist, the owner verifies. */
  status: "pending" | "booked" | "slot-taken" | "failed" | "uncertain";
  /** Whether an email went with the booking (so the invite and confirmation reach them). */
  emailed?: boolean;
  meetLink?: string;
  error?: string;
  appointmentId?: string;
}

/** What an outbound call is for (copied from clara_call_requests so the webhook needs no extra lookup). */
export interface CallObjective {
  requestId: string;
  kind: "confirm_appointment" | "clarify" | "follow_up" | "owner_request";
  name: string;
  phone: string;
  goal: string;
  mustConfirm: string[];
  context?: string;
}

/** Everything a call carries across webhook turns, stored as clara_call_sessions.state. */
export interface CallState {
  /** Present on calls Clara PLACED. */
  objective?: CallObjective;
  fromE164: string;
  turns: CallTurn[];
  /** What Clara has learned: callerName, company, need, timeline, callback... */
  learned: Record<string, string>;
  /** Which number they rang: the published business line or the owner's forwarded work phone. */
  line?: "business" | "work";
  profile?: { kind: CallerKind; name?: string; company?: string; tier?: PutThroughTier };
  /** Open calendar slots offered to the caller (ISO starts); only these can be booked. */
  offeredSlots?: string[];
  /** Business line: each offered start -> its exact end. */
  offeredSlotEnds?: Record<string, string>;
  booking?: BusinessBooking;
  /** A transfer-tier VIP was declined without ringing the owner because his calendar was busy. */
  vipBusyReason?: DeclineReasonKind;
  /** A heads-up text already went to the owner at the start of this call. */
  vipImmediateTexted?: boolean;
  /** Prebuilt context block about meetings the caller attended; empty string = resolved, found nothing. */
  meetingContext?: string;
  /** A warm transfer was attempted on this call; never try twice. */
  transferTried?: boolean;
  transferAccepted?: boolean;
  transferOutcome?: TransferOutcome;
  /**
   * The owner's question that is still being worked on while he hears "one sec" (voice.ts owner path).
   * `reply` is filled in by the background run; `spoken` once the waiting webhook has said it.
   */
  ownerAsk?: { id: string; startedAt: number; reply?: string; spoken?: boolean };
}

export type CallStatePatch = Partial<Pick<CallState,
  "line" | "profile" | "offeredSlots" | "offeredSlotEnds" | "booking" | "transferTried" |
  "transferAccepted" | "transferOutcome" | "vipBusyReason" | "vipImmediateTexted" | "meetingContext" | "ownerAsk">>;
