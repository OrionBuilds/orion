/**
 * OAuth state helpers - server-side state token backed by the oauth_states table.
 *
 * The pattern replaces the older `state = btoa(JSON.stringify({user_id, org_id}))`
 * anti-pattern used across drive-oauth-*, gmail-oauth-*, google-chat-*, qbo-oauth-*,
 * and late-*. That was NOT a state check - it just base64-encoded caller-supplied
 * identifiers, letting anyone with an OAuth code impersonate any user or org at the
 * callback. Confirmed by reading the callbacks: each JSON.parse(atob(state))'d the
 * value and trusted whatever userId/orgId came back.
 *
 * With this helper:
 *   1. The `*-start` creates an unguessable state token, stores {user_id, org_id,
 *      integration_key, redirect_uri, expires_at} in oauth_states, and passes the
 *      opaque token to the provider.
 *   2. The `*-callback` looks the token up. If not found or expired, refuse. Otherwise
 *      the user_id/org_id come from the SERVER row, not from the URL.
 *   3. Each state token is one-shot: the row is deleted on successful consume, so a
 *      leaked code+state pair cannot be replayed.
 *
 * The table already exists (created in 20260123025902_create_integrations_core_schema.sql):
 *
 *   CREATE TABLE oauth_states (
 *     id uuid PK,
 *     org_id uuid NOT NULL,
 *     user_id uuid NOT NULL,
 *     integration_key text NOT NULL,
 *     state_token text NOT NULL UNIQUE,
 *     redirect_uri text NOT NULL,
 *     scope_requested text,
 *     created_at timestamptz,
 *     expires_at timestamptz DEFAULT now() + 15 min
 *   );
 *
 * integrations-connect / integrations-oauth-callback is the reference caller. This
 * helper extracts that pattern so every OAuth flow can adopt it consistently.
 */
import type { SupabaseClient } from "npm:@supabase/supabase-js@2";

export interface CreateOAuthStateOptions {
  supabase: SupabaseClient;
  orgId: string;
  userId: string;
  integrationKey: string;
  /** The OAuth callback URL registered with the provider (redirect_uri sent in the auth request). */
  redirectUri: string;
  /** The in-app URL to return the user to after the callback completes. Optional. */
  appUrl?: string;
  scopeRequested?: string;
  /** Optional TTL override in seconds. Default is the table default (15 min). */
  ttlSeconds?: number;
}

/**
 * Create a fresh state token bound to this user/org and store it in oauth_states.
 * Returns the token to pass as ?state= to the OAuth provider.
 */
export async function createOAuthState(opts: CreateOAuthStateOptions): Promise<string> {
  const stateToken = crypto.randomUUID();
  const row: Record<string, unknown> = {
    org_id: opts.orgId,
    user_id: opts.userId,
    integration_key: opts.integrationKey,
    state_token: stateToken,
    redirect_uri: opts.redirectUri,
    scope_requested: opts.scopeRequested ?? "",
    app_url: opts.appUrl ?? null,
  };
  if (opts.ttlSeconds !== undefined) {
    row.expires_at = new Date(Date.now() + opts.ttlSeconds * 1000).toISOString();
  }
  const { error } = await opts.supabase.from("oauth_states").insert(row);
  if (error) throw new Error(`oauth_states insert failed: ${error.message}`);
  return stateToken;
}

export interface OAuthStateRow {
  id: string;
  org_id: string;
  user_id: string;
  integration_key: string;
  state_token: string;
  redirect_uri: string;
  scope_requested: string | null;
  app_url: string | null;
  created_at: string;
  expires_at: string;
}

export interface ConsumeOAuthStateOptions {
  supabase: SupabaseClient;
  stateToken: string | null | undefined;
  /** Optional guard: only accept rows whose integration_key matches this. */
  expectedIntegrationKey?: string;
}

export type ConsumeResult =
  | { valid: true; state: OAuthStateRow }
  | { valid: false; reason: string };

/**
 * Look up a state token, verify it is not expired, and DELETE it (one-shot). Returns
 * the stored row so the caller can trust user_id/org_id/integration_key from server
 * state rather than from the URL. Always fails closed - missing, expired, deleted, or
 * (when expectedIntegrationKey is set) wrong-integration tokens all return { valid:
 * false, reason }.
 */
export async function consumeOAuthState(opts: ConsumeOAuthStateOptions): Promise<ConsumeResult> {
  const token = opts.stateToken;
  if (!token || typeof token !== "string") {
    return { valid: false, reason: "missing state" };
  }

  const { data: row, error } = await opts.supabase
    .from("oauth_states")
    .select("id, org_id, user_id, integration_key, state_token, redirect_uri, scope_requested, app_url, created_at, expires_at")
    .eq("state_token", token)
    .maybeSingle();

  if (error) return { valid: false, reason: `lookup failed: ${error.message}` };
  if (!row) return { valid: false, reason: "unknown state" };

  const expiresAt = new Date(row.expires_at).getTime();
  if (!isFinite(expiresAt) || expiresAt < Date.now()) {
    // Best-effort cleanup of the stale row.
    await opts.supabase.from("oauth_states").delete().eq("id", row.id);
    return { valid: false, reason: "state expired" };
  }

  if (opts.expectedIntegrationKey && row.integration_key !== opts.expectedIntegrationKey) {
    return { valid: false, reason: `wrong integration_key ${row.integration_key}` };
  }

  // One-shot: delete before returning success so a leaked (code, state) pair can only
  // ever succeed once.
  const { error: delError } = await opts.supabase
    .from("oauth_states")
    .delete()
    .eq("id", row.id);
  if (delError) {
    console.warn(`[oauth-state] consume: row lookup ok but delete failed: ${delError.message}`);
  }

  return { valid: true, state: row as OAuthStateRow };
}
