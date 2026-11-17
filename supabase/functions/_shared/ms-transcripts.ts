/**
 * Teams meeting transcripts for EVERY company meeting via app-only Graph (see ms-app-graph.ts).
 * Needs the application permissions OnlineMeetingTranscript.Read.All, OnlineMeetings.Read.All and
 * User.Read.All (OnlineMeetingArtifact.Read.All optional, for attendance), a Teams application access
 * policy granted to the organizers, and Teams admin "Transcript API access → Microsoft Graph" on.
 *
 * Discovery: per organizer, getAllTranscripts(...)/delta. Microsoft returns pages (@odata.nextLink)
 * and finally an @odata.deltaLink to resume from next time. Branch on innerError.code, never the
 * message: GraphAccessToTranscriptsDisabled (tenant switch off), SpeakerAttributionNotAllowed (only
 * the unattributed transcript format is allowed).
 */
import { graphFetch } from "./ms-graph.ts";
import { vttToText } from "./ms-meetings.ts";

type FetchLike = typeof fetch;

export type GraphErrorKind =
  | "transcripts_disabled"
  | "speaker_attribution_blocked"
  | "no_access_policy"
  | "forbidden"
  | "not_found"
  | "throttled"
  | "other";

/** Pure: what a failed Graph response means for this pipeline. */
export function classifyGraphError(status: number, body: string): GraphErrorKind {
  let code = "", message = "";
  try {
    const e = (JSON.parse(body) as { error?: { code?: string; message?: string; innerError?: { code?: string } } }).error;
    code = e?.innerError?.code ?? e?.code ?? "";
    message = e?.message ?? "";
  } catch { /* not JSON */ }
  if (code === "GraphAccessToTranscriptsDisabled") return "transcripts_disabled";
  if (code === "SpeakerAttributionNotAllowed") return "speaker_attribution_blocked";
  if (status === 403 && /application access policy/i.test(message)) return "no_access_policy";
  if (status === 403 || status === 401) return "forbidden";
  if (status === 404) return "not_found";
  if (status === 429 || status === 503) return "throttled";
  return "other";
}

/** Kinds that block the whole tenant until an admin acts (alert the owner, stop retrying). */
export const TENANT_BLOCKING: ReadonlySet<GraphErrorKind> = new Set(["transcripts_disabled", "no_access_policy", "forbidden"]);

export class GraphCallError extends Error {
  constructor(public kind: GraphErrorKind, public status: number, what: string) {
    super(`${what} failed: ${status} ${kind}`);
  }
}

async function getJson<T>(token: string, url: string, what: string, f: FetchLike, headers?: HeadersInit): Promise<T> {
  const r = await graphFetch(token, url, headers ? { headers } : {}, f);
  if (!r.ok) throw new GraphCallError(classifyGraphError(r.status, await r.text()), r.status, what);
  return await r.json() as T;
}

// ── organizers ───────────────────────────────────────────────────────────────────────────────

export interface Organizer { id: string; email: string | null; name: string | null }

/** Enabled member accounts in the tenant (User.Read.All). Guests and disabled users are skipped. */
export async function listOrganizers(token: string, f: FetchLike = fetch, maxPages = 10): Promise<Organizer[]> {
  const filter = encodeURIComponent("accountEnabled eq true and userType eq 'Member'");
  let url: string | undefined = `/users?$select=id,mail,userPrincipalName,displayName&$filter=${filter}&$count=true&$top=999`;
  const out: Organizer[] = [];
  for (let page = 0; url && page < maxPages; page++) {
    // $filter on accountEnabled/userType is an advanced query: needs ConsistencyLevel + $count.
    const j: { value: { id: string; mail?: string | null; userPrincipalName?: string; displayName?: string }[]; "@odata.nextLink"?: string } =
      await getJson(token, url, "list users", f, { ConsistencyLevel: "eventual" });
    for (const u of j.value) out.push({ id: u.id, email: (u.mail ?? u.userPrincipalName ?? null)?.toLowerCase() ?? null, name: u.displayName ?? null });
    url = j["@odata.nextLink"];
  }
  return out;
}

// ── transcript discovery (delta) ─────────────────────────────────────────────────────────────

export interface CallTranscript {
  id: string;
  meetingId: string;
  createdDateTime?: string | null;
  endDateTime?: string | null;
  meetingOrganizer?: { user?: { id?: string } | null } | null;
}

/** Pure: the first delta request for an organizer, limited to transcripts created since `since`. */
export function deltaStartUrl(organizerId: string, since: Date): string {
  return `/users/${organizerId}/onlineMeetings/getAllTranscripts(meetingOrganizerUserId='${organizerId}',startDateTime=${since.toISOString()})/delta`;
}

export interface DeltaResult {
  transcripts: CallTranscript[];
  /** Where to resume next run: the deltaLink when the round finished, else the last nextLink. */
  resumeUrl: string | null;
  complete: boolean;
}

/** Follow one round of delta paging from `url`, up to `maxPages` (no $top: it can drop nextLink). */
export async function syncTranscripts(token: string, url: string, f: FetchLike = fetch, maxPages = 10): Promise<DeltaResult> {
  const transcripts: CallTranscript[] = [];
  let next: string | undefined = url;
  for (let page = 0; next && page < maxPages; page++) {
    const j: { value: CallTranscript[]; "@odata.nextLink"?: string; "@odata.deltaLink"?: string } =
      await getJson(token, next, "getAllTranscripts delta", f);
    transcripts.push(...j.value);
    if (j["@odata.deltaLink"]) return { transcripts, resumeUrl: j["@odata.deltaLink"], complete: true };
    next = j["@odata.nextLink"];
  }
  return { transcripts, resumeUrl: next ?? null, complete: false };
}

// ── meeting details ──────────────────────────────────────────────────────────────────────────

export interface Attendee { name?: string; email?: string }

export interface MeetingDetails {
  subject: string | null;
  startDateTime: string | null;
  endDateTime: string | null;
  organizerEmail: string | null;
  invitees: Attendee[];
}

interface IdentitySet { upn?: string; identity?: { user?: { displayName?: string | null } | null } | null }

export async function getMeetingDetails(token: string, organizerId: string, meetingId: string, f: FetchLike = fetch): Promise<MeetingDetails> {
  const m = await getJson<{
    subject?: string | null; startDateTime?: string | null; endDateTime?: string | null;
    participants?: { organizer?: IdentitySet | null; attendees?: IdentitySet[] | null } | null;
  }>(token, `/users/${organizerId}/onlineMeetings/${encodeURIComponent(meetingId)}`, "get onlineMeeting", f);
  const person = (p: IdentitySet): Attendee => ({ email: p.upn?.toLowerCase(), name: p.identity?.user?.displayName ?? undefined });
  return {
    subject: m.subject ?? null,
    startDateTime: m.startDateTime ?? null,
    endDateTime: m.endDateTime ?? null,
    organizerEmail: m.participants?.organizer?.upn?.toLowerCase() ?? null,
    invitees: (m.participants?.attendees ?? []).map(person).filter((a) => a.email || a.name),
  };
}

/**
 * Who actually joined, from the latest attendance report (OnlineMeetingArtifact.Read.All). Best
 * effort: null when the permission is missing or no report exists; callers fall back to invitees.
 */
export async function getAttendance(token: string, organizerId: string, meetingId: string, f: FetchLike = fetch): Promise<Attendee[] | null> {
  try {
    const base = `/users/${organizerId}/onlineMeetings/${encodeURIComponent(meetingId)}/attendanceReports`;
    const reports = await getJson<{ value: { id: string }[] }>(token, base, "attendance reports", f);
    const latest = reports.value[reports.value.length - 1];
    if (!latest) return null;
    const recs = await getJson<{ value: { emailAddress?: string | null; identity?: { displayName?: string | null } | null }[] }>(
      token, `${base}/${encodeURIComponent(latest.id)}/attendanceRecords`, "attendance records", f);
    return recs.value.map((r) => ({ email: r.emailAddress?.toLowerCase() ?? undefined, name: r.identity?.displayName ?? undefined }));
  } catch {
    return null;
  }
}

/** Pure: attendance first (who really joined), then invitees; one entry per email, name kept. */
export function mergeAttendees(attended: Attendee[] | null, invitees: Attendee[]): Attendee[] {
  const byEmail = new Map<string, Attendee>();
  const nameOnly: Attendee[] = [];
  for (const a of [...(attended ?? []), ...invitees]) {
    const email = a.email?.trim().toLowerCase();
    if (!email) { if (a.name && !nameOnly.some((n) => n.name === a.name)) nameOnly.push({ name: a.name }); continue; }
    const prev = byEmail.get(email);
    byEmail.set(email, { email, name: prev?.name ?? a.name });
  }
  return [...byEmail.values(), ...nameOnly.filter((n) => ![...byEmail.values()].some((a) => a.name === n.name))];
}

// ── transcript content ───────────────────────────────────────────────────────────────────────

const UNATTRIBUTED = "application/vnd.microsoft.graph.transcript+text";

/**
 * Transcript text for one transcript. Prefers WebVTT (speaker names, flattened to "Name: text").
 * When the tenant disallows speaker attribution, retries with the unattributed format.
 */
export async function fetchTranscriptText(
  token: string, organizerId: string, meetingId: string, transcriptId: string, f: FetchLike = fetch,
): Promise<{ text: string; attributed: boolean }> {
  const url = `/users/${organizerId}/onlineMeetings/${encodeURIComponent(meetingId)}/transcripts/${encodeURIComponent(transcriptId)}/content`;
  const r = await graphFetch(token, `${url}?$format=text/vtt`, {}, f);
  if (r.ok) return { text: vttToText(await r.text()), attributed: true };
  const kind = classifyGraphError(r.status, await r.text());
  if (kind !== "speaker_attribution_blocked") throw new GraphCallError(kind, r.status, "transcript content");
  const plain = await graphFetch(token, url, { headers: { Accept: UNATTRIBUTED } }, f);
  if (!plain.ok) throw new GraphCallError(classifyGraphError(plain.status, await plain.text()), plain.status, "transcript content (unattributed)");
  return { text: (await plain.text()).trim(), attributed: false };
}

// ── delegated path helper ────────────────────────────────────────────────────────────────────

/**
 * Pure: for a recurring meeting Graph lists every occurrence's transcripts under one onlineMeeting.
 * Pick the one created during this occurrence (10 min before start .. 3 h after end), newest first;
 * null when none fits (that occurrence was not transcribed yet).
 */
export function pickTranscriptForWindow<T extends { createdDateTime?: string | null }>(
  transcripts: T[], startAt: string, endAt: string,
): T | null {
  const start = Date.parse(startAt), end = Date.parse(endAt);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return transcripts[transcripts.length - 1] ?? null;
  const inWindow = transcripts.filter((t) => {
    const c = Date.parse(t.createdDateTime ?? "");
    return Number.isFinite(c) && c >= start - 10 * 60_000 && c <= end + 3 * 3_600_000;
  });
  return inWindow.sort((a, b) => Date.parse(b.createdDateTime!) - Date.parse(a.createdDateTime!))[0] ?? null;
}
