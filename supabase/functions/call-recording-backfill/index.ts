/**
 * call-recording-backfill — gives every stored call recording a conversation, a Play button and a
 * transcript. Cron/service only (no user can call it).
 *
 * Picks calls that have audio in the call-recordings bucket but are not yet findable in
 * Conversations, or whose transcript is still pending. A transcript that failed with a recorded
 * reason is NOT retried automatically (that would loop on a bad key); only legacy failures with no
 * reason are given one more try. A few per run, within the 60 s the cron call allows.
 */
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";
import { isCronRequest, isServiceRoleRequest } from "../_shared/auth.ts";
import { repairRecording } from "../_shared/clara/recordings.ts";
import { isTranscribeError, transcribeAudio } from "../_shared/elevenLabsStt.ts";

const PER_RUN = 3;
const BUDGET_MS = 35_000;
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { "Content-Type": "application/json" } });

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  if (!isCronRequest(req) && !isServiceRoleRequest(req)) return json({ error: "Forbidden" }, 403);
  const started = Date.now();
  const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { autoRefreshToken: false, persistSession: false } });

  const { data: rows } = await db.from("call_logs")
    .select("twilio_call_sid")
    .not("recording_path", "is", null)
    .or("conversation_id.is.null,transcript_status.eq.pending,transcript_status.is.null,and(transcript_status.eq.failed,transcript_error.is.null)")
    .order("created_at", { ascending: false })
    .limit(PER_RUN);

  const out: Record<string, unknown>[] = [];
  for (const r of (rows ?? []) as { twilio_call_sid: string }[]) {
    if (Date.now() - started > BUDGET_MS) break;
    const sid = r.twilio_call_sid;
    try {
      const res = await repairRecording(db, sid, {
        downloadStored: async (path) => {
          const { data, error } = await db.storage.from("call-recordings").download(path);
          if (error || !data) throw new Error(error?.message ?? "empty download");
          return new Uint8Array(await data.arrayBuffer());
        },
        transcribe: async (bytes, orgId) => {
          const o = await transcribeAudio(db, orgId, new Blob([bytes as unknown as BlobPart], { type: "audio/mpeg" }), { filename: "call.mp3", language: "en" });
          return isTranscribeError(o) ? { error: o.error } : { text: o.text };
        },
      });
      out.push({ sid: sid.slice(0, 10), ...res });
    } catch (e) {
      console.error("[call-recording-backfill]", sid, (e as Error).message);
      out.push({ sid: sid.slice(0, 10), ok: false, error: (e as Error).message.slice(0, 120) });
    }
  }
  return json({ ok: true, processed: out.length, out });
});
