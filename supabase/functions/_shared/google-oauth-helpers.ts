import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2";
import { encryptToken } from "./crypto.ts";
import { pickGoogleConnection, readStoredToken, resolveGoogleConnection, upsertGoogleConnection } from "./google-connections.ts";

const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";

export const ALL_GOOGLE_SCOPES = [
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/gmail.send",
  "https://www.googleapis.com/auth/gmail.modify",
  "https://www.googleapis.com/auth/calendar",
  "https://www.googleapis.com/auth/drive",
  // Meet REST API: conference records -> transcripts + recordings.
  "https://www.googleapis.com/auth/meetings.space.readonly",
  // Docs API: read the transcript document Meet writes to Drive.
  "https://www.googleapis.com/auth/documents",
  "https://www.googleapis.com/auth/userinfo.email",
  "https://www.googleapis.com/auth/userinfo.profile",
];

export const GMAIL_SCOPES = [
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/gmail.send",
  "https://www.googleapis.com/auth/gmail.modify",
];

export const CALENDAR_SCOPES = [
  "https://www.googleapis.com/auth/calendar",
];

export const DRIVE_SCOPES = [
  "https://www.googleapis.com/auth/drive",
];

/**
 * Required to pull Meet transcripts/recordings via the Meet REST API.
 * Without these we fall back to guessing filenames in Drive.
 */
export const MEET_SCOPES = [
  "https://www.googleapis.com/auth/meetings.space.readonly",
];

export function hasGmailScopes(scopes: string[]): boolean {
  return GMAIL_SCOPES.every((s) => scopes.includes(s));
}

export function hasCalendarScopes(scopes: string[]): boolean {
  return CALENDAR_SCOPES.every((s) => scopes.includes(s));
}

export function hasDriveScopes(scopes: string[]): boolean {
  return DRIVE_SCOPES.every((s) => scopes.includes(s));
}

export function hasMeetScopes(scopes: string[]): boolean {
  return MEET_SCOPES.every((s) => scopes.includes(s));
}

/** Docs API access, used to read the Meet transcript document. */
export function hasDocsScopes(scopes: string[]): boolean {
  return scopes.includes("https://www.googleapis.com/auth/documents");
}

export function mergeScopes(existing: string[], incoming: string[]): string[] {
  const set = new Set([...existing, ...incoming]);
  return Array.from(set);
}

/**
 * Store (or re-authorize) one Google account as a connection. The same email (any case) re-authorizes its own row; a new
 * email adds a row. Tokens are encrypted and the write FAILS CLOSED: a plaintext token is never stored. Returns the
 * connection id (the `google_oauth_master.id`). Never touches another account of the user.
 */
export async function writeMasterToken(
  supabase: SupabaseClient,
  orgId: string,
  userId: string,
  email: string,
  accessToken: string,
  refreshToken: string,
  tokenExpiry: string,
  scopes: string[]
): Promise<string> {
  const r = await upsertGoogleConnection(supabase, { orgId, userId, email, accessToken, refreshToken, tokenExpiry, scopes });
  return r.connectionId;
}

type ChildKey = { id: string; user_id: string; email: string };

/**
 * Write one connection's row in a per-account table WITHOUT ON CONFLICT (the new unique columns only exist after migration
 * step 2): update the row keyed by connection_id; else adopt a legacy row (connection_id NULL) of the same user and email;
 * else insert with connection_id set. Returns the row id.
 */
export async function upsertChildRow(
  supabase: SupabaseClient,
  table: string,
  conn: ChildKey,
  insertValues: Record<string, unknown>,
  updateValues: Record<string, unknown>,
): Promise<string> {
  const { data: own, error: ownErr } = await supabase.from(table).select("id").eq("connection_id", conn.id).limit(1);
  if (ownErr) throw new Error(`${table} lookup failed: ${ownErr.message}`);
  let rowId = ((own ?? []) as { id: string }[])[0]?.id as string | undefined;
  if (!rowId) {
    const { data: legacy, error: legErr } = await supabase.from(table).select("id, email").eq("user_id", conn.user_id).is("connection_id", null);
    if (legErr) throw new Error(`${table} lookup failed: ${legErr.message}`);
    rowId = ((legacy ?? []) as { id: string; email: string | null }[]).find((r) => (r.email ?? "").toLowerCase() === conn.email.toLowerCase())?.id;
  }
  if (rowId) {
    const { error } = await supabase.from(table).update({ ...updateValues, connection_id: conn.id }).eq("id", rowId);
    if (error) throw new Error(`${table} update failed: ${error.message}`);
    return rowId;
  }
  const { data, error } = await supabase.from(table).insert({ ...insertValues, ...updateValues, connection_id: conn.id }).select("id").single();
  if (error || !data) throw new Error(`${table} insert failed: ${error?.message ?? "no row"}`);
  return (data as { id: string }).id;
}

export interface CrossPopulateResult {
  connectionId: string;
  isPrimary: boolean;
  gmail: boolean;
  calendarConnectionId: string | null;
  driveConnectionId: string | null;
}

/**
 * Fan one connection's grant out to its per-service rows (gmail_oauth_tokens, google_calendar_connections,
 * drive_connections), each keyed by `connection_id`. The user_connected_accounts mirror is written for the PRIMARY account
 * only; users.gmail_connected / google_drive_connected are "any account has it" flags. Tokens are encrypted (fail closed).
 * `connectionId` defaults to the user's connection with this email.
 */
export async function crossPopulateServiceTables(
  supabase: SupabaseClient,
  orgId: string,
  userId: string,
  email: string,
  accessToken: string,
  refreshToken: string,
  tokenExpiry: string,
  grantedScopes: string[],
  connectionId?: string
): Promise<CrossPopulateResult> {
  const now = new Date().toISOString();
  const conn = await resolveGoogleConnection(supabase, userId, connectionId ? { connectionId } : { email });
  if (!conn) throw new Error("Google account is not stored for this user");
  const key: ChildKey = { id: conn.id, user_id: userId, email: conn.email };
  const result: CrossPopulateResult = { connectionId: conn.id, isPrimary: conn.is_primary, gmail: false, calendarConnectionId: null, driveConnectionId: null };

  // Encrypt once per call (throws when the key is missing: nothing is stored in plaintext).
  const encAccess = await encryptToken(accessToken);
  const encRefresh = await encryptToken(refreshToken);

  // One provider-level row per Google-connected user: this is what the workspace-provider resolver
  // (_shared/provider.ts, src/services/connectedProvider.ts) reads to pick Google vs Microsoft. It mirrors the
  // PRIMARY account only; a secondary account never overwrites it.
  if (conn.is_primary) {
    await supabase.from("user_connected_accounts").upsert(
      {
        user_id: userId,
        provider: "google_workspace",
        provider_account_id: conn.email,
        provider_account_email: conn.email,
        scopes: grantedScopes,
        status: "connected",
        connected_at: now,
        last_synced_at: now,
        updated_at: now,
      },
      { onConflict: "user_id,provider" }
    );
  }

  if (hasGmailScopes(grantedScopes)) {
    await upsertChildRow(supabase, "gmail_oauth_tokens", key,
      { organization_id: orgId, user_id: userId },
      { access_token: encAccess, refresh_token: encRefresh, token_expiry: tokenExpiry, email: conn.email, updated_at: now });
    result.gmail = true;

    await supabase.from("users").update({ gmail_connected: true, updated_at: now }).eq("id", userId);

    if (conn.is_primary) {
      await supabase.from("user_connected_accounts").upsert(
        {
          user_id: userId,
          provider: "google_gmail",
          provider_account_id: conn.email,
          provider_account_email: conn.email,
          scopes: GMAIL_SCOPES.map((s) => s.split("/").pop()!),
          connected_at: now,
          last_synced_at: now,
          updated_at: now,
        },
        { onConflict: "user_id,provider" }
      );
    }
  }

  if (hasCalendarScopes(grantedScopes)) {
    const { data: existingCal } = await supabase.from("google_calendar_connections").select("selected_calendar_ids").eq("connection_id", conn.id).limit(1);
    const selected = ((existingCal ?? []) as { selected_calendar_ids?: string[] }[])[0]?.selected_calendar_ids;
    result.calendarConnectionId = await upsertChildRow(supabase, "google_calendar_connections", key,
      { org_id: orgId, user_id: userId },
      {
        access_token: encAccess,
        refresh_token: encRefresh,
        token_expiry: tokenExpiry,
        email: conn.email,
        selected_calendar_ids: selected && selected.length ? selected : ["primary"],
        sync_enabled: true,
        scopes: grantedScopes.filter((s) => s.includes("calendar") || s.includes("userinfo")).join(" "),
        updated_at: now,
      });
  }

  if (hasDriveScopes(grantedScopes)) {
    result.driveConnectionId = await upsertChildRow(supabase, "drive_connections", key,
      { user_id: userId, organization_id: orgId, connected_by: userId },
      {
        email: conn.email,
        access_token_encrypted: encAccess,
        refresh_token_encrypted: encRefresh,
        token_expiry: tokenExpiry,
        scopes: DRIVE_SCOPES.concat([
          "https://www.googleapis.com/auth/userinfo.email",
          "https://www.googleapis.com/auth/userinfo.profile",
        ]),
        is_active: true,
        updated_at: now,
      });
    await supabase.from("users").update({ google_drive_connected: true, updated_at: now }).eq("id", userId);
  }
  return result;
}

async function readFirst(value: string | null | undefined, label: string): Promise<string | null> {
  if (!value) return null;
  try {
    return await readStoredToken(value);
  } catch {
    console.warn(`Failed to decrypt ${label} refresh token`);
    return null;
  }
}

/**
 * A refresh token for ONE of the user's Google accounts (default: the primary): the master row first, then that connection's
 * own per-service rows. Never returns another account's token. `connectionId` in the result says which account it belongs to.
 */
export async function resolveRefreshToken(
  supabase: SupabaseClient,
  userId: string,
  _orgId: string,
  connectionId?: string | null
): Promise<{ refreshToken: string; source: string; connectionId: string } | null> {
  const { data: rows } = await supabase
    .from("google_oauth_master")
    .select("id, user_id, email, is_primary, created_at, encrypted_refresh_token")
    .eq("user_id", userId);
  const master = pickGoogleConnection((rows ?? []) as Array<{ id: string; email: string; is_primary?: boolean; created_at?: string; encrypted_refresh_token: string | null }>,
    connectionId ? { connectionId } : {});
  if (!master) return null;

  const fromMaster = await readFirst(master.encrypted_refresh_token, "master");
  if (fromMaster) return { refreshToken: fromMaster, source: "master", connectionId: master.id };

  const children: Array<[string, string, string]> = [
    ["google_calendar_connections", "refresh_token", "calendar"],
    ["drive_connections", "refresh_token_encrypted", "drive"],
    ["gmail_oauth_tokens", "refresh_token", "gmail"],
  ];
  for (const [table, col, source] of children) {
    const { data } = await supabase.from(table).select(col).eq("connection_id", master.id).limit(1);
    let value = ((data ?? []) as Array<Record<string, string | null>>)[0]?.[col];
    if (!value && master.is_primary) {
      // a legacy row written before connection_id existed belongs to the primary account
      const { data: legacy } = await supabase.from(table).select(col).eq("user_id", userId).is("connection_id", null).limit(1);
      value = ((legacy ?? []) as Array<Record<string, string | null>>)[0]?.[col];
    }
    const rt = await readFirst(value, source);
    if (rt) return { refreshToken: rt, source, connectionId: master.id };
  }
  return null;
}

/** Legacy refresh: returns null on ANY failure (even a revoked grant). New code should use refreshGoogleAccessToken / getGoogleAccessToken. */
export async function refreshAccessToken(
  refreshToken: string
): Promise<{
  access_token: string;
  expires_in: number;
  refresh_token?: string;
  scope?: string;
} | null> {
  const clientId = Deno.env.get("GOOGLE_CLIENT_ID");
  const clientSecret = Deno.env.get("GOOGLE_CLIENT_SECRET");
  if (!clientId || !clientSecret) return null;

  const res = await fetch(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      refresh_token: refreshToken,
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: "refresh_token",
    }),
    signal: AbortSignal.timeout(15000),
  });

  if (!res.ok) return null;
  return await res.json();
}
