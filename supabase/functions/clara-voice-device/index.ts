// clara-voice-device — one spoken turn with Clara from a trusted device (the always-listening daemon on
// the office box, later a phone). The device has already heard its wake word locally and sends ONE
// utterance; this transcribes it, runs Clara's owner brain (same brain as her SMS, calls and chat) and
// returns her reply as text plus mp3 audio for THAT device to play. History is server-side (shared thread),
// so switching devices mid-conversation just works.
//
// Auth: a shared device key in the x-clara-device-key header, compared to the CLARA_VOICE_DEVICE_KEY
// secret. The turn runs as the account owner (OWNER_USER_ID), so a leaked key is owner-level access to
// Clara: rotate it by setting a new secret and rewriting the device's key file. Unset secret = closed.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { getSupabaseClient } from "../_shared/auth.ts";
import { ownerCtx, claraNumberFor } from "../_shared/clara/runtime.ts";
import { overheardReply, ownerTurn, soundOnly } from "../_shared/clara/owner-turn.ts";
import { transcribeAudio, isTranscribeError, resolveElevenLabsApiKey } from "../_shared/elevenLabsStt.ts";
import { phonemize } from "npm:phonemizer@1";
import { deviceKeyOk } from "../_shared/clara/device-key.ts";

const DEFAULT_VOICE = "21m00Tcm4TlvDq8ikWAM";
const MAX_AUDIO = 4_000_000;
const MAX_REPLY_CHARS = 1200;

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });

function spoken(text: string): string {
  const pairs = (Deno.env.get("CLARA_TTS_PRONUNCIATIONS") ?? "").split(",")
    .map((p) => p.split("=").map((s) => s.trim())).filter((p) => p.length === 2 && p[0] && p[1]);
  return pairs.reduce((t, [w, say]) => t.replace(new RegExp(`\\b${w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "g"), say), text);
}

/**
 * British-English IPA per sentence (espeak-ng, the same front end Kokoro uses), for devices that speak in
 * Clara's on-board voice with a phoneme-driven engine (the Android app). Punctuation is kept so pauses land
 * where they should.
 */
async function sentencesToPhonemes(text: string): Promise<string[]> {
  const out: string[] = [];
  for (const m of spoken(text).matchAll(/[^.!?]+[.!?]*/g)) {
    const sentence = m[0].trim();
    if (!sentence) continue;
    const end = /[.!?]+$/.exec(sentence)?.[0] ?? ".";
    const clauses = sentence.replace(/[.!?]+$/, "").split(/(?<=[,;:])\s*/);
    const parts: string[] = [];
    for (const c of clauses) {
      const punct = /[,;:]$/.exec(c)?.[0] ?? "";
      const ipa = (await phonemize(c.replace(/[,;:]$/, ""), "en-gb")).join(" ").trim();
      if (ipa) parts.push(ipa + punct);
    }
    if (parts.length) out.push(parts.join(" ") + end);
  }
  return out;
}

function b64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

Deno.serve(async (req: Request): Promise<Response> => {
  if (req.method !== "POST") return json({ error: "Use POST" }, 405);
  if (!deviceKeyOk(req.headers.get("x-clara-device-key"), Deno.env.get("CLARA_VOICE_DEVICE_KEY"))) return json({ error: "Unauthorized" }, 401);

  const ownerId = Deno.env.get("OWNER_USER_ID")?.trim();
  if (!ownerId) return json({ error: "OWNER_USER_ID is not set" }, 500);
  const svc = getSupabaseClient();
  const { data: u } = await svc.from("users").select("organization_id, super_admin_active_org_id").eq("id", ownerId).maybeSingle();
  const orgId = ((u?.super_admin_active_org_id ?? u?.organization_id) as string | null) ?? null;
  if (!orgId) return json({ error: "Owner has no organization" }, 500);

  let form: FormData;
  try { form = await req.formData(); } catch { return json({ error: "Expected multipart form data" }, 400); }
  const audio = form.get("audio") as File | null;
  if (!audio || audio.size === 0) return json({ error: "No audio" }, 400);
  if (audio.size > MAX_AUDIO) return json({ error: "Audio too large" }, 413);

  const stt = await transcribeAudio(svc, orgId, audio, { filename: audio.name || "utterance.wav", language: "en" });
  if (isTranscribeError(stt)) return json({ error: `transcription failed: ${stt.error}` }, 502);
  const heard = stt.text.trim();
  // A beep or a click is not a request: no turn, no reply. (The device keeps its window open for the real one.)
  if (!heard || soundOnly(heard)) return json({ success: true, heard, text: "", audio_b64: null });

  let reply: string;
  try {
    const claraNumber = await claraNumberFor(svc, Deno.env, orgId);
    const ctx = ownerCtx(svc, Deno.env, { orgId, claraNumber, channel: "voice", ownerVerified: true });
    // ownerTurn reads and writes the ONE shared Clara thread (clara_owner_thread), so a conversation begun on
    // one device (or by text) continues on any other. The reply goes back only to the device that asked.
    const result = await ownerTurn(svc, Deno.env, ctx, heard);
    reply = (result.reply ?? "").trim();
  } catch (e) {
    console.error("[clara-voice-device]", (e as Error).message);
    return json({ error: `Clara hit a snag: ${(e as Error).message}`, heard }, 500);
  }
  if (!reply) return json({ success: true, heard, text: "", audio_b64: null });
  // The room was talking, not the owner to Clara: say nothing aloud, and tell the device to stop listening for
  // a follow-up (otherwise it feeds her a whole meeting, one "I'm staying quiet" at a time).
  if (overheardReply(reply)) return json({ success: true, heard, text: "", audio_b64: null, overheard: true });

  // Speak it with her phone voice (same key + voice as clara-tts). A TTS failure still returns the text and
  // the reason, so the device can say something instead of going silent.
  let audioB64: string | null = null;
  let ttsError: string | null = null;
  const envVoice = Deno.env.get("CLARA_ELEVENLABS_VOICE_ID") ?? Deno.env.get("CLARA_VOICE_ID") ?? "";
  const voice = /^[A-Za-z0-9]{16,}$/.test(envVoice) ? envVoice : DEFAULT_VOICE;
  const keys = [Deno.env.get("ELEVENLABS_API_KEY")?.trim(), await resolveElevenLabsApiKey(svc, orgId).catch(() => null)]
    .filter((k, i, all): k is string => !!k && all.indexOf(k) === i);
  // Devices with Clara's voice on board (Kokoro, bf_isabella) send tts=none: no ElevenLabs call at all.
  const ttsMode = String(form.get("tts") ?? "");
  const localVoice = ttsMode === "none" || ttsMode === "phonemes";
  let phonemes: string[] | null = null;
  if (ttsMode === "phonemes") {
    try { phonemes = await sentencesToPhonemes(reply); } catch (e) { ttsError = `phonemize: ${(e as Error).message}`; }
  }
  if (!localVoice && keys.length === 0) ttsError = "no ElevenLabs key";
  for (const key of localVoice ? [] : keys) {
    try {
      const r = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voice}?output_format=mp3_44100_64`, {
        method: "POST",
        headers: { "xi-api-key": key, "Content-Type": "application/json", Accept: "audio/mpeg" },
        body: JSON.stringify({
          text: spoken(reply).slice(0, MAX_REPLY_CHARS), model_id: "eleven_flash_v2_5",
          voice_settings: { stability: 0.55, similarity_boost: 0.75, style: 0.35, use_speaker_boost: true },
        }),
        signal: AbortSignal.timeout(20_000),
      });
      if (r.ok) { audioB64 = b64(new Uint8Array(await r.arrayBuffer())); ttsError = null; break; }
      ttsError = `ElevenLabs ${r.status}: ${(await r.text()).slice(0, 160)}`;
    } catch (e) { ttsError = (e as Error).message.slice(0, 160); }
  }
  if (ttsError) console.warn("[clara-voice-device] tts:", ttsError);

  return json({ success: true, heard, text: reply, audio_b64: audioB64, phonemes, tts_error: ttsError });
});
