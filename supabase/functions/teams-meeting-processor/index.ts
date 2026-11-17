/**
 * teams-meeting-processor — cron (every 5 min). Finds new Teams meeting transcripts and files them
 * for CLARA (digest → tasks, FRIDAY handoff, follow-up drafts, owner SMS). Cron-only.
 *
 * Two discovery modes:
 *  - app (MS_TRANSCRIPTS_* secrets set): every company meeting. Per Entra organizer, Graph's
 *    getAllTranscripts delta lists transcripts added since the last run (cursor in
 *    teams_transcript_cursors). One session per TRANSCRIPT, so recurring occurrences stay apart.
 *  - delegated (fallback): only meetings each connected user organises, found from the calendar
 *    mirror; a meeting with no transcript yet stays `detected` and is retried for 48h.
 *
 * Sessions stuck in `processing` (a run that timed out) are reset; errors retry up to MAX_RETRIES
 * then fail; a tenant-level block (transcript API access off, no access policy, consent missing)
 * pages the owner once a day and the run stops early.
 */
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { isCronRequest } from "../_shared/auth.ts";
import { denoEnv, serviceClient } from "../_shared/clara/webhook.ts";
import { MsTokenError } from "../_shared/ms-graph.ts";
import { CHECK_DELAY_MS, DETECT_WINDOW_MS, discoverDelegated, sessionToken } from "../_shared/teams-delegated.ts";
import { getAppToken, msAppConfig } from "../_shared/ms-app-graph.ts";
import {
  fetchAiInsights,
  fetchRecordingUrl,
  fetchTranscriptVtt,
  findOneDriveRecording,
  findOnlineMeeting,
  listTranscripts,
  vttToText,
} from "../_shared/ms-meetings.ts";
import {
  deltaStartUrl,
  fetchTranscriptText,
  getAttendance,
  getMeetingDetails,
  GraphCallError,
  type GraphErrorKind,
  listOrganizers,
  mergeAttendees,
  pickTranscriptForWindow,
  syncTranscripts,
  TENANT_BLOCKING,
} from "../_shared/ms-transcripts.ts";
import { runMeetingDigest, type MeetingRecord } from "../_shared/clara/meeting-digest.ts";
import { fileMeeting, type FileResult } from "../_shared/clara/meeting-file.ts";
import { notifyOwner } from "../_shared/clara/notify.ts";
import { claraNumberFor, notifyDeps } from "../_shared/clara/runtime.ts";

// DETECT_WINDOW_MS (48h: delegated meetings that ended within it are still worth checking) and CHECK_DELAY_MS
// (15 min: Graph publishes transcripts a few minutes after the call) live in _shared/teams-delegated.ts.
const MAX_PER_RUN = 5;                   // each one runs an LLM digest; keep well inside the 120s cron timeout
const TIME_BUDGET_MS = 90_000;           // stop starting new sessions after this
const STUCK_AFTER_MS = 15 * 60_000;      // a `processing` row older than this belonged to a run that died
const MAX_RETRIES = 12;                  // ~3h of retries at CHECK_DELAY_MS, then `failed`
const ORGANIZERS_PER_RUN = 25;           // app mode: least-recently-synced organizers first
const APP_FIRST_SYNC_LOOKBACK_MS = 48 * 3_600_000;
const APP_MAX_TRANSCRIPT_AGE_MS = 7 * 86_400_000; // delta can resurface old artifacts; ignore them
/** After this many empty checks (~1 h), a meeting with a OneDrive recording but no transcript is
 *  filed as recording-only so it can be transcribed on demand ("Transcribe recording"). */
const RECORDING_ONLY_AFTER_RETRIES = 3;

// deno-lint-ignore no-explicit-any
type Db = any;
type Session = Record<string, unknown>;

class TenantBlockedError extends Error {
  constructor(public kind: GraphErrorKind | string, what: string) {
    super(`${what}: ${kind}`);
  }
}

const TENANT_HELP: Record<string, string> = {
  transcripts_disabled: "Teams admin center → Meetings → Meeting settings → Transcript API access: turn on Microsoft Graph access.",
  no_access_policy: "Grant the Teams application access policy to the organizers (Grant-CsApplicationAccessPolicy -Global).",
  forbidden: "Check the app's application permissions and admin consent in Entra (OnlineMeetingTranscript.Read.All, OnlineMeetings.Read.All, User.Read.All).",
};

/** Page the owner once a day per kind when the tenant blocks transcript access. Never throws. */
async function alertTenantBlock(db: Db, orgId: string, kind: string): Promise<void> {
  const day = new Date().toISOString().slice(0, 10);
  try {
    await notifyOwner(db, {
      kind: "teams.transcripts", priority: "normal", category: "production",
      text: `Teams transcripts are blocked (${kind}). ${TENANT_HELP[kind] ?? "Check the transcripts app in Entra."}`,
      dedupeKey: `teams-transcripts:${kind}:${day}`,
    }, notifyDeps(db, denoEnv, orgId, await claraNumberFor(db, denoEnv, orgId)));
  } catch (e) {
    console.warn("[teams-meeting-processor] owner alert failed:", (e as Error).message);
  }
}

/** Workflows listen for meeting_processed (same event the Google pipeline emitted). Never throws. */
async function publishProcessed(db: Db, sess: Session, rec: MeetingRecord, filed: FileResult): Promise<void> {
  if (!filed.meetingTranscriptionId) return;
  const { error } = await db.from("event_outbox").insert({
    org_id: sess.org_id,
    event_type: "meeting_processed",
    entity_type: "meeting_transcription",
    entity_id: filed.meetingTranscriptionId,
    payload: {
      meeting_transcription_id: filed.meetingTranscriptionId,
      meeting_session_id: sess.id,
      provider: "teams",
      meeting_title: rec.title,
      meeting_date: rec.startedAt ?? null,
      contacts_linked: filed.contactsLinked,
      tasks_created: filed.tasksCreated,
      has_transcript: true,
      has_recording: !!rec.recordingUrl,
    },
  });
  if (error) console.warn("[teams-meeting-processor] meeting_processed event failed:", error.message);
}

/**
 * Files a Teams meeting that has a recording (organiser's OneDrive) but no Teams transcript:
 * a meeting_transcriptions row with no transcript, linked to attendee contacts, so it shows up in
 * the proposal/contract builders where the user can run speech-to-text on it.
 */
async function fileRecordingOnly(
  db: Db,
  sess: Session,
  rec: { id: string; webUrl: string | null; size: number },
): Promise<string | null> {
  const attendees = Array.isArray(sess.attendees) ? (sess.attendees as { name?: string; email?: string }[]) : [];
  const start = sess.start_at as string;
  const end = sess.end_at as string;
  const duration = start && end ? Math.max(1, Math.round((Date.parse(end) - Date.parse(start)) / 60000)) : null;
  const { data: row, error } = await db.from("meeting_transcriptions").upsert({
    org_id: sess.org_id,
    meeting_source: "teams",
    external_meeting_id: sess.external_event_id,
    meeting_title: (sess.title as string) || "Meeting",
    meeting_date: start ?? new Date().toISOString(),
    duration_minutes: duration,
    participants: attendees,
    recording_url: rec.webUrl,
    recording_file_id: rec.id,
    recording_size_bytes: rec.size || null,
    imported_by: sess.user_id,
    updated_at: new Date().toISOString(),
  }, { onConflict: "org_id,meeting_source,external_meeting_id" }).select("id").maybeSingle();
  if (error) throw new Error(`meeting_transcriptions upsert failed: ${error.message}`);
  const id = (row as { id: string } | null)?.id ?? null;
  if (!id) return null;
  const emails = [...new Set(
    [...attendees.map((a) => a.email), sess.organizer_email as string | undefined]
      .map((e) => e?.toLowerCase()).filter(Boolean) as string[],
  )];
  if (emails.length) {
    const { data: contacts } = await db.from("contacts").select("id, email").eq("organization_id", sess.org_id).in("email", emails);
    const matched = ((contacts ?? []) as { id: string; email: string }[]).filter((c) => c.email);
    for (const c of matched) {
      await db.from("meeting_transcription_contacts").upsert(
        { org_id: sess.org_id, meeting_transcription_id: id, contact_id: c.id, participant_email: c.email },
        { onConflict: "meeting_transcription_id,contact_id" },
      );
    }
    if (matched[0]) await db.from("meeting_transcriptions").update({ contact_id: matched[0].id }).eq("id", id).is("contact_id", null);
  }
  return id;
}

async function digestAndFile(db: Db, sess: Session, rec: MeetingRecord): Promise<FileResult> {
  const digest = await runMeetingDigest(denoEnv, rec);
  if (!digest) throw new Error("digest failed");
  const filed = await fileMeeting(db, denoEnv, sess.org_id as string, rec, digest, {
    importedBy: sess.user_id as string,
    claraUserId: denoEnv.get("CLARA_USER_ID")?.trim() || null,
    ownerUserId: denoEnv.get("OWNER_USER_ID")?.trim() || null,
  });
  await publishProcessed(db, sess, rec, filed);
  return filed;
}

const filedSummary = (f: FileResult) => `filed (${f.tasksCreated} tasks, ${f.fridayHandoffs} to friday, ${f.followUpDrafts} drafts)`;

// ── app mode ─────────────────────────────────────────────────────────────────────────────────

/** The OS org and owner the tenant's meetings are filed under (one Entra app per OS deployment). */
async function appTarget(db: Db): Promise<{ orgId: string; ownerUserId: string } | null> {
  const ownerUserId = denoEnv.get("OWNER_USER_ID")?.trim();
  if (!ownerUserId) return null;
  const fixedOrg = denoEnv.get("MS_TRANSCRIPTS_ORG_ID")?.trim();
  if (fixedOrg) return { orgId: fixedOrg, ownerUserId };
  const { data } = await db.from("users").select("organization_id").eq("id", ownerUserId).maybeSingle();
  const orgId = (data as { organization_id: string } | null)?.organization_id;
  return orgId ? { orgId, ownerUserId } : null;
}

/** New transcripts since each organizer's cursor → one `detected` session per transcript. */
async function discoverApp(db: Db, token: string, orgId: string, ownerUserId: string, now: number): Promise<number> {
  const organizers = await listOrganizers(token);
  // Map an Entra account to an OS user: the Microsoft connection first (the owner's Microsoft
  // address need not equal the OS login), then the OS email, else the owner.
  const [{ data: conns }, { data: users }, { data: cursors }] = await Promise.all([
    db.from("microsoft_oauth_master").select("id, user_id, email, account_type").eq("organization_id", orgId),
    db.from("users").select("id, email").eq("organization_id", orgId),
    db.from("teams_transcript_cursors").select("organizer_aad_id, delta_link, last_synced_at").eq("org_id", orgId),
  ]);
  const userByEmail = new Map<string, string>();
  for (const u of (users ?? []) as { id: string; email: string }[]) if (u.email) userByEmail.set(u.email.toLowerCase(), u.id);
  const connByEmail = new Map<string, string>(); // organiser address -> the connection (account) it is
  for (const c of (conns ?? []) as { id: string; user_id: string; email: string; account_type?: string | null }[]) {
    if (!c.email || (c.account_type ?? "work") !== "work") continue; // Teams is home-organization only
    userByEmail.set(c.email.toLowerCase(), c.user_id);
    connByEmail.set(c.email.toLowerCase(), c.id);
  }
  const cursorOf = new Map(((cursors ?? []) as { organizer_aad_id: string; delta_link: string | null; last_synced_at: string | null }[])
    .map((c) => [c.organizer_aad_id, c]));

  const batch = organizers
    .sort((a, b) => Date.parse(cursorOf.get(a.id)?.last_synced_at ?? "1970-01-01") - Date.parse(cursorOf.get(b.id)?.last_synced_at ?? "1970-01-01"))
    .slice(0, ORGANIZERS_PER_RUN);

  let found = 0, policyMisses = 0;
  for (const org of batch) {
    const url = cursorOf.get(org.id)?.delta_link ?? deltaStartUrl(org.id, new Date(now - APP_FIRST_SYNC_LOOKBACK_MS));
    try {
      const res = await syncTranscripts(token, url);
      for (const t of res.transcripts) {
        const created = Date.parse(t.createdDateTime ?? t.endDateTime ?? "");
        if (Number.isFinite(created) && now - created > APP_MAX_TRANSCRIPT_AGE_MS) continue;
        const { error } = await db.from("meeting_sessions").upsert({
          org_id: orgId, user_id: (org.email && userByEmail.get(org.email)) || ownerUserId,
          connection_id: (org.email && connByEmail.get(org.email)) || null,
          provider: "teams", source: "app", external_event_id: `tx:${t.id}`,
          online_meeting_id: t.meetingId, transcript_id: t.id, organizer_aad_id: org.id, organizer_email: org.email,
          end_at: t.endDateTime ?? null, first_check_after: new Date(now).toISOString(),
        }, { onConflict: "org_id,provider,external_event_id", ignoreDuplicates: true });
        if (!error) found++;
      }
      await db.from("teams_transcript_cursors").upsert({
        org_id: orgId, organizer_aad_id: org.id, organizer_email: org.email,
        delta_link: res.resumeUrl ?? url, last_synced_at: new Date().toISOString(), last_error: null, updated_at: new Date().toISOString(),
      }, { onConflict: "org_id,organizer_aad_id" });
    } catch (e) {
      const kind = e instanceof GraphCallError ? e.kind : "other";
      await db.from("teams_transcript_cursors").upsert({
        org_id: orgId, organizer_aad_id: org.id, organizer_email: org.email,
        last_error: (e as Error).message.slice(0, 300), updated_at: new Date().toISOString(),
      }, { onConflict: "org_id,organizer_aad_id" });
      // A missing access policy can be per-user (policy granted per user), so keep going; any other
      // tenant-level block shows up on every organizer, so stop at the first one.
      if (kind === "no_access_policy") policyMisses++;
      else if (TENANT_BLOCKING.has(kind as GraphErrorKind)) throw new TenantBlockedError(kind, "transcript discovery");
    }
  }
  // Every organizer refused: the policy isn't granted tenant-wide (or at all).
  if (batch.length > 0 && policyMisses === batch.length) throw new TenantBlockedError("no_access_policy", "transcript discovery");
  return found;
}

async function processApp(db: Db, token: string, sess: Session): Promise<string> {
  const organizerId = sess.organizer_aad_id as string;
  const meetingId = sess.online_meeting_id as string;
  const details = await getMeetingDetails(token, organizerId, meetingId);
  const attendees = mergeAttendees(await getAttendance(token, organizerId, meetingId), details.invitees);
  const { text, attributed } = await fetchTranscriptText(token, organizerId, meetingId, sess.transcript_id as string);
  const title = details.subject || "Meeting";
  const startAt = details.startDateTime ?? null;
  const endAt = details.endDateTime ?? (sess.end_at as string | null) ?? null;
  if (!text.trim()) {
    await db.from("meeting_sessions").update({ status: "no_artifacts", title, start_at: startAt, end_at: endAt, attendees, processing_error: "empty transcript" }).eq("id", sess.id);
    return "empty";
  }
  const rec: MeetingRecord = {
    provider: "teams", externalId: sess.external_event_id as string, title, startedAt: startAt, endedAt: endAt,
    attendees, organizerEmail: details.organizerEmail ?? (sess.organizer_email as string | null) ?? null, transcript: text, recordingUrl: null,
  };
  const filed = await digestAndFile(db, sess, rec);
  if (filed.meetingTranscriptionId) {
    await db.from("meeting_transcriptions").update({ transcript_source: "provider" }).eq("id", filed.meetingTranscriptionId);
  }
  await db.from("meeting_sessions").update({
    status: "completed", title, start_at: startAt, end_at: endAt, attendees,
    meeting_transcription_id: filed.meetingTranscriptionId, last_checked_at: new Date().toISOString(),
    processing_error: attributed ? null : "speaker names unavailable (Teams speaker attribution is off)",
  }).eq("id", sess.id);
  return filedSummary(filed);
}

// ── delegated mode ───────────────────────────────────────────────────────────────────────────

async function processDelegated(db: Db, sess: Session, now: number): Promise<string> {
  const id = sess.id as string;
  const token = await sessionToken(db, sess);
  const om = await findOnlineMeeting(token, sess.join_url as string);
  // A recurring series shares one onlineMeeting: take the transcript made during THIS occurrence.
  const transcript = om ? pickTranscriptForWindow(await listTranscripts(token, om.id), sess.start_at as string, sess.end_at as string) : null;
  const giveUp = now - Date.parse(sess.end_at as string) > DETECT_WINDOW_MS;

  if (!om || !transcript) {
    const retry = (sess.retry_count as number ?? 0) + 1;
    // No Teams transcript, but maybe a recording: file it as recording-only once we have
    // waited long enough for a transcript to appear.
    if (giveUp || retry >= RECORDING_ONLY_AFTER_RETRIES) {
      const recording = await findOneDriveRecording(token, {
        title: (sess.title as string) || "",
        startAt: sess.start_at as string,
        endAt: sess.end_at as string,
      }).catch(() => null);
      if (recording) {
        const mtId = await fileRecordingOnly(db, sess, recording);
        await db.from("meeting_sessions").update({
          status: "completed", retry_count: retry, recording_url: recording.webUrl,
          meeting_transcription_id: mtId, last_checked_at: new Date().toISOString(),
          processing_error: "recording only — no Teams transcript (use Transcribe recording)",
        }).eq("id", id);
        return "recording_only";
      }
    }
    await db.from("meeting_sessions").update({
      status: giveUp ? "no_artifacts" : "detected", retry_count: retry,
      first_check_after: new Date(now + CHECK_DELAY_MS).toISOString(),
      processing_error: om ? "no transcript yet" : "online meeting not found (not organiser or not a Teams meeting)",
    }).eq("id", id);
    return giveUp ? "no_artifacts" : "waiting";
  }

  const text = vttToText(await fetchTranscriptVtt(token, om.id, transcript.id));
  if (!text.trim()) {
    await db.from("meeting_sessions").update({ status: "no_artifacts", processing_error: "empty transcript" }).eq("id", id);
    return "empty";
  }
  const attendees = Array.isArray(sess.attendees) ? (sess.attendees as unknown as { name?: string; email?: string }[]) : [];
  const rec: MeetingRecord = {
    provider: "teams", externalId: sess.external_event_id as string, title: (sess.title as string) || "Meeting",
    startedAt: sess.start_at as string, endedAt: sess.end_at as string, attendees,
    organizerEmail: (sess.organizer_email as string) ?? null, transcript: text,
    recordingUrl: await fetchRecordingUrl(token, om.id).catch(() => null),
  };
  const filed = await digestAndFile(db, sess, rec);
  // Teams AI recap (Copilot "AI insights") when the tenant has it and the permission is granted;
  // otherwise null and the OS digest above stands alone. Never blocks filing.
  if (filed.meetingTranscriptionId) {
    const insights = await fetchAiInsights(token, om.id).catch(() => null);
    await db.from("meeting_transcriptions").update({
      transcript_source: "provider",
      ...(insights ? { ai_notes: insights, ai_notes_source: "teams_ai_insights" } : {}),
    }).eq("id", filed.meetingTranscriptionId);
  }
  await db.from("meeting_sessions").update({
    status: "completed", transcript_id: transcript.id, recording_url: rec.recordingUrl ?? null,
    meeting_transcription_id: filed.meetingTranscriptionId, last_checked_at: new Date().toISOString(), processing_error: null,
  }).eq("id", id);
  return filedSummary(filed);
}

// ── run ──────────────────────────────────────────────────────────────────────────────────────

Deno.serve(async (req: Request) => {
  if (!isCronRequest(req)) return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 });
  const db = serviceClient();
  const started = Date.now();
  const now = started;
  const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { "Content-Type": "application/json" } });
  try {
    // 0. Reset sessions a previous run left in `processing` (it timed out mid-digest).
    await db.from("meeting_sessions").update({ status: "detected", processing_error: "reset: previous run did not finish" })
      .eq("provider", "teams").eq("status", "processing").lt("last_checked_at", new Date(now - STUCK_AFTER_MS).toISOString());

    // 1. Discover.
    const appCfg = msAppConfig(denoEnv);
    let appToken: string | null = null;
    let mode = "delegated", discovered: number | null = null;
    if (appCfg) {
      mode = "app";
      const target = await appTarget(db);
      if (!target) return json({ success: false, error: "app mode needs OWNER_USER_ID (and its org) to file meetings under" }, 500);
      try {
        appToken = await getAppToken(appCfg);
        discovered = await discoverApp(db, appToken, target.orgId, target.ownerUserId, now);
      } catch (e) {
        // Token refused (bad secret / no consent), a tenant-wide block, or listing users denied.
        const kind = e instanceof TenantBlockedError ? e.kind
          : e instanceof MsTokenError ? "forbidden"
          : e instanceof GraphCallError && TENANT_BLOCKING.has(e.kind) ? e.kind
          : null;
        if (kind) {
          await alertTenantBlock(db, target.orgId, kind);
          return json({ success: false, mode, blocked: kind, error: (e as Error).message });
        }
        throw e;
      }
    } else {
      await discoverDelegated(db, now);
    }

    // 2. Process a batch of due sessions, inside the time budget.
    const { data: due } = await db.from("meeting_sessions").select("*")
      .eq("provider", "teams").eq("status", "detected").eq("source", mode)
      .lte("first_check_after", new Date(now).toISOString()).order("first_check_after", { ascending: true }).limit(MAX_PER_RUN);

    const results: Record<string, string> = {};
    for (const sess of (due ?? []) as Session[]) {
      if (Date.now() - started > TIME_BUDGET_MS) break;
      const id = sess.id as string;
      try {
        await db.from("meeting_sessions").update({ status: "processing", last_checked_at: new Date().toISOString() }).eq("id", id);
        results[id] = mode === "app" ? await processApp(db, appToken!, sess) : await processDelegated(db, sess, now);
      } catch (e) {
        const kind = e instanceof GraphCallError ? e.kind : null;
        const retry = (sess.retry_count as number ?? 0) + 1;
        const failed = retry >= MAX_RETRIES;
        await db.from("meeting_sessions").update({
          status: failed ? "failed" : "detected", retry_count: retry,
          first_check_after: new Date(now + CHECK_DELAY_MS).toISOString(),
          processing_error: (e as Error).message.slice(0, 300),
        }).eq("id", id);
        results[id] = `${failed ? "failed" : "error"}: ${(e as Error).message.slice(0, 120)}`;
        if (kind && TENANT_BLOCKING.has(kind)) {
          await alertTenantBlock(db, sess.org_id as string, kind);
          break; // every other session would hit the same wall
        }
      }
    }
    return json({ success: true, mode, discovered, processed: Object.keys(results).length, results });
  } catch (e) {
    console.error("[teams-meeting-processor]", e);
    return json({ success: false, error: (e as Error).message }, 500);
  }
});
