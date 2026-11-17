/**
 * clara-voice-status — Twilio call status callback for Clara's numbers.
 *
 * Fires when a call reaches a terminal state. This is the path that files most real leads: a
 * caller who has said what they came to say hangs up, they don't wait to be dismissed.
 * finalizeInboundCall claims the finalize slot, so racing the voice webhook's own "done" branch is
 * safe. Also writes duration/end time to call_logs (the old OS handler wrote nonexistent columns).
 */
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { FORBIDDEN, denoEnv, readSignedForm, serviceClient } from "../_shared/clara/webhook.ts";
import { applyCallStatus } from "../_shared/clara/conversations.ts";
import { getSession, setStatus } from "../_shared/clara/call-state.ts";
import { finalizeInboundCall } from "../_shared/clara/finalize.ts";
import { claraNumberFor, finalizeDeps, notifyDeps, resolveLine } from "../_shared/clara/runtime.ts";
import { finishOutbound } from "../_shared/clara/outbound-finish.ts";
import { notifyOwner } from "../_shared/clara/notify.ts";

const TERMINAL = ["completed", "busy", "failed", "no-answer", "canceled"];

Deno.serve(async (req: Request) => {
  const p = await readSignedForm(req, "clara-voice-status");
  if (!p) return FORBIDDEN();
  const db = serviceClient();
  const callSid = p.CallSid ?? "";
  const status = (p.CallStatus ?? "").toLowerCase();
  if (!callSid || !status) return new Response(null, { status: 204 });

  try {
    const duration = p.CallDuration ? parseInt(p.CallDuration, 10) : null;
    await applyCallStatus(db, callSid, status, Number.isNaN(duration as number) ? null : duration, p.AnsweredBy);

    // Only terminal states: finalizing on "in-progress" would file the lead mid-conversation.
    if (!TERMINAL.includes(status)) return new Response(null, { status: 204 });
    // A call Clara placed: settle its request. Unanswered / busy / failed calls never reach a webhook,
    // so this callback is the only place they are noticed (and re-queued for another try).
    const { data: placed } = await db.from("clara_call_requests").select("id, organization_id").eq("call_sid", callSid).maybeSingle();
    if (placed) {
      const org = (placed as { organization_id: string }).organization_id;
      const number = await claraNumberFor(db, denoEnv, org);
      const ending = status === "failed" ? "failed" : status === "completed" ? "conversation" : "no_answer";
      await finishOutbound(db, callSid, ending, {
        now: () => new Date(), fromNumber: number, agentUserId: denoEnv.get("CLARA_USER_ID")?.trim() || null,
        notify: (o, r) => notifyOwner(db, r, notifyDeps(db, denoEnv, o, number)),
      });
      return new Response(null, { status: 204 });
    }
    // No session = the owner's own call, an already-finalized one, or a call that never got past
    // the greeting. Nothing to do, and not an error.
    const row = await getSession(db, callSid);
    if (!row || row.direction !== "inbound") return new Response(null, { status: 204 });

    await setStatus(db, callSid, status === "completed" ? "ended" : "voicemail");
    const line = await resolveLine(db, row.to_e164 ?? "");
    if (!line) return new Response(null, { status: 204 });
    // A caller bridged to the owner had that conversation live; this must not file it as one he still owes a call.
    const bridged = row.state.transferOutcome === "connected";
    await finalizeInboundCall(db, callSid, bridged ? "transferred" : "qualified", finalizeDeps(db, denoEnv, line.orgId, line.departmentId, line.number));
  } catch (e) {
    console.error("[clara-voice-status]", callSid, e);
  }
  return new Response(null, { status: 204 });
});
