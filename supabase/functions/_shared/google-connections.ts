/**
 * Google accounts ("connections") of one OS user: the Google counterpart of ms-graph.ts' multi-account helpers.
 *
 * A connection is one `google_oauth_master` row (its `id` is the connection_id used everywhere). A user may have several
 * (unique per user + lower(email)); exactly one is the primary and is what every call that names no account uses.
 * Per-service rows (gmail_oauth_tokens, google_calendar_connections, drive_connections, gmail_sync_state, ...) carry the
 * same `connection_id`. A token refresh of one connection writes ONLY that connection's rows, never another account's.
 *
 * Tokens are AES-GCM encrypted with GMAIL_ENCRYPTION_KEY. New writes FAIL CLOSED if encryption is unavailable
 * (the old writers silently stored plaintext); reads still accept legacy plaintext values.
 */
import type { SupabaseClient } from "npm:@supabase/supabase-js@2";
import { decryptToken, encryptToken, isEncryptedToken } from "./crypto.ts";

const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const REFRESH_SKEW_MS = 60_000;

export interface GoogleConnection {
  id: string; user_id: string; org_id: string; email: string; label: string | null; is_primary: boolean;
  connection_status: "active" | "needs_reauth"; granted_scopes?: string[]; created_at?: string;
}
export interface ConnectionSelector { connectionId?: string | null; email?: string | null }
const CONN_COLS = "id, user_id, org_id, email, label, is_primary, connection_status, granted_scopes, created_at";

export class GoogleTokenError extends Error {
  constructor(public code: string, public status: number) { super(`Google token request failed: ${code}`); }
  /** invalid_grant: the user revoked access or the refresh token expired; they must reconnect, not retry. */
  get needsReauth(): boolean { return this.code === "invalid_grant"; }
}

/**
 * Pure choice among one user's connections: by id, else by email (case-insensitive), else the primary, else the oldest row.
 * A selector naming an account the user does not have returns null (never a different account).
 */
export function pickGoogleConnection<T extends { id: string; email: string; is_primary?: boolean; created_at?: string }>(rows: T[], sel: ConnectionSelector = {}): T | null {
  if (!rows.length) return null;
  if (sel.connectionId) return rows.find((r) => r.id === sel.connectionId) ?? null;
  if (sel.email) return rows.find((r) => r.email.toLowerCase() === String(sel.email).toLowerCase()) ?? null;
  return rows.find((r) => r.is_primary) ?? [...rows].sort((a, b) => String(a.created_at ?? "").localeCompare(String(b.created_at ?? "")))[0];
}

/** Every Google account the user has connected, primary first. */
export async function listGoogleConnections(db: SupabaseClient, userId: string): Promise<GoogleConnection[]> {
  const { data, error } = await db.from("google_oauth_master").select(CONN_COLS).eq("user_id", userId)
    .order("is_primary", { ascending: false }).order("created_at", { ascending: true });
  if (error) throw new Error(`google_oauth_master lookup failed: ${error.message}`);
  return (data ?? []) as GoogleConnection[];
}

/** The connection a call should use: the selected one, else the user's primary. Null when there is none. */
export async function resolveGoogleConnection(db: SupabaseClient, userId: string, sel: ConnectionSelector = {}): Promise<GoogleConnection | null> {
  return pickGoogleConnection(await listGoogleConnections(db, userId), sel);
}

type FetchLike = typeof fetch;
export interface RefreshedToken { access_token: string; expires_in: number; refresh_token?: string; scope?: string }

/** Refresh an access token. Unlike the legacy `refreshAccessToken` (null on any failure) this tells `invalid_grant` apart. */
export async function refreshGoogleAccessToken(refreshToken: string, fetchImpl: FetchLike = fetch, env: { get(k: string): string | undefined } = Deno.env): Promise<RefreshedToken> {
  const clientId = env.get("GOOGLE_CLIENT_ID"); const clientSecret = env.get("GOOGLE_CLIENT_SECRET");
  if (!clientId || !clientSecret) throw new GoogleTokenError("not_configured", 0);
  const res = await fetchImpl(GOOGLE_TOKEN_URL, {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ refresh_token: refreshToken, client_id: clientId, client_secret: clientSecret, grant_type: "refresh_token" }),
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) {
    let code = `http_${res.status}`;
    try { code = (JSON.parse(await res.text()) as { error?: string }).error ?? code; } catch { /* keep the http code */ }
    throw new GoogleTokenError(code, res.status);
  }
  return await res.json() as RefreshedToken;
}

/** A stored token value: encrypted (`iv:ct`) or legacy plaintext. */
export async function readStoredToken(value: string | null | undefined): Promise<string | null> {
  if (!value) return null;
  return isEncryptedToken(value) ? await decryptToken(value) : value;
}

/** Record that a connection needs the user to sign in again (revoked / expired grant). Touches only that connection. */
export async function markGoogleReauth(db: SupabaseClient, connectionId: string, code: string): Promise<void> {
  await db.from("google_oauth_master").update({ connection_status: "needs_reauth", last_refresh_error: code.slice(0, 80), refresh_failed_at: new Date().toISOString(), updated_at: new Date().toISOString() }).eq("id", connectionId);
}

/** Push a refreshed access token to this connection's per-service rows (and legacy rows of the same user+email not yet linked). */
export async function syncChildTokens(db: SupabaseClient, conn: Pick<GoogleConnection, "id" | "user_id" | "email">, access: string, expiryIso: string, refresh?: string): Promise<void> {
  const base = { token_expiry: expiryIso, updated_at: new Date().toISOString() };
  const targets: Array<[string, Record<string, unknown>]> = [
    ["gmail_oauth_tokens", { ...base, access_token: access, ...(refresh ? { refresh_token: refresh } : {}) }],
    ["google_calendar_connections", { ...base, access_token: access, ...(refresh ? { refresh_token: refresh } : {}) }],
    ["drive_connections", { ...base, access_token_encrypted: access, ...(refresh ? { refresh_token_encrypted: refresh } : {}) }],
  ];
  for (const [table, patch] of targets) {
    await db.from(table).update(patch).eq("connection_id", conn.id);
    // a legacy row written before connection_id existed: adopt it only when it is unambiguously this user + email
    const { data: legacy } = await db.from(table).select("id, email").eq("user_id", conn.user_id).is("connection_id", null);
    for (const row of (legacy ?? []) as { id: string; email: string | null }[]) {
      if ((row.email ?? "").toLowerCase() === conn.email.toLowerCase()) await db.from(table).update({ ...patch, connection_id: conn.id }).eq("id", row.id);
    }
  }
}

/**
 * A valid access token for one of the user's Google accounts (default: the primary), refreshing when it is within a minute of
 * expiry. The refreshed token is stored on that connection's rows only. `invalid_grant` marks THAT connection `needs_reauth`.
 */
export async function getGoogleAccessToken(
  db: SupabaseClient, userId: string,
  opts: ConnectionSelector & { fetchImpl?: FetchLike; now?: () => Date } = {},
): Promise<string> {
  const now = opts.now ?? (() => new Date());
  const { data: rows, error } = await db.from("google_oauth_master")
    .select(`${CONN_COLS}, encrypted_access_token, encrypted_refresh_token, token_expiry, refresh_fail_count`).eq("user_id", userId);
  if (error) throw new Error(`google_oauth_master lookup failed: ${error.message}`);
  const row = pickGoogleConnection((rows ?? []) as Array<GoogleConnection & Record<string, any>>, opts);
  if (!row) throw new Error(opts.connectionId || opts.email ? "That Google account is not connected for this user" : "Google is not connected for this user");
  if (row.connection_status === "needs_reauth") throw new Error("Google connection needs to be re-authorized");

  if (row.encrypted_access_token && new Date(row.token_expiry).getTime() - now().getTime() > REFRESH_SKEW_MS) {
    const t = await readStoredToken(row.encrypted_access_token);
    if (t) return t;
  }
  const refreshToken = await readStoredToken(row.encrypted_refresh_token);
  if (!refreshToken) { await markGoogleReauth(db, row.id, "no_refresh_token"); throw new Error("Google connection needs to be re-authorized"); }

  let tok: RefreshedToken;
  try {
    tok = await refreshGoogleAccessToken(refreshToken, opts.fetchImpl ?? fetch);
  } catch (e) {
    if (e instanceof GoogleTokenError && e.needsReauth) await markGoogleReauth(db, row.id, e.code);
    else await db.from("google_oauth_master").update({ refresh_fail_count: (row.refresh_fail_count ?? 0) + 1, last_refresh_error: String((e as Error).message).slice(0, 80), refresh_failed_at: now().toISOString() }).eq("id", row.id);
    throw e;
  }
  const expiryIso = new Date(now().getTime() + (tok.expires_in ?? 3600) * 1000).toISOString();
  const encAccess = await encryptToken(tok.access_token);                         // fail closed
  const encRefresh = tok.refresh_token ? await encryptToken(tok.refresh_token) : undefined;
  await db.from("google_oauth_master").update({
    encrypted_access_token: encAccess, ...(encRefresh ? { encrypted_refresh_token: encRefresh } : {}),
    token_expiry: expiryIso, refresh_fail_count: 0, last_refresh_error: null, connection_status: "active", updated_at: now().toISOString(),
  }).eq("id", row.id);
  await syncChildTokens(db, row, encAccess, expiryIso, encRefresh);
  return tok.access_token;
}

export interface UpsertGoogleConnectionArgs {
  orgId: string; userId: string; email: string; accessToken: string; refreshToken: string; tokenExpiry: string; scopes: string[];
}
export interface UpsertGoogleConnectionResult { connectionId: string; created: boolean; isPrimary: boolean; scopes: string[] }

const mergeScopes = (a: string[], b: string[]) => Array.from(new Set([...a, ...b]));

/**
 * Store a signed-in Google account as a connection. The same email (any case) re-authorizes its own row (tokens refreshed,
 * status active, scopes merged FOR THAT ACCOUNT ONLY); a new email creates a new row (primary only if it is the user's first).
 * Throws if the tokens cannot be encrypted: a plaintext token is never stored.
 */
export async function upsertGoogleConnection(db: SupabaseClient, a: UpsertGoogleConnectionArgs): Promise<UpsertGoogleConnectionResult> {
  const encAccess = await encryptToken(a.accessToken);
  const encRefresh = await encryptToken(a.refreshToken);
  const now = new Date().toISOString();
  const patch = { encrypted_access_token: encAccess, encrypted_refresh_token: encRefresh, token_expiry: a.tokenExpiry, connection_status: "active", last_refresh_error: null, refresh_fail_count: 0, updated_at: now };

  const find = async () => pickGoogleConnection(await listGoogleConnections(db, a.userId), { email: a.email });
  const reauth = async (row: GoogleConnection): Promise<UpsertGoogleConnectionResult> => {
    const scopes = mergeScopes(row.granted_scopes ?? [], a.scopes);
    const { error } = await db.from("google_oauth_master").update({ ...patch, granted_scopes: scopes }).eq("id", row.id);
    if (error) throw new Error(`google_oauth_master update failed: ${error.message}`);
    return { connectionId: row.id, created: false, isPrimary: row.is_primary, scopes };
  };

  const existing = await find();
  if (existing) return await reauth(existing);
  const { data, error } = await db.from("google_oauth_master").insert({ org_id: a.orgId, user_id: a.userId, email: a.email, granted_scopes: a.scopes, ...patch }).select("id, is_primary").single();
  if (error) {
    // lost a race for the same email: it exists now, so re-authorize it
    if (error.code === "23505") { const again = await find(); if (again) return await reauth(again); }
    throw new Error(`google_oauth_master insert failed: ${error.message}`);
  }
  const row = data as { id: string; is_primary: boolean };
  return { connectionId: row.id, created: true, isPrimary: Boolean(row.is_primary), scopes: a.scopes };
}
