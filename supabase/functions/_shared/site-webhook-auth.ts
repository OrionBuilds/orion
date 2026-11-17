/**
 * Signature check for the website submission webhook (business website → site-lead-intake).
 *
 * The sender (`lib/submissions/sinks/webhook.ts` in the site repo) sends
 *   X-Submission-Timestamp: <ms since epoch>
 *   X-Submission-Signature: sha256=<hex HMAC-SHA256(`${timestamp}.${rawBody}`, secret)>
 * The body must be verified as the raw bytes received, before any JSON parsing.
 * Fails closed when the secret is not configured.
 */

export type SiteSignatureResult = "ok" | "missing" | "stale" | "mismatch";

const DEFAULT_WINDOW_MS = 5 * 60 * 1000;

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  const enc = new TextEncoder();
  const ba = enc.encode(a);
  const bb = enc.encode(b);
  let diff = 0;
  for (let i = 0; i < ba.length; i++) diff |= ba[i] ^ bb[i];
  return diff === 0;
}

export async function hmacSha256Hex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
  return Array.from(new Uint8Array(sig)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function verifySiteSignature(i: {
  rawBody: string;
  timestamp: string | null;
  signature: string | null;
  secret: string | undefined | null;
  nowMs?: number;
  windowMs?: number;
}): Promise<SiteSignatureResult> {
  if (!i.secret || !i.timestamp || !i.signature) return "missing";
  const ts = Number(i.timestamp);
  if (!Number.isFinite(ts)) return "missing";
  const now = i.nowMs ?? Date.now();
  if (Math.abs(now - ts) > (i.windowMs ?? DEFAULT_WINDOW_MS)) return "stale";
  const m = /^sha256=([0-9a-f]{64})$/i.exec(i.signature.trim());
  if (!m) return "mismatch";
  const expected = await hmacSha256Hex(i.secret, `${i.timestamp}.${i.rawBody}`);
  return timingSafeEqual(expected.toLowerCase(), m[1].toLowerCase()) ? "ok" : "mismatch";
}
