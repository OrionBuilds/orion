/**
 * TwiML builders for Clara's voice flows (ported from CLARA's channels.ts).
 *
 * Pure string builders; no I/O. `speak()` plays Clara's ElevenLabs voice through the signed
 * clara-tts function when a TTS base URL is given, otherwise Twilio's Polly voice. A <Play>
 * whose fetch fails makes Twilio announce an error to the caller, so callers pass `ttsBase`
 * only while TTS is healthy.
 */

export const FALLBACK_VOICE = "Polly.Joanna-Neural";

export function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export const response = (inner: string) => `<?xml version="1.0" encoding="UTF-8"?><Response>${inner}</Response>`;

export interface SpeakOpts {
  /** Public base of the clara-tts function, e.g. https://<ref>.supabase.co/functions/v1/clara-tts */
  ttsBase?: string;
  /** HMAC signature for `text` (see signTts). Required with ttsBase. */
  sig?: string;
  tone?: string;
}

/** Inner TwiML fragment (no <Response>) that speaks `text`. */
export function speak(text: string, opts: SpeakOpts = {}): string {
  const t = text.slice(0, 850).trim();
  if (opts.ttsBase && opts.sig) {
    const url = `${opts.ttsBase}?text=${encodeURIComponent(t)}&sig=${opts.sig}&tone=${encodeURIComponent(opts.tone ?? "stranger")}`;
    return `<Play>${esc(url)}</Play>`;
  }
  return `<Say voice="${FALLBACK_VOICE}">${esc(t)}</Say>`;
}

/** Speech-gather loop fragment: prompt plays inside the Gather so the caller can barge in. */
export function gatherFragment(prompt: string, actionUrl: string, speakFn: (t: string) => string): string {
  return `<Gather input="speech" speechTimeout="auto" action="${esc(actionUrl)}" method="POST">${speakFn(prompt)}</Gather>` +
    speakFn("I didn't catch that. Call back any time.");
}

/** <Start><Recording> (the supported form; <Start><Record> draws warning 12200). */
export function startRecording(callbackUrl: string): string {
  return `<Start><Recording recordingStatusCallback="${esc(callbackUrl)}" recordingStatusCallbackEvent="completed"/></Start>`;
}

/** Twilio fetches `url` for the next instructions once everything before it has played. */
export function redirect(url: string): string {
  return `<Redirect method="POST">${esc(url)}</Redirect>`;
}

export function hangup(): string {
  return "<Hangup/>";
}

/** Park the caller in their own queue; waitUrl supplies hold audio, actionUrl fires when they leave. */
export function enqueue(o: { queueName: string; waitUrl: string; actionUrl: string; sayXml?: string }): string {
  return `${o.sayXml ?? ""}<Enqueue waitUrl="${esc(o.waitUrl)}" waitUrlMethod="POST" action="${esc(o.actionUrl)}" method="POST">${esc(o.queueName)}</Enqueue>`;
}

/** Live whispered transfer: the callee hears whisperUrl before being bridged to the caller. */
export function dialWhisper(o: { number: string; whisperUrl: string; actionUrl: string; callerId?: string; timeoutSec?: number }): string {
  return `<Dial timeout="${o.timeoutSec ?? 20}" action="${esc(o.actionUrl)}"${o.callerId ? ` callerId="${esc(o.callerId)}"` : ""}>` +
    `<Number url="${esc(o.whisperUrl)}">${esc(o.number)}</Number></Dial>`;
}

/** Hex HMAC-SHA256 truncated to 24 chars, same shape as CLARA's ttsSign. */
export async function signTts(text: string, key: string): Promise<string> {
  const k = await crypto.subtle.importKey("raw", new TextEncoder().encode(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", k, new TextEncoder().encode(text));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 24);
}

export async function ttsSigValid(text: string, sig: string | null, key: string): Promise<boolean> {
  if (!sig) return false;
  const expected = await signTts(text, key);
  if (expected.length !== sig.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ sig.charCodeAt(i);
  return diff === 0;
}
