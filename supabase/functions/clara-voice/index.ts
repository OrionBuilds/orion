/**
 * clara-voice — Twilio voice webhook for Clara's numbers (the published business line and the
 * owner's forwarded work phone). One invocation per caller utterance; all logic is in
 * _shared/clara/voice.ts. Signature-verified (query string included), fail closed.
 */
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { FORBIDDEN, background, denoEnv, functionsBase, readSignedForm, serviceClient, twiml } from "../_shared/clara/webhook.ts";
import { ownerDeliveryNumber } from "../_shared/clara/phones.ts";
import { ownerTurn } from "../_shared/clara/owner-turn.ts";
import { handleVoiceTurn } from "../_shared/clara/voice.ts";
import {
  callerProfile, companyKnowledge, currentBusyEvent, finalizeDeps, holdDeps, makeSpeak, notifyDeps, openSlots, ownerCtx, putThroughFor, resolveLine, sendAndLogSms,
} from "../_shared/clara/runtime.ts";
import { bookReady, businessSlots } from "../_shared/clara/booking.ts";
import { nextInboundTurn } from "../_shared/clara/brain.ts";
import { finalizeInboundCall } from "../_shared/clara/finalize.ts";
import { notifyOwner } from "../_shared/clara/notify.ts";

const HANGUP = `<?xml version="1.0" encoding="UTF-8"?><Response><Hangup/></Response>`;

Deno.serve(async (req: Request) => {
  const params = await readSignedForm(req, "clara-voice");
  if (!params) return FORBIDDEN();

  try {
    const db = serviceClient();
    const line = await resolveLine(db, params.To ?? "");
    if (!line) {
      console.warn("[clara-voice] no twilio_numbers row for", params.To);
      return new Response(HANGUP, { headers: { "Content-Type": "text/xml" } });
    }
    const base = functionsBase(denoEnv);
    const knowledge = await companyKnowledge(db, line.orgId);

    const inner = await handleVoiceTurn({
      params, base, line: { orgId: line.orgId, departmentId: line.departmentId, number: line.number },
      isFirstReply: new URL(req.url).searchParams.get("rec") === "start",
      ownerWait: new URL(req.url).searchParams.get("owner_wait") ?? undefined,
      relayDone: new URL(req.url).searchParams.get("relay") === "done",
    }, {
      db, env: denoEnv, speak: await makeSpeak(db, denoEnv),
      turn: (state, utterance) => nextInboundTurn(state, utterance, { env: denoEnv, knowledge }),
      finalize: (callSid, reason) => finalizeInboundCall(db, callSid, reason, finalizeDeps(db, denoEnv, line.orgId, line.departmentId, line.number)),
      holdDeps: () => holdDeps(db, denoEnv, line.number, base, line.orgId),
      notify: (r) => notifyOwner(db, r, notifyDeps(db, denoEnv, line.orgId, line.number)),
      putThroughFor: (from) => putThroughFor(db, line.orgId, from),
      callerProfile: (from) => callerProfile(db, line.orgId, from),
      openSlots: () => openSlots(db, denoEnv),
      businessSlots: () => businessSlots(denoEnv),
      busyEvent: () => currentBusyEvent(db, denoEnv),
      bookReady: (state, p) => bookReady(denoEnv, state, p),
      usageIncr: async (purpose) => {
        const { data, error } = await db.rpc("clara_usage_incr", { p_org: line.orgId, p_purpose: purpose });
        if (error) throw new Error(error.message);
        return data as number;
      },
      ownerTurn: async (speech) => {
        const ctx = ownerCtx(db, denoEnv, { orgId: line.orgId, claraNumber: line.number, channel: "voice", ownerVerified: true });
        // No deadline here: voice.ts says "one sec" and waits for this run (texting only past OWNER_GIVE_UP_MS).
        return (await ownerTurn(db, denoEnv, ctx, speech)).reply;
      },
      keepAlive: background,
      textOwner: async (reply, from) => {
        const to = ownerDeliveryNumber(denoEnv) ?? from;
        await sendAndLogSms(db, denoEnv, line.orgId, line.number, to, reply, "owner_voice_followup");
      },
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
      now: () => Date.now(),
    });
    return twiml(inner);
  } catch (e) {
    console.error("[clara-voice]", e);
    // A live caller must never hear silence or a Twilio error.
    return new Response(
      `<?xml version="1.0" encoding="UTF-8"?><Response><Say voice="Polly.Joanna-Neural">I'm sorry, I'm having trouble on my end. Please try again shortly.</Say><Hangup/></Response>`,
      { headers: { "Content-Type": "text/xml" } },
    );
  }
});
