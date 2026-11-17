/**
 * File a digested meeting into the OS: transcription row, contact links + notes, action items as
 * contact tasks, FRIDAY items onto the agent_requests handoff queue, client recap drafts (into
 * Clara's owner-approval queue, see meeting-followups.ts), and an SMS digest to the owner. Same downstream tables the Google pipeline wrote; provider-neutral.
 */
import type { SupabaseClient } from "npm:@supabase/supabase-js@2";
import type { Env } from "./phones.ts";
import { type DigestItem, type MeetingDigest, type MeetingRecord, buildOwnerDigestText } from "./meeting-digest.ts";
import { notifyOwner } from "./notify.ts";
import { notifyDeps, claraNumberFor, draftMeetingFollowUp, fridayUserId } from "./runtime.ts";
import { queueMeetingFollowUps } from "./meeting-followups.ts";
import { pushMeetingItemsToMotion } from "../motion.ts";

interface MatchedContact { id: string; email: string; first_name: string | null; phone: string | null }

export interface FileResult {
  meetingTranscriptionId: string | null;
  contactsLinked: number;
  tasksCreated: number;
  fridayHandoffs: number;
  /** Recap drafts newly filed to Clara's owner-approval queue. */
  followUpDrafts: number;
  /** The owner's action items newly created as Motion tasks (0 when Motion isn't connected). */
  motionTasks: number;
}

const priorityOf = (it: DigestItem): "low" | "medium" | "high" => (it.costsMoney ? "high" : "medium");

export async function fileMeeting(
  db: SupabaseClient,
  env: Env,
  orgId: string,
  rec: MeetingRecord,
  digest: MeetingDigest,
  opts: { importedBy: string; claraUserId: string | null; ownerUserId: string | null; consent?: { basis: string; note: string | null } },
): Promise<FileResult> {
  const durationMinutes = rec.startedAt && rec.endedAt
    ? Math.max(1, Math.round((Date.parse(rec.endedAt) - Date.parse(rec.startedAt)) / 60000))
    : null;

  // 1. transcription row (idempotent on org + source + external id) and its consent statement, in one database
  // statement (see upsert_meeting_transcription): the transcript and the consent that applies to it are decided
  // together under the row lock, so concurrent imports under one key cannot mix them, and a failure leaves the
  // previous transcript and statement untouched. Automated Teams / Google imports pass no consent: an existing
  // statement is kept while the transcript is unchanged.
  const now = new Date().toISOString();
  const row: Record<string, unknown> = {
    org_id: orgId,
    meeting_source: rec.provider,
    external_meeting_id: rec.externalId,
    meeting_title: rec.title,
    meeting_date: rec.startedAt ?? now,
    duration_minutes: durationMinutes,
    participants: rec.attendees,
    transcript_text: rec.transcript,
    summary: digest.summary,
    key_points: digest.decisions,
    action_items: digest.items,
    recording_url: rec.recordingUrl ?? null,
    processed_at: now,
    imported_by: opts.importedBy,
    updated_at: now,
    ...(opts.consent
      ? {
        consent_basis: opts.consent.basis,
        consent_note: opts.consent.note,
        consent_confirmed_at: now,
        consent_confirmed_by: opts.importedBy,
      }
      : {}),
  };
  const { data: newId, error: tErr } = await db.rpc("upsert_meeting_transcription", { p_row: row });
  if (tErr) {
    // Keep the raw database detail server-side; the handler returns this message to the client.
    console.error("[meeting-file] upsert_meeting_transcription failed:", tErr.message);
    throw new Error("could not save the meeting");
  }
  const meetingTranscriptionId = (newId as string | null) ?? null;

  // 2. match attendees + organizer to contacts.
  const emails = Array.from(new Set(
    [...rec.attendees.map((a) => a.email), rec.organizerEmail].map((e) => e?.toLowerCase()).filter(Boolean) as string[],
  ));
  let matched: MatchedContact[] = [];
  if (emails.length) {
    const { data } = await db.from("contacts").select("id, email, first_name, phone")
      .eq("organization_id", orgId).in("email", emails);
    matched = ((data ?? []) as MatchedContact[]).filter((c) => c.email);
  }

  if (meetingTranscriptionId && matched.length) {
    for (const c of matched) {
      await db.from("meeting_transcription_contacts").upsert(
        { org_id: orgId, meeting_transcription_id: meetingTranscriptionId, contact_id: c.id, participant_email: c.email },
        { onConflict: "meeting_transcription_id,contact_id" },
      );
    }
    await db.from("meeting_transcriptions").update({ contact_id: matched[0].id }).eq("id", meetingTranscriptionId).is("contact_id", null);
    // 3. a note on each matched contact.
    for (const c of matched) {
      const noteBody = `${digest.summary}\n\nDecisions:\n${digest.decisions.map((d) => `- ${d}`).join("\n") || "- none"}`;
      await db.from("contact_notes").upsert({
        contact_id: c.id, user_id: opts.importedBy, title: `Meeting — ${rec.title}`, content: noteBody,
        source_type: rec.provider, source_id: rec.externalId,
        metadata: { meeting_transcription_id: meetingTranscriptionId, recording_url: rec.recordingUrl ?? null, organizer_email: rec.organizerEmail, attendees: rec.attendees, duration_minutes: durationMinutes },
        updated_at: new Date().toISOString(),
      }, { onConflict: "contact_id,source_type,source_id" });
    }
  }

  // 4/5. route items.
  const primaryContact = matched[0] ?? null;
  const friday = await fridayUserId(db, env, orgId);
  let tasksCreated = 0, fridayHandoffs = 0;
  for (const it of digest.items) {
    if (it.owner === "friday") {
      if (friday && opts.claraUserId) {
        const body = `${it.item}${it.why ? `\n\nContext: ${it.why}` : ""}${it.client ? `\nClient: ${it.client}` : ""}${it.project ? `\nProject: ${it.project}` : ""}${it.costsMoney ? "\nFlag: likely costs money — apply your spend gate." : ""}`;
        const { error } = await db.from("agent_requests").insert({
          org_id: orgId, from_user_id: opts.claraUserId, to_user_id: friday, kind: "task",
          title: it.item.slice(0, 160), body,
          source: { kind: "meeting", meeting_transcription_id: meetingTranscriptionId, requested_by: "owner", client: it.client ?? null },
        });
        if (!error) fridayHandoffs++;
      }
      continue;
    }
    // owner/clara items: a contact task when we know the client, else only the owner digest carries it.
    const assignee = it.owner === "clara" ? opts.claraUserId : opts.ownerUserId;
    if (primaryContact && meetingTranscriptionId) {
      const title = it.item.length > 100 ? `${it.item.slice(0, 97)}...` : it.item;
      const { data: task } = await db.from("contact_tasks").insert({
        contact_id: primaryContact.id, created_by_user_id: opts.importedBy, assigned_to_user_id: assignee ?? opts.importedBy,
        title, description: `${it.item}${it.why ? `\n\n${it.why}` : ""}\n\n[Source: meeting — ${rec.title}]`,
        due_date: it.due ?? null, priority: priorityOf(it), status: "pending", source_meeting_id: meetingTranscriptionId,
      }).select("id").maybeSingle();
      const taskId = (task as { id: string } | null)?.id ?? null;
      await db.from("meeting_action_items").upsert({
        org_id: orgId, meeting_transcription_id: meetingTranscriptionId, contact_id: primaryContact.id, contact_task_id: taskId,
        description: it.item, assignee_name: it.owner, assignee_user_id: assignee ?? null, due_date: it.due ?? null,
        priority: priorityOf(it), status: taskId ? "task_created" : "pending", source: "transcript_ai", raw_text: it.why ?? it.item,
      }, { onConflict: "meeting_transcription_id,contact_id,description" });
      if (taskId) tasksCreated++;
    }
  }

  // 6. client recap drafts (external matched contacts) → Clara's owner-approval queue; sent by
  //    clara-approved-sends only after approval, after send_after and outside quiet hours.
  let followUpDrafts = 0;
  if (meetingTranscriptionId && matched.length) {
    const r = await queueMeetingFollowUps(db, {
      orgId,
      meeting: {
        meetingTranscriptionId, title: rec.title, startedAt: rec.startedAt ?? null, endedAt: rec.endedAt ?? null,
        summary: digest.summary || null, keyPoints: digest.decisions,
        // FRIDAY's internal engineering items aren't the client's business; owner/clara commitments are.
        actionItems: digest.items.filter((i) => i.owner !== "friday").map((i) => ({ description: i.item, due_date: i.due ?? null })),
        injectionFlagged: digest.injectionFlagged === true,
      },
      contacts: matched,
      draft: (i) => draftMeetingFollowUp(env, i, { orgId }),
    }).catch((e) => { console.warn("[meeting-file] follow-up drafts failed:", (e as Error).message); return null; });
    followUpDrafts = r?.drafted ?? 0;
  }

  // 6b. the owner's own items → Motion (if connected). Best effort and idempotent; agent items stay in the OS.
  let motionTasks = 0;
  if (meetingTranscriptionId) {
    const r = await pushMeetingItemsToMotion(db, orgId, { transcriptionId: meetingTranscriptionId, title: rec.title },
      digest.items.filter((i) => i.owner === "owner")).catch((e) => {
      console.warn("[meeting-file] motion push failed:", (e as Error).message);
      return null;
    });
    motionTasks = r?.pushed ?? 0;
    if (r?.error) console.warn("[meeting-file] motion:", r.error);
  }

  // 7. owner SMS digest.
  const fromNumber = await claraNumberFor(db, env, orgId);
  await notifyOwner(db, {
    kind: "meeting.digest", priority: "normal", category: "production",
    text: buildOwnerDigestText(rec.title, digest), dedupeKey: `meeting-digest:${rec.provider}:${rec.externalId}`,
  }, notifyDeps(db, env, orgId, fromNumber)).catch((e) => console.warn("[meeting-file] owner notify failed:", (e as Error).message));

  return { meetingTranscriptionId, contactsLinked: matched.length, tasksCreated, fridayHandoffs, followUpDrafts, motionTasks };
}
