/**
 * Clara's inbound voice turn (ported from CLARA's voice/route.ts).
 *
 * One Twilio webhook per caller utterance. Everything that touches the outside world is injected
 * (VoiceDeps) so the whole call flow is testable without Twilio, a model, or a calendar.
 *
 * Recording: the disclosure is spoken INSIDE the first <Gather> and recording starts only once
 * Twilio comes back with a SpeechResult. Twilio does that only after the nested <Say>/<Play> has
 * fully finished, so by the time we see speech the disclosure is guaranteed to have been spoken.
 *
 * Two callers, two brains: the owner gets the owner path; everyone else gets the qualification /
 * message-taking brain (business line) or the owner's-assistant brain (work line). The stranger
 * path is metered, turn-capped and injection-screened.
 */
import type { SupabaseClient } from "npm:@supabase/supabase-js@2";
import type { CallState } from "./types.ts";
import type { Env } from "./phones.ts";
import { isOwner, ownerPhoneSet, transferTarget } from "./phones.ts";
import { appendTurn, ensureSession, getSession, patchSession, setStatus, updateLearned, updateOwnerAsk, type SessionRow } from "./call-state.ts";
import { type InboundTurnResult, greeting, nextInboundTurn } from "./brain.ts";
import { BOOKING_TURN_DEADLINE_MS, bookReady, businessBookingEnabled, businessSlots, bookingFallbackLine, bookingTz, pendingBooking } from "./booking.ts";
import { decideVipGreeting, isWorkLineCall, ownerFirst, triageUrgency, vipBlocksLiveTransfer, vipTakeMessageFallback, workLineGreeting } from "./work-line.ts";
import { holdWho } from "./hold-who.ts";
import { type HoldDeps, startHold } from "./hold.ts";
import { upsertCallLog } from "./conversations.ts";
import { type LeadReason } from "./work-line-calls.ts";
import type { NotifyRequest } from "./notify.ts";
import { names } from "./persona.ts";
import { type Speak, gatherXml } from "./runtime.ts";
import { dialWhisper, enqueue, hangup, redirect, startRecording } from "../twiml.ts";
import { relayAfter, relayEnabled, relayTwiml } from "./relay.ts";

export const RECORDING_DISCLOSURE = "This call may be recorded for quality and record-keeping.";

/**
 * Owner questions on a call. An answer ready inside OWNER_INLINE_MS is spoken straight away. Otherwise he hears
 * OWNER_ACK at once (no dead air), Twilio comes back to `?owner_wait=<id>`, and that webhook waits up to
 * OWNER_POLL_MS for the answer (Twilio drops a webhook after ~15 s), saying OWNER_STILL between waits. Only past
 * OWNER_GIVE_UP_MS does the answer go by text. The same run keeps going throughout: nothing is run twice.
 */
export const OWNER_INLINE_MS = 4_000;
export const OWNER_POLL_MS = 9_000;
export const OWNER_GIVE_UP_MS = 30_000;
/** After the answer is ready, how long the run waits for the call to say it before texting it (caller hung up). */
export const OWNER_SPOKEN_GRACE_MS = 15_000;
export const OWNER_ACK = "One sec, I'm checking.";
export const OWNER_STILL = "Still checking.";
export const OWNER_TEXT_FALLBACK = "This one's taking a while, so I'll text you the answer. Anything else?";
export const OWNER_SNAG = "I hit a snag thinking that through and I haven't done anything. Try again in a minute.";

/** What a call says out loud: the first paragraph of the written answer. */
export const voiceLine = (reply: string) => reply.split("\n\n")[0].slice(0, 600);

export interface VoiceInput {
  params: Record<string, string>;
  /** ?rec=start was on the URL: this is the first reply (recording starts now). */
  isFirstReply: boolean;
  /** ?owner_wait=<id>: Twilio is back for the answer to the owner's pending question. */
  ownerWait?: string;
  /** ?relay=done: a live-relay session on this call ended (Twilio's <Connect> action). */
  relayDone?: boolean;
  /** Functions base URL (no trailing slash). */
  base: string;
  line: { orgId: string; departmentId: string | null; number: string };
}

export interface VoiceDeps {
  db: SupabaseClient;
  env: Env;
  speak: Speak;
  turn: (state: CallState, utterance: string) => Promise<InboundTurnResult>;
  finalize: (callSid: string, reason: LeadReason) => Promise<unknown>;
  holdDeps: () => HoldDeps;
  notify: (req: NotifyRequest) => Promise<unknown>;
  putThroughFor: (from: string) => Promise<{ name: string; tier: "transfer" | "message_only" } | null>;
  callerProfile: (from: string) => Promise<NonNullable<CallState["profile"]>>;
  openSlots: () => Promise<string[]>;
  businessSlots: () => Promise<{ start: string; end: string }[]>;
  busyEvent: () => Promise<{ summary?: string } | null>;
  bookReady: (state: CallState, p: { slot: { start: string; end: string }; email?: string }) => ReturnType<typeof bookReady>;
  /** Atomic per-day counter; returns the count including this call. */
  usageIncr: (purpose: string) => Promise<number>;
  /** The owner's whole turn (no deadline): the brain run, saved to his thread; resolves to the written answer. */
  ownerTurn: (speech: string, from: string, callSid: string) => Promise<string>;
  /** Keep work alive after the webhook has answered (EdgeRuntime.waitUntil). */
  keepAlive: (p: Promise<unknown>) => void;
  /** Text the owner (an answer that came too late for the call). */
  textOwner: (text: string, from: string) => Promise<unknown>;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
}

const withTimeout = <T>(p: Promise<T>, ms: number, fallback: T) =>
  Promise.race([p.catch(() => fallback), new Promise<T>((r) => setTimeout(() => r(fallback), ms))]);

export async function handleVoiceTurn(i: VoiceInput, d: VoiceDeps): Promise<string> {
  const { params: p, base, line } = i;
  const from = p.From ?? "", to = p.To ?? line.number, callSid = p.CallSid ?? "";
  const speech = (p.SpeechResult ?? "").trim();
  const voiceUrl = `${base}/clara-voice`;
  const n = names(d.env);
  const first = ownerFirst(d.env);
  const owner = isOwner(d.env, from);
  const workLine = isWorkLineCall(p, d.env);
  const startRec = i.isFirstReply ? startRecording(`${base}/clara-recording`) : "";
  const gather = (prompt: string, tone = "stranger") => gatherXml(prompt, voiceUrl, d.speak, tone);
  const gatherFirst = (prompt: string, tone = "stranger") => gatherXml(prompt, `${voiceUrl}?rec=start`, d.speak, tone);
  const sayHang = async (t: string) => `${await d.speak(t, "stranger")}${hangup()}`;

  const session = await ensureSession(d.db, { callSid, orgId: line.orgId, direction: "inbound", from, to });

  // ── Owner waiting on an answer (Twilio back after "one sec") ─────────────────────────────
  if (owner && i.ownerWait) return await ownerWaitTurn(i.ownerWait, callSid, voiceUrl, gather, d);

  // ── Owner's live-relay session ended: roll onto a fresh connection, hang up, or drop back to the classic path ──
  const relayKey = d.env.get("TWILIO_AUTH_TOKEN")?.trim() ?? "";
  if (i.relayDone) {
    const next = relayAfter(p);
    console.log(`[voice] ${callSid} relay ended: ${next.kind} status=${p.SessionStatus ?? "?"}`);
    if (next.kind === "hangup") return hangup();
    if (owner && next.kind === "rollover" && relayKey) {
      return await relayTwiml({ base, callSid, key: relayKey, env: d.env, pending: next.pending, recording: true });
    }
    // The connection failed: carry on with the classic one-webhook-per-turn path for the rest of the call.
    // (No new recording here: the relay may already have started one.)
    return await gather("Sorry, I lost you for a second. What were you saying?", owner ? "owner" : "stranger");
  }

  // ── First hit: greet, no recording yet ──────────────────────────────────────────────────
  if (!speech) {
    console.log(`[voice] ${callSid} first hit: owner=${owner} workLine=${workLine} ownerNumbersConfigured=${ownerPhoneSet(d.env).length} forwardedFrom=${p.ForwardedFrom ? "yes" : "no"}`);
    await upsertCallLog(d.db, {
      orgId: line.orgId, callSid, direction: "inbound", from, to,
      line: owner ? "owner" : workLine ? "work" : "business", status: "in-progress",
    }).catch((e) => console.error("[voice] call log failed:", e));

    if (workLine && !owner) {
      await patchSession(d.db, callSid, { line: "work" });
      // The always-put-through list: a short hello and straight onto hold while the owner's cell rings.
      // Once per call: a caller sent back here after the owner didn't take it must never be re-held.
      const pt = await d.putThroughFor(from).catch(() => null);
      if (pt && !(await getSession(d.db, callSid))?.state.transferTried) {
        await patchSession(d.db, callSid, { profile: { kind: "vip", name: pt.name, tier: pt.tier } });
        const busy = pt.tier === "transfer" ? await d.busyEvent().catch(() => null) : null;
        const decision = decideVipGreeting(pt.name, pt.tier, busy, first);
        if (decision.outcome !== "hold") {
          if (decision.outcome === "vip_blocked_calendar") await patchSession(d.db, callSid, { vipBusyReason: decision.reasonKind });
          // Text the owner right away so he can break out of his meeting if he wants to.
          await d.notify({ kind: "work_line.vip_heads_up", priority: "critical", category: "revenue", text: decision.headsUp, dedupeKey: `vip-heads-up:${callSid}` }).catch(() => {});
          await patchSession(d.db, callSid, { vipImmediateTexted: true });
          return gatherFirst(`${RECORDING_DISCLOSURE} ${decision.greeting}`);
        }
        const held = await startHold(d.db, { callSid, orgId: line.orgId, from, who: pt.name, vip: true, base }, d.holdDeps());
        if (held.ok) {
          const hello = await d.speak(`${RECORDING_DISCLOSURE} Hi ${pt.name}, it's Clara, ${first}'s AI assistant. One moment — I'm letting him know you're on the line.`, "stranger");
          return enqueue({ queueName: held.queueName, waitUrl: holdUrl(base, "wait", callSid), actionUrl: holdUrl(base, "done", callSid), sayXml: hello });
        }
        console.warn(`[voice] put-through for ${pt.name} not held (${held.reason}) — taking a message`);
      }
    }
    const opener = owner ? `Hi, this is Clara — ${first}'s assistant. How can I help you?`
      : workLine ? workLineGreeting(d.env) : greeting(d.env);
    // The owner on the live relay: streamed answers he can talk over. Recording starts at his first words.
    if (owner && relayEnabled(d.env) && relayKey) {
      return await relayTwiml({ base, callSid, key: relayKey, env: d.env, greeting: `${RECORDING_DISCLOSURE} ${opener}` });
    }
    // No recording yet: the disclosure is only confirmed spoken once Twilio returns a SpeechResult.
    return gatherFirst(`${RECORDING_DISCLOSURE} ${opener}`, owner ? "owner" : "stranger");
  }

  // ── Owner path ──────────────────────────────────────────────────────────────────────────
  if (owner) {
    const startedAt = d.now();
    const run = d.ownerTurn(speech, from, callSid).catch((e) => { console.error("[voice] owner turn failed:", e); return OWNER_SNAG; });
    const quick = await Promise.race([run, d.sleep(OWNER_INLINE_MS).then(() => null)]);
    if (quick !== null) return startRec + await gather(voiceLine(quick), "owner");

    const id = String(startedAt);
    await updateOwnerAsk(d.db, callSid, () => ({ id, startedAt }));
    d.keepAlive(deliverOwnerAnswer(run, id, startedAt, callSid, from, d));
    return startRec + await d.speak(OWNER_ACK, "owner") + redirect(`${voiceUrl}?owner_wait=${encodeURIComponent(id)}`);
  }

  // ── Stranger path: metered, capped, multi-turn ──────────────────────────────────────────
  // Cost ceiling BEFORE the model call, not after. The owner is exempt (handled above), so a
  // stranger flood can never lock him out of his own line.
  const cap = Number(d.env.get("CLARA_INBOUND_CALL_DAILY_CAP") ?? "") || 400;
  const used = await d.usageIncr("inbound-call").catch(() => 0);
  if (used > cap) {
    await d.notify({
      kind: "job.call_cap", priority: "critical", category: "production",
      text: `⏸ Clara stopped answering inbound calls conversationally — ${used - 1} model turns today (cap ${cap}). Callers now get a take-a-message message.`,
      dedupeKey: `clara:callcap:inbound-call:${new Date(d.now()).toISOString().slice(0, 10)}`,
    }).catch(() => {});
    await d.finalize(callSid, "capped");
    return startRec + await sayHang(workLine
      ? `This is Clara, ${first}'s assistant. I can't take details right now — please text this number and ${first} will get back to you.`
      : `Thanks for calling ${n.business}. I can't take details right now, but please email ${n.infoEmail.replace("@", " at ").replace(/\./g, " dot ")} and the team will get right back to you.`);
  }

  let state = (await getSession(d.db, callSid))!.state;
  if (workLine && !state.profile) {
    // First turn on the work line: who is this to the owner, and when could he talk. Both bounded.
    const [profile, slots] = await Promise.all([
      withTimeout(d.callerProfile(from), 3_000, { kind: "unknown" } as NonNullable<CallState["profile"]>),
      withTimeout(d.openSlots(), 3_000, [] as string[]),
    ]);
    await patchSession(d.db, callSid, { line: "work", profile, offeredSlots: slots });
  }
  if (!workLine && state.line !== "work" && state.offeredSlots === undefined) {
    // First turn on the main line: a few real open times on the booking calendar. Bounded.
    const slots = businessBookingEnabled(d.env) ? await withTimeout(d.businessSlots(), 4_000, []) : [];
    await patchSession(d.db, callSid, {
      line: "business", offeredSlots: slots.map((s) => s.start),
      offeredSlotEnds: Object.fromEntries(slots.map((s) => [s.start, s.end])),
    });
  }
  await appendTurn(d.db, callSid, { role: "caller", text: speech, at: new Date(d.now()).toISOString() });
  state = (await getSession(d.db, callSid))!.state;

  const turnStarted = d.now();
  try {
    const turn = await d.turn(state, speech);
    if (turn.injection?.length) {
      await d.notify({
        kind: "injection.detected", priority: "critical", category: "security",
        text: `Possible prompt injection on an inbound call from ${from}: ${turn.injection.join(", ")}.`,
        dedupeKey: `injection:inbound-call:${from}:${new Date(d.now()).toISOString().slice(0, 10)}`,
      }).catch(() => {});
    }
    if (turn.learnedPatch) await updateLearned(d.db, callSid, turn.learnedPatch);

    // Main line: book as soon as they've picked an offered time AND given an email, so what Clara
    // says next is true. A taken slot replaces her line: she must never confirm a booking that
    // didn't happen. No email by the end of the call -> finalize books it phone-only.
    let live = (await getSession(d.db, callSid))!.state;
    const ready = live.line !== "work" && !turn.hardBlocked ? pendingBooking(live, { requireEmail: true }) : null;
    if (ready) {
      await patchSession(d.db, callSid, { booking: { start: ready.slot.start, status: "pending" } });
      const budget = Math.max(1_000, BOOKING_TURN_DEADLINE_MS - (d.now() - turnStarted));
      const bookingP = d.bookReady(live, ready);
      bookingP.then((b) => patchSession(d.db, callSid, { booking: b })).catch(() => {});
      const booking = await withTimeout(bookingP, budget, null);
      if (!booking) turn.sayText = bookingFallbackLine("pending", turn.hangup);
      else if (booking.status !== "booked") turn.sayText = bookingFallbackLine(booking.status, turn.hangup);
      live = (await getSession(d.db, callSid))!.state;
    }
    await appendTurn(d.db, callSid, { role: "clara", text: turn.sayText, at: new Date(d.now()).toISOString() });

    // Work line: an urgent caller is parked while the owner's cell rings, once we know what they
    // need. One attempt per call; if he doesn't take it the hold routes bring them back.
    if (live.line === "work" && !turn.hardBlocked && !live.transferTried && !vipBlocksLiveTransfer(live.profile, live.vipBusyReason)) {
      const ownerNumber = transferTarget(d.env);
      const { urgent } = triageUrgency({
        kind: live.profile?.kind ?? "unknown", text: `${live.learned.need ?? ""} ${speech}`, wantsOwner: turn.wantsHuman, first,
      });
      const knowsWhy = Boolean(live.learned.need) || live.turns.filter((t) => t.role === "caller").length >= 2;
      if (urgent && knowsWhy && ownerNumber) {
        const held = await startHold(d.db, {
          callSid, orgId: line.orgId, from, who: holdWho(live), need: live.learned.need,
          vip: live.profile?.kind === "vip", urgent: true, base,
        }, d.holdDeps());
        if (held.ok) {
          const text = `Understood. One moment — I'm letting ${first} know you're on the line.`;
          await appendTurn(d.db, callSid, { role: "clara", text, at: new Date(d.now()).toISOString() });
          return enqueue({
            queueName: held.queueName, waitUrl: holdUrl(base, "wait", callSid), actionUrl: holdUrl(base, "done", callSid),
            sayXml: startRec + await d.speak(text, "stranger"),
          });
        }
        // Counted as an attempt that never reached him, so the end-of-call text says so and the caller is never held twice.
        await patchSession(d.db, callSid, { transferTried: true, transferOutcome: "no-answer" });
        if (held.reason === "busy") {
          return startRec + await gather(`${first}'s tied up on another call just now. ${turn.sayText}`);
        }
      }
    }

    if (turn.hangup) {
      // A stranger asking for a person on the business line: a live, WHISPERED transfer (the owner
      // hears who's calling before the caller is bridged in), with the same take-a-message fallback
      // (dial-status) if he doesn't pick up. Hard-blocked/goal-met calls are unchanged.
      const ownerNumber = transferTarget(d.env);
      if (live.line !== "work" && turn.wantsHuman && !turn.hardBlocked && ownerNumber) {
        await setStatus(d.db, callSid, "goal-met");
        await patchSession(d.db, callSid, { transferTried: true });
        return dialWhisper({
          number: ownerNumber, callerId: from,
          whisperUrl: holdUrl(base, "whisper", callSid), actionUrl: holdUrl(base, "dial-status", callSid),
        });
      }
      await setStatus(d.db, callSid, turn.hardBlocked ? "injection-blocked" : "goal-met");
      await d.finalize(callSid, turn.hardBlocked ? "blocked" : turn.wantsHuman ? "wants-human" : "qualified");
      return startRec + await sayHang(turn.sayText);
    }

    // Clara's line IS the gather prompt: speaking it separately and then opening an empty <Gather>
    // would give the caller silence to talk over.
    return startRec + await gather(turn.sayText);
  } catch (e) {
    // Never leak an internal error to a caller: say something human, keep what was learned.
    console.error("[voice] turn failed:", callSid, e);
    await d.finalize(callSid, "wants-human").catch(() => {});
    const s = (await getSession(d.db, callSid).catch(() => null)) as SessionRow | null;
    const vipFallback = workLine && s && vipBlocksLiveTransfer(s.state.profile, s.state.vipBusyReason);
    return await sayHang(vipFallback ? vipTakeMessageFallback(first)
      : workLine ? `I'm sorry — this is Clara, ${first}'s assistant, and I'm having trouble on my end. I've flagged this so ${first} sees it, or you can text this number. Thanks for your patience.`
      : "I'm sorry, I'm having trouble on my end. I've flagged this and someone from the team will reach out shortly. Thanks for your patience.");
  }
}

function holdUrl(base: string, step: string, callSid: string): string {
  return `${base}/clara-voice-hold?step=${step}&callSid=${encodeURIComponent(callSid)}`;
}


/**
 * The background half of a long owner question: store the answer for the waiting webhook to say. An answer that
 * arrives after OWNER_GIVE_UP_MS (he was told it would come by text), or that the call never says (he hung up),
 * is texted. Decided by time, so the waiting webhook and this run agree without locking.
 */
export async function deliverOwnerAnswer(
  run: Promise<string>, id: string, startedAt: number, callSid: string, from: string, d: VoiceDeps,
): Promise<void> {
  const reply = await run;
  await updateOwnerAsk(d.db, callSid, (a) => (a?.id === id ? { ...a, reply } : a));
  if (d.now() - startedAt >= OWNER_GIVE_UP_MS) { await d.textOwner(reply, from); return; }
  const until = d.now() + OWNER_SPOKEN_GRACE_MS;
  while (d.now() < until) {
    await d.sleep(1_000);
    const a = (await getSession(d.db, callSid))?.state.ownerAsk;
    if (a?.id !== id || a.spoken) return;
  }
  await d.textOwner(reply, from);
}

/** Twilio is back for the pending answer: say it if it's ready, otherwise "still checking" and come back. */
export async function ownerWaitTurn(
  id: string, callSid: string, voiceUrl: string,
  gather: (prompt: string, tone?: string) => Promise<string>, d: VoiceDeps,
): Promise<string> {
  const until = d.now() + OWNER_POLL_MS;
  for (;;) {
    const a = (await getSession(d.db, callSid))?.state.ownerAsk;
    if (!a || a.id !== id) return await gather("Anything else?", "owner");
    if (a.reply !== undefined) {
      await updateOwnerAsk(d.db, callSid, (x) => (x?.id === id ? { ...x, spoken: true } : x));
      return await gather(voiceLine(a.reply), "owner");
    }
    if (d.now() - a.startedAt >= OWNER_GIVE_UP_MS) return await gather(OWNER_TEXT_FALLBACK, "owner");
    if (d.now() >= until) return await d.speak(OWNER_STILL, "owner") + redirect(`${voiceUrl}?owner_wait=${encodeURIComponent(id)}`);
    await d.sleep(500);
  }
}
