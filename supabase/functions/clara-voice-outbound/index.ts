/**
 * clara-voice-outbound — the TwiML loop for a call Clara placed (the dialer sets ?requestId=).
 * Signature-verified (query included). All logic is in _shared/clara/outbound-voice.ts.
 */
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { FORBIDDEN, denoEnv, functionsBase, readSignedForm, serviceClient, twiml } from "../_shared/clara/webhook.ts";
import { handleOutboundTurn } from "../_shared/clara/outbound-voice.ts";
import { nextOutboundTurn } from "../_shared/clara/outbound-brain.ts";
import { finishOutbound } from "../_shared/clara/outbound-finish.ts";
import { notifyOwner } from "../_shared/clara/notify.ts";
import { claraNumberFor, makeSpeak, notifyDeps } from "../_shared/clara/runtime.ts";
import type { CallRequest } from "../_shared/clara/outbound.ts";

const COLS = "id, organization_id, requested_by, kind, contact_id, name, phone_e164, goal, must_confirm, context, appointment_id, agent_request_id, not_before, status, attempts, last_attempt_at, call_sid";
const HANGUP = `<?xml version="1.0" encoding="UTF-8"?><Response><Hangup/></Response>`;

Deno.serve(async (req: Request) => {
  const params = await readSignedForm(req, "clara-voice-outbound");
  if (!params) return FORBIDDEN();
  const url = new URL(req.url);
  const db = serviceClient();
  try {
    const requestId = url.searchParams.get("requestId") ?? "";
    const { data } = await db.from("clara_call_requests").select(COLS).eq("id", requestId).maybeSingle();
    const request = data as CallRequest | null;
    if (!request) { console.warn("[clara-voice-outbound] unknown request", requestId); return new Response(HANGUP, { headers: { "Content-Type": "text/xml" } }); }

    const orgId = request.organization_id;
    const fromNumber = await claraNumberFor(db, denoEnv, orgId);
    const inner = await handleOutboundTurn({
      params, request, orgId, base: functionsBase(denoEnv), isFirstReply: url.searchParams.get("rec") === "start",
    }, {
      db, env: denoEnv, speak: await makeSpeak(db, denoEnv),
      turn: (state, utterance) => nextOutboundTurn(state, utterance, { env: denoEnv }),
      finish: (callSid, ending) => finishOutbound(db, callSid, ending, {
        now: () => new Date(), fromNumber, agentUserId: denoEnv.get("CLARA_USER_ID")?.trim() || null,
        notify: (org, r) => notifyOwner(db, r, notifyDeps(db, denoEnv, org, fromNumber)),
      }),
      notify: (r) => notifyOwner(db, r, notifyDeps(db, denoEnv, orgId, fromNumber)),
      now: () => Date.now(),
    });
    return twiml(inner);
  } catch (e) {
    console.error("[clara-voice-outbound]", e);
    return new Response(HANGUP, { headers: { "Content-Type": "text/xml" } });
  }
});
