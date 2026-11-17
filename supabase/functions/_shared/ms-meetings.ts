/**
 * Microsoft Teams online-meeting transcripts via Graph.
 *
 * Delegated flow: the OS can only read transcripts for meetings the connected user ORGANISES, and
 * only when transcription (or recording) was turned on for the meeting. We resolve the meeting from
 * the calendar event's join URL, then pull the transcript as WebVTT and flatten it to
 * "Speaker: text" lines. No artifact yet is a normal, expected state (no_artifacts), not an error.
 */
import { graphFetch } from "./ms-graph.ts";

type FetchLike = typeof fetch;

export interface OnlineMeetingRef {
  id: string;
  joinWebUrl?: string;
}

/** Resolve the Graph onlineMeeting for a Teams join URL. Null when none (e.g. not the organiser). */
export async function findOnlineMeeting(
  accessToken: string,
  joinWebUrl: string,
  fetchImpl: FetchLike = fetch,
): Promise<OnlineMeetingRef | null> {
  // Graph requires the JoinWebUrl filter value to be singly URL-encoded inside the OData string.
  const filter = `JoinWebUrl eq '${joinWebUrl.replace(/'/g, "''")}'`;
  const r = await graphFetch(accessToken, `/me/onlineMeetings?$filter=${encodeURIComponent(filter)}`, {}, fetchImpl);
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`Graph onlineMeetings lookup failed: ${r.status}`);
  const j = await r.json() as { value?: OnlineMeetingRef[] };
  return j.value?.[0] ?? null;
}

export interface TranscriptRef {
  id: string;
  createdDateTime?: string;
  transcriptContentUrl?: string;
}

/** List transcripts for an online meeting (usually 0 or 1). */
export async function listTranscripts(
  accessToken: string,
  onlineMeetingId: string,
  fetchImpl: FetchLike = fetch,
): Promise<TranscriptRef[]> {
  const r = await graphFetch(accessToken, `/me/onlineMeetings/${onlineMeetingId}/transcripts`, {}, fetchImpl);
  if (r.status === 404) return [];
  if (!r.ok) throw new Error(`Graph transcripts list failed: ${r.status}`);
  const j = await r.json() as { value?: TranscriptRef[] };
  return j.value ?? [];
}

/** Fetch one transcript as WebVTT text. */
export async function fetchTranscriptVtt(
  accessToken: string,
  onlineMeetingId: string,
  transcriptId: string,
  fetchImpl: FetchLike = fetch,
): Promise<string> {
  const r = await graphFetch(
    accessToken,
    `/me/onlineMeetings/${onlineMeetingId}/transcripts/${transcriptId}/content?$format=text/vtt`,
    {},
    fetchImpl,
  );
  if (!r.ok) throw new Error(`Graph transcript content failed: ${r.status}`);
  return await r.text();
}

/**
 * Flatten WebVTT to "Speaker: utterance" lines. Graph tags each cue with a voice span
 * `<v Speaker Name>text</v>`. Consecutive cues from the same speaker are merged. Pure; tested.
 */
export function vttToText(vtt: string): string {
  const out: string[] = [];
  let lastSpeaker = "";
  for (const raw of vtt.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line === "WEBVTT" || /^\d+$/.test(line) || line.includes("-->") || line.startsWith("NOTE")) continue;
    const m = line.match(/^<v\s+([^>]+)>(.*?)(?:<\/v>)?$/i);
    const speaker = m ? m[1].trim() : "";
    const text = (m ? m[2] : line).replace(/<[^>]+>/g, "").trim();
    if (!text) continue;
    if (speaker && speaker !== lastSpeaker) {
      out.push(`${speaker}: ${text}`);
      lastSpeaker = speaker;
    } else if (speaker) {
      out[out.length - 1] += ` ${text}`;
    } else {
      out.push(text);
      lastSpeaker = "";
    }
  }
  return out.join("\n");
}

/** Best-effort recording playback URL for an online meeting; null when none exists. */
export async function fetchRecordingUrl(
  accessToken: string,
  onlineMeetingId: string,
  fetchImpl: FetchLike = fetch,
): Promise<string | null> {
  const r = await graphFetch(accessToken, `/me/onlineMeetings/${onlineMeetingId}/recordings`, {}, fetchImpl);
  if (!r.ok) return null;
  const j = await r.json() as { value?: { id: string }[] };
  const rec = j.value?.[0];
  return rec
    ? `https://graph.microsoft.com/v1.0/me/onlineMeetings/${onlineMeetingId}/recordings/${rec.id}/content`
    : null;
}

export interface OneDriveRecording {
  id: string;
  name: string;
  size: number;
  webUrl: string | null;
  createdDateTime: string;
}

interface DriveChild {
  id: string;
  name: string;
  size?: number;
  webUrl?: string;
  createdDateTime?: string;
  file?: { mimeType?: string };
}

/**
 * Pure: picks the Teams recording for a meeting from the organiser's OneDrive "Recordings"
 * folder listing — a video created between 10 min before the start and 3 h after the end,
 * preferring one whose name contains the meeting title, then the one created closest to the start.
 */
export function pickRecording(
  items: DriveChild[],
  meeting: { title: string; startAt: string; endAt: string },
): OneDriveRecording | null {
  const start = Date.parse(meeting.startAt);
  const end = Date.parse(meeting.endAt);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  const title = meeting.title.trim().toLowerCase();
  const candidates = items.filter((i) => {
    const isVideo = (i.file?.mimeType ?? "").startsWith("video/") || /\.(mp4|m4a|mkv|webm)$/i.test(i.name);
    const created = Date.parse(i.createdDateTime ?? "");
    return isVideo && Number.isFinite(created) && created >= start - 10 * 60_000 && created <= end + 3 * 3_600_000;
  });
  if (candidates.length === 0) return null;
  const score = (i: DriveChild) =>
    (title && i.name.toLowerCase().includes(title) ? 0 : 1e13) + Math.abs(Date.parse(i.createdDateTime!) - start);
  const best = candidates.sort((a, b) => score(a) - score(b))[0];
  return { id: best.id, name: best.name, size: best.size ?? 0, webUrl: best.webUrl ?? null, createdDateTime: best.createdDateTime! };
}

/**
 * Teams saves meeting recordings to the organiser's OneDrive "Recordings" folder. Reading them
 * needs only Files.ReadWrite.All (already granted), unlike /onlineMeetings/{id}/recordings which
 * needs the admin-consent-only OnlineMeetingRecording.Read.All. Null when nothing matches.
 */
export async function findOneDriveRecording(
  accessToken: string,
  meeting: { title: string; startAt: string; endAt: string },
  fetchImpl: FetchLike = fetch,
): Promise<OneDriveRecording | null> {
  const r = await graphFetch(
    accessToken,
    `/me/drive/root:/Recordings:/children?$select=id,name,size,webUrl,createdDateTime,file&$top=200`,
    {},
    fetchImpl,
  );
  if (!r.ok) return null; // 404 = no Recordings folder yet
  const j = await r.json() as { value?: DriveChild[] };
  return pickRecording(j.value ?? [], meeting);
}

interface AiInsight {
  meetingNotes?: { title?: string; text?: string; subpoints?: { title?: string; text?: string }[] }[];
  actionItems?: { title?: string; text?: string; ownerDisplayName?: string }[];
}

/** Pure: Teams "AI insights" (intelligent recap) → readable notes text. Empty string when empty. */
export function formatAiInsight(ins: AiInsight): string {
  const out: string[] = [];
  for (const n of ins.meetingNotes ?? []) {
    const head = [n.title, n.text].filter(Boolean).join(": ");
    if (head) out.push(`- ${head}`);
    for (const sp of n.subpoints ?? []) {
      const t = [sp.title, sp.text].filter(Boolean).join(": ");
      if (t) out.push(`  - ${t}`);
    }
  }
  const items = (ins.actionItems ?? []).map((a) =>
    `- ${[a.title, a.text].filter(Boolean).join(": ")}${a.ownerDisplayName ? ` (owner: ${a.ownerDisplayName})` : ""}`);
  if (items.length) out.push("Action items:", ...items);
  return out.join("\n").trim();
}

/**
 * Best-effort Teams AI recap (Graph /copilot/users/{id}/onlineMeetings/{id}/aiInsights). Requires a
 * Microsoft 365 Copilot licence AND the OnlineMeetingAiInsight.Read.All delegated permission, which
 * the OS does not request by default — so this normally returns null and callers fall back to the
 * OS's own transcript digest.
 */
export async function fetchAiInsights(
  accessToken: string,
  onlineMeetingId: string,
  fetchImpl: FetchLike = fetch,
): Promise<string | null> {
  const me = await graphFetch(accessToken, "/me?$select=id", {}, fetchImpl);
  if (!me.ok) return null;
  const userId = (await me.json() as { id?: string }).id;
  if (!userId) return null;
  const base = `/copilot/users/${encodeURIComponent(userId)}/onlineMeetings/${encodeURIComponent(onlineMeetingId)}/aiInsights`;
  const list = await graphFetch(accessToken, base, {}, fetchImpl);
  if (!list.ok) return null;
  const first = ((await list.json()) as { value?: { id: string }[] }).value?.[0];
  if (!first) return null;
  const one = await graphFetch(accessToken, `${base}/${encodeURIComponent(first.id)}`, {}, fetchImpl);
  if (!one.ok) return null;
  const text = formatAiInsight(await one.json() as AiInsight);
  return text || null;
}
