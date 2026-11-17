/**
 * Verify Google-signed JWTs (RS256), suitable for Pub/Sub push OIDC tokens and
 * Google Sign-In id_tokens. Fetches Google's public certs from the standard JWKS
 * endpoint with a process-lifetime TTL cache.
 *
 * Callers should always check the returned `.valid` and, when true, the parsed claims.
 * When `.valid` is false, `.reason` describes why - suitable for a single log line.
 *
 * Pub/Sub push usage: configure the subscription in GCP with a service account and an
 * `audience`; Google will attach `Authorization: Bearer <JWT>` where the token's
 * `iss` is `accounts.google.com` (or `https://accounts.google.com`), `email` matches the
 * service account, `email_verified` is true, and `aud` matches the configured audience.
 * See: https://cloud.google.com/pubsub/docs/authenticate-push-subscriptions
 */

const GOOGLE_JWKS_URL = "https://www.googleapis.com/oauth2/v3/certs";
const CACHE_TTL_MS = 60 * 60 * 1000; // 1h - well below Google's key rotation cadence
const VALID_ISSUERS = new Set(["https://accounts.google.com", "accounts.google.com"]);

let cachedKeys: Map<string, CryptoKey> | null = null;
let cachedAt = 0;

interface JwkKey {
  kid: string;
  kty: string;
  n: string;
  e: string;
  alg?: string;
  use?: string;
}

async function fetchGooglePublicKeys(): Promise<Map<string, CryptoKey>> {
  if (cachedKeys && Date.now() - cachedAt < CACHE_TTL_MS) return cachedKeys;

  const res = await fetch(GOOGLE_JWKS_URL, { signal: AbortSignal.timeout(5000) });
  if (!res.ok) throw new Error(`JWKS fetch failed: ${res.status}`);
  const jwks = await res.json() as { keys: JwkKey[] };

  const out = new Map<string, CryptoKey>();
  for (const jwk of jwks.keys) {
    if (jwk.kty !== "RSA") continue;
    const key = await crypto.subtle.importKey(
      "jwk",
      { kty: jwk.kty, n: jwk.n, e: jwk.e, alg: "RS256", ext: true },
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["verify"],
    );
    out.set(jwk.kid, key);
  }
  cachedKeys = out;
  cachedAt = Date.now();
  return out;
}

function b64UrlDecode(s: string): Uint8Array {
  // Convert base64url to base64, then decode.
  let b64 = s.replace(/-/g, "+").replace(/_/g, "/");
  const pad = b64.length % 4;
  if (pad) b64 += "=".repeat(4 - pad);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function b64UrlDecodeText(s: string): string {
  return new TextDecoder().decode(b64UrlDecode(s));
}

export interface GoogleJwtClaims {
  iss: string;
  aud: string;
  email?: string;
  email_verified?: boolean;
  sub?: string;
  exp: number;
  iat?: number;
}

export interface VerifyResult {
  valid: boolean;
  reason?: string;
  claims?: GoogleJwtClaims;
}

export interface VerifyOptions {
  /** Required `aud` claim (typically the endpoint URL configured on the subscription). */
  expectedAudience?: string;
  /** Required `email` claim (the service account configured on the subscription). */
  expectedEmail?: string;
  /** Clock-skew tolerance in seconds. Default 60. */
  clockSkewSeconds?: number;
}

/**
 * Verify a Google-signed RS256 JWT. Returns { valid: true, claims } on success, or
 * { valid: false, reason } on failure - always fails closed on any error.
 */
export async function verifyGoogleIdToken(
  token: string,
  options: VerifyOptions = {},
): Promise<VerifyResult> {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return { valid: false, reason: "malformed token" };

    const header = JSON.parse(b64UrlDecodeText(parts[0])) as { alg: string; kid: string };
    if (header.alg !== "RS256") return { valid: false, reason: `unexpected alg ${header.alg}` };
    if (!header.kid) return { valid: false, reason: "missing kid" };

    const keys = await fetchGooglePublicKeys();
    const key = keys.get(header.kid);
    if (!key) return { valid: false, reason: `unknown kid ${header.kid}` };

    const signingInput = new TextEncoder().encode(`${parts[0]}.${parts[1]}`);
    const signature = b64UrlDecode(parts[2]);
    const sigOk = await crypto.subtle.verify(
      "RSASSA-PKCS1-v1_5",
      key,
      signature,
      signingInput,
    );
    if (!sigOk) return { valid: false, reason: "signature verification failed" };

    const claims = JSON.parse(b64UrlDecodeText(parts[1])) as GoogleJwtClaims;
    const now = Math.floor(Date.now() / 1000);
    const skew = options.clockSkewSeconds ?? 60;

    if (!VALID_ISSUERS.has(claims.iss)) return { valid: false, reason: `bad iss ${claims.iss}` };
    if (!claims.exp || claims.exp + skew < now) return { valid: false, reason: "token expired" };

    if (options.expectedAudience && claims.aud !== options.expectedAudience) {
      return { valid: false, reason: `bad aud ${claims.aud}` };
    }
    if (options.expectedEmail) {
      if (claims.email !== options.expectedEmail) {
        return { valid: false, reason: `bad email ${claims.email}` };
      }
      if (claims.email_verified !== true) {
        return { valid: false, reason: "email not verified" };
      }
    }
    return { valid: true, claims };
  } catch (err) {
    return { valid: false, reason: err instanceof Error ? err.message : "unknown error" };
  }
}
