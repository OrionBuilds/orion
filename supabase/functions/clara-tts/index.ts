/**
 * clara-tts — signed text-to-speech for Twilio <Play> (ported from CLARA's tts route).
 *
 * Twilio can't sign media fetches, so the URL carries an HMAC of the text; arbitrary callers can't
 * spend TTS credits. On any provider failure the outage is recorded (clara_service_health) so the
 * next webhooks switch to Twilio's built-in voice instead of playing an error to a live caller.
 */
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { ttsSigValid } from "../_shared/twiml.ts";
import { denoEnv, serviceClient } from "../_shared/clara/webhook.ts";

const DEFAULT_VOICE = "21m00Tcm4TlvDq8ikWAM";
const OUTAGE_MS = 5 * 60_000;

/**
 * Words the model says wrong, respelled for the synthesizer only (the text Clara writes is
 * untouched). CLARA_TTS_PRONUNCIATIONS="Word=Respelling,Other=Respelling" sets them (none by default).
 */
function spoken(text: string): string {
  const pairs = (denoEnv.get("CLARA_TTS_PRONUNCIATIONS") ?? "").split(",")
    .map((p) => p.split("=").map((s) => s.trim())).filter((p) => p.length === 2 && p[0] && p[1]);
  return pairs.reduce((t, [word, say]) => t.replace(new RegExp(`\\b${word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "g"), say), text);
}

// Per-tone ElevenLabs settings (warm-familiar / crisp-professional / neutral).
const TONES: Record<string, { stability: number; similarity_boost: number; style: number }> = {
  owner: { stability: 0.55, similarity_boost: 0.75, style: 0.35 },
  vendor: { stability: 0.75, similarity_boost: 0.75, style: 0.15 },
  stranger: { stability: 0.7, similarity_boost: 0.75, style: 0.2 },
};

const cache = new Map<string, Uint8Array>();
const CACHE_MAX = 80;

Deno.serve(async (req: Request) => {
  const url = new URL(req.url);
  const text = url.searchParams.get("text") ?? "";
  const tone = url.searchParams.get("tone") ?? "stranger";
  const key = denoEnv.get("TWILIO_AUTH_TOKEN") ?? "clara-tts";
  if (!text || !(await ttsSigValid(text, url.searchParams.get("sig"), key))) return new Response("bad signature", { status: 403 });

  const apiKey = denoEnv.get("ELEVENLABS_API_KEY")?.trim();
  if (!apiKey) return new Response("tts not configured", { status: 503 });
  const voice = /^[A-Za-z0-9]{16,}$/.test(denoEnv.get("CLARA_ELEVENLABS_VOICE_ID") ?? "") ? denoEnv.get("CLARA_ELEVENLABS_VOICE_ID")! : DEFAULT_VOICE;
  const cacheKey = `${voice}:${tone}:${text}`;
  const hit = cache.get(cacheKey);
  if (hit) return audio(hit);

  try {
    const r = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voice}?output_format=ulaw_8000&optimize_streaming_latency=4`, {
      method: "POST",
      headers: { "xi-api-key": apiKey, "Content-Type": "application/json" },
      body: JSON.stringify({
        text: spoken(text).slice(0, 2500), model_id: "eleven_flash_v2_5",
        voice_settings: { ...(TONES[tone] ?? TONES.stranger), use_speaker_boost: true },
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!r.ok) throw new Error(`ElevenLabs ${r.status}`);
    const buf = new Uint8Array(await r.arrayBuffer());
    if (buf.length === 0) throw new Error("empty audio");
    cache.set(cacheKey, buf);
    if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value!);
    return audio(buf);
  } catch (e) {
    const msg = (e as Error).message.slice(0, 160);
    console.error("[clara-tts] failed:", msg);
    await serviceClient().from("clara_service_health").upsert(
      { service: "tts", down_until: new Date(Date.now() + OUTAGE_MS).toISOString(), last_error: msg, updated_at: new Date().toISOString() },
      { onConflict: "service" },
    );
    return new Response("tts unavailable", { status: 502 });
  }
});

const audio = (buf: Uint8Array) =>
  new Response(buf as unknown as BodyInit, { headers: { "Content-Type": "audio/basic", "Cache-Control": "public, max-age=300" } });
