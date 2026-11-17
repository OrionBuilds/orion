/**
 * call-recording-url — short-lived signed URL for a stored call recording.
 *
 * Recordings live in the private `call-recordings` bucket (no storage policies), so the app can't
 * read them directly. POST { call_sid } (or { call_log_id }) as a signed-in user; the call must
 * belong to the caller's org. Returns { url, expires_in, transcript_status }. 5-minute URLs: the
 * player fetches a fresh one each time it opens.
 */
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { extractUserContext, getSupabaseClient } from "../_shared/auth.ts";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { ...cors, "Content-Type": "application/json" } });
const TTL = 300;

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 200, headers: cors });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  const db = getSupabaseClient();
  const ctx = await extractUserContext(req, db);
  if (!ctx) return json({ error: "Unauthorized" }, 401);

  const body = await req.json().catch(() => ({}));
  let q = db.from("call_logs").select("organization_id, recording_path, transcript_status");
  if (typeof body.call_log_id === "string") q = q.eq("id", body.call_log_id);
  else if (typeof body.call_sid === "string") q = q.eq("twilio_call_sid", body.call_sid);
  else return json({ error: "call_sid or call_log_id required" }, 400);
  const { data } = await q.maybeSingle();
  const row = data as { organization_id: string; recording_path: string | null; transcript_status: string | null } | null;
  // Same answer for "no such call" and "someone else's call": don't reveal which exist.
  if (!row || row.organization_id !== ctx.orgId) return json({ error: "Recording not found" }, 404);
  if (!row.recording_path) return json({ error: "This call has no stored recording" }, 404);

  const { data: signed, error } = await db.storage.from("call-recordings").createSignedUrl(row.recording_path, TTL);
  if (error || !signed) { console.error("[call-recording-url]", error?.message); return json({ error: "Could not prepare the recording" }, 500); }
  return json({ url: signed.signedUrl, expires_in: TTL, transcript_status: row.transcript_status });
});
