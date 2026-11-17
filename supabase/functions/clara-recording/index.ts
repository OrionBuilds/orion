/**
 * clara-recording — Twilio recording status callback.
 *
 * Downloads the finished recording (Twilio's own host only), stores it in the private
 * call-recordings bucket, transcribes it with ElevenLabs Scribe, and logs both to the caller's
 * conversation. Work runs after the response so Twilio isn't kept waiting; failures are logged and
 * never lose the audio.
 */
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { FORBIDDEN, background, denoEnv, readSignedForm, serviceClient, twilioAuth } from "../_shared/clara/webhook.ts";
import { processRecording } from "../_shared/clara/recordings.ts";
import { isTranscribeError, transcribeAudio } from "../_shared/elevenLabsStt.ts";

Deno.serve(async (req: Request) => {
  const p = await readSignedForm(req, "clara-recording");
  if (!p) return FORBIDDEN();
  const db = serviceClient();
  const auth = twilioAuth(denoEnv);
  if (!auth) return new Response("twilio not configured", { status: 500 });

  background((async () => {
    const r = await processRecording(db, p, {
      download: async (url) => {
        const res = await fetch(url, { headers: { Authorization: "Basic " + btoa(`${auth.accountSid}:${auth.authToken}`) } });
        if (!res.ok) throw new Error(`recording download ${res.status}`);
        return new Uint8Array(await res.arrayBuffer());
      },
      upload: async (path, bytes) => {
        const { error } = await db.storage.from("call-recordings").upload(path, bytes, { contentType: "audio/mpeg", upsert: true });
        if (error) throw new Error(error.message);
      },
      transcribe: async (bytes, orgId) => {
        const out = await transcribeAudio(db, orgId, new Blob([bytes as unknown as BlobPart], { type: "audio/mpeg" }), { filename: "call.mp3", language: "en" });
        return isTranscribeError(out) ? { error: out.error } : { text: out.text };
      },
    });
    if (!r.ok) console.warn(`[clara-recording] ${p.CallSid}: ${r.reason}`);
  })());

  return new Response("ok");
});
