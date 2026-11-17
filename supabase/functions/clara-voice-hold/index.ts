/**
 * clara-voice-hold — every Twilio callback in the work-line hold / warm-transfer flow, selected by
 * ?step=. One function instead of ten routes; each step is signature-verified (the query string is
 * part of what Twilio signs) and the logic lives in _shared/clara/hold.ts.
 *
 *   wait         caller parked: play hold audio; each replay re-checks the deadline (the backstop
 *                that ends a hold even if the in-function timer never fired)
 *   done         caller left the queue (bridged / left / hung up / redirected / timed out)
 *   return       back to Clara after the owner didn't take it
 *   answer       owner's cell answered: key-press whisper, then dequeue the caller into his call
 *   bridged      runs on the caller's leg just before bridging: the one place that knows it connected
 *   owner-done   owner's <Dial><Queue> finished
 *   owner-status owner's leg ended; if it never bridged the caller comes back
 *   whisper / accept / dial-status   the business line's direct warm transfer
 */
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { FORBIDDEN, denoEnv, functionsBase, readSignedForm, serviceClient, twiml } from "../_shared/clara/webhook.ts";
import { appendTurn, getSession, patchSession } from "../_shared/clara/call-state.ts";
import {
  acceptedDigits, transferConnected, transferOutcomeFromDial, whisperText, whisperTwiml,
} from "../_shared/clara/work-line.ts";
import {
  classifyQueueResult, declineOnWhisper, getHold, holdAudioUrl, holdExpired, leaveTwiml, markBridged, markReturned,
  onCallerLeft, onOwnerAnswered, onOwnerLegEnded, ownerAnswerTwiml, ownerConfirmWhisperLine, ownerWhisperLine, returnLine, waitTwiml,
} from "../_shared/clara/hold.ts";
import { finalizeDeps, gatherXml, holdDeps, makeSpeak, resolveLine, type Speak } from "../_shared/clara/runtime.ts";
import { finalizeInboundCall } from "../_shared/clara/finalize.ts";
import { names } from "../_shared/clara/persona.ts";
import { deleteQueueByName } from "../_shared/clara/twilio-rest.ts";
import { twilioAuth } from "../_shared/clara/webhook.ts";

const FN = "clara-voice-hold";
const BACKSTOP_GRACE_MS = 5_000;

Deno.serve(async (req: Request) => {
  const p = await readSignedForm(req, FN);
  if (!p) return FORBIDDEN();
  const url = new URL(req.url);
  const step = url.searchParams.get("step") ?? "";
  const callSid = url.searchParams.get("callSid") ?? p.CallSid ?? "";
  const db = serviceClient();
  const base = functionsBase(denoEnv);
  const first = names(denoEnv).ownerFirst;
  const qs = `callSid=${encodeURIComponent(callSid)}`;
  const holdUrl = (s: string, extra = "") => `${base}/${FN}?step=${s}&${qs}${extra}`;

  // The deps need the number Clara is calling from: the caller's session knows what they dialed.
  const session = callSid ? await getSession(db, callSid) : null;
  const line = session ? await resolveLine(db, session.to_e164 ?? "") : null;
  const deps = () => holdDeps(db, denoEnv, line?.number ?? "", base, line?.orgId ?? session?.organization_id ?? "");
  const speak = await makeSpeak(db, denoEnv);
  const clearQueue = async (name: string) => { const a = twilioAuth(denoEnv); if (a) await deleteQueueByName(a, name).catch(() => false); };

  try {
    switch (step) {
      case "wait": {
        const h = callSid ? await getHold(db, callSid) : null;
        const live = h && (h.state === "waiting" || h.state === "accepted");
        if (!live || holdExpired(h, Date.now(), BACKSTOP_GRACE_MS)) return xmlLeave();
        return xmlPlay(waitTwiml(holdAudioUrl(denoEnv.get("CLARA_HOLD_AUDIO_URL"), null)));
      }

      case "answer": {
        const h = callSid ? await getHold(db, callSid) : null;
        if (url.searchParams.get("confirmed") === "1" && p.Digits) {
          // 1 = take it; 2 (or anything else) = pass. Any other digit is treated as decline to be safe.
          if (p.Digits === "1" && h?.state === "accepted") {
            return xmlPlay(ownerAnswerTwiml({
              sayXml: await speak(ownerWhisperLine(h), "owner"), queueName: h.queue_name,
              bridgedUrl: holdUrl("bridged"), actionUrl: holdUrl("owner-done"),
            }));
          }
          if (callSid) await declineOnWhisper(db, callSid, deps());
          return twiml("<Hangup/>");
        }
        const decision = await onOwnerAnswered(db, callSid, p.AnsweredBy, deps());
        if (decision.action === "confirm" && h) {
          const text = ownerConfirmWhisperLine(h);
          return xmlPlay(whisperTwiml({ speakXml: await speak(text, "owner"), acceptUrl: holdUrl("answer", "&confirmed=1") }));
        }
        return twiml("<Hangup/>");
      }

      case "bridged": {
        if (callSid) await markBridged(db, callSid, deps());
        return twiml(await speak(`Connecting you to ${first} now.`, "stranger"));
      }

      case "owner-done":
        return twiml("<Hangup/>");

      case "owner-status": {
        if (callSid) await onOwnerLegEnded(db, callSid, p.CallStatus, deps());
        return new Response(null, { status: 204 });
      }

      case "done": {
        const result = classifyQueueResult(p.QueueResult);
        const h = callSid ? await getHold(db, callSid) : null;
        const finalize = (reason: "transferred" | "qualified") =>
          session && line ? finalizeInboundCall(db, callSid, reason, finalizeDeps(db, denoEnv, line.orgId, line.departmentId, line.number)) : Promise.resolve();
        switch (result) {
          case "bridged":
            // They talked to the owner and that conversation has ended; file what was learned before it.
            await finalize("transferred").catch((e) => console.error(e));
            if (h) await clearQueue(h.queue_name);
            return twiml("<Hangup/>");
          case "hangup":
            await onCallerLeft(db, callSid, deps());
            await finalize("qualified").catch((e) => console.error(e));
            if (h) await clearQueue(h.queue_name);
            return twiml("<Hangup/>");
          case "redirected":
          case "bridging-in-process":
            return twiml(""); // Clara's redirect (or the bridge) already owns this leg
          default: {
            // leave (the backstop), error, queue-full, system-error: the caller is still on the line and
            // this TwiML is what they hear next. No redirect: they have already left the queue.
            if (!(await markReturned(db, callSid, result === "leave" ? "no-reply" : "no-answer", deps()))) {
              await patchSession(db, callSid, { transferTried: true, transferOutcome: "no-reply" });
            }
            return await backToClara(db, callSid, first, base, speak);
          }
        }
      }

      case "return":
        return await backToClara(db, callSid, first, base, speak);

      // ── Business line: direct warm transfer to the owner's cell ──────────────────────────
      case "whisper": {
        const text = whisperText(session ? { learned: session.state.learned, fromE164: session.state.fromE164, line: session.state.line, profile: session.state.profile } : null);
        return xmlPlay(whisperTwiml({ speakXml: await speak(text, "owner"), acceptUrl: holdUrl("accept") }));
      }
      case "accept": {
        if (callSid && acceptedDigits(p.Digits)) {
          await patchSession(db, callSid, { transferAccepted: true, transferOutcome: "connected" });
          return twiml(""); // ends the whisper and bridges him to the caller
        }
        // Any other key is the owner saying no; the record and the text to him say which it was.
        if (callSid) await patchSession(db, callSid, { transferOutcome: "declined" });
        return twiml("<Hangup/>");
      }
      case "dial-status": {
        const status = p.DialCallStatus ?? "";
        const fin = (reason: "transferred" | "wants-human") =>
          session && line ? finalizeInboundCall(db, callSid, reason, finalizeDeps(db, denoEnv, line.orgId, line.departmentId, line.number)) : Promise.resolve();
        // Connected means the owner pressed 1. A "completed" dial he never accepted is his voicemail
        // or a missed whisper: the caller was never really put through.
        if (transferConnected(status, session?.state.transferAccepted)) {
          await fin("transferred").catch((e) => console.error(e));
          return twiml("");
        }
        if (session && !session.state.transferOutcome) await patchSession(db, callSid, { transferOutcome: transferOutcomeFromDial(status) });
        await fin("wants-human").catch((e) => console.error(e));
        return twiml(`${await speak("Sorry, he's not available right now, but I've passed this along and someone from the team will reach out shortly. Thanks for your patience.", "stranger")}<Hangup/>`);
      }

      default:
        return new Response("unknown step", { status: 400 });
    }
  } catch (e) {
    console.error(`[${FN}] ${step} ${callSid}:`, e);
    // Never leave a live caller in silence: a held caller gets a safe exit, everyone else a hang-up.
    return step === "wait" ? xmlLeave() : twiml(step === "done" || step === "return"
      ? `${await speak(`I'm sorry, I'm having trouble on my end. ${first} will get back to you.`, "stranger")}<Hangup/>`
      : "<Hangup/>");
  }
});

const xmlPlay = (body: string) => new Response(body.startsWith("<?xml") ? body : `<?xml version="1.0" encoding="UTF-8"?>${body}`, { headers: { "Content-Type": "text/xml; charset=utf-8" } });
const xmlLeave = () => xmlPlay(leaveTwiml());

/** The neutral line, then the ordinary gather into the voice function so Clara finishes taking the message. */
async function backToClara(db: ReturnType<typeof serviceClient>, callSid: string, first: string, base: string, speak: Speak) {
  const line = returnLine(first);
  if (callSid) await appendTurn(db, callSid, { role: "clara", text: line, at: new Date().toISOString() });
  return twiml(await gatherXml(line, `${base}/clara-voice`, speak));
}
