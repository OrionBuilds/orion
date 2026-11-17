/**
 * Shared webhook secret verification.
 *
 * Compares an X-Webhook-Secret header against the WEBHOOK_SECRET env var in constant time,
 * and fails CLOSED if either side is missing. An earlier version returned true when the env
 * var was unset "for backward compatibility" - which meant that every caller (vapi-webhook,
 * vapi-tool-gateway, google-chat-webhook) accepted unauthenticated requests as long as
 * WEBHOOK_SECRET stayed unset, which it did. Same fail-open pattern as F-0. Confirmed
 * 2026-07-29: WEBHOOK_SECRET was not configured, so all three functions were effectively
 * open.
 *
 * Prefer per-provider signature verification (verifyTwilioSignature, verifyResendSignature,
 * verifyKieSignature, etc.) over this generic shared-secret check where the provider offers
 * one.
 */

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  const encoder = new TextEncoder();
  const bufA = encoder.encode(a);
  const bufB = encoder.encode(b);
  let result = 0;
  for (let i = 0; i < bufA.length; i++) {
    result |= bufA[i] ^ bufB[i];
  }
  return result === 0;
}

export function verifyWebhookSecret(req: Request): boolean {
  const configuredSecret = Deno.env.get("WEBHOOK_SECRET") || "";
  const providedSecret = req.headers.get("X-Webhook-Secret") || "";

  if (!configuredSecret) {
    console.error("[Webhook Auth] WEBHOOK_SECRET is not configured - rejecting request");
    return false;
  }
  if (!providedSecret) {
    console.error("[Webhook Auth] No X-Webhook-Secret header on request");
    return false;
  }
  return timingSafeEqual(configuredSecret, providedSecret);
}
