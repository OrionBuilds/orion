/**
 * Google Calendar side of the several-Google-accounts-per-user model (see google-connections.ts).
 *
 * Two different ids are in play, do not mix them up:
 *   - `google_calendar_connections.id`            the calendar connection row. The event tables (google_calendar_events,
 *                                                  calendar_event_map, google_calendar_sync_jobs, google_meet_sessions)
 *                                                  carry THIS id as their `connection_id`.
 *   - `google_calendar_connections.connection_id` the master row (`google_oauth_master.id`) = the Google ACCOUNT.
 *
 * A caller-supplied `connection_id` may be either one (the UI knows the account id; event rows know the calendar row id);
 * it is always resolved against the caller's own rows, so another user's id never matches. No selector = the primary
 * account's calendar. Token refresh and failure counters act on the MASTER row of the connection in question only.
 */
import type { SupabaseClient } from "npm:@supabase/supabase-js@2";
import { getGoogleAccessToken, listGoogleConnections, readStoredToken, refreshGoogleAccessToken, resolveGoogleConnection } from "./google-connections.ts";
import { encryptToken } from "./crypto.ts";

type Db = SupabaseClient;
// deno-lint-ignore no-explicit-any
type Row = Record<string, any>;

export interface MasterRef { id: string; email: string; is_primary?: boolean; created_at?: string }
export interface CalendarConnectionLike { id: string; email?: string | null; connection_id?: string | null; created_at?: string | null }

const lc = (s: unknown) => String(s ?? "").toLowerCase();

/** The master (account) a calendar row belongs to: by connection_id, else (unlinked legacy row) by same email. */
export function masterOfCalendarRow(row: CalendarConnectionLike, masters: MasterRef[]): MasterRef | undefined {
  if (row.connection_id) return masters.find((m) => m.id === row.connection_id);
  return row.email ? masters.find((m) => lc(m.email) === lc(row.email)) : undefined;
}

/**
 * Pure choice among one user's calendar connection rows.
 *  - `requested` (a calendar row id OR a master/account id): that row, or null when the user has no such row.
 *  - no selector: the primary account's row; else an unlinked legacy row; else the oldest row.
 */
export function pickCalendarConnection<T extends CalendarConnectionLike>(rows: T[], masters: MasterRef[], requested?: string | null): T | null {
  if (!rows.length) return null;
  const want = (requested ?? "").trim();
  if (want) {
    return rows.find((r) => r.id === want)
      ?? rows.find((r) => masterOfCalendarRow(r, masters)?.id === want)
      ?? null;
  }
  const primary = masters.find((m) => m.is_primary);
  if (primary) {
    const hit = rows.find((r) => masterOfCalendarRow(r, masters)?.id === primary.id);
    if (hit) return hit;
  }
  const unlinked = rows.filter((r) => !masterOfCalendarRow(r, masters));
  return [...(unlinked.length ? unlinked : rows)].sort((a, b) => String(a.created_at ?? "").localeCompare(String(b.created_at ?? "")))[0];
}

/** All of a user's calendar connection rows, primary account first. */
export async function listCalendarConnections(db: Db, userId: string, orgId?: string | null): Promise<Row[]> {
  let q = db.from("google_calendar_connections").select("*").eq("user_id", userId);
  if (orgId) q = q.eq("org_id", orgId);
  const { data } = await q;
  const rows = (data ?? []) as Row[];
  if (rows.length < 2) return rows;
  const masters = await listGoogleConnections(db, userId);
  const primary = masters.find((m) => m.is_primary);
  const rank = (r: Row) => (primary && masterOfCalendarRow(r, masters)?.id === primary.id ? 0 : 1);
  return [...rows].sort((a, b) => rank(a) - rank(b) || String(a.created_at ?? "").localeCompare(String(b.created_at ?? "")));
}

/**
 * The calendar connection a call should use: the requested one (must be the user's), else the primary account's.
 * Null when the user has none, or when the requested id is not theirs (the caller answers 400/403/404).
 */
export async function getCalendarConnection(db: Db, userId: string, orgId: string | null | undefined, requested?: string | null): Promise<Row | null> {
  const rows = await listCalendarConnections(db, userId, orgId);
  if (!rows.length) return null;
  const masters = rows.length > 1 || requested ? await listGoogleConnections(db, userId) : [];
  return pickCalendarConnection(rows, masters, requested);
}

/** Pure: the single connection id among event-mirror rows, or undefined when none or more than one (do not guess). */
export function uniqueConnectionId(rows: Array<{ connection_id?: string | null }>): string | undefined {
  const ids = [...new Set(rows.map((r) => r.connection_id).filter(Boolean))] as string[];
  return ids.length === 1 ? ids[0] : undefined;
}

/**
 * Which of the user's calendar connections holds a Google event (by Google event id and/or CRM appointment id), when the caller
 * did not say. Only an unambiguous match is returned (a calendar connection row id); otherwise undefined and the primary stays the default.
 */
export async function connectionOfGoogleEvent(
  db: Db, userId: string, ref: { googleEventId?: string | null; appointmentId?: string | null },
): Promise<string | undefined> {
  const found: Array<{ connection_id?: string | null }> = [];
  if (ref.googleEventId) {
    const { data: m } = await db.from("calendar_event_map").select("connection_id").eq("user_id", userId).eq("google_event_id", ref.googleEventId);
    found.push(...((m ?? []) as Row[]));
    const { data: e } = await db.from("google_calendar_events").select("connection_id").eq("user_id", userId).eq("google_event_id", ref.googleEventId);
    found.push(...((e ?? []) as Row[]));
  }
  if (ref.appointmentId && !found.length) {
    const { data: m } = await db.from("calendar_event_map").select("connection_id").eq("user_id", userId).eq("appointment_id", ref.appointmentId);
    found.push(...((m ?? []) as Row[]));
  }
  return uniqueConnectionId(found);
}

/**
 * Connection for an operation on a CRM item that may already have a Google event:
 * an explicit request wins (and must be the user's: `null` when it is not), then the connection that holds the event,
 * else the primary. A holder that no longer exists (account removed) falls back to the primary.
 */
export async function resolveConnectionForEvent(
  db: Db, userId: string, orgId: string | null | undefined,
  opts: { requested?: string | null; googleEventId?: string | null; appointmentId?: string | null },
): Promise<{ connection: Row | null; heldBy: string | undefined }> {
  if (opts.requested) return { connection: await getCalendarConnection(db, userId, orgId, opts.requested), heldBy: undefined };
  const heldBy = (opts.googleEventId || opts.appointmentId) ? await connectionOfGoogleEvent(db, userId, opts) : undefined;
  if (heldBy) {
    const held = await getCalendarConnection(db, userId, orgId, heldBy);
    if (held) return { connection: held, heldBy };
  }
  return { connection: await getCalendarConnection(db, userId, orgId), heldBy };
}

/** Pure: does a caller-named id (a calendar connection id or its Google account id) name this connection? No id = yes. */
export function connectionMatchesRequest(conn: { id: string; connection_id?: string | null }, requested: string | undefined): boolean {
  return !requested || requested === conn.id || requested === conn.connection_id;
}

/** A body/param value to an optional trimmed id. */
export function requestedConnectionId(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

type FetchLike = typeof fetch;

interface TokenCols { table: string; access: string; refresh: string }
const CALENDAR_COLS: TokenCols = { table: "google_calendar_connections", access: "access_token", refresh: "refresh_token" };
const DRIVE_COLS: TokenCols = { table: "drive_connections", access: "access_token_encrypted", refresh: "refresh_token_encrypted" };

async function accessTokenFor(
  db: Db, conn: Row, cols: TokenCols, skewMs: number, opts: { fetchImpl?: FetchLike; now?: () => Date },
): Promise<string> {
  const now = opts.now ?? (() => new Date());
  const expiry = new Date(conn.token_expiry).getTime();
  if (conn[cols.access] && expiry - now().getTime() > skewMs) {
    try {
      const t = await readStoredToken(conn[cols.access]);
      if (t) return t;
    } catch { /* unreadable: refresh below */ }
  }

  const masters = await listGoogleConnections(db, conn.user_id);
  const master = masterOfCalendarRow(conn, masters);
  if (master) {
    const token = await getGoogleAccessToken(db, conn.user_id, { connectionId: master.id, fetchImpl: opts.fetchImpl, now });
    conn[cols.access] = token;
    conn.token_expiry = new Date(now().getTime() + 55 * 60_000).toISOString();
    return token;
  }

  const refresh = await readStoredToken(conn[cols.refresh]);
  if (!refresh) throw new Error("No refresh token available for this Google connection");
  const tok = await refreshGoogleAccessToken(refresh, opts.fetchImpl ?? fetch);
  const expiryIso = new Date(now().getTime() + (tok.expires_in ?? 3600) * 1000).toISOString();
  const patch: Row = { [cols.access]: await encryptToken(tok.access_token), token_expiry: expiryIso, updated_at: now().toISOString() };
  if (tok.refresh_token) patch[cols.refresh] = await encryptToken(tok.refresh_token);
  await db.from(cols.table).update(patch).eq("id", conn.id);
  conn[cols.access] = tok.access_token;
  conn.token_expiry = expiryIso;
  return tok.access_token;
}

/**
 * A usable access token for one calendar connection. A still-valid stored token is used as is; otherwise the refresh goes
 * through the shared per-account helper (ONLY that account's master + child rows are written; `invalid_grant` marks that
 * account `needs_reauth`). A calendar row with no master (orphan) refreshes with its own refresh token and writes only itself.
 * The row object is updated in memory with the new token.
 */
export function getCalendarAccessToken(db: Db, conn: Row, opts: { fetchImpl?: FetchLike; now?: () => Date } = {}): Promise<string> {
  return accessTokenFor(db, conn, CALENDAR_COLS, 60_000, opts);
}

/** Same for a `drive_connections` row (encrypted columns `*_token_encrypted`, 5 minute skew like drive-api always had). */
export function getDriveAccessToken(db: Db, conn: Row, opts: { fetchImpl?: FetchLike; now?: () => Date } = {}): Promise<string> {
  return accessTokenFor(db, conn, DRIVE_COLS, 5 * 60_000, opts);
}

/**
 * The user's active Drive connection: the requested one (a drive connection id or a Google account id; must be the user's),
 * else the primary account's. Null when none, or when the requested one is not theirs.
 */
export async function getDriveConnection(db: Db, userId: string, requested?: string | null): Promise<Row | null> {
  const { data } = await db.from("drive_connections").select("*").eq("user_id", userId).eq("is_active", true);
  const rows = (data ?? []) as Row[];
  if (!rows.length) return null;
  const masters = rows.length > 1 || requested ? await listGoogleConnections(db, userId) : [];
  return pickCalendarConnection(rows, masters, requested);
}

// ---- token failure circuit breaker (per account) ----

/** Consecutive permanently failed sync JOBS before a calendar connection is parked. */
export const REFRESH_FAIL_DISABLE_THRESHOLD = 5;
/** getGoogleAccessToken counts every failed refresh ATTEMPT on the master row; a job makes up to this many attempts. */
export const ATTEMPTS_PER_JOB = 5;

export function isTokenFailure(message: string): boolean {
  return /token refresh|refresh token|invalid_grant|invalid_client|unauthorized|re-authorized|token request failed/i.test(message);
}

/** Pure: park a calendar connection when its account needs re-auth, or its refresh keeps failing. */
export function shouldDisableCalendarSync(m: { connection_status?: string | null; refresh_fail_count?: number | null } | undefined): boolean {
  if (!m) return false;
  if (m.connection_status === "needs_reauth") return true;
  return (m.refresh_fail_count ?? 0) >= REFRESH_FAIL_DISABLE_THRESHOLD * ATTEMPTS_PER_JOB;
}

/**
 * After a job failed permanently on a token problem: look at THIS connection's account only and, when it is dead, switch off
 * sync for THIS calendar connection row only. Another account of the same user is never touched.
 */
export async function recordCalendarTokenFailure(db: Db, calendarConnectionId: string): Promise<{ disabled: boolean; email?: string; failCount: number }> {
  const { data: conn } = await db.from("google_calendar_connections").select("id, user_id, email, connection_id").eq("id", calendarConnectionId).maybeSingle();
  if (!conn) return { disabled: false, failCount: 0 };
  const masters = await listGoogleConnections(db, conn.user_id);
  const ref = masterOfCalendarRow(conn, masters);
  if (!ref) return { disabled: false, email: conn.email, failCount: 0 };
  const { data: master } = await db.from("google_oauth_master").select("id, connection_status, refresh_fail_count").eq("id", ref.id).maybeSingle();
  const failCount = (master?.refresh_fail_count as number | null) ?? 0;
  if (!shouldDisableCalendarSync(master ?? undefined)) return { disabled: false, email: conn.email, failCount };
  await db.from("google_calendar_connections").update({ sync_enabled: false, updated_at: new Date().toISOString() }).eq("id", calendarConnectionId);
  return { disabled: true, email: conn.email, failCount };
}

/** A job succeeded: reset the failure counter of THIS connection's account (never another account's). */
export async function clearCalendarTokenFailure(db: Db, calendarConnectionId: string): Promise<void> {
  const { data: conn } = await db.from("google_calendar_connections").select("id, user_id, email, connection_id").eq("id", calendarConnectionId).maybeSingle();
  if (!conn) return;
  const masters = await listGoogleConnections(db, conn.user_id);
  const ref = masterOfCalendarRow(conn, masters);
  if (!ref) return;
  await db.from("google_oauth_master").update({ refresh_fail_count: 0, refresh_failed_at: null }).eq("id", ref.id).gt("refresh_fail_count", 0);
}

// ---- one call for "act on a Google calendar / mailbox for this user" (assistant actions) ----

export type GoogleActionAccess<T> =
  | { ok: true } & T
  | { ok: false; reason: "not_owned" | "not_connected" | "token"; message: string };

/**
 * Calendar token for an assistant action. `requested` (optional, must be the user's) picks the account for a create; an
 * update/cancel names no account and uses the one that holds the event (else the primary).
 */
export async function googleCalendarAccessForAction(
  db: Db, userId: string, orgId: string | null | undefined,
  opts: { requested?: unknown; googleEventId?: string | null; fetchImpl?: FetchLike } = {},
): Promise<GoogleActionAccess<{ token: string; connection: Row }>> {
  const requested = requestedConnectionId(opts.requested);
  const { connection } = await resolveConnectionForEvent(db, userId, orgId, { requested, googleEventId: opts.googleEventId });
  if (!connection) {
    return requested
      ? { ok: false, reason: "not_owned", message: "That Google account is not connected for you." }
      : { ok: false, reason: "not_connected", message: "Google Calendar not connected." };
  }
  try {
    return { ok: true, token: await getCalendarAccessToken(db, connection, { fetchImpl: opts.fetchImpl }), connection };
  } catch (e) {
    return { ok: false, reason: "token", message: `Google Calendar needs to be reconnected (${(e as Error).message}).` };
  }
}

/** Gmail token for an assistant action: the requested account (must be the user's), else the primary. */
export async function googleMailAccessForAction(
  db: Db, userId: string, opts: { requested?: unknown; fetchImpl?: FetchLike } = {},
): Promise<GoogleActionAccess<{ token: string; email: string; connectionId: string }>> {
  const requested = requestedConnectionId(opts.requested);
  const conn = await resolveGoogleConnection(db, userId, { connectionId: requested });
  if (!conn) {
    return requested
      ? { ok: false, reason: "not_owned", message: "That Google account is not connected for you." }
      : { ok: false, reason: "not_connected", message: "Gmail not connected." };
  }
  try {
    return { ok: true, token: await getGoogleAccessToken(db, userId, { connectionId: conn.id, fetchImpl: opts.fetchImpl }), email: conn.email, connectionId: conn.id };
  } catch (e) {
    return { ok: false, reason: "token", message: `Google needs to be reconnected (${(e as Error).message}).` };
  }
}
