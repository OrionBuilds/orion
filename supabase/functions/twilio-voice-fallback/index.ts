/**
 * twilio-voice-fallback — what a caller hears when Clara's voice webhook fails.
 *
 * Twilio calls VoiceFallbackUrl when the primary VoiceUrl errors, times out, or returns malformed
 * TwiML. Clara's voice route runs on a Cloudflare tunnel off the owner's box, so the single most likely
 * reason for that is the box being down — which is exactly why this CANNOT live there too. A
 * fallback hosted on the thing that just failed is not a fallback. It lives here, on Supabase, the
 * one host in the estate that stays up when the house does not.
 *
 * Deliberately static TwiML and nothing else:
 *
 *   - No DB writes. This only runs during an outage, and an outage is the worst time to depend on
 *     one more moving part.
 *   - No SMS to the owner. agent-liveness-alarm already pages when Clara stops heartbeating, so a second
 *     alert here would be a duplicate of a page he is already getting.
 *   - No Twilio signature check. There are no side effects and no data to protect; failing closed
 *     on a credentials mismatch would silence the one message a caller gets during an outage,
 *     turning a graceful apology back into Twilio's error tone.
 *
 * The console.error is the trace: a caller reaching this function means a real person called the
 * published number and did not get through, which is worth seeing in the function logs next to the
 * liveness alarm that fired at the same time.
 */

import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const TWIML = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="Polly.Joanna">Thanks for calling. We're having a technical problem with our phone system right now and I'm sorry about that. Please send us an email and someone will get back to you today. Thanks for your patience.</Say>
  <Hangup/>
</Response>`;

Deno.serve(async (req: Request) => {
  let from = "unknown";
  let callSid = "unknown";
  try {
    const form = await req.formData();
    from = String(form.get("From") ?? "unknown");
    callSid = String(form.get("CallSid") ?? "unknown");
  } catch {
    // Twilio always posts a form here, but a malformed body must not stop the caller from hearing
    // something — that is the entire job of this function.
  }

  console.error(`[twilio-voice-fallback] primary voice webhook failed; served apology to ${from} (CallSid ${callSid})`);

  return new Response(TWIML, {
    status: 200,
    headers: { "Content-Type": "text/xml; charset=utf-8" },
  });
});
