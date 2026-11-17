/**
 * "Transcribe recording" for meetings that have a recording but no transcript (Google Meet
 * recordings in Drive, Teams recordings in the organiser's OneDrive).
 *
 * Speech-to-text reuses the repo's existing provider, ElevenLabs Scribe (see elevenLabsStt.ts —
 * org `elevenlabs_connection` key, else the ELEVENLABS_API_KEY secret). Recordings are far too big
 * to buffer in an edge function, so Scribe is handed a URL to fetch (`cloud_storage_url`):
 *   - OneDrive/SharePoint: Graph's pre-authenticated, short-lived download URL (no copy made);
 *   - Google Drive: the file is streamed in 6 MB chunks (TUS resumable upload) into the private
 *     `meeting-recordings-staging` bucket, Scribe gets a 1-hour signed URL, and the staged copy is
 *     deleted afterwards.
 * The edge function runs this as a background task (EdgeRuntime.waitUntil) and tracks progress in
 * meeting_transcriptions.transcription_status.
 */
import { ELEVENLABS_STT_MODEL, ELEVENLABS_STT_URL } from "./elevenLabsStt.ts";

type FetchLike = typeof fetch;

export const STAGING_BUCKET = "meeting-recordings-staging";
/** Supabase resumable uploads require exactly 6 MB chunks (except the last). */
export const TUS_CHUNK_BYTES = 6 * 1024 * 1024;
export const DEFAULT_MAX_RECORDING_BYTES = 1024 * 1024 * 1024; // = staging bucket limit
/** Scribe processes roughly an hour of audio in well under this. */
export const SCRIBE_TIMEOUT_MS = 330_000;
/** If Scribe refuses a URL, recordings up to this size are retried as a direct upload. */
export const DIRECT_UPLOAD_FALLBACK_BYTES = 80 * 1024 * 1024;
/** A processing job older than this is considered dead and may be restarted. */
export const STALE_JOB_MS = 20 * 60_000;

export function maxRecordingBytes(env: { get(k: string): string | undefined } = Deno.env): number {
  const v = Number(env.get("MEETING_RECORDING_MAX_BYTES") ?? "");
  return Number.isFinite(v) && v > 0 ? v : DEFAULT_MAX_RECORDING_BYTES;
}

/** Google Drive file id from the common Drive URL shapes, else null. */
export function parseDriveFileId(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    if (!/(^|\.)google\.com$/.test(u.hostname)) return null;
    const m = /\/(?:file|document|presentation|spreadsheets)\/d\/([A-Za-z0-9_-]{10,})/.exec(u.pathname);
    if (m) return m[1];
    const id = u.searchParams.get("id");
    return id && /^[A-Za-z0-9_-]{10,}$/.test(id) ? id : null;
  } catch {
    return null;
  }
}

export type RecordingSource =
  | { kind: "google_drive"; fileId: string }
  | { kind: "onedrive"; itemId: string }
  | { kind: "graph_url"; url: string }
  | { kind: "unsupported"; reason: string };

/** Where a meeting's recording lives, from meeting_transcriptions columns. Pure. */
export function resolveRecordingSource(m: {
  meeting_source: string | null;
  recording_url: string | null;
  recording_file_id: string | null;
}): RecordingSource {
  const url = m.recording_url ?? "";
  if (m.meeting_source === "teams") {
    if (m.recording_file_id) return { kind: "onedrive", itemId: m.recording_file_id };
    if (url.startsWith("https://graph.microsoft.com/")) return { kind: "graph_url", url };
    return { kind: "unsupported", reason: "Teams recording location unknown" };
  }
  if (m.recording_file_id) return { kind: "google_drive", fileId: m.recording_file_id };
  const fromUrl = parseDriveFileId(url);
  if (fromUrl) return { kind: "google_drive", fileId: fromUrl };
  if (url.startsWith("https://graph.microsoft.com/")) return { kind: "graph_url", url };
  return { kind: "unsupported", reason: url ? "recording is not in Google Drive or OneDrive" : "meeting has no recording" };
}

/** Re-chunks a byte stream into fixed-size pieces (last one may be shorter). */
export async function* rechunk(stream: ReadableStream<Uint8Array>, size: number): AsyncGenerator<Uint8Array> {
  const reader = stream.getReader();
  let buf = new Uint8Array(size);
  let fill = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      let off = 0;
      while (off < value.byteLength) {
        const n = Math.min(size - fill, value.byteLength - off);
        buf.set(value.subarray(off, off + n), fill);
        fill += n;
        off += n;
        if (fill === size) {
          yield buf;
          buf = new Uint8Array(size);
          fill = 0;
        }
      }
    }
    if (fill > 0) yield buf.subarray(0, fill);
  } finally {
    reader.releaseLock();
  }
}

const b64 = (s: string) => btoa(String.fromCharCode(...new TextEncoder().encode(s)));

/**
 * Streams `stream` (of exactly `size` bytes) into Supabase Storage with the TUS resumable
 * protocol, so memory stays at one 6 MB chunk regardless of file size.
 */
export async function tusUpload(args: {
  supabaseUrl: string;
  serviceKey: string;
  bucket: string;
  path: string;
  contentType: string;
  size: number;
  stream: ReadableStream<Uint8Array>;
  fetchImpl?: FetchLike;
}): Promise<{ error: string | null }> {
  const doFetch = args.fetchImpl ?? fetch;
  const auth = { Authorization: `Bearer ${args.serviceKey}`, apikey: args.serviceKey, "Tus-Resumable": "1.0.0" };
  const create = await doFetch(`${args.supabaseUrl}/storage/v1/upload/resumable`, {
    method: "POST",
    headers: {
      ...auth,
      "Upload-Length": String(args.size),
      "x-upsert": "true",
      "Upload-Metadata": [
        `bucketName ${b64(args.bucket)}`,
        `objectName ${b64(args.path)}`,
        `contentType ${b64(args.contentType)}`,
        `cacheControl ${b64("3600")}`,
      ].join(","),
    },
  });
  if (create.status !== 201) {
    const body = await create.text().catch(() => "");
    return { error: `storage upload create failed (${create.status}) ${body.slice(0, 200)}` };
  }
  const loc = create.headers.get("location");
  if (!loc) return { error: "storage upload create returned no location" };
  const target = new URL(loc, args.supabaseUrl).toString();

  let offset = 0;
  for await (const chunk of rechunk(args.stream, TUS_CHUNK_BYTES)) {
    if (offset + chunk.byteLength > args.size) return { error: "recording is larger than its declared size" };
    const r = await doFetch(target, {
      method: "PATCH",
      headers: { ...auth, "Upload-Offset": String(offset), "Content-Type": "application/offset+octet-stream" },
      body: chunk as unknown as BodyInit,
    });
    if (r.status !== 204) {
      const body = await r.text().catch(() => "");
      return { error: `storage upload chunk failed at ${offset} (${r.status}) ${body.slice(0, 200)}` };
    }
    await r.body?.cancel().catch(() => {});
    offset += chunk.byteLength;
  }
  if (offset !== args.size) return { error: `uploaded ${offset} of ${args.size} bytes` };
  return { error: null };
}

interface ScribeWord {
  text?: string;
  type?: string;
  speaker_id?: string | null;
}

/** Scribe response → "Speaker 1: …" lines when diarised, else the plain text. Pure. */
export function formatScribeTranscript(data: { text?: string; words?: ScribeWord[] } | null): string {
  const words = data?.words ?? [];
  if (!words.some((w) => w.speaker_id)) return (data?.text ?? "").trim();
  const labels = new Map<string, string>();
  const label = (id: string) => labels.get(id) ?? labels.set(id, `Speaker ${labels.size + 1}`).get(id)!;
  const lines: string[] = [];
  let current: string | null = null;
  let buf = "";
  for (const w of words) {
    if (w.type === "audio_event") continue;
    const sp: string | null = w.speaker_id ?? current;
    if (w.type === "word" && sp && sp !== current) {
      if (current !== null && buf.trim()) lines.push(`${label(current)}: ${buf.trim()}`);
      current = sp;
      buf = "";
    }
    buf += w.text ?? "";
  }
  if (current !== null && buf.trim()) lines.push(`${label(current)}: ${buf.trim()}`);
  return lines.join("\n").replace(/[ \t]+/g, " ");
}

export type ScribeOutcome = { ok: true; text: string; language?: string } | { ok: false; status?: number; error: string };

async function scribeRequest(apiKey: string, form: FormData, fetchImpl: FetchLike, timeoutMs: number): Promise<ScribeOutcome> {
  let resp: Response;
  try {
    resp = await fetchImpl(ELEVENLABS_STT_URL, {
      method: "POST",
      headers: { "xi-api-key": apiKey },
      body: form,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    return { ok: false, error: `speech-to-text request failed: ${String((e as Error)?.message ?? e).slice(0, 200)}` };
  }
  const raw = await resp.text();
  // deno-lint-ignore no-explicit-any
  let data: any = null;
  try { data = JSON.parse(raw); } catch { /* not JSON */ }
  if (!resp.ok) {
    const detail = typeof data?.detail === "string" ? data.detail : data?.detail?.message ?? data?.message ?? raw.slice(0, 200);
    return { ok: false, status: resp.status, error: `ElevenLabs Scribe ${resp.status}: ${detail}` };
  }
  const text = formatScribeTranscript(data);
  return { ok: true, text, language: typeof data?.language_code === "string" ? data.language_code : undefined };
}

function baseForm(): FormData {
  const form = new FormData();
  form.append("model_id", ELEVENLABS_STT_MODEL);
  form.append("diarize", "true");
  form.append("tag_audio_events", "false");
  return form;
}

/**
 * Transcribes a recording reachable at an https URL (signed / pre-authenticated). When Scribe
 * rejects the URL (4xx) and the recording is small enough, retries by uploading the bytes.
 */
export async function transcribeRecordingUrl(
  apiKey: string,
  url: string,
  opts: { sizeBytes?: number; filename?: string; fetchImpl?: FetchLike; timeoutMs?: number } = {},
): Promise<ScribeOutcome> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? SCRIBE_TIMEOUT_MS;
  const form = baseForm();
  form.append("cloud_storage_url", url);
  const first = await scribeRequest(apiKey, form, fetchImpl, timeoutMs);
  if (first.ok || !first.status || first.status >= 500 || first.status === 401) return first;
  if ((opts.sizeBytes ?? Infinity) > DIRECT_UPLOAD_FALLBACK_BYTES) return first;

  const dl = await fetchImpl(url, { signal: AbortSignal.timeout(120_000) }).catch(() => null);
  if (!dl || !dl.ok) return first;
  const blob = await dl.blob();
  const direct = baseForm();
  direct.append("file", blob, opts.filename ?? "recording.mp4");
  return scribeRequest(apiKey, direct, fetchImpl, timeoutMs);
}
