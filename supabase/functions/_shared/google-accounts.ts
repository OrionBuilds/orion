/**
 * Multi-account Google logic shared by google-oauth-unified, the legacy gmail/drive/calendar OAuth functions, the
 * token cron and `google-accounts`. The Google counterpart of ms-accounts.ts. A connection is one `google_oauth_master`
 * row (its id is the connection_id). Kept out of the function entrypoints (which call Deno.serve at import) so every
 * behaviour here can be unit-tested with FakeSupabase.
 *
 * Works on BOTH schema steps: nothing here uses ON CONFLICT on a connection_id unique; every per-connection insert sets
 * connection_id (select-then-insert/update, adopting a legacy row with connection_id NULL).
 */
import type { SupabaseClient } from "npm:@supabase/supabase-js@2";
import { encryptToken, signState, verifyState } from "./crypto.ts";
import { enqueueMailboxJob, saveSyncState, type GmailMailbox } from "./gmail-mailbox.ts";
import {
  crossPopulateServiceTables,
  hasCalendarScopes,
  hasDriveScopes,
  hasGmailScopes,
  type CrossPopulateResult,
} from "./google-oauth-helpers.ts";
import {
  getGoogleAccessToken,
  GoogleTokenError,
  listGoogleConnections,
  markGoogleReauth,
  pickGoogleConnection,
  readStoredToken,
  refreshGoogleAccessToken,
  syncChildTokens,
  upsertGoogleConnection,
  type GoogleConnection,
  type UpsertGoogleConnectionResult,
} from "./google-connections.ts";

type Sb = SupabaseClient;
type FetchLike = typeof fetch;

export const GMAIL_API_URL = "https://gmail.googleapis.com/gmail/v1";
export const GOOGLE_USERINFO_URL = "https://www.googleapis.com/oauth2/v2/userinfo";
const GOOGLE_REVOKE_URL = "https://oauth2.googleapis.com/revoke";
export const STATE_MAX_AGE_MS = 10 * 60 * 1000;

/* ------------------------------------------------------------------ signed OAuth state */

export interface GoogleOAuthState {
  userId: string; orgId: string; redirectUri: string; appOrigin?: string; mode?: "add"; ts: number;
}

/** Sign the OAuth state. Throws when signing is not configured: the caller must fail closed (no unsigned fallback). */
export async function signGoogleState(state: GoogleOAuthState): Promise<string> {
  return await signState(JSON.stringify(state));
}

export type ReadStateResult =
  | { ok: true; state: GoogleOAuthState }
  | { ok: false; reason: "missing" | "invalid" | "expired" };

/**
 * Verify a state value. ONLY an HMAC-signed state is accepted: a bare base64 JSON blob (the old unsigned fallback), a bad
 * signature, a missing signing key or a malformed value is "invalid". A signed state older than 10 minutes is "expired".
 */
export async function readGoogleState(raw: string | null | undefined, now = Date.now()): Promise<ReadStateResult> {
  if (!raw) return { ok: false, reason: "missing" };
  let payload: string | null = null;
  try { payload = await verifyState(raw); } catch { payload = null; }
  if (!payload) return { ok: false, reason: "invalid" };
  let s: Partial<GoogleOAuthState>;
  try { s = JSON.parse(payload); } catch { return { ok: false, reason: "invalid" }; }
  if (!s || typeof s.userId !== "string" || typeof s.orgId !== "string" || typeof s.redirectUri !== "string" || typeof s.ts !== "number") {
    return { ok: false, reason: "invalid" };
  }
  if (now - s.ts > STATE_MAX_AGE_MS) return { ok: false, reason: "expired" };
  return { ok: true, state: s as GoogleOAuthState };
}

/** Request parsing for `/start`: `{redirect_uri?, mode?:'add', login_hint?}` plus the `app_origin` query parameter. */
export function parseStartRequest(body: unknown, query: URLSearchParams): { appOrigin: string; mode?: "add"; loginHint?: string } {
  const b = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  let appOrigin = query.get("app_origin") || "";
  if (!appOrigin && typeof b.redirect_uri === "string") {
    try {
      const u = new URL(b.redirect_uri);
      if (u.protocol === "https:" || u.protocol === "http:") appOrigin = u.origin;
    } catch { /* ignore */ }
  }
  const hint = typeof b.login_hint === "string" ? b.login_hint.trim() : "";
  return {
    appOrigin,
    ...(b.mode === "add" ? { mode: "add" as const } : {}),
    ...(hint && hint.length <= 254 ? { loginHint: hint } : {}),
  };
}

/** The Google consent URL. Adding an account (or hinting one) forces the account chooser; offline access and all scopes are kept. */
export function buildGoogleAuthUrl(o: { clientId: string; callbackUri: string; scopes: readonly string[]; state: string; mode?: "add"; loginHint?: string }): string {
  const u = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  u.searchParams.set("client_id", o.clientId);
  u.searchParams.set("redirect_uri", o.callbackUri);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("scope", o.scopes.join(" "));
  u.searchParams.set("access_type", "offline");
  u.searchParams.set("prompt", o.mode === "add" || o.loginHint ? "select_account consent" : "consent");
  u.searchParams.set("include_granted_scopes", "true");
  if (o.loginHint) u.searchParams.set("login_hint", o.loginHint);
  u.searchParams.set("state", o.state);
  return u.toString();
}

/* ------------------------------------------------------------------ connecting an account */

/** The signed-in account's email from Google userinfo, or null when Google does not give one. */
export async function fetchGoogleEmail(accessToken: string, fetchImpl: FetchLike = fetch): Promise<string | null> {
  try {
    const res = await fetchImpl(GOOGLE_USERINFO_URL, { headers: { Authorization: `Bearer ${accessToken}` }, signal: AbortSignal.timeout(8000) });
    if (!res.ok) return null;
    const info = await res.json() as { email?: string };
    const email = typeof info.email === "string" ? info.email.trim() : "";
    return email.includes("@") ? email : null;
  } catch {
    return null;
  }
}

export interface ConnectGoogleInput {
  orgId: string; userId: string; email: string; accessToken: string; refreshToken: string; tokenExpiry: string; scopes: string[];
}
export interface ConnectGoogleResult extends UpsertGoogleConnectionResult { cross: CrossPopulateResult }

/**
 * Store one Google account and fan its grant out to ITS per-service rows. Same email = re-auth of that connection; a new
 * email = a new connection (primary only if it is the user's first). Another account of the user is never touched.
 * Fails closed when tokens cannot be encrypted.
 */
export async function connectGoogleAccount(db: Sb, c: ConnectGoogleInput): Promise<ConnectGoogleResult> {
  const up = await upsertGoogleConnection(db, c);
  const cross = await crossPopulateServiceTables(db, c.orgId, c.userId, c.email, c.accessToken, c.refreshToken, c.tokenExpiry, up.scopes, up.connectionId);
  return { ...up, cross };
}

/** Enqueue the calendar initial_sync for ONE calendar connection row (skipped when a job is already in flight). */
export async function enqueueCalendarInitialSync(db: Sb, orgId: string, calendarConnectionId: string): Promise<void> {
  // Same vocabulary as google-calendar-sync-runner/-cron: pending|processing, `attempts`, no user_id column.
  const { data: existingJobs } = await db.from("google_calendar_sync_jobs").select("id")
    .eq("connection_id", calendarConnectionId).in("status", ["pending", "processing"]).limit(1);
  if (existingJobs && (existingJobs as unknown[]).length > 0) return;
  const { error } = await db.from("google_calendar_sync_jobs").insert({
    org_id: orgId, connection_id: calendarConnectionId, job_type: "initial_sync", status: "pending",
    scheduled_at: new Date().toISOString(), attempts: 0, max_attempts: 5,
  });
  if (error) console.error("[google-accounts] failed to enqueue initial_sync:", error.message);
}

export interface RegisterMailboxInput {
  orgId: string; userId: string; connectionId: string; email: string; isPrimary: boolean; accessToken: string;
  pubsubTopic?: string | null; supabaseUrl: string; serviceKey: string;
  /** The legacy callback awaited the first sync trigger; the unified one fired it and moved on. */
  awaitSyncTrigger?: boolean; fetchImpl?: FetchLike;
}

/**
 * Gmail setup for ONE connection: register the push watch, write that connection's gmail_sync_state (select-then-insert/update,
 * adopting the primary's legacy row), queue its initial sync job and trigger gmail-sync. The history cursor is only set from a
 * successful watch of THIS mailbox, so connecting or re-authorizing one account never resets another account's cursor.
 */
export async function registerGmailMailbox(db: Sb, a: RegisterMailboxInput): Promise<void> {
  const f = a.fetchImpl ?? fetch;
  const now = new Date().toISOString();
  let historyId: string | null = null;
  let watchExpiration: string | null = null;
  if (a.pubsubTopic) {
    try {
      const res = await f(`${GMAIL_API_URL}/users/me/watch`, {
        method: "POST",
        headers: { Authorization: `Bearer ${a.accessToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({ topicName: a.pubsubTopic, labelIds: ["INBOX", "SENT"], labelFilterBehavior: "include" }),
        signal: AbortSignal.timeout(8000),
      });
      if (res.ok) {
        const w = await res.json();
        historyId = String(w.historyId);
        watchExpiration = new Date(Number(w.expiration)).toISOString();
      } else {
        console.error("[google-accounts] Gmail watch registration failed:", res.status);
      }
    } catch (e) {
      console.error("[google-accounts] Gmail watch error:", (e as Error).message);
    }
  }
  const watchPatch = historyId ? { history_id: historyId, watch_expiration: watchExpiration } : {};

  const mb: GmailMailbox = { connectionId: a.connectionId, userId: a.userId, orgId: a.orgId, email: a.email, isPrimary: a.isPrimary };
  // per-mailbox state (the primary adopts its legacy row) and first-sync job, via the shared mailbox helpers
  await saveSyncState(db, mb, { sync_status: "idle", ...watchPatch, updated_at: now });
  await enqueueMailboxJob(db, mb, "initial");

  const trigger = f(`${a.supabaseUrl}/functions/v1/gmail-sync`, {
    method: "POST",
    headers: { Authorization: `Bearer ${a.serviceKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ org_id: a.orgId, user_id: a.userId, connection_id: a.connectionId }),
  }).then(() => {}).catch((err) => console.error("[google-accounts] Failed to trigger gmail-sync:", (err as Error).message));
  if (a.awaitSyncTrigger) await trigger;
}

/** Primary first, then oldest first (done in code too, so the order never depends on the query builder). */
function sortPrimaryFirst<T extends { is_primary?: boolean; created_at?: string }>(rows: T[]): T[] {
  return [...rows].sort((x, y) => Number(!!y.is_primary) - Number(!!x.is_primary) || String(x.created_at ?? "").localeCompare(String(y.created_at ?? "")));
}

/* ------------------------------------------------------------------ status */

export interface PublicConnectionRef { id: string; email: string; label: string | null; is_primary: boolean; connection_status: string }

export interface ConnectionStatusOptions {
  /** Refresh the primary's token (default: getGoogleAccessToken for that connection). */
  getToken?: (connectionId: string) => Promise<string>;
  refreshTimeoutMs?: number;
}

/**
 * Body of `google-oauth-unified /connection`: the PRIMARY account's legacy shape (unchanged for one-account users) plus
 * `accounts:[{id,email,label,is_primary,connection_status}]` for everyone. An expired primary token is refreshed silently.
 */
export async function getGoogleConnectionStatus(db: Sb, userId: string, opts: ConnectionStatusOptions = {}): Promise<Record<string, unknown>> {
  const { data, error } = await db.from("google_oauth_master")
    .select("id, org_id, email, label, is_primary, connection_status, granted_scopes, token_expiry, created_at, updated_at")
    .eq("user_id", userId).order("is_primary", { ascending: false }).order("created_at", { ascending: true });
  if (error) throw new Error(`google_oauth_master lookup failed: ${error.message}`);
  const rows = sortPrimaryFirst((data ?? []) as Array<GoogleConnection & { token_expiry: string }>);
  const accounts: PublicConnectionRef[] = rows.map((r) => ({
    id: r.id, email: r.email, label: r.label ?? null, is_primary: !!r.is_primary, connection_status: r.connection_status,
  }));

  if (rows.length === 0) {
    const first = async (table: string, cols: string) => {
      const { data: d } = await db.from(table).select(cols).eq("user_id", userId).limit(1);
      return ((d ?? []) as Array<Record<string, unknown>>)[0] ?? null;
    };
    const calConn = await first("google_calendar_connections", "email, scopes, created_at");
    const gmailToken = await first("gmail_oauth_tokens", "email, created_at");
    const driveConn = await first("drive_connections", "email, scopes, created_at");
    const hasAny = !!(calConn || gmailToken || driveConn);
    return {
      connected: hasAny, legacy: hasAny,
      email: (calConn?.email as string) || (gmailToken?.email as string) || (driveConn?.email as string) || null,
      gmail: !!gmailToken, calendar: !!calConn, drive: !!driveConn, scopes: [], accounts,
    };
  }

  const master = pickGoogleConnection(rows) as GoogleConnection & { token_expiry: string };
  const scopes = master.granted_scopes || [];
  let tokenExpired = master.connection_status === "needs_reauth";
  if (!tokenExpired && new Date(master.token_expiry) <= new Date()) {
    const getToken = opts.getToken ?? ((id: string) => getGoogleAccessToken(db, userId, { connectionId: id }));
    try {
      const result = await Promise.race([
        getToken(master.id).then(() => true, () => false),
        new Promise<boolean>((resolve) => setTimeout(() => resolve(false), opts.refreshTimeoutMs ?? 12000)),
      ]);
      if (!result) tokenExpired = true;
    } catch {
      tokenExpired = true;
    }
  }
  return {
    connected: true, legacy: false, email: master.email,
    gmail: hasGmailScopes(scopes), calendar: hasCalendarScopes(scopes), drive: hasDriveScopes(scopes),
    scopes, connectedAt: master.created_at, tokenExpired, accounts,
  };
}

/* ------------------------------------------------------------------ disconnect */

export interface GoogleDisconnectResult { status: number; body: Record<string, unknown> }

export async function revokeGoogleToken(token: string, fetchImpl: FetchLike = fetch): Promise<void> {
  try {
    await fetchImpl(GOOGLE_REVOKE_URL, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ token }), signal: AbortSignal.timeout(8000) });
  } catch {
    // Revocation is best-effort: the local tokens are deleted regardless.
    console.error("[google-accounts] Failed to revoke Google token");
  }
}

const CALENDAR_CHILD_TABLES = ["google_calendar_sync_jobs", "calendar_event_map", "calendar_sync_logs", "google_calendar_events", "google_calendar_list"] as const;

async function deleteCalendarChildren(db: Sb, calendarConnectionIds: string[]): Promise<void> {
  for (const calId of calendarConnectionIds) {
    for (const t of CALENDAR_CHILD_TABLES) await db.from(t).delete().eq("connection_id", calId);
  }
}

/**
 * Remove one Google account (`connectionId`) or, with none and exactly one account, everything as before. With several
 * accounts and no id it refuses (400); an id that is not the caller's is 404. Removing the primary makes the DB promote the
 * oldest remaining account and move the user_connected_accounts mirror. The users.gmail_connected / google_drive_connected
 * flags are cleared only when no remaining account has that service.
 */
export async function disconnectGoogle(
  db: Sb, userId: string, connectionId?: string | null,
  opts: { revoke?: (token: string) => Promise<void> } = {},
): Promise<GoogleDisconnectResult> {
  const revoke = opts.revoke ?? ((t: string) => revokeGoogleToken(t));
  const conns = await listGoogleConnections(db, userId);
  if (connectionId) {
    if (!conns.some((c) => c.id === connectionId)) return { status: 404, body: { error: "That Google account is not connected" } };
  } else if (conns.length > 1) {
    return { status: 400, body: { error: "You have more than one Google account connected; choose which account to disconnect (connection_id)." } };
  }
  const target = connectionId ?? conns[0]?.id ?? null;
  const last = conns.length <= 1;

  // revoke the account's grant before its rows are gone
  if (target) {
    const { data: m } = await db.from("google_oauth_master").select("encrypted_access_token, encrypted_refresh_token").eq("id", target).limit(1);
    const row = ((m ?? []) as Array<{ encrypted_access_token: string | null; encrypted_refresh_token: string | null }>)[0];
    try {
      const token = (await readStoredToken(row?.encrypted_refresh_token)) ?? (await readStoredToken(row?.encrypted_access_token));
      if (token) await revoke(token);
    } catch {
      console.error("[google-accounts] could not read the token to revoke");
    }
  }

  const calQ = db.from("google_calendar_connections").select("id");
  const { data: calRows } = await (last ? calQ.eq("user_id", userId) : calQ.eq("connection_id", target));
  await deleteCalendarChildren(db, ((calRows ?? []) as { id: string }[]).map((r) => r.id));

  const scoped = (table: string) => last ? db.from(table).delete().eq("user_id", userId) : db.from(table).delete().eq("connection_id", target);
  for (const t of ["google_calendar_connections", "gmail_oauth_tokens", "gmail_sync_state", "gmail_sync_jobs", "drive_connections"]) await scoped(t);
  if (!last) {
    await db.from("drive_files").delete().eq("connection_id", target);
    await db.from("drive_folders").delete().eq("connection_id", target);
  }

  const { error } = await (last ? db.from("google_oauth_master").delete().eq("user_id", userId) : db.from("google_oauth_master").delete().eq("id", target));
  if (error) {
    console.error("[google-disconnect]", error.message);
    return { status: 500, body: { error: "Failed to disconnect" } };
  }

  const now = new Date().toISOString();
  if (last) {
    await db.from("users").update({ gmail_connected: false, google_drive_connected: false, updated_at: now }).eq("id", userId);
    await db.from("user_connected_accounts").delete().eq("user_id", userId)
      .in("provider", ["google_workspace", "google_gmail", "google_drive", "google_calendar", "google_chat"]);
  } else {
    const has = async (table: string) => {
      const { data } = await db.from(table).select("id").eq("user_id", userId).limit(1);
      return ((data ?? []) as unknown[]).length > 0;
    };
    const patch: Record<string, unknown> = {};
    if (!(await has("gmail_oauth_tokens"))) patch.gmail_connected = false;
    if (!(await has("drive_connections"))) patch.google_drive_connected = false;
    if (Object.keys(patch).length) await db.from("users").update({ ...patch, updated_at: now }).eq("id", userId);
  }

  await db.from("audit_logs").insert({
    user_id: userId, action: "google_unified_disconnected", entity_type: "google_oauth_master",
    after_state: { disconnected_at: now, ...(target ? { connection_id: target } : {}) },
  });
  return { status: 200, body: { success: true } };
}

/* ------------------------------------------------------------------ google-accounts function */

export interface PublicGoogleAccount {
  id: string; email: string; label: string | null; is_primary: boolean; connection_status: string;
  last_refresh_error: string | null; granted_scopes: string[];
}
const PUBLIC_COLS = "id, email, label, is_primary, connection_status, last_refresh_error, granted_scopes, created_at";

/** The caller's Google accounts, primary first, never a token column. */
export async function listPublicGoogleAccounts(db: Sb, userId: string): Promise<PublicGoogleAccount[]> {
  const { data, error } = await db.from("google_oauth_master").select(PUBLIC_COLS).eq("user_id", userId)
    .order("is_primary", { ascending: false }).order("created_at", { ascending: true });
  if (error) throw new Error(error.message);
  return sortPrimaryFirst((data ?? []) as Array<Record<string, unknown> & { is_primary?: boolean; created_at?: string }>).map((r) => ({
    id: r.id as string, email: r.email as string, label: (r.label as string | null) ?? null, is_primary: !!r.is_primary,
    connection_status: r.connection_status as string, last_refresh_error: (r.last_refresh_error as string | null) ?? null,
    granted_scopes: Array.isArray(r.granted_scopes) ? r.granted_scopes as string[] : [],
  }));
}

export type GoogleAccountsAction =
  | { action: "list" }
  | { action: "set-primary"; connection_id: string }
  | { action: "set-label"; connection_id: string; label?: string | null };

/** Owner-scoped actions behind `google-accounts`. A connection id that is not the caller's is refused (404). */
export async function runGoogleAccountsAction(db: Sb, userId: string, req: GoogleAccountsAction): Promise<GoogleDisconnectResult> {
  if (req?.action === "list") return { status: 200, body: { accounts: await listPublicGoogleAccounts(db, userId) } };
  if (req?.action !== "set-primary" && req?.action !== "set-label") return { status: 400, body: { error: "Unknown action" } };
  if (!req.connection_id || typeof req.connection_id !== "string") return { status: 400, body: { error: "connection_id required" } };
  const mine = await listGoogleConnections(db, userId);
  if (!mine.some((c) => c.id === req.connection_id)) return { status: 404, body: { error: "That Google account is not connected" } };
  const { error } = req.action === "set-primary"
    ? await db.rpc("google_set_primary", { p_connection: req.connection_id })
    : await db.rpc("google_set_label", { p_connection: req.connection_id, p_label: typeof req.label === "string" ? req.label : "" });
  if (error) return { status: 500, body: { error: "Update failed" } };
  return { status: 200, body: { accounts: await listPublicGoogleAccounts(db, userId) } };
}

/* ------------------------------------------------------------------ token cron */

/**
 * Cron core: every active master row whose access token expires inside the window (soonest first, capped per run, rows at
 * the failure cap skipped) is refreshed with ITS OWN refresh token. A failure is recorded on that row only: `invalid_grant`
 * flips it to needs_reauth (so it leaves the queue), anything else bumps its fail counter. One bad account never blocks the others.
 * The refresh is forced (getGoogleAccessToken would return a still-valid cached token inside the window).
 */
export async function refreshStaleGoogleConnections(
  db: Sb,
  opts: { windowMs?: number; maxBatch?: number; maxFail?: number; fetchImpl?: FetchLike } = {},
): Promise<{ total: number; refreshed: number; failed: number; errors: string[] }> {
  const windowMs = opts.windowMs ?? 10 * 60 * 1000;
  const { data: rows, error } = await db.from("google_oauth_master")
    .select("id, user_id, email, encrypted_refresh_token, refresh_fail_count")
    .eq("connection_status", "active")
    .lt("token_expiry", new Date(Date.now() + windowMs).toISOString())
    .lt("refresh_fail_count", opts.maxFail ?? 5)
    .order("token_expiry", { ascending: true })
    .limit(opts.maxBatch ?? 20);
  if (error) throw new Error(error.message);
  const list = (rows ?? []) as Array<GoogleConnection & { encrypted_refresh_token: string | null; refresh_fail_count: number | null }>;
  let refreshed = 0;
  const errors: string[] = [];
  for (const row of list) {
    try {
      let refreshToken: string | null = null;
      try { refreshToken = await readStoredToken(row.encrypted_refresh_token); } catch { refreshToken = null; }
      if (!refreshToken) { await markGoogleReauth(db, row.id, "no_refresh_token"); throw new Error("no refresh token"); }
      let tok;
      try {
        tok = await refreshGoogleAccessToken(refreshToken, opts.fetchImpl ?? fetch);
      } catch (e) {
        if (e instanceof GoogleTokenError && e.needsReauth) await markGoogleReauth(db, row.id, e.code);
        else await db.from("google_oauth_master").update({
          refresh_fail_count: (row.refresh_fail_count ?? 0) + 1, last_refresh_error: String((e as Error).message).slice(0, 80), refresh_failed_at: new Date().toISOString(),
        }).eq("id", row.id);
        throw e;
      }
      const expiryIso = new Date(Date.now() + (tok.expires_in ?? 3600) * 1000).toISOString();
      const encAccess = await encryptToken(tok.access_token);
      const encRefresh = tok.refresh_token ? await encryptToken(tok.refresh_token) : undefined;
      await db.from("google_oauth_master").update({
        encrypted_access_token: encAccess, ...(encRefresh ? { encrypted_refresh_token: encRefresh } : {}),
        token_expiry: expiryIso, refresh_fail_count: 0, refresh_failed_at: null, last_refresh_error: null, connection_status: "active", updated_at: new Date().toISOString(),
      }).eq("id", row.id);
      await syncChildTokens(db, row, encAccess, expiryIso, encRefresh);
      refreshed++;
    } catch (e) {
      errors.push(`Connection ${row.id}: ${(e as Error).message}`);
      console.error(`[TokenRefreshCron] connection ${row.id}: ${(e as Error).message}`);
    }
  }
  return { total: list.length, refreshed, failed: errors.length, errors };
}

/* ------------------------------------------------------------------ calendar connection handlers */

export interface CalendarRow {
  id: string; user_id: string; org_id: string; email: string | null; connection_id: string | null;
  access_token: string; refresh_token: string; token_expiry: string; selected_calendar_ids: string[]; created_at?: string;
  [k: string]: unknown;
}

/**
 * The caller's calendar connection row for a request. `connectionId` may be the account's master id (what the account list
 * shows) or the calendar row's own id; an id that is not the caller's is "not_found". With no id: the primary account's row,
 * else the oldest row. "not_connected" when the user has none.
 */
export async function resolveCalendarRow(db: Sb, userId: string, connectionId?: string | null): Promise<{ row: CalendarRow } | { error: "not_found" | "not_connected" }> {
  const { data, error } = await db.from("google_calendar_connections").select("*").eq("user_id", userId);
  if (error) throw new Error(`google_calendar_connections lookup failed: ${error.message}`);
  const rows = ((data ?? []) as CalendarRow[]).slice().sort((a, b) => String(a.created_at ?? "").localeCompare(String(b.created_at ?? "")));
  if (connectionId) {
    const row = rows.find((r) => r.connection_id === connectionId || r.id === connectionId);
    return row ? { row } : { error: "not_found" };
  }
  if (!rows.length) return { error: "not_connected" };
  const primary = pickGoogleConnection(await listGoogleConnections(db, userId));
  return { row: (primary && rows.find((r) => r.connection_id === primary.id)) || rows[0] };
}

/**
 * A valid access token for a calendar row: through its master connection (refresh written for that connection only),
 * or, for a legacy calendar-only row with no master, a refresh of that row's own token written back to that row only.
 */
export async function getCalendarAccessToken(db: Sb, row: CalendarRow, opts: { fetchImpl?: FetchLike } = {}): Promise<string> {
  if (row.connection_id) return await getGoogleAccessToken(db, row.user_id, { connectionId: row.connection_id, fetchImpl: opts.fetchImpl });
  const access = await readStoredToken(row.access_token);
  if (access && new Date(row.token_expiry).getTime() - Date.now() > 60_000) return access;
  const refresh = await readStoredToken(row.refresh_token);
  if (!refresh) throw new Error("Google calendar connection needs to be re-authorized");
  const tok = await refreshGoogleAccessToken(refresh, opts.fetchImpl ?? fetch);
  await db.from("google_calendar_connections").update({
    access_token: await encryptToken(tok.access_token),
    token_expiry: new Date(Date.now() + (tok.expires_in ?? 3600) * 1000).toISOString(),
    updated_at: new Date().toISOString(),
  }).eq("id", row.id);
  return tok.access_token;
}

/** The old "primary + the account's own email" duplicate rule for the selected calendars list. */
export function dedupeSelectedCalendars(calendarIds: string[], connEmail: string | null | undefined): string[] {
  const email = connEmail?.toLowerCase();
  const hasPrimary = calendarIds.includes("primary");
  const hasEmail = !!email && calendarIds.some((id) => id.toLowerCase() === email);
  return hasPrimary && hasEmail ? calendarIds.filter((id) => id !== "primary") : calendarIds;
}

/** Remove one calendar connection (children, row, grant). With several rows and no id: 400; an id that is not the caller's: 404. */
export async function disconnectGoogleCalendar(
  db: Sb, userId: string, connectionId?: string | null, opts: { revoke?: (token: string) => Promise<void> } = {},
): Promise<GoogleDisconnectResult> {
  const revoke = opts.revoke ?? ((t: string) => revokeGoogleToken(t));
  const { data } = await db.from("google_calendar_connections").select("id, connection_id, access_token").eq("user_id", userId);
  const rows = (data ?? []) as Array<{ id: string; connection_id: string | null; access_token: string | null }>;
  let row: (typeof rows)[number] | undefined;
  if (connectionId) {
    row = rows.find((r) => r.connection_id === connectionId || r.id === connectionId);
    if (!row) return { status: 404, body: { error: "That Google calendar is not connected" } };
  } else if (rows.length > 1) {
    return { status: 400, body: { error: "You have more than one Google account connected; choose which account to disconnect (connection_id)." } };
  } else {
    row = rows[0];
  }
  if (!row) return { status: 200, body: { success: true } };
  try {
    const token = await readStoredToken(row.access_token);
    if (token) await revoke(token);
  } catch {
    console.error("[google-calendar-oauth] could not read the token to revoke");
  }
  await deleteCalendarChildren(db, [row.id]);
  const { error } = await db.from("google_calendar_connections").delete().eq("id", row.id);
  if (error) return { status: 500, body: { error: "Failed to disconnect" } };
  return { status: 200, body: { success: true } };
}

/**
 * Per user, the Google calendar row to report in team-connections: the primary account's row when it has one, else the
 * oldest. Accepts the embed as an object (one row) or an array (several).
 */
export function pickTeamGoogleRow<T extends { connection_id?: string | null; created_at?: string | null }>(
  embed: T | T[] | null | undefined, primaryMasterIds: ReadonlySet<string>,
): T | null {
  const rows = embed ? (Array.isArray(embed) ? embed : [embed]) : [];
  if (!rows.length) return null;
  return rows.find((r) => r.connection_id && primaryMasterIds.has(r.connection_id))
    ?? [...rows].sort((a, b) => String(a.created_at ?? "").localeCompare(String(b.created_at ?? "")))[0];
}
