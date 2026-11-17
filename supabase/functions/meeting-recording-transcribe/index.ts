/**
 * meeting-recording-transcribe — "Transcribe recording" for a meeting that has a recording but no
 * transcript (Google Meet recording in Drive, Teams recording in the organiser's OneDrive).
 *
 * POST { action: "status" }                          → { configured } (is speech-to-text set up?)
 * POST { meeting_transcription_id, force? }          → 202 { status: "queued" } and runs in the
 *      background; progress is on meeting_transcriptions.transcription_status
 *      (queued → processing → completed | failed | not_configured), error in transcription_error.
 *
 * STT = ElevenLabs Scribe (org elevenlabs_connection key, else ELEVENLABS_API_KEY). See
 * _shared/recording-transcribe.ts for how big recordings are handed over without buffering.
 * Limits: recordings up to MEETING_RECORDING_MAX_BYTES (default 1 GB, also the staging bucket and
 * the project's Storage upload limit); the background task must finish within the edge-function
 * wall-clock limit (150 s Free / 400 s paid plans) — roughly 1–2 h of audio on a paid plan.
 */
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { CONSENT_REQUIRED_MESSAGE, parseConsent } from "../_shared/meeting-consent.ts";
import { extractUserContext, getSupabaseClient } from "../_shared/auth.ts";
import { resolveElevenLabsApiKey } from "../_shared/elevenLabsStt.ts";
import { refreshAccessToken, resolveRefreshToken } from "../_shared/google-oauth-helpers.ts";
import { getValidAccessToken as getMsAccessToken, graphFetch } from "../_shared/ms-graph.ts";
import {
  maxRecordingBytes,
  resolveRecordingSource,
  STAGING_BUCKET,
  STALE_JOB_MS,
  transcribeRecordingUrl,
  tusUpload,
} from "../_shared/recording-transcribe.ts";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};
const json = (b: unknown, status = 200) =>
  new Response(JSON.stringify(b), { status, headers: { ...cors, "Content-Type": "application/json" } });

const NOT_CONFIGURED =
  "Speech-to-text is not configured: connect ElevenLabs in AI settings or set the ELEVENLABS_API_KEY secret.";

// deno-lint-ignore no-explicit-any
type Db = any;

interface MeetingRow {
  id: string;
  org_id: string;
  meeting_source: string | null;
  meeting_title: string | null;
  transcript_text: string | null;
  recording_url: string | null;
  recording_file_id: string | null;
  recording_size_bytes: number | null;
  imported_by: string | null;
  transcription_status: string | null;
  transcription_requested_at: string | null;
  consent_basis: string | null;
}

function background(p: Promise<unknown>): void {
  const rt = (globalThis as { EdgeRuntime?: { waitUntil?: (p: Promise<unknown>) => void } }).EdgeRuntime;
  const safe = p.catch((e) => console.error("[meeting-recording-transcribe] background", e));
  if (rt?.waitUntil) rt.waitUntil(safe);
}

async function setStatus(db: Db, id: string, status: string, error: string | null = null, extra: Record<string, unknown> = {}) {
  await db.from("meeting_transcriptions").update({
    transcription_status: status,
    transcription_error: error ? error.slice(0, 500) : null,
    updated_at: new Date().toISOString(),
    ...extra,
  }).eq("id", id);
}

/** Users whose connection may hold the recording: requester, importer, the provider session owner. */
async function candidateUsers(db: Db, m: MeetingRow, requester: string): Promise<string[]> {
  const ids = [requester, m.imported_by];
  const table = m.meeting_source === "teams" ? "meeting_sessions" : "google_meet_sessions";
  const { data } = await db.from(table).select("user_id").eq("meeting_transcription_id", m.id).limit(3);
  for (const r of (data ?? []) as { user_id: string | null }[]) ids.push(r.user_id);
  return [...new Set(ids.filter((x): x is string => !!x))];
}

async function googleToken(db: Db, userId: string, orgId: string): Promise<string | null> {
  const rt = await resolveRefreshToken(db, userId, orgId).catch(() => null);
  if (!rt) return null;
  return (await refreshAccessToken(rt.refreshToken).catch(() => null))?.access_token ?? null;
}

/** Produces an https URL Scribe can fetch, plus a cleanup callback for any staged copy. */
async function recordingUrlFor(
  db: Db,
  m: MeetingRow,
  requester: string,
): Promise<{ url: string; size: number; filename: string; cleanup: () => Promise<void> }> {
  const src = resolveRecordingSource(m);
  const users = await candidateUsers(db, m, requester);
  const maxBytes = maxRecordingBytes();
  const noop = async () => {};

  if (src.kind === "unsupported") throw new Error(src.reason);

  if (src.kind === "onedrive" || src.kind === "graph_url") {
    let lastErr = "no connected Microsoft account can read this recording";
    for (const uid of users) {
      const token = await getMsAccessToken(db, uid).catch(() => null);
      if (!token) continue;
      if (src.kind === "onedrive") {
        const r = await graphFetch(token, `/me/drive/items/${encodeURIComponent(src.itemId)}?$select=id,name,size,@microsoft.graph.downloadUrl`);
        if (!r.ok) { lastErr = `OneDrive lookup failed (${r.status})`; continue; }
        const item = await r.json() as Record<string, unknown>;
        const url = item["@microsoft.graph.downloadUrl"] as string | undefined;
        const size = Number(item.size ?? 0);
        if (!url) { lastErr = "recording has no download URL"; continue; }
        if (size > maxBytes) throw new Error(`recording is ${size} bytes (limit ${maxBytes})`);
        return { url, size, filename: String(item.name ?? "recording.mp4"), cleanup: noop };
      }
      // Graph onlineMeeting recording content: needs OnlineMeetingRecording.Read.All; stream → staging.
      const r = await graphFetch(token, src.url);
      if (!r.ok || !r.body) { lastErr = `Teams recording download failed (${r.status}) — needs OnlineMeetingRecording.Read.All`; continue; }
      const size = Number(r.headers.get("content-length") ?? "0");
      if (!size) { await r.body.cancel(); throw new Error("Teams recording size unknown; cannot stage it"); }
      if (size > maxBytes) { await r.body.cancel(); throw new Error(`recording is ${size} bytes (limit ${maxBytes})`); }
      return await stage(db, m, r.body, size, r.headers.get("content-type") ?? "video/mp4", "recording.mp4");
    }
    throw new Error(lastErr);
  }

  // Google Drive
  let lastErr = "no connected Google account can read this recording";
  for (const uid of users) {
    const token = await googleToken(db, uid, m.org_id);
    if (!token) continue;
    const id = encodeURIComponent(src.fileId);
    const meta = await fetch(`https://www.googleapis.com/drive/v3/files/${id}?fields=id,name,size,mimeType&supportsAllDrives=true`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!meta.ok) { lastErr = `Drive lookup failed (${meta.status})`; continue; }
    const info = await meta.json() as { name?: string; size?: string; mimeType?: string };
    const size = Number(info.size ?? "0");
    if (!size) throw new Error("Drive did not report the recording size");
    if (size > maxBytes) throw new Error(`recording is ${size} bytes (limit ${maxBytes})`);
    const media = await fetch(`https://www.googleapis.com/drive/v3/files/${id}?alt=media&supportsAllDrives=true`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!media.ok || !media.body) { lastErr = `Drive download failed (${media.status})`; continue; }
    return await stage(db, m, media.body, size, info.mimeType ?? "video/mp4", info.name ?? "recording.mp4");
  }
  throw new Error(lastErr);
}

async function stage(
  db: Db,
  m: MeetingRow,
  body: ReadableStream<Uint8Array>,
  size: number,
  contentType: string,
  filename: string,
): Promise<{ url: string; size: number; filename: string; cleanup: () => Promise<void> }> {
  const ext = /\.[A-Za-z0-9]{2,4}$/.exec(filename)?.[0] ?? ".mp4";
  const path = `${m.org_id}/${m.id}/${crypto.randomUUID()}${ext}`;
  const up = await tusUpload({
    supabaseUrl: Deno.env.get("SUPABASE_URL")!,
    serviceKey: Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    bucket: STAGING_BUCKET,
    path,
    contentType,
    size,
    stream: body,
  });
  const cleanup = async () => { await db.storage.from(STAGING_BUCKET).remove([path]).catch(() => {}); };
  if (up.error) {
    await cleanup();
    throw new Error(`${up.error} (check the Storage upload size limit)`);
  }
  const { data, error } = await db.storage.from(STAGING_BUCKET).createSignedUrl(path, 3600);
  if (error || !data?.signedUrl) {
    await cleanup();
    throw new Error(`could not sign staged recording: ${error?.message ?? "no url"}`);
  }
  return { url: data.signedUrl, size, filename, cleanup };
}

async function runTranscription(db: Db, m: MeetingRow, requester: string, apiKey: string): Promise<void> {
  await setStatus(db, m.id, "processing");
  let cleanup: () => Promise<void> = async () => {};
  try {
    const rec = await recordingUrlFor(db, m, requester);
    cleanup = rec.cleanup;
    const out = await transcribeRecordingUrl(apiKey, rec.url, { sizeBytes: rec.size, filename: rec.filename });
    if (!out.ok) throw new Error(out.error);
    if (!out.text.trim()) throw new Error("speech-to-text returned an empty transcript");
    await setStatus(db, m.id, "completed", null, {
      transcript_text: out.text,
      transcript_source: "stt",
      recording_size_bytes: m.recording_size_bytes ?? rec.size,
      processed_at: new Date().toISOString(),
    });
  } catch (e) {
    await setStatus(db, m.id, "failed", String((e as Error)?.message ?? e));
  } finally {
    await cleanup();
  }
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 200, headers: cors });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  try {
    const db = getSupabaseClient();
    const user = await extractUserContext(req, db);
    if (!user) return json({ error: "Unauthorized" }, 401);
    const body = await req.json().catch(() => ({})) as { action?: string; meeting_transcription_id?: string; force?: boolean; consent_basis?: string; consent_note?: string };

    const apiKey = await resolveElevenLabsApiKey(db, user.orgId);
    if (body.action === "status") return json({ configured: !!apiKey, provider: "elevenlabs_scribe" });

    const id = body.meeting_transcription_id;
    if (!id) return json({ error: "meeting_transcription_id is required" }, 400);
    const { data: m } = await db.from("meeting_transcriptions")
      .select("id, org_id, meeting_source, meeting_title, transcript_text, recording_url, recording_file_id, recording_size_bytes, imported_by, transcription_status, transcription_requested_at, consent_basis")
      .eq("id", id).eq("org_id", user.orgId).maybeSingle();
    const meeting = m as MeetingRow | null;
    if (!meeting) return json({ error: "Meeting not found" }, 404);
    if (meeting.transcript_text?.trim() && !body.force) {
      return json({ error: "Meeting already has a transcript", status: "completed" }, 409);
    }
    const src = resolveRecordingSource(meeting);
    if (src.kind === "unsupported") return json({ error: src.reason, status: "failed" }, 422);

    // Transcribing a recording needs a stated consent basis, on the meeting already or sent now (then stored).
    if (!meeting.consent_basis) {
      const consent = parseConsent(body.consent_basis, body.consent_note);
      if (!consent) return json({ error: CONSENT_REQUIRED_MESSAGE, code: "consent_required" }, 400);
      const stored = await db.from("meeting_transcriptions").update({
        consent_basis: consent.basis, consent_note: consent.note,
        consent_confirmed_at: new Date().toISOString(), consent_confirmed_by: user.id,
      }).eq("id", meeting.id).is("consent_basis", null);
      // The statement is the audit trail: if it cannot be saved, nothing is queued. Log the database
      // detail server-side; return a generic message so it is not exposed to the client.
      if (stored.error) {
        console.error("[meeting-recording-transcribe] consent update failed:", stored.error.message);
        return json({ error: "Could not record the consent statement.", code: "consent_store_failed" }, 500);
      }
    }

    if (!apiKey) {
      await setStatus(db, meeting.id, "not_configured", NOT_CONFIGURED);
      return json({ status: "not_configured", error: NOT_CONFIGURED }, 200);
    }

    const running = (meeting.transcription_status === "queued" || meeting.transcription_status === "processing") &&
      meeting.transcription_requested_at &&
      Date.now() - Date.parse(meeting.transcription_requested_at) < STALE_JOB_MS;
    if (running) return json({ status: meeting.transcription_status }, 202);

    await setStatus(db, meeting.id, "queued", null, { transcription_requested_at: new Date().toISOString() });
    background(runTranscription(db, meeting, user.id, apiKey));
    return json({ status: "queued" }, 202);
  } catch (e) {
    console.error("[meeting-recording-transcribe]", e);
    return json({ error: (e as Error).message }, 500);
  }
});
