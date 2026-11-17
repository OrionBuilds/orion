/**
 * Shared ElevenLabs Scribe speech-to-text helper.
 *
 * Replaces the previous OpenAI Whisper / gpt-4o-transcribe calls. ElevenLabs
 * is already integrated for TTS in this codebase (`elevenlabs_connection`
 * table), and the same API key supports their Scribe STT model.
 *
 * Resolution order for the API key:
 *   1. Org's `elevenlabs_connection.api_key_encrypted` (stored plaintext
 *      despite the column name — see ai-settings-elevenlabs/index.ts)
 *   2. Platform-wide `ELEVENLABS_API_KEY` env var fallback
 *
 * ElevenLabs API reference:
 *   https://elevenlabs.io/docs/api-reference/speech-to-text/convert
 */

import type { SupabaseClient } from "npm:@supabase/supabase-js@2";
import { openSecret } from "./secrets.ts";

export const ELEVENLABS_STT_URL = "https://api.elevenlabs.io/v1/speech-to-text";
export const ELEVENLABS_STT_MODEL = "scribe_v1";

export interface TranscribeOptions {
  /** ISO-639-1 language code (e.g. "en", "es"). Omit for auto-detect. */
  language?: string;
  /** Override the API key (skips the elevenlabs_connection lookup). */
  apiKey?: string;
  /** Filename to send in the multipart upload (helps server-side decoding). */
  filename?: string;
}

export interface TranscribeResult {
  text: string;
  language?: string;
  confidence?: number;
}

export interface TranscribeError {
  error: string;
  status?: number;
}

export type TranscribeOutcome = TranscribeResult | TranscribeError;

export function isTranscribeError(
  result: TranscribeOutcome,
): result is TranscribeError {
  return typeof (result as TranscribeError).error === "string";
}

/**
 * Resolve the ElevenLabs API key for an organization.
 *  - First tries the org's `elevenlabs_connection` row.
 *  - Falls back to the `ELEVENLABS_API_KEY` env var so anonymous / service
 *    contexts (e.g. wake-word detection from a not-yet-authenticated user)
 *    still work in development.
 */
export async function resolveElevenLabsApiKey(
  supabase: SupabaseClient,
  orgId: string | null,
): Promise<string | null> {
  if (orgId) {
    const { data } = await supabase
      .from("elevenlabs_connection")
      .select("api_key_encrypted")
      .eq("org_id", orgId)
      .maybeSingle();
    let key: string | undefined;
    try { key = (await openSecret(data?.api_key_encrypted as string | undefined)) ?? undefined; }
    catch (e) { console.warn("[elevenLabsStt] org ElevenLabs key could not be opened, using the platform key:", (e as Error).message); }
    if (key && key.trim()) return key.trim();
  }
  const envKey = Deno.env.get("ELEVENLABS_API_KEY");
  return envKey && envKey.trim() ? envKey.trim() : null;
}

/**
 * Send an audio Blob/File to ElevenLabs Scribe and return the transcript.
 * Designed to be a near drop-in for the previous Whisper helpers in
 * assistant-stt-wake / assistant-stt-final / assistant-voice.
 */
export async function transcribeAudio(
  supabase: SupabaseClient,
  orgId: string | null,
  audio: File | Blob,
  opts: TranscribeOptions = {},
): Promise<TranscribeOutcome> {
  const apiKey = opts.apiKey ?? (await resolveElevenLabsApiKey(supabase, orgId));
  if (!apiKey) {
    return { error: "ElevenLabs not configured (org connection or ELEVENLABS_API_KEY)" };
  }

  const form = new FormData();
  const filename = opts.filename ?? "audio.webm";
  if (audio instanceof File) {
    form.append("file", audio, audio.name || filename);
  } else {
    form.append("file", audio, filename);
  }
  form.append("model_id", ELEVENLABS_STT_MODEL);
  if (opts.language) form.append("language_code", opts.language);

  let response: Response;
  const send = (key: string) => fetch(ELEVENLABS_STT_URL, { method: "POST", headers: { "xi-api-key": key }, body: form });
  try {
    response = await send(apiKey);
    // An org-stored key that was revoked or rotated must not stop transcription while the platform key works.
    const envKey = Deno.env.get("ELEVENLABS_API_KEY")?.trim();
    if ((response.status === 401 || response.status === 403) && !opts.apiKey && envKey && envKey !== apiKey) {
      response = await send(envKey);
    }
  } catch (e) {
    const message = e instanceof Error ? e.message : "ElevenLabs request failed";
    return { error: message };
  }

  if (!response.ok) {
    let errMsg = `ElevenLabs Scribe error ${response.status}`;
    try {
      const data = await response.json();
      if (typeof data?.detail === "string") errMsg = data.detail;
      else if (typeof data?.detail?.message === "string") errMsg = data.detail.message;
      else if (typeof data?.message === "string") errMsg = data.message;
    } catch {
      try {
        const text = await response.text();
        if (text) errMsg = text.slice(0, 200);
      } catch {
        // ignore
      }
    }
    return { error: errMsg, status: response.status };
  }

  const data = await response.json().catch(() => null);
  const text =
    (data && typeof data.text === "string" && data.text) ||
    (data && typeof data.transcript === "string" && data.transcript) ||
    "";
  const language =
    data && typeof data.language_code === "string"
      ? (data.language_code as string)
      : undefined;
  const confidence =
    data && typeof data.language_probability === "number"
      ? (data.language_probability as number)
      : undefined;

  return { text, language, confidence };
}
