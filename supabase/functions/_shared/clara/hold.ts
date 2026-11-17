/**
 * Putting a work-line caller through to the owner (ported from CLARA's holdTransfer.ts).
 *
 * An urgent caller, or one on the always-put-through list, is parked on hold while the owner's
 * personal cell rings. The leg to him uses answering-machine detection and a key-press whisper, so
 * his voicemail can never take the call. If he declines, doesn't answer, or the deadline passes,
 * the caller is redirected back to Clara to leave a message.
 *
 *   caller leg   <Enqueue hold-{CallSid}> waitUrl=hold/wait action=hold/done
 *   owner's leg  REST call to his cell, url=hold/answer, machine detection
 *   return       REST redirect of the caller leg to hold/return
 *
 * Differences from CLARA, forced by serverless:
 *   - the hold lives in clara_holds, not process memory; "one live hold at a time" is a partial
 *     unique index, and every state change is a conditional UPDATE so two webhooks can't both win;
 *   - the in-process setTimeout becomes an injected `schedule` (EdgeRuntime.waitUntil + sleep in
 *     production). The wait route is the backstop: every replay of the hold audio re-checks the
 *     deadline and <Leave/>s if it has passed, so a missed timer still ends the hold.
 */
import type { SupabaseClient } from "npm:@supabase/supabase-js@2";
import type { CallStatePatch, TransferOutcome } from "./types.ts";
import { esc } from "../twiml.ts";

export const HOLD_TIMEOUT_SEC_DEFAULT = 45;
/** A "1"/"2" this long after the deadline still counts, so a reply that crosses the timeout isn't lost. */
export const HOLD_REPLY_GRACE_MS = 30_000;
export const TWILIO_DEFAULT_HOLD_MUSIC = "http://com.twilio.music.classical.s3.amazonaws.com/BusyStrings.mp3";

export type HoldState = "waiting" | "accepted" | "bridged" | "returned" | "caller-left";

export interface HoldRow {
  call_sid: string;
  organization_id: string;
  from_e164: string;
  queue_name: string;
  who: string;
  need: string | null;
  vip: boolean;
  base_url: string;
  texted_at: string;
  deadline_at: string;
  state: HoldState;
  outcome: string | null;
  owner_call_sid: string | null;
}

const COLS = "call_sid, organization_id, from_e164, queue_name, who, need, vip, base_url, texted_at, deadline_at, state, outcome, owner_call_sid";
const LIVE: HoldState[] = ["waiting", "accepted"];
const SETTLED: HoldState[] = ["bridged", "returned", "caller-left"];

// ── Pure ────────────────────────────────────────────────────────────────────────────────────

export function holdTimeoutMs(raw: string | undefined): number {
  const v = Number(raw ?? "");
  return (Number.isFinite(v) && v >= 15 ? Math.min(v, 180) : HOLD_TIMEOUT_SEC_DEFAULT) * 1000;
}

export const queueNameFor = (callSid: string) => `hold-${callSid}`.slice(0, 64);

/** The text the owner gets on his cell: who it is, what they need, and the two answers. */
export function holdText(h: { who: string; need?: string | null; vip: boolean }, opts: { urgent?: boolean } = {}): string {
  const handle = h.who.replace(/\s*\(.*\)$/, "").split(/\s+/)[0] || h.who;
  const about = h.vip && !h.need
    ? `${h.who} (always put through)`
    : `${h.who}${h.need ? ` — needs: ${h.need.replace(/\s+/g, " ").trim().slice(0, 160)}` : ""}${opts.urgent ? ", says urgent" : ""}`;
  return `Work call holding: ${about}. Reply 1 to take it, 2 to pass. (re: ${handle}) — Clara`;
}

export type HoldReply = "take" | "pass";

/** "1"/"take it"/"yes" -> take; "2"/"pass"/"no" -> pass; anything else isn't an answer to this. */
export function parseHoldReply(text: string): HoldReply | null {
  const t = text.trim().toLowerCase().replace(/[.!]+$/, "");
  if (/^(1|one|take( it| the call)?|yes|y|yeah|yep|put (them|him|her) through|connect)$/.test(t)) return "take";
  if (/^(2|two|pass|no|n|nope|can'?t|not now|take a message|message)$/.test(t)) return "pass";
  return null;
}

export const holdExpired = (h: { deadline_at: string }, now: number, graceMs = 0) => now > new Date(h.deadline_at).getTime() + graceMs;

export type AnsweredBy = "human" | "machine" | "unknown";

/** Twilio's AnsweredBy -> what to do with the owner's leg. Fails toward "unknown": a key press decides. */
export function classifyAnsweredBy(v: string | undefined): AnsweredBy {
  const a = String(v ?? "").toLowerCase();
  if (a === "human") return "human";
  if (a.startsWith("machine") || a === "fax") return "machine";
  return "unknown";
}

export type QueueResult = "bridged" | "leave" | "hangup" | "redirected" | "error" | "queue-full" | "system-error" | "bridging-in-process" | "other";

export function classifyQueueResult(v: string | undefined): QueueResult {
  const q = String(v ?? "").toLowerCase();
  return (["bridged", "leave", "hangup", "redirected", "error", "queue-full", "system-error", "bridging-in-process"] as const).find((x) => x === q) ?? "other";
}

/** What a caller hears when the owner didn't take it: the same line whatever the reason. */
export const returnLine = (first: string) =>
  `Sorry — ${first} can't break away just now. I'll make sure he gets this right away. Is there anything else you want me to pass along, or a better time for him to call you back?`;

export function holdAudioUrl(configured: string | undefined, fileUrl: string | null): string {
  const url = configured?.trim();
  if (url && /^https?:\/\//i.test(url)) return url;
  return fileUrl ?? TWILIO_DEFAULT_HOLD_MUSIC;
}

export const waitTwiml = (audioUrl: string) => `<?xml version="1.0" encoding="UTF-8"?><Response><Play>${esc(audioUrl)}</Play></Response>`;
export const leaveTwiml = () => `<?xml version="1.0" encoding="UTF-8"?><Response><Leave/></Response>`;

/** The owner's leg once a person answered: dequeue the caller into this call. */
export function ownerAnswerTwiml(o: { sayXml: string; queueName: string; bridgedUrl: string; actionUrl: string }): string {
  return `<?xml version="1.0" encoding="UTF-8"?><Response>${o.sayXml}` +
    `<Dial action="${esc(o.actionUrl)}" method="POST"><Queue url="${esc(o.bridgedUrl)}" method="POST">${esc(o.queueName)}</Queue></Dial></Response>`;
}

export const ownerWhisperLine = (h: { who: string }) => `Connecting you to ${h.who.replace(/\s*\((.*)\)$/, " from $1")} now.`;

/** Confirmation whisper when the owner's cell picks up: who is holding and the two keys. */
export function ownerConfirmWhisperLine(h: { who: string; need?: string | null }): string {
  const who = h.who.replace(/\s*\((.*)\)$/, " from $1");
  return `${who}${h.need ? ` about ${h.need}` : ""} is on hold for you. Press 1 to take it, 2 to pass.`;
}

// ── Effects ─────────────────────────────────────────────────────────────────────────────────

export interface HoldDeps {
  /** Text the owner's personal cell from Clara's number (no quiet hours: someone is on the line). */
  textOwner: (text: string) => Promise<boolean>;
  /** Ring the owner's cell with machine detection; resolves with his leg's CallSid. */
  ringOwner: (h: HoldRow) => Promise<{ ok: boolean; sid?: string; error?: string }>;
  /** Move the caller's live leg to new TwiML. */
  redirect: (callSid: string, url: string) => Promise<{ ok: boolean; error?: string }>;
  patchSession: (callSid: string, patch: CallStatePatch) => Promise<unknown>;
  log: (what: string, callSid: string, meta?: Record<string, unknown>) => Promise<void>;
  /** Run `fn` after `ms` without blocking the response (EdgeRuntime.waitUntil in production). */
  schedule: (fn: () => Promise<void>, ms: number) => void;
  now: () => number;
  first: string;
  timeoutMs: number;
  transferAvailable: boolean;
}

export async function getHold(db: SupabaseClient, callSid: string): Promise<HoldRow | null> {
  const { data, error } = await db.from("clara_holds").select(COLS).eq("call_sid", callSid).maybeSingle();
  if (error) throw new Error(`clara_holds read failed: ${error.message}`);
  return (data as HoldRow | null) ?? null;
}

/** The one hold the owner can still answer. */
export async function liveHold(db: SupabaseClient): Promise<HoldRow | null> {
  const { data, error } = await db.from("clara_holds").select(COLS).in("state", LIVE).order("created_at").limit(1);
  if (error) throw new Error(`clara_holds live read failed: ${error.message}`);
  return ((data as HoldRow[] | null) ?? [])[0] ?? null;
}

/** Atomically move a hold between states. Returns the updated row, or null if it wasn't in `from`. */
async function settle(db: SupabaseClient, callSid: string, from: HoldState[], to: HoldState, outcome?: string): Promise<HoldRow | null> {
  const { data, error } = await db.from("clara_holds")
    .update({ state: to, ...(outcome ? { outcome } : {}), updated_at: new Date().toISOString() })
    .eq("call_sid", callSid).in("state", from).select(COLS);
  if (error) throw new Error(`clara_holds transition failed: ${error.message}`);
  return ((data as HoldRow[] | null) ?? [])[0] ?? null;
}

export type StartHoldResult =
  | { ok: true; queueName: string }
  | { ok: false; reason: "busy" | "no-number" | "ring-failed" };

/**
 * Park the caller and ring the owner. Called BEFORE the <Enqueue> TwiML is returned; on failure the
 * voice route carries on with the message path and never parks anyone. The hold starts `accepted`:
 * a VIP ring commits the warm transfer immediately (owner rule 2026-10-02) and the whisper on his
 * cell is a confirmation step, not a gate on whether to ring.
 */
export async function startHold(
  db: SupabaseClient,
  input: { callSid: string; orgId: string; from: string; who: string; need?: string; vip: boolean; urgent?: boolean; base: string },
  d: HoldDeps,
): Promise<StartHoldResult> {
  if (!d.transferAvailable) return { ok: false, reason: "no-number" };
  const now = d.now();
  const row = {
    call_sid: input.callSid, organization_id: input.orgId, from_e164: input.from, queue_name: queueNameFor(input.callSid),
    who: input.who, need: input.need ?? null, vip: input.vip, base_url: input.base,
    texted_at: new Date(now).toISOString(), deadline_at: new Date(now + d.timeoutMs).toISOString(), state: "accepted" as const,
  };
  // The partial unique index enforces "one live hold": a second caller would compete for the same "1".
  const { error } = await db.from("clara_holds").insert(row);
  if (error) {
    if (error.code === "23505") return { ok: false, reason: "busy" };
    throw new Error(`clara_holds insert failed: ${error.message}`);
  }
  const h = (await getHold(db, input.callSid))!;
  const ring = await d.ringOwner(h).catch((e) => ({ ok: false, error: String(e) } as { ok: boolean; sid?: string; error?: string }));
  if (!ring.ok) {
    await db.from("clara_holds").delete().eq("call_sid", input.callSid);
    await d.log(`hold for ${h.who} not started — couldn't ring ${d.first}'s cell (${ring.error ?? "unknown"})`, input.callSid, { hold: "ring-failed" });
    return { ok: false, reason: "ring-failed" };
  }
  await db.from("clara_holds").update({ owner_call_sid: ring.sid ?? null }).eq("call_sid", input.callSid);
  // Heads-up text in parallel (he can still reply 1/2 if he can't press keys); never blocks the ring.
  void d.textOwner(holdText(h, { urgent: input.urgent })).catch(() => false);
  await d.patchSession(input.callSid, { transferTried: true });
  d.schedule(() => expireHold(db, input.callSid, d), d.timeoutMs);
  await d.log(`hold started: ${h.who} parked, ringing ${d.first}'s cell (whisper 1/2) + heads-up text`, input.callSid,
    { hold: "started", queue: h.queue_name, ownerCallSid: ring.sid });
  return { ok: true, queueName: h.queue_name };
}

/** Bring the caller back to Clara with the neutral line; outcome goes on the session and the hold. */
export async function returnCaller(
  db: SupabaseClient, callSid: string, why: Exclude<TransferOutcome, "connected" | "caller-left">, d: HoldDeps,
): Promise<boolean> {
  const h = await settle(db, callSid, LIVE, "returned", why);
  if (!h) return false;
  await d.patchSession(callSid, { transferOutcome: why });
  const r = await d.redirect(callSid, `${h.base_url}/clara-voice-hold?step=return&callSid=${encodeURIComponent(callSid)}&why=${why}`)
    .catch((e) => ({ ok: false, error: String(e) }));
  if (!r.ok) {
    // The redirect fails when the call is already over: they hung up while waiting.
    await db.from("clara_holds").update({ state: "caller-left", outcome: "caller-left" }).eq("call_sid", callSid);
    await d.patchSession(callSid, { transferOutcome: "caller-left" });
    await d.log(`hold for ${h.who} ended (${why}) but they had already hung up (${r.error ?? "redirect failed"})`, callSid, { hold: "caller-left" });
    return false;
  }
  await d.log(`hold for ${h.who} ended: ${why} — back to Clara for a message`, callSid, { hold: why });
  return true;
}

/**
 * The caller has ALREADY left the queue (hold/done: the wait route's <Leave/> backstop, or a queue
 * error) and is being answered with TwiML right now: record the outcome without redirecting a leg
 * that is no longer parked. False when the hold had already been settled.
 */
export async function markReturned(
  db: SupabaseClient, callSid: string, why: Exclude<TransferOutcome, "connected" | "caller-left">, d: HoldDeps,
): Promise<boolean> {
  const h = await settle(db, callSid, LIVE, "returned", why);
  if (!h) return false;
  await d.patchSession(callSid, { transferOutcome: why });
  await d.log(`hold for ${h.who} ended: ${why} — they left the queue, back to Clara for a message`, callSid, { hold: why });
  if (why === "no-reply") await d.textOwner(`I didn't hear back in time, so ${h.who} is back with me and I'm taking a message. — Clara`).catch(() => false);
  return true;
}

export async function expireHold(db: SupabaseClient, callSid: string, d: HoldDeps): Promise<void> {
  const h = await getHold(db, callSid);
  if (!h || !LIVE.includes(h.state)) return;
  if (await returnCaller(db, callSid, "no-reply", d)) {
    await d.textOwner(`I didn't hear back in time, so ${h.who} is back with me and I'm taking a message. — Clara`).catch(() => false);
  }
}

/**
 * The owner texting Clara's number while a hold is live. Returns the line to text back, or null
 * when the message isn't an answer to the hold. Runs FIRST in the owner SMS path: a bare "1" must
 * never reach the general handler, which would relay "<owner> says 1."
 */
export async function tryHandleHoldReply(db: SupabaseClient, text: string, d: HoldDeps): Promise<string | null> {
  const h = await liveHold(db);
  if (!h) return null;
  const reply = parseHoldReply(text);
  if (!reply) return null;
  if (h.state === "accepted") {
    return reply === "take"
      ? "Already ringing you — pick up and I'll connect you."
      : `Your cell is already ringing for ${h.who} — just don't pick up and I'll take a message.`;
  }
  if (holdExpired(h, d.now(), HOLD_REPLY_GRACE_MS)) return `Too late — ${h.who} went back to me and I'm taking a message; I'll text you the details.`;
  return null;
}

export type OwnerAnswer = { action: "confirm" } | { action: "hangup"; why: "voicemail" | "not-holding" };

/** The owner's leg answered. Human and unknown both get the key-press whisper; a machine is hung up. */
export async function onOwnerAnswered(db: SupabaseClient, callSid: string, answeredBy: string | undefined, d: HoldDeps): Promise<OwnerAnswer> {
  const h = await getHold(db, callSid);
  if (!h || h.state !== "accepted") return { action: "hangup", why: "not-holding" };
  if (classifyAnsweredBy(answeredBy) !== "machine") return { action: "confirm" };
  await d.log(`hold for ${h.who}: ${d.first}'s voicemail answered, hanging up his leg`, callSid, { hold: "voicemail" });
  await returnCaller(db, callSid, "voicemail", d);
  await d.textOwner(`Your voicemail picked up, so I kept ${h.who} with me and took a message. — Clara`).catch(() => false);
  return { action: "hangup", why: "voicemail" };
}

/** The owner pressed 2 (or anything but 1) on the whisper. */
export async function declineOnWhisper(db: SupabaseClient, callSid: string, d: HoldDeps): Promise<void> {
  const h = await getHold(db, callSid);
  if (!h || SETTLED.includes(h.state)) return;
  await d.log(`hold for ${h.who}: ${d.first} pressed 2 on the whisper — declining`, callSid, { hold: "declined-on-whisper" });
  await returnCaller(db, callSid, "declined", d);
}

/** The caller's leg is about to be bridged into the owner's. */
export async function markBridged(db: SupabaseClient, callSid: string, d: Pick<HoldDeps, "patchSession">): Promise<boolean> {
  const h = await settle(db, callSid, LIVE, "bridged", "connected");
  if (!h) return false;
  await d.patchSession(callSid, { transferAccepted: true, transferOutcome: "connected" });
  return true;
}

/** The owner's leg ended. If it never bridged, the caller comes back. */
export async function onOwnerLegEnded(db: SupabaseClient, callSid: string, callStatus: string | undefined, d: HoldDeps): Promise<void> {
  const h = await getHold(db, callSid);
  if (!h || h.state !== "accepted") return;
  const status = String(callStatus ?? "").toLowerCase();
  const why: TransferOutcome = status === "completed" ? "no-reply" : "no-answer";
  await d.log(`hold for ${h.who}: ${d.first}'s leg ended (${status || "unknown"}) before bridging`, callSid, { hold: why });
  if (await returnCaller(db, callSid, why, d)) {
    await d.textOwner(why === "no-answer"
      ? `Couldn't reach your cell, so ${h.who} is back with me and I'm taking a message. — Clara`
      : `Nobody took the call on your cell, so ${h.who} is back with me and I'm taking a message. — Clara`).catch(() => false);
  }
}

/** The caller hung up while parked. */
export async function onCallerLeft(db: SupabaseClient, callSid: string, d: HoldDeps): Promise<void> {
  const before = await getHold(db, callSid);
  if (!before || before.state === "bridged" || before.state === "caller-left") return;
  const h = await settle(db, callSid, ["waiting", "accepted", "returned"], "caller-left", "caller-left");
  if (!h) return;
  await d.patchSession(callSid, { transferOutcome: "caller-left" });
  await d.log(`hold for ${h.who}: they hung up while holding`, callSid, { hold: "caller-left" });
  // Only worth interrupting the owner if he could still have taken the call.
  if (LIVE.includes(before.state)) await d.textOwner(`Never mind — ${h.who} hung up while holding. Their number is ${h.from_e164}. — Clara`).catch(() => false);
}
