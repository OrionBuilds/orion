/**
 * Pure helpers for caio-source-ingest: VTT cleaning, hashing, safe storage names and the consent / PII status rule.
 * The consent rule lives here (and again in the caio_source_before trigger) so a meeting-derived source can never be
 * 'ready' without the owner's attestation.
 */
import type { SupabaseClient } from "npm:@supabase/supabase-js@2";
import { type PiiFlag, scanPii } from "./pii.ts";

// deno-lint-ignore no-explicit-any
type Json = Record<string, any>;

export const MAX_FILE_BYTES = 25 * 1024 * 1024;
export const MAX_FILES = 10;
export const ALLOWED_EXT = ["docx", "pdf", "txt", "md", "vtt"];

/** Speaker-labelled lines from a WebVTT file: no header, cue ids, timestamps, NOTE/STYLE blocks or markup. */
export function cleanVtt(raw: string): string {
  const text = raw.replace(/^﻿/, "").replace(/\r\n?/g, "\n");
  if (!/^\s*WEBVTT/.test(text) && !/-->/.test(text)) return text;
  const out: string[] = [];
  for (const block of text.split(/\n{2,}/)) {
    const lines = block.split("\n");
    const ts = lines.findIndex((l) => l.includes("-->"));
    if (ts < 0) continue; // WEBVTT header, NOTE, STYLE, REGION, or a bare cue id
    for (const l of lines.slice(ts + 1)) {
      const voice = /^<v(?:\.[^\s>]+)?\s+([^>]+)>/.exec(l.trim());
      let s = l.replace(/<[^>]+>/g, "").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").trim();
      if (!s) continue;
      if (voice && !s.toLowerCase().startsWith(voice[1].trim().toLowerCase() + ":")) s = `${voice[1].trim()}: ${s}`;
      out.push(s);
    }
  }
  // consecutive lines from one speaker read better as one paragraph
  const merged: string[] = [];
  for (const line of out) {
    const speaker = /^([^:]{1,60}):\s/.exec(line)?.[1];
    const prev = merged[merged.length - 1];
    const prevSpeaker = prev ? /^([^:]{1,60}):\s/.exec(prev)?.[1] : undefined;
    if (prev && !speaker && !/^([^:]{1,60}):\s/.test(line)) merged[merged.length - 1] = `${prev} ${line}`;
    else if (prev && speaker && speaker === prevSpeaker) merged[merged.length - 1] = `${prev} ${line.slice(speaker.length + 1).trim()}`;
    else merged.push(line);
  }
  return merged.join("\n");
}

export async function sha256Hex(text: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text.replace(/\s+/g, " ").trim().toLowerCase()));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function safeName(name: string): string {
  const base = (name.split(/[\\/]/).pop() ?? "file").normalize("NFKD").replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^\.+/, "").slice(0, 80);
  return base || "file";
}

export function fileExt(name: string): string {
  const m = /\.([A-Za-z0-9]{1,8})$/.exec(name.trim());
  return m ? m[1].toLowerCase() : "";
}

export function titleFromFilename(name: string): string {
  return safeName(name).replace(/\.[A-Za-z0-9]{1,8}$/, "").replace(/[_-]+/g, " ").trim().slice(0, 160) || "Untitled source";
}

export interface StatusInput {
  pii: PiiFlag[];
  /** The owner ticked "I have permission to process this material". */
  consent: boolean;
  /** Derived from an OS meeting (meeting_transcriptions). */
  fromMeeting: boolean;
  /** The owner has attested consent for this meeting (link-meeting with consent, or allow-source). */
  attested: boolean;
  /** Engagement policy: personal data (SSN-, account-, card-like) does not hold a source back. Secrets always do. */
  allowPersonalData?: boolean;
}

/** 'ready' only when nothing is flagged and consent exists; a meeting-derived source additionally needs the attestation. */
export function processStatusFor(i: StatusInput): "ready" | "needs_review" {
  const held = i.pii.filter((f) => f.type === "secret" || !i.allowPersonalData);
  if (held.length > 0) return "needs_review";
  if (!i.consent) return "needs_review";
  if (i.fromMeeting && !i.attested) return "needs_review";
  return "ready";
}

// ── owner actions on sources / meetings (caio-source-ingest JSON actions) ─────────────────────────

export type ActionResult = { ok: true; source?: Json } | { ok: false; error: string; status?: number };
const fail = (error: string, status = 400): ActionResult => ({ ok: false, error, status });

export interface SourceRow {
  org_id: string; engagement_id: string; kind: string; title: string; department?: string | null; interviewees?: string | null;
  text_content: string; text_hash: string; pii_flags: PiiFlag[]; process_status: "ready" | "needs_review";
  storage_path?: string | null; original_filename?: string | null; mime?: string | null;
  meeting_transcription_id?: string | null; consent_attested_by?: string | null; consent_attested_at?: string | null; consent_note?: string | null;
  extraction_status: "pending" | "no_text";
}

/** Link an OS meeting as a source. The owner's `consent: true` IS the attestation; without it nothing is linked. */
export async function linkMeeting(db: SupabaseClient, a: {
  orgId: string; userId: string; engagementId: string; meetingId: string; consent: boolean; consentNote?: string; department?: string; now: Date;
}): Promise<ActionResult> {
  if (a.consent !== true) return fail("consent_required");
  const { data: eng } = await db.from("caio_engagements").select("id, org_id").eq("id", a.engagementId).eq("org_id", a.orgId).maybeSingle();
  if (!eng) return fail("engagement_not_found", 404);
  const { data: mt } = await db.from("meeting_transcriptions").select("id, org_id, meeting_title, transcript_text").eq("id", a.meetingId).eq("org_id", a.orgId).maybeSingle();
  if (!mt) return fail("meeting_not_found", 404);
  const text = cleanVtt(String((mt as Json).transcript_text ?? ""));
  if (!text.trim()) return fail("meeting_has_no_transcript");
  const pii = scanPii(text);
  const attestedAt = a.now.toISOString();
  const { data: existing } = await db.from("caio_sources").select("id").eq("engagement_id", a.engagementId).eq("meeting_transcription_id", a.meetingId).maybeSingle();
  let source: Json | null = null;
  if (existing) {
    const { data } = await db.from("caio_sources").update({
      consent_attested_by: a.userId, consent_attested_at: attestedAt, consent_note: a.consentNote?.slice(0, 500) ?? null,
      process_status: processStatusFor({ pii, consent: true, fromMeeting: true, attested: true }),
    }).eq("id", (existing as Json).id).select("id, title, process_status, extraction_status, pii_flags, char_count").maybeSingle();
    source = data as Json | null;
  } else {
    const row: SourceRow = {
      org_id: a.orgId, engagement_id: a.engagementId, kind: "transcript", title: String((mt as Json).meeting_title || "Meeting").slice(0, 160),
      department: a.department?.slice(0, 120) ?? null, text_content: text, text_hash: await sha256Hex(text), pii_flags: pii,
      process_status: processStatusFor({ pii, consent: true, fromMeeting: true, attested: true }), meeting_transcription_id: a.meetingId,
      consent_attested_by: a.userId, consent_attested_at: attestedAt, consent_note: a.consentNote?.slice(0, 500) ?? null, extraction_status: "pending",
    };
    const { data, error } = await db.from("caio_sources").insert(row).select("id, title, process_status, extraction_status, pii_flags, char_count").maybeSingle();
    if (error) return fail(error.code === "23505" ? "already_added" : "could_not_save", error.code === "23505" ? 409 : 500);
    source = data as Json | null;
  }
  if (!source) return fail("could_not_save", 500);
  const link = { org_id: a.orgId, meeting_transcription_id: a.meetingId, engagement_id: a.engagementId, state: "linked", match_method: "manual", source_id: source.id, owner_notified_at: attestedAt };
  const { data: prior } = await db.from("caio_meeting_links").select("id").eq("meeting_transcription_id", a.meetingId).maybeSingle();
  if (prior) await db.from("caio_meeting_links").update(link).eq("id", (prior as Json).id);
  else await db.from("caio_meeting_links").insert(link);
  return { ok: true, source };
}

/** The owner clears a flagged / unattested source: records the attestation and releases it for extraction. */
export async function allowSource(db: SupabaseClient, a: { orgId: string; userId: string; sourceId: string; now: Date }): Promise<ActionResult> {
  const { data } = await db.from("caio_sources").update({ consent_attested_by: a.userId, consent_attested_at: a.now.toISOString(), process_status: "ready" })
    .eq("id", a.sourceId).eq("org_id", a.orgId).select("id, title, process_status, extraction_status, pii_flags, char_count").maybeSingle();
  return data ? { ok: true, source: data as Json } : fail("source_not_found", 404);
}

export async function blockSource(db: SupabaseClient, a: { orgId: string; sourceId: string }): Promise<ActionResult> {
  const { data } = await db.from("caio_sources").update({ process_status: "blocked" }).eq("id", a.sourceId).eq("org_id", a.orgId)
    .select("id, title, process_status, extraction_status, pii_flags, char_count").maybeSingle();
  return data ? { ok: true, source: data as Json } : fail("source_not_found", 404);
}

export async function ignoreMeeting(db: SupabaseClient, a: { orgId: string; meetingId: string }): Promise<ActionResult> {
  const { data: mt } = await db.from("meeting_transcriptions").select("id").eq("id", a.meetingId).eq("org_id", a.orgId).maybeSingle();
  if (!mt) return fail("meeting_not_found", 404);
  const { data: prior } = await db.from("caio_meeting_links").select("id").eq("meeting_transcription_id", a.meetingId).maybeSingle();
  if (prior) await db.from("caio_meeting_links").update({ state: "ignored", owner_notified_at: new Date().toISOString() }).eq("id", (prior as Json).id);
  else await db.from("caio_meeting_links").insert({ org_id: a.orgId, meeting_transcription_id: a.meetingId, state: "ignored", owner_notified_at: new Date().toISOString() });
  return { ok: true };
}

/** Insert one uploaded/extracted text as a source (dedupe on engagement + hash). */
export async function insertSource(db: SupabaseClient, row: SourceRow): Promise<{ source?: Json; duplicate?: boolean; error?: string }> {
  const { data, error } = await db.from("caio_sources").insert(row).select("id, title, process_status, extraction_status, pii_flags, char_count").maybeSingle();
  if (error) return error.code === "23505" ? { duplicate: true } : { error: "could_not_save" };
  return { source: data as Json };
}
