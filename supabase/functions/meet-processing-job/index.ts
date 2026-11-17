import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";
import { getCalendarAccessToken } from "../_shared/google-calendar-connections.ts";
import { extractUserContext, isCronRequest, isServiceRoleRequest } from "../_shared/auth.ts";
import {
  findMeetRecordingInDrive,
  findMeetTranscriptInDrive,
  findGeminiNotesInDrive,
  findGeminiNotesInAttachments,
  exportGoogleDoc,
  parseGeminiNotesForActionItems,
  parseGeminiNotesForKeyPoints,
  type EnrichedActionItem,
} from "../_shared/google-drive-helpers.ts";
import {
  getMeetArtifacts,
  buildTranscriptFromEntries,
  MeetScopeError,
} from "../_shared/google-meet-api.ts";
import { type FollowUpContact, queueMeetingFollowUps } from "../_shared/clara/meeting-followups.ts";
import { draftMeetingFollowUp } from "../_shared/clara/runtime.ts";
import { detectPromptInjection } from "../_shared/clara/injection.ts";
import { denoEnv } from "../_shared/clara/webhook.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};

const MAX_SESSIONS_PER_RUN = 10;
const MAX_RETRIES = 5;
const NO_ARTIFACTS_CUTOFF_HOURS = 48;
/**
 * Only process meetings within this window. Bounds the backfill of previously
 * undetected-but-unprocessed sessions; older ones are left alone (their Meet
 * artifacts have usually aged out of Google's retention anyway).
 */
const BACKFILL_WINDOW_DAYS = 90;

function getSupabaseClient() {
  return createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    { auth: { autoRefreshToken: false, persistSession: false } }
  );
}

type Supabase = ReturnType<typeof getSupabaseClient>;

interface MeetSession {
  id: string;
  org_id: string;
  user_id: string;
  connection_id: string;
  google_event_id: string;
  meet_conference_id: string | null;
  calendar_event_summary: string | null;
  event_start_time: string | null;
  event_end_time: string | null;
  organizer_email: string | null;
  attendees: { email?: string; displayName?: string; responseStatus?: string }[];
  meet_link: string | null;
  html_link: string | null;
  status: string;
  retry_count: number;
}

/**
 * Token for the calendar connection (= Google account) the session belongs to. A refresh acts on THAT account only; there is
 * deliberately no "fallback to any refresh token of the user" (that could read another account's calendar and Drive).
 */
async function getValidAccessToken(
  supabase: Supabase,
  session: MeetSession
): Promise<string> {
  const { data: connection } = await supabase
    .from("google_calendar_connections")
    .select("*")
    .eq("id", session.connection_id)
    .maybeSingle();

  if (!connection) throw new Error("Calendar connection not found");
  return await getCalendarAccessToken(supabase, connection);
}

async function processSession(supabase: Supabase, session: MeetSession, artifactsOnly = false): Promise<void> {
  await supabase
    .from("google_meet_sessions")
    .update({ status: "processing", updated_at: new Date().toISOString() })
    .eq("id", session.id);

  const accessToken = await getValidAccessToken(supabase, session);
  const eventTitle = session.calendar_event_summary || "Meeting";
  const meetingDate = session.event_start_time || new Date().toISOString();

  let recordingFileId: string | null = null;
  let recordingUrl: string | null = null;
  let transcriptFileId: string | null = null;
  let transcriptUrl: string | null = null;
  let transcriptContent: string | null = null;
  let geminiNotesFileId: string | null = null;
  let geminiNotesUrl: string | null = null;
  let geminiNotesContent: string | null = null;

  // ── Preferred path: the Meet REST API knows exactly which Drive/Docs files
  // belong to this conference, so we don't have to guess filenames. Falls back
  // to the legacy Drive search when the scope is missing or nothing is found.
  let usedMeetApi = false;
  if (session.meet_conference_id) {
    try {
      const artifacts = await getMeetArtifacts(
        accessToken,
        session.meet_conference_id,
        session.event_start_time,
      );
      if (artifacts.recording?.fileId) {
        recordingFileId = artifacts.recording.fileId;
        recordingUrl =
          artifacts.recording.url ||
          `https://drive.google.com/file/d/${artifacts.recording.fileId}/view`;
        usedMeetApi = true;
      }
      if (artifacts.transcript?.documentId) {
        transcriptFileId = artifacts.transcript.documentId;
        transcriptUrl =
          artifacts.transcript.url ||
          `https://docs.google.com/document/d/${artifacts.transcript.documentId}/edit`;
        try {
          transcriptContent = await exportGoogleDoc(accessToken, artifacts.transcript.documentId);
        } catch (e) {
          console.warn("[MeetProcessor] Meet transcript export failed:", (e as Error).message);
        }
        usedMeetApi = true;
      } else if (artifacts.conferenceRecord) {
        // No transcript doc, but structured entries may still exist.
        try {
          transcriptContent = await buildTranscriptFromEntries(
            accessToken,
            `${artifacts.conferenceRecord}/transcripts`,
          );
        } catch { /* best effort */ }
      }
    } catch (e) {
      if (e instanceof MeetScopeError) {
        console.warn(
          `[MeetProcessor] Session ${session.id}: Meet scope missing for user ${session.user_id}; falling back to Drive search.`,
        );
      } else if (/-> 401\b/.test((e as Error).message)) {
        // A rejected token isn't "no recording": fail the run (retried, error recorded) instead of
        // quietly settling the session as no_artifacts.
        throw new Error(`Google rejected the access token for session ${session.id}: ${(e as Error).message.slice(0, 160)}`);
      } else {
        console.warn("[MeetProcessor] Meet API lookup failed:", (e as Error).message);
      }
    }
  }

  if (!recordingFileId) {
    const recording = await findMeetRecordingInDrive(
      accessToken, eventTitle, session.meet_conference_id, meetingDate
    );
    if (recording) {
      recordingFileId = recording.id;
      recordingUrl = recording.webViewLink || null;
    }
  }

  if (!transcriptFileId) {
    const transcript = await findMeetTranscriptInDrive(accessToken, eventTitle, meetingDate);
    if (transcript) {
      transcriptFileId = transcript.id;
      transcriptUrl = transcript.webViewLink || null;
      try {
        transcriptContent = await exportGoogleDoc(accessToken, transcript.id);
      } catch (e) {
        console.warn("[MeetProcessor] Transcript export failed:", (e as Error).message);
      }
    }
  }
  void usedMeetApi;

  const { data: calendarEvent } = await supabase
    .from("google_calendar_events")
    .select("attachments")
    .eq("google_event_id", session.google_event_id)
    .eq("user_id", session.user_id)
    .eq("connection_id", session.connection_id)
    .limit(1)
    .maybeSingle();
  const geminiNotes =
    (await findGeminiNotesInAttachments(accessToken, calendarEvent?.attachments, meetingDate)) ??
    (await findGeminiNotesInDrive(accessToken, eventTitle, meetingDate));
  if (geminiNotes) {
    geminiNotesFileId = geminiNotes.id;
    geminiNotesUrl = geminiNotes.webViewLink || null;
    try {
      geminiNotesContent = await exportGoogleDoc(accessToken, geminiNotes.id);
    } catch (e) {
      console.warn("[MeetProcessor] Gemini notes export failed:", (e as Error).message);
    }
  }

  const hasAnyArtifact = !!(
    recordingFileId || transcriptFileId || transcriptContent || geminiNotesFileId
  );

  if (!hasAnyArtifact) {
    const endTime = session.event_end_time ? new Date(session.event_end_time) : new Date();
    const hoursSinceEnd = (Date.now() - endTime.getTime()) / (1000 * 60 * 60);

    if (hoursSinceEnd > NO_ARTIFACTS_CUTOFF_HOURS) {
      await supabase
        .from("google_meet_sessions")
        .update({
          status: "no_artifacts",
          processed: true,
          last_processed_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        })
        .eq("id", session.id);
      return;
    }

    // Retry, but don't loop forever: the cron only picks up rows with
    // retry_count < MAX_RETRIES, so incrementing past that without a terminal status
    // left sessions stranded in 'detected' indefinitely. Once the retries are spent,
    // settle on no_artifacts — the meeting simply was never recorded.
    const nextRetry = session.retry_count + 1;
    await supabase
      .from("google_meet_sessions")
      .update({
        status: nextRetry >= MAX_RETRIES ? "no_artifacts" : "detected",
        processed: nextRetry >= MAX_RETRIES,
        retry_count: nextRetry,
        last_processed_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq("id", session.id);
    return;
  }

  let summary: string | null = null;
  let keyPoints: string[] = [];
  let actionItems: EnrichedActionItem[] = [];

  if (geminiNotesContent) {
    summary = geminiNotesContent.substring(0, 2000);
    keyPoints = parseGeminiNotesForKeyPoints(geminiNotesContent);
    actionItems = parseGeminiNotesForActionItems(geminiNotesContent, meetingDate);
  }

  const durationMinutes = session.event_start_time && session.event_end_time
    ? Math.round((new Date(session.event_end_time).getTime() - new Date(session.event_start_time).getTime()) / 60000)
    : null;

  const participants = (session.attendees || [])
    .filter((a: { email?: string }) => a.email)
    .map((a: { email?: string; displayName?: string }) => ({
      name: a.displayName || a.email || "",
      email: a.email || "",
    }));

  const { data: existingTranscription } = await supabase
    .from("meeting_transcriptions")
    .select("id")
    .eq("org_id", session.org_id)
    .eq("meeting_source", "google_meet")
    .eq("external_meeting_id", session.google_event_id)
    .maybeSingle();

  let meetingTranscriptionId: string | null = null;

  if (existingTranscription) {
    meetingTranscriptionId = existingTranscription.id;
    await supabase
      .from("meeting_transcriptions")
      .update({
        meeting_title: eventTitle,
        meeting_date: meetingDate,
        duration_minutes: durationMinutes,
        participants,
        transcript_text: transcriptContent || "",
        summary,
        key_points: keyPoints,
        action_items: actionItems,
        recording_url: recordingUrl,
        recording_file_id: recordingFileId,
        processed_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq("id", existingTranscription.id);
  } else {
    const { data: newTranscription } = await supabase
      .from("meeting_transcriptions")
      .insert({
        org_id: session.org_id,
        meeting_source: "google_meet",
        external_meeting_id: session.google_event_id,
        meeting_title: eventTitle,
        meeting_date: meetingDate,
        duration_minutes: durationMinutes,
        participants,
        transcript_text: transcriptContent || "",
        summary,
        key_points: keyPoints,
        action_items: actionItems,
        recording_url: recordingUrl,
        recording_file_id: recordingFileId,
        imported_by: session.user_id,
        processed_at: new Date().toISOString(),
      })
      .select("id")
      .maybeSingle();

    if (newTranscription) {
      meetingTranscriptionId = newTranscription.id;
    }
  }

  const attendeeEmails = (session.attendees || [])
    .map((a: { email?: string }) => a.email?.toLowerCase())
    .filter(Boolean) as string[];

  if (session.organizer_email) {
    const orgEmail = session.organizer_email.toLowerCase();
    if (!attendeeEmails.includes(orgEmail)) {
      attendeeEmails.push(orgEmail);
    }
  }

  // The org's own people aren't the client: a contact record for a team member's address otherwise
  // became the meeting's primary contact and collected every action item as a task.
  const { data: orgUsers } = await supabase
    .from("users")
    .select("email")
    .eq("organization_id", session.org_id);
  const teamEmails = new Set((orgUsers || []).map((u: { email: string | null }) => u.email?.toLowerCase()));
  const clientEmails = attendeeEmails.filter((e) => !teamEmails.has(e));

  let matchedContacts: (FollowUpContact & { email: string })[] = [];

  if (clientEmails.length > 0) {
    const { data: contacts } = await supabase
      .from("contacts")
      .select("id, email, first_name, last_name, phone")
      .eq("organization_id", session.org_id)
      .in("email", clientEmails);

    matchedContacts = ((contacts || []) as (FollowUpContact & { email: string })[]).filter((c) => c.email);
  }

  if (meetingTranscriptionId && matchedContacts.length > 0) {
    for (const contact of matchedContacts) {
      await supabase
        .from("meeting_transcription_contacts")
        .upsert(
          {
            org_id: session.org_id,
            meeting_transcription_id: meetingTranscriptionId,
            contact_id: contact.id,
            participant_email: contact.email,
          },
          { onConflict: "meeting_transcription_id,contact_id" }
        );
    }

    // Also stamp the "primary" contact. getMeetingTranscriptionsByContact()
    // unions meeting_transcriptions.contact_id with the join table, and this
    // side was never populated — leaving half the lookup dead.
    const primaryContactId = matchedContacts[0].id;
    await supabase
      .from("meeting_transcriptions")
      .update({ contact_id: primaryContactId })
      .eq("id", meetingTranscriptionId)
      .is("contact_id", null);
  }

  if (matchedContacts.length > 0) {
    await upsertContactNotes(supabase, session, matchedContacts, {
      recordingUrl,
      transcriptUrl,
      geminiNotesContent,
      geminiNotesUrl,
      recordingFileId,
      transcriptFileId,
      geminiNotesFileId,
      meetingTranscriptionId,
      durationMinutes,
    });
  }

  if (!artifactsOnly && matchedContacts.length > 0 && actionItems.length > 0 && meetingTranscriptionId) {
    await createContactTasks(supabase, session, matchedContacts, actionItems, meetingTranscriptionId);
  }

  // Client recap drafts → Clara's owner-approval queue (the same path Teams and imported meetings
  // use). Never fails the session: the meeting is filed whether or not a recap could be drafted.
  if (!artifactsOnly && matchedContacts.length > 0 && meetingTranscriptionId) {
    const meetingId = meetingTranscriptionId;
    await queueMeetingFollowUps(supabase, {
      orgId: session.org_id,
      meeting: {
        meetingTranscriptionId: meetingId, title: eventTitle, startedAt: session.event_start_time, endedAt: session.event_end_time,
        summary, keyPoints, actionItems: actionItems.map((a) => ({ description: a.description, assignee: a.assignee ?? null, due_date: a.due_date ?? null })),
        // Gemini notes are third-party text: a tripped detector means the plain template, no model.
        injectionFlagged: detectPromptInjection([summary ?? "", ...keyPoints, ...actionItems.map((a) => a.description)].join("\n"), denoEnv).triggered,
      },
      contacts: matchedContacts,
      draft: (i) => draftMeetingFollowUp(denoEnv, i, { orgId: session.org_id }),
    }).catch((e) => console.warn(`[meet-processing-job] follow-up drafts failed for ${meetingId}:`, (e as Error).message));
  }

  if (!artifactsOnly && meetingTranscriptionId) {
    await publishMeetingProcessedEvent(supabase, session, meetingTranscriptionId, matchedContacts, actionItems, {
      // Use the outer accumulators, not the Drive-fallback locals: those are
      // block-scoped (ReferenceError here) and miss artifacts found via the Meet API.
      hasRecording: !!recordingFileId,
      hasTranscript: !!(transcriptFileId || transcriptContent),
      hasGeminiNotes: !!(geminiNotesFileId || geminiNotesContent),
      durationMinutes,
    });
  }

  await supabase
    .from("google_meet_sessions")
    .update({
      recording_file_id: recordingFileId,
      recording_url: recordingUrl,
      transcript_file_id: transcriptFileId,
      transcript_url: transcriptUrl,
      transcript_content: transcriptContent,
      gemini_notes_file_id: geminiNotesFileId,
      gemini_notes_url: geminiNotesUrl,
      gemini_notes_content: geminiNotesContent,
      meeting_transcription_id: meetingTranscriptionId,
      status: "completed",
      processed: true,
      processing_error: null,
      last_processed_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq("id", session.id);
}

interface NoteArtifacts {
  recordingUrl: string | null;
  transcriptUrl: string | null;
  geminiNotesContent: string | null;
  geminiNotesUrl: string | null;
  recordingFileId: string | null;
  transcriptFileId: string | null;
  geminiNotesFileId: string | null;
  meetingTranscriptionId: string | null;
  durationMinutes: number | null;
}

async function upsertContactNotes(
  supabase: Supabase,
  session: MeetSession,
  contacts: { id: string; email: string }[],
  artifacts: NoteArtifacts
): Promise<void> {
  const eventTitle = session.calendar_event_summary || "Meeting";
  const noteTitle = `Google Meet -- ${eventTitle}`;

  const startFormatted = session.event_start_time
    ? new Date(session.event_start_time).toLocaleString("en-US", {
        dateStyle: "medium",
        timeStyle: "short",
      })
    : "Unknown";
  const endFormatted = session.event_end_time
    ? new Date(session.event_end_time).toLocaleString("en-US", { timeStyle: "short" })
    : "";

  const attendeeList = (session.attendees || [])
    .map((a: { displayName?: string; email?: string }) =>
      a.displayName ? `${a.displayName} (${a.email})` : a.email
    )
    .join(", ");

  let content = `Meeting: ${eventTitle}\n`;
  content += `Date: ${startFormatted}${endFormatted ? ` - ${endFormatted}` : ""}\n`;
  if (artifacts.durationMinutes) content += `Duration: ${artifacts.durationMinutes} minutes\n`;
  if (session.organizer_email) content += `Organizer: ${session.organizer_email}\n`;
  if (attendeeList) content += `Attendees: ${attendeeList}\n`;
  content += "\n";

  if (session.meet_link) content += `Meet Link: ${session.meet_link}\n`;
  if (artifacts.recordingUrl) content += `Recording: ${artifacts.recordingUrl}\n`;
  if (artifacts.transcriptUrl) content += `Transcript: ${artifacts.transcriptUrl}\n`;
  if (session.html_link) content += `Calendar Event: ${session.html_link}\n`;
  content += "\n";

  if (artifacts.geminiNotesContent) {
    content += `--- Gemini Meeting Notes ---\n${artifacts.geminiNotesContent}\n`;
  }

  const metadata = {
    google_event_id: session.google_event_id,
    meet_conference_id: session.meet_conference_id,
    drive_file_ids: {
      recording: artifacts.recordingFileId,
      transcript: artifacts.transcriptFileId,
      gemini_notes: artifacts.geminiNotesFileId,
    },
    drive_urls: {
      recording: artifacts.recordingUrl,
      transcript: artifacts.transcriptUrl,
      gemini_notes: artifacts.geminiNotesUrl,
    },
    meeting_transcription_id: artifacts.meetingTranscriptionId,
    calendar_html_link: session.html_link,
    meet_link: session.meet_link,
    organizer_email: session.organizer_email,
    attendees: session.attendees,
    duration_minutes: artifacts.durationMinutes,
  };

  for (const contact of contacts) {
    const { data: existing } = await supabase
      .from("contact_notes")
      .select("id")
      .eq("contact_id", contact.id)
      .eq("source_type", "google_meet")
      .eq("source_id", session.google_event_id)
      .maybeSingle();

    if (existing) {
      await supabase
        .from("contact_notes")
        .update({
          title: noteTitle,
          content,
          metadata,
          updated_at: new Date().toISOString(),
        })
        .eq("id", existing.id);
    } else {
      const { data: newNote } = await supabase
        .from("contact_notes")
        .insert({
          contact_id: contact.id,
          user_id: session.user_id,
          title: noteTitle,
          content,
          source_type: "google_meet",
          source_id: session.google_event_id,
          metadata,
        })
        .select("id")
        .maybeSingle();

      if (newNote) {
        await supabase.from("contact_timeline").insert({
          contact_id: contact.id,
          user_id: session.user_id,
          event_type: "note_added",
          event_data: {
            note_id: newNote.id,
            preview: noteTitle,
            source: "google_meet",
          },
        });
      }
    }
  }
}

async function createContactTasks(
  supabase: Supabase,
  session: MeetSession,
  contacts: { id: string; email: string }[],
  actionItems: EnrichedActionItem[],
  meetingTranscriptionId: string
): Promise<void> {
  const eventTitle = session.calendar_event_summary || "Meeting";

  const { data: orgUsers } = await supabase
    .from("users")
    .select("id, name, email")
    .eq("organization_id", session.org_id);

  const userMap = new Map<string, string>();
  for (const u of orgUsers || []) {
    if (u.email) userMap.set(u.email.toLowerCase(), u.id);
    if (u.name) userMap.set(u.name.toLowerCase(), u.id);
  }

  for (const contact of contacts) {
    for (const item of actionItems) {
      const { data: existingActionItem } = await supabase
        .from("meeting_action_items")
        .select("id, status, contact_task_id")
        .eq("meeting_transcription_id", meetingTranscriptionId)
        .eq("contact_id", contact.id)
        .eq("description", item.description)
        .maybeSingle();

      if (existingActionItem) continue;

      let assignedUserId: string | null = null;
      if (item.assignee) {
        assignedUserId = userMap.get(item.assignee.toLowerCase()) || null;
      }
      if (!assignedUserId) assignedUserId = session.user_id;

      const title = item.description.length > 100
        ? item.description.substring(0, 97) + "..."
        : item.description;

      const description = `${item.description}\n\n[Source: Google Meet -- ${eventTitle}]`;

      const { data: newTask } = await supabase
        .from("contact_tasks")
        .insert({
          contact_id: contact.id,
          created_by_user_id: session.user_id,
          assigned_to_user_id: assignedUserId,
          title,
          description,
          due_date: item.due_date || null,
          priority: item.priority,
          status: "pending",
          source_meeting_id: meetingTranscriptionId,
        })
        .select("id")
        .maybeSingle();

      const taskId = newTask?.id || null;

      await supabase.from("meeting_action_items").insert({
        org_id: session.org_id,
        meeting_transcription_id: meetingTranscriptionId,
        contact_id: contact.id,
        contact_task_id: taskId,
        description: item.description,
        assignee_name: item.assignee || null,
        assignee_user_id: assignedUserId,
        due_date: item.due_date || null,
        priority: item.priority,
        status: taskId ? "task_created" : "pending",
        source: "gemini_notes",
        raw_text: item.raw_text,
      });

      if (newTask) {
        await supabase.from("contact_timeline").insert({
          contact_id: contact.id,
          user_id: session.user_id,
          event_type: "task_created",
          event_data: {
            task_id: newTask.id,
            task_title: title,
            source: "google_meet",
            meeting_transcription_id: meetingTranscriptionId,
          },
        });
      }
    }
  }
}

async function publishMeetingProcessedEvent(
  supabase: Supabase,
  session: MeetSession,
  meetingTranscriptionId: string,
  contacts: { id: string; email: string }[],
  actionItems: EnrichedActionItem[],
  artifacts: {
    hasRecording: boolean;
    hasTranscript: boolean;
    hasGeminiNotes: boolean;
    durationMinutes: number | null;
  }
): Promise<void> {
  try {
    await supabase.from("event_outbox").insert({
      organization_id: session.org_id,
      event_type: "meeting_processed",
      payload: {
        meeting_transcription_id: meetingTranscriptionId,
        google_meet_session_id: session.id,
        google_event_id: session.google_event_id,
        contact_ids: contacts.map((c) => c.id),
        action_item_count: actionItems.length,
        has_recording: artifacts.hasRecording,
        has_transcript: artifacts.hasTranscript,
        has_gemini_notes: artifacts.hasGeminiNotes,
        meeting_title: session.calendar_event_summary || "Meeting",
        meeting_date: session.event_start_time || new Date().toISOString(),
        duration_minutes: artifacts.durationMinutes,
      },
    });
  } catch (err) {
    console.warn("[MeetProcessor] Failed to publish meeting_processed event:", (err as Error).message);
  }
}

Deno.serve(async (req: Request) => {
  try {
    if (req.method === "OPTIONS") {
      return new Response(null, { status: 200, headers: corsHeaders });
    }

    // verify_jwt=false, so authorize here: meet-processing-cron sends the service-role key and
    // pg_cron sends X-Cron-Secret; a signed-in user may only force one session of their own org
    // (the Meetings page "Reprocess" button and the MCP tool).
    const trusted = isCronRequest(req) || isServiceRoleRequest(req);
    const unauthorized = () => new Response(
      JSON.stringify({ error: "Unauthorized" }),
      { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );

    const supabase = getSupabaseClient();

    // A single session id can be forced through (manual "process now"),
    // bypassing the backfill window.
    let forcedSessionId: string | null = null;
    // artifacts_only: fetch + store transcripts/recordings/notes and link
    // contacts, but skip task creation and the meeting_processed event. Used by
    // manual/backfill reprocessing that must not spawn tasks or trigger
    // client-facing follow-ups.
    let artifactsOnly = false;
    try {
      const body = await req.json();
      forcedSessionId = (body?.session_id as string) ?? null;
      artifactsOnly = body?.artifacts_only === true;
    } catch { /* no body — normal cron invocation */ }

    if (!trusted) {
      const user = forcedSessionId ? await extractUserContext(req, supabase) : null;
      if (!user) return unauthorized();
      const { data: owned } = await supabase
        .from("google_meet_sessions")
        .select("id")
        .eq("id", forcedSessionId)
        .eq("org_id", user.orgId)
        .maybeSingle();
      if (!owned) return unauthorized();
    }

    const windowStart = new Date(
      Date.now() - BACKFILL_WINDOW_DAYS * 86_400_000,
    ).toISOString();

    let query = supabase
      .from("google_meet_sessions")
      .select("*")
      .eq("processed", false)
      .in("status", ["detected", "queued"])
      .lt("retry_count", MAX_RETRIES)
      .lte("first_check_after", new Date().toISOString());

    if (forcedSessionId) {
      query = query.eq("id", forcedSessionId);
    } else {
      query = query.gte("event_start_time", windowStart);
    }

    const { data: sessions, error: fetchError } = await query
      .order("event_start_time", { ascending: false })
      .limit(MAX_SESSIONS_PER_RUN);

    if (fetchError) {
      console.error("[MeetProcessor] Failed to fetch sessions:", fetchError);
      return new Response(
        JSON.stringify({ success: false, error: "Failed to fetch sessions" }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    if (!sessions || sessions.length === 0) {
      return new Response(
        JSON.stringify({ success: true, processed: 0, message: "No sessions to process" }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    let processed = 0;
    let failed = 0;

    for (const session of sessions) {
      try {
        await processSession(supabase, session as MeetSession, artifactsOnly);
        processed++;
      } catch (err) {
        const errMsg = (err as Error).message || String(err);
        console.error(`[MeetProcessor] Session ${session.id} failed:`, errMsg);

        const newRetryCount = (session.retry_count || 0) + 1;
        const newStatus = newRetryCount >= MAX_RETRIES ? "failed" : "queued";

        await supabase
          .from("google_meet_sessions")
          .update({
            status: newStatus,
            processing_error: errMsg,
            retry_count: newRetryCount,
            processed: newStatus === "failed",
            last_processed_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          })
          .eq("id", session.id);

        failed++;
      }
    }

    return new Response(
      JSON.stringify({ success: true, processed, failed, total: sessions.length }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (error) {
    console.error("[MeetProcessor] Unhandled error:", error);
    return new Response(
      JSON.stringify({ success: false, error: (error as Error).message }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
