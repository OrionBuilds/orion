/**
 * The TwiML loop for a call Clara placed (ported from CLARA's business-call route).
 *
 * Same ordering rule as inbound: the recording disclosure is spoken inside the first <Gather> and
 * recording starts only once Twilio returns a SpeechResult. A machine gets one short message and a
 * hang-up; a person gets the deterministic opener, then the confirm-list loop until done.
 */
import type { SupabaseClient } from "npm:@supabase/supabase-js@2";
import type { Env } from "./phones.ts";
import type { NotifyRequest } from "./notify.ts";
import { appendTurn, getSession, updateLearned } from "./call-state.ts";
import { type CallRequest, sessionForRequest } from "./outbound.ts";
import { type OutboundTurn, nextOutboundTurn, openingLine, voicemailLine } from "./outbound-brain.ts";
import { type CallEnding } from "./outbound-finish.ts";
import { type Speak, gatherXml } from "./runtime.ts";
import { hangup, startRecording } from "../twiml.ts";
import { RECORDING_DISCLOSURE } from "./voice.ts";
import type { CallState } from "./types.ts";

export interface OutboundVoiceInput {
  params: Record<string, string>;
  request: CallRequest;
  isFirstReply: boolean;
  base: string;
  orgId: string;
}

export interface OutboundVoiceDeps {
  db: SupabaseClient;
  env: Env;
  speak: Speak;
  turn: (state: CallState, utterance: string) => Promise<OutboundTurn>;
  finish: (callSid: string, ending: CallEnding) => Promise<unknown>;
  notify: (r: NotifyRequest) => Promise<unknown>;
  now: () => number;
}

export async function handleOutboundTurn(i: OutboundVoiceInput, d: OutboundVoiceDeps): Promise<string> {
  const { params: p, request: r } = i;
  const callSid = p.CallSid ?? "";
  const actionUrl = `${i.base}/clara-voice-outbound?requestId=${encodeURIComponent(r.id)}`;
  const gather = (prompt: string, first = false) => gatherXml(prompt, first ? `${actionUrl}&rec=start` : actionUrl, d.speak);
  const sayHang = async (t: string) => `${await d.speak(t, "stranger")}${hangup()}`;

  const session = await sessionForRequest(d.db, r, callSid, i.orgId, p.To ?? "");
  const objective = session.state.objective!;

  // A machine (or fax) answered: one short, content-free message, then done. It never gets the call's details.
  if ((p.AnsweredBy ?? "").toLowerCase().startsWith("machine") || (p.AnsweredBy ?? "").toLowerCase() === "fax") {
    await d.finish(callSid, "voicemail");
    return await sayHang(voicemailLine(d.env, objective));
  }

  const speech = (p.SpeechResult ?? "").trim();
  if (!speech) {
    // First human hit: no recording yet (the disclosure isn't confirmed spoken until Twilio returns speech).
    return await gather(`${RECORDING_DISCLOSURE} ${openingLine(d.env, objective)}`, true);
  }

  const startRec = i.isFirstReply ? startRecording(`${i.base}/clara-recording`) : "";
  try {
    await appendTurn(d.db, callSid, { role: "business", text: speech, at: new Date(d.now()).toISOString() });
    const state = (await getSession(d.db, callSid))!.state;
    const turn = await d.turn(state, speech);
    if (turn.injection?.length) {
      await d.notify({
        kind: "injection.detected", priority: "critical", category: "security",
        text: `Possible prompt injection during Clara's call to ${r.name}: ${turn.injection.join(", ")}.`,
        dedupeKey: `injection:outbound-call:${callSid}`,
      }).catch(() => {});
    }
    const patch = { ...(turn.learnedPatch ?? {}), ...(turn.optOut ? { optOut: "yes" } : {}) };
    if (Object.keys(patch).length) await updateLearned(d.db, callSid, patch);
    await appendTurn(d.db, callSid, { role: "clara", text: turn.sayText, at: new Date(d.now()).toISOString() });

    if (turn.hangup) {
      await d.finish(callSid, "conversation");
      return startRec + await sayHang(turn.sayText);
    }
    return startRec + await gather(turn.sayText);
  } catch (e) {
    console.error("[outbound-voice] turn failed:", callSid, e);
    await d.finish(callSid, "conversation").catch(() => {});
    return await sayHang("I'm sorry, I'm having trouble on my end. I'll follow up another way. Thank you for your time.");
  }
}
