/**
 * Google Meet REST API v2 helpers.
 *
 * Authoritative source for a meeting's transcript + recording, replacing the
 * previous approach of guessing Drive filenames (which broke whenever a title
 * had punctuation, was renamed, or two meetings shared a name).
 *
 * Flow: calendar conferenceId (the meeting code, e.g. "abc-defg-hij")
 *   -> conferenceRecords.list?filter=space.meeting_code="…"
 *   -> conferenceRecords.transcripts.list -> docsDestination.document (a Doc id)
 *   -> conferenceRecords.recordings.list  -> driveDestination.file  (a Drive id)
 *
 * Requires the `meetings.space.readonly` scope. When it's missing Google
 * answers 403 — we surface that as `MeetScopeError` so callers can fall back
 * to the legacy Drive search instead of silently producing nothing.
 */

const MEET_API = "https://meet.googleapis.com/v2";

export class MeetScopeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MeetScopeError";
  }
}

export interface MeetTranscriptRef {
  /** Google Docs document id holding the transcript. */
  documentId: string | null;
  /** Human-openable link. */
  url: string | null;
  /** Plain text, when we could resolve it. */
  text: string | null;
}

export interface MeetRecordingRef {
  /** Drive file id of the recording. */
  fileId: string | null;
  url: string | null;
}

export interface MeetArtifacts {
  conferenceRecord: string | null;
  transcript: MeetTranscriptRef | null;
  recording: MeetRecordingRef | null;
}

async function meetGet(
  accessToken: string,
  path: string,
): Promise<Record<string, unknown> | null> {
  const res = await fetch(`${MEET_API}/${path}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (res.status === 403) {
    throw new MeetScopeError(
      `Meet API 403 (missing meetings.space.readonly?): ${(await res.text()).slice(0, 200)}`,
    );
  }
  if (res.status === 404) return null;
  // A bad token is not "nothing found": callers must see it, or every session settles as no_artifacts.
  if (res.status === 401) {
    throw new Error(`[MeetAPI] GET ${path} -> 401: ${(await res.text()).slice(0, 160)}`);
  }
  if (!res.ok) {
    console.warn(`[MeetAPI] GET ${path} -> ${res.status}: ${(await res.text()).slice(0, 200)}`);
    return null;
  }
  return await res.json();
}

/**
 * Find the conference record for a meeting code. A recurring meeting code can
 * have many records, so prefer the one whose start time is nearest the
 * calendar event.
 */
export async function findConferenceRecord(
  accessToken: string,
  meetingCode: string,
  eventStartTime?: string | null,
): Promise<string | null> {
  const filter = encodeURIComponent(`space.meeting_code="${meetingCode}"`);
  const data = await meetGet(accessToken, `conferenceRecords?filter=${filter}&pageSize=20`);
  const records = (data?.conferenceRecords as Record<string, unknown>[] | undefined) ?? [];
  if (records.length === 0) return null;
  if (records.length === 1 || !eventStartTime) return records[0].name as string;

  const target = new Date(eventStartTime).getTime();
  let best = records[0];
  let bestDelta = Number.POSITIVE_INFINITY;
  for (const r of records) {
    const start = r.startTime ? new Date(r.startTime as string).getTime() : NaN;
    if (!Number.isFinite(start)) continue;
    const delta = Math.abs(start - target);
    if (delta < bestDelta) {
      bestDelta = delta;
      best = r;
    }
  }
  return best.name as string;
}

/** conferenceRecords/{id}/transcripts -> the first transcript with a document. */
export async function getTranscriptRef(
  accessToken: string,
  conferenceRecord: string,
): Promise<MeetTranscriptRef | null> {
  const data = await meetGet(accessToken, `${conferenceRecord}/transcripts`);
  const list = (data?.transcripts as Record<string, unknown>[] | undefined) ?? [];
  for (const t of list) {
    const dest = t.docsDestination as { document?: string; exportUri?: string } | undefined;
    if (dest?.document) {
      return { documentId: dest.document, url: dest.exportUri ?? null, text: null };
    }
  }
  return null;
}

/** conferenceRecords/{id}/recordings -> the first recording with a Drive file. */
export async function getRecordingRef(
  accessToken: string,
  conferenceRecord: string,
): Promise<MeetRecordingRef | null> {
  const data = await meetGet(accessToken, `${conferenceRecord}/recordings`);
  const list = (data?.recordings as Record<string, unknown>[] | undefined) ?? [];
  for (const r of list) {
    const dest = r.driveDestination as { file?: string; exportUri?: string } | undefined;
    if (dest?.file) {
      return { fileId: dest.file, url: dest.exportUri ?? null };
    }
  }
  return null;
}

/**
 * Fallback transcript text built from structured entries, used when Meet
 * exposes no transcript document. Speaker names need a second lookup per
 * participant, so we resolve each unique participant once.
 */
export async function buildTranscriptFromEntries(
  accessToken: string,
  transcriptName: string,
): Promise<string | null> {
  const data = await meetGet(accessToken, `${transcriptName}/entries?pageSize=1000`);
  const entries = (data?.transcriptEntries as Record<string, unknown>[] | undefined) ?? [];
  if (entries.length === 0) return null;

  const names = new Map<string, string>();
  const lines: string[] = [];
  for (const e of entries) {
    const participant = (e.participant as string) ?? "";
    let speaker = names.get(participant) ?? "";
    if (participant && !names.has(participant)) {
      const p = await meetGet(accessToken, participant);
      speaker =
        ((p?.signedinUser as { displayName?: string } | undefined)?.displayName) ||
        ((p?.anonymousUser as { displayName?: string } | undefined)?.displayName) ||
        ((p?.phoneUser as { displayName?: string } | undefined)?.displayName) ||
        "Speaker";
      names.set(participant, speaker);
    }
    const text = (e.text as string) ?? "";
    if (text) lines.push(speaker ? `${speaker}: ${text}` : text);
  }
  return lines.length > 0 ? lines.join("\n") : null;
}

/**
 * One-shot: resolve a meeting code to its transcript + recording.
 * Throws `MeetScopeError` when the token lacks the Meet scope.
 */
export async function getMeetArtifacts(
  accessToken: string,
  meetingCode: string,
  eventStartTime?: string | null,
): Promise<MeetArtifacts> {
  const conferenceRecord = await findConferenceRecord(accessToken, meetingCode, eventStartTime);
  if (!conferenceRecord) {
    return { conferenceRecord: null, transcript: null, recording: null };
  }
  const [transcript, recording] = await Promise.all([
    getTranscriptRef(accessToken, conferenceRecord),
    getRecordingRef(accessToken, conferenceRecord),
  ]);
  return { conferenceRecord, transcript, recording };
}
