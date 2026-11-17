/**
 * Call recordings: Twilio recording callback -> private Storage -> transcript -> conversation.
 *
 * Replaces CLARA's "download the .wav to the vault and leave a stub for local whisper". The audio
 * lands in the private `call-recordings` bucket at <org>/<CallSid>.mp3 (call_logs.recording_path);
 * readers get short-lived signed URLs, never a Twilio URL (those need our credentials). The
 * transcript is stored on the call_logs row and added to the caller's conversation next to the
 * call event. A transcription failure never loses the recording.
 */
import type { SupabaseClient } from "npm:@supabase/supabase-js@2";
import { findOrCreateConversation, insertMessage, resolveContactByPhone } from "./conversations.ts";
import { linkConversation } from "./call-state.ts";

/** Only Twilio's own recording host is ever fetched, so an attacker-supplied RecordingUrl can't aim our credentials elsewhere. */
export const ALLOWED_RECORDING_HOST = "api.twilio.com";

export function isAllowedRecordingUrl(raw: string): boolean {
  try {
    const u = new URL(raw);
    return u.protocol === "https:" && u.hostname.toLowerCase() === ALLOWED_RECORDING_HOST;
  } catch {
    return false;
  }
}

export const recordingPath = (orgId: string, callSid: string) => `${orgId}/${callSid}.mp3`;

export interface RecordingDeps {
  /** GET the recording bytes from Twilio with our credentials. */
  download: (url: string) => Promise<Uint8Array>;
  upload: (path: string, bytes: Uint8Array) => Promise<void>;
  transcribe: (bytes: Uint8Array, orgId: string) => Promise<{ text: string } | { error: string }>;
  sleep?: (ms: number) => Promise<void>;
}

export type RecordingResult =
  | { ok: true; path: string; transcript: "done" | "failed" | "skipped"; messageLogged: boolean }
  | { ok: false; reason: "not-completed" | "bad-host" | "unknown-call" | "download-failed" | "upload-failed" };


/**
 * Put a recorded call into its contact's voice conversation. Only a caller who already is a contact
 * (matched by phone) gets a thread: an unknown number is never turned into a contact, so its
 * recording stays on the call_logs row with no conversation. Hangups with no recording create nothing.
 */
export async function ensureCallConversation(
  db: SupabaseClient, callSid: string, opts: { sleepFor?: number; seconds?: number | null } = {},
): Promise<{ conversationId: string; contactId: string } | null> {
  const { data } = await db.from("call_logs")
    .select("organization_id, conversation_id, contact_id, from_number, to_number, direction, agent_user_id, created_at")
    .eq("twilio_call_sid", callSid).maybeSingle();
  const c = data as {
    organization_id: string; conversation_id: string | null; contact_id: string | null; from_number: string | null;
    to_number: string | null; direction: string | null; agent_user_id: string | null; created_at: string | null;
  } | null;
  if (!c) return null;
  if (c.conversation_id && c.contact_id) return { conversationId: c.conversation_id, contactId: c.contact_id };

  const caller = (c.direction === "outbound" ? c.to_number : c.from_number) ?? "";
  let contactId = c.contact_id;
  if (!contactId) {
    if (!caller) return null;
    const ref = await resolveContactByPhone(db, c.organization_id, caller);
    contactId = ref?.id ?? null;
  }
  if (!contactId) return null;
  const conv = await findOrCreateConversation(db, {
    orgId: c.organization_id, contactId, channel: "voice", assignedUserId: c.agent_user_id,
  });
  await db.from("call_logs").update({ conversation_id: conv.id, contact_id: contactId }).eq("twilio_call_sid", callSid);
  try { await linkConversation(db, callSid, conv.id, contactId); } catch { /* the session row may not exist (mirrored calls) */ }

  // The thread should show the call itself, not only its recording; skip if the finalizer already did.
  const { data: ev } = await db.from("messages").select("id").eq("conversation_id", conv.id)
    .eq("message_type", "call_event").eq("metadata->>call_sid", callSid).limit(1).maybeSingle();
  if (!ev) {
    const secs = opts.seconds ?? null;
    await insertMessage(db, {
      orgId: c.organization_id, conversationId: conv.id, contactId, channel: "voice", direction: "system",
      messageType: "call_event", senderIdentifier: caller || null, at: c.created_at ?? undefined,
      body: `${c.direction === "outbound" ? "Outbound" : "Inbound"} call${secs ? ` (${secs}s)` : ""} — recorded`,
      metadata: { call_sid: callSid, recorded: true },
    });
  }
  return { conversationId: conv.id, contactId };
}

/** Add the playable-recording message to the thread, or refresh it if one exists (e.g. after a re-transcription). */
export async function upsertRecordingMessage(
  db: SupabaseClient,
  m: { orgId: string; conversationId: string; contactId: string; callSid: string; path: string; seconds: number | null; transcript: "done" | "failed" | "skipped" | "pending"; text: string },
): Promise<void> {
  const body = m.text ? `Call recording transcript:\n${m.text}` : "Call recording saved (no speech transcribed).";
  const metadata = { call_sid: m.callSid, recording_path: m.path, duration_seconds: m.seconds, transcript_status: m.transcript };
  const { data: existing } = await db.from("messages").select("id").eq("conversation_id", m.conversationId)
    .eq("message_type", "call_recording").eq("metadata->>call_sid", m.callSid).limit(1).maybeSingle();
  if (existing) {
    await db.from("messages").update({ body, metadata }).eq("id", (existing as { id: string }).id);
    return;
  }
  await insertMessage(db, {
    orgId: m.orgId, conversationId: m.conversationId, contactId: m.contactId, channel: "voice", direction: "system",
    messageType: "call_recording", body, metadata,
  });
}

/** Best effort: keep the reason a transcription failed where someone can read it (edge logs are not always reachable). */
async function noteTranscriptError(db: SupabaseClient, callSid: string, err: string | null): Promise<void> {
  try { await db.from("call_logs").update({ transcript_error: err ? err.slice(0, 300) : null }).eq("twilio_call_sid", callSid); } catch { /* column may not exist yet */ }
}

export async function processRecording(
  db: SupabaseClient,
  p: { CallSid?: string; RecordingUrl?: string; RecordingStatus?: string; RecordingDuration?: string },
  d: RecordingDeps,
): Promise<RecordingResult> {
  if (p.RecordingStatus !== "completed" || !p.RecordingUrl || !p.CallSid) return { ok: false, reason: "not-completed" };
  if (!isAllowedRecordingUrl(p.RecordingUrl)) return { ok: false, reason: "bad-host" };

  const { data: log } = await db.from("call_logs").select("organization_id, conversation_id, contact_id")
    .eq("twilio_call_sid", p.CallSid).maybeSingle();
  if (!log) return { ok: false, reason: "unknown-call" };
  const row = log as { organization_id: string; conversation_id: string | null; contact_id: string | null };

  let bytes: Uint8Array;
  try { bytes = await d.download(`${p.RecordingUrl}.mp3`); } catch { return { ok: false, reason: "download-failed" }; }
  const path = recordingPath(row.organization_id, p.CallSid);
  try { await d.upload(path, bytes); } catch { return { ok: false, reason: "upload-failed" }; }

  const seconds = p.RecordingDuration ? parseInt(p.RecordingDuration, 10) : null;
  await db.from("call_logs").update({
    recording_path: path,
    recording_duration_seconds: Number.isFinite(seconds as number) ? seconds : null,
    transcript_status: "pending",
  }).eq("twilio_call_sid", p.CallSid);

  const t = await d.transcribe(bytes, row.organization_id).catch((e) => ({ error: String(e) }));
  const text = "text" in t ? t.text.trim() : "";
  const transcript: "done" | "failed" | "skipped" = "text" in t ? (text ? "done" : "skipped") : "failed";
  if (transcript === "failed") console.warn(`[recordings] transcription failed for ${p.CallSid}: ${(t as { error: string }).error.slice(0, 200)}`);
  await db.from("call_logs").update({ transcript: text || null, transcript_status: transcript }).eq("twilio_call_sid", p.CallSid);
  await noteTranscriptError(db, p.CallSid, transcript === "failed" ? (t as { error: string }).error : null);

  // The recording callback can beat the finalizer that links the call to a conversation; give it a moment.
  let conversationId = row.conversation_id, contactId = row.contact_id;
  const sleep = d.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  for (let i = 0; !conversationId && i < 5; i++) {
    await sleep(2_000);
    const { data } = await db.from("call_logs").select("conversation_id, contact_id").eq("twilio_call_sid", p.CallSid).maybeSingle();
    const r = data as { conversation_id: string | null; contact_id: string | null } | null;
    conversationId = r?.conversation_id ?? null;
    contactId = r?.contact_id ?? null;
  }

  // A known contact's recorded call gets a conversation and a Play button; an unknown number only keeps its call log.
  if (!conversationId || !contactId) {
    const ensured = await ensureCallConversation(db, p.CallSid, { seconds }).catch((e) => { console.warn(`[recordings] ensure conversation failed for ${p.CallSid}: ${String(e).slice(0, 200)}`); return null; });
    conversationId = ensured?.conversationId ?? null;
    contactId = ensured?.contactId ?? null;
  }

  let messageLogged = false;
  if (conversationId && contactId) {
    await upsertRecordingMessage(db, { orgId: row.organization_id, conversationId, contactId, callSid: p.CallSid, path, seconds, transcript, text });
    messageLogged = true;
  }
  return { ok: true, path, transcript, messageLogged };
}

export interface RepairDeps {
  /** Read a stored recording back out of the private bucket. */
  downloadStored: (path: string) => Promise<Uint8Array>;
  transcribe: RecordingDeps["transcribe"];
}

/**
 * Repair one already-stored recording: make sure the call has a conversation and a Play message, and
 * (re)try the transcript when it is missing. Used by the backfill job for recordings made before
 * the conversation guarantee existed, and for mirrored calls whose audio was only just stored.
 */
export async function repairRecording(
  db: SupabaseClient, callSid: string, d: RepairDeps,
): Promise<{ ok: boolean; linked: boolean; transcript: "done" | "failed" | "skipped" | "pending" }> {
  const { data } = await db.from("call_logs")
    .select("organization_id, recording_path, recording_duration_seconds, transcript, transcript_status")
    .eq("twilio_call_sid", callSid).maybeSingle();
  const r = data as { organization_id: string; recording_path: string | null; recording_duration_seconds: number | null; transcript: string | null; transcript_status: string | null } | null;
  if (!r?.recording_path) return { ok: false, linked: false, transcript: "pending" };

  let text = (r.transcript ?? "").trim();
  let transcript = (r.transcript_status as "done" | "failed" | "skipped" | "pending" | null) ?? "pending";
  if (!text && transcript !== "skipped") {
    try {
      const bytes = await d.downloadStored(r.recording_path);
      const t = await d.transcribe(bytes, r.organization_id).catch((e) => ({ error: String(e) }));
      text = "text" in t ? t.text.trim() : "";
      transcript = "text" in t ? (text ? "done" : "skipped") : "failed";
      await db.from("call_logs").update({ transcript: text || null, transcript_status: transcript }).eq("twilio_call_sid", callSid);
      await noteTranscriptError(db, callSid, transcript === "failed" ? (t as { error: string }).error : null);
    } catch (e) {
      transcript = "failed";
      await db.from("call_logs").update({ transcript_status: "failed" }).eq("twilio_call_sid", callSid);
      await noteTranscriptError(db, callSid, `could not read stored recording: ${String(e)}`);
    }
  }

  const ensured = await ensureCallConversation(db, callSid, { seconds: r.recording_duration_seconds });
  if (ensured) {
    await upsertRecordingMessage(db, {
      orgId: r.organization_id, conversationId: ensured.conversationId, contactId: ensured.contactId,
      callSid, path: r.recording_path, seconds: r.recording_duration_seconds, transcript, text,
    });
  }
  return { ok: true, linked: !!ensured, transcript };
}
