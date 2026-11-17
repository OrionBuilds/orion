/**
 * App-only (client credentials) Microsoft Graph auth for tenant-wide jobs: the "Orion – Meeting
 * Transcripts" Entra app, separate from the delegated sign-in app in ms-graph.ts so its tenant-wide
 * application permissions sit behind their own credential.
 *
 * Secrets: MS_TRANSCRIPTS_CLIENT_ID, MS_TRANSCRIPTS_CLIENT_SECRET, and MS_TRANSCRIPTS_TENANT_ID
 * (falls back to MS_OAUTH_TENANT_ID; both apps live in the same tenant). Unset = app-only mode off.
 * Calls go through graphFetch, so only graph.microsoft.com / login.microsoftonline.com are reachable.
 */
import { MsTokenError } from "./ms-graph.ts";

type FetchLike = typeof fetch;

export interface MsAppConfig {
  clientId: string;
  clientSecret: string;
  tenantId: string;
}

export function msAppConfig(env: { get(k: string): string | undefined } = Deno.env): MsAppConfig | null {
  const clientId = env.get("MS_TRANSCRIPTS_CLIENT_ID")?.trim();
  const clientSecret = env.get("MS_TRANSCRIPTS_CLIENT_SECRET")?.trim();
  const tenantId = (env.get("MS_TRANSCRIPTS_TENANT_ID") ?? env.get("MS_OAUTH_TENANT_ID"))?.trim();
  if (!clientId || !clientSecret || !tenantId) return null;
  return { clientId, clientSecret, tenantId };
}

let cached: { token: string; expiresAt: number; clientId: string } | null = null;

/** A Graph token for the app itself (scope .default = the application permissions admin-consented). */
export async function getAppToken(cfg: MsAppConfig, fetchImpl: FetchLike = fetch, now = Date.now()): Promise<string> {
  if (cached && cached.clientId === cfg.clientId && cached.expiresAt - now > 60_000) return cached.token;
  const r = await fetchImpl(`https://login.microsoftonline.com/${cfg.tenantId}/oauth2/v2.0/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: cfg.clientId,
      client_secret: cfg.clientSecret,
      scope: "https://graph.microsoft.com/.default",
      grant_type: "client_credentials",
    }),
  });
  const text = await r.text();
  if (!r.ok) {
    let code = `http_${r.status}`;
    try { code = (JSON.parse(text) as { error?: string }).error ?? code; } catch { /* keep http code */ }
    throw new MsTokenError(code, r.status);
  }
  const j = JSON.parse(text) as { access_token: string; expires_in?: number };
  cached = { token: j.access_token, expiresAt: now + (j.expires_in ?? 3600) * 1000, clientId: cfg.clientId };
  return j.access_token;
}

/** Test hook: forget the cached token. */
export function resetAppTokenCache(): void {
  cached = null;
}
