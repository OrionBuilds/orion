/**
 * Multi-account Microsoft 365 logic shared by the OAuth callback, disconnect, token cron and
 * `microsoft-accounts` functions. A connection is one `microsoft_oauth_master` row (its id is the
 * connection_id). Kept out of the function entrypoints so it can be unit-tested with FakeSupabase.
 *
 * Works on both schema steps: every outlook_sync_state insert carries connection_id.
 */
import type { SupabaseClient } from "npm:@supabase/supabase-js@2";
import { encryptToken } from "./crypto.ts";
import {
  getValidAccessToken,
  isExcludedIdentity,
  listMsConnections,
  MSA_TENANT_ID,
  type MsAccountType,
  type MsConfig,
  type MsConnection,
} from "./ms-graph.ts";

/** Gate: connecting an 'external' or 'personal' account needs the secret MS_OAUTH_ALLOW_OTHER_ACCOUNTS=on. */
export function otherAccountsEnabled(env: { get(k: string): string | undefined } = Deno.env): boolean {
  return (env.get("MS_OAUTH_ALLOW_OTHER_ACCOUNTS") ?? "").trim().toLowerCase() === "on";
}

/** What the UI may offer, from the secret. */
export function accountCapabilities(env: { get(k: string): string | undefined } = Deno.env): { external: boolean; personal: boolean } {
  const on = otherAccountsEnabled(env);
  return { external: on, personal: on };
}

const TYPES: readonly string[] = ["work", "external", "personal"];

export type AccountTypeDecision =
  | { ok: true; accountType: MsAccountType }
  | { ok: false; status: number; body: { error: string; message: string } };

/**
 * Start-side choice of account type. `requested` is the body value (absent = 'work' unless re-authing an existing
 * account, where the row's type is used). Non-work types need the gate; an unknown value is 400; asking for a type
 * other than the stored one for an existing account (login_hint) is refused with 409.
 */
export function decideAccountType(
  requested: unknown,
  opts: { env?: { get(k: string): string | undefined }; existingType?: MsAccountType | null } = {},
): AccountTypeDecision {
  const existing = opts.existingType ?? null;
  if (requested !== undefined && requested !== null && requested !== "" && (typeof requested !== "string" || !TYPES.includes(requested))) {
    return { ok: false, status: 400, body: { error: "invalid_account_type", message: "account_type must be work, external or personal." } };
  }
  const asked = (requested ? requested : null) as MsAccountType | null;
  if (existing && asked && asked !== existing) {
    return { ok: false, status: 409, body: { error: "account_type_mismatch", message: `That account is already connected as a ${existing} account. Reconnect it with the same type, or disconnect it first.` } };
  }
  const accountType: MsAccountType = asked ?? existing ?? "work";
  if (accountType !== "work" && !otherAccountsEnabled(opts.env)) {
    return { ok: false, status: 403, body: { error: "other_accounts_disabled", message: "Connecting accounts from other organizations or personal Microsoft accounts is not enabled yet." } };
  }
  return { ok: true, accountType };
}

const STATE_PREFIX = /^account_type=(external|personal);/;
/** The OAuth state's scope_requested: unchanged for 'work'; other types carry their type in front of the scopes. */
export function stateScopeRequested(type: MsAccountType, scopes: readonly string[]): string {
  return type === "work" ? scopes.join(" ") : `account_type=${type};${scopes.join(" ")}`;
}
export function accountTypeFromState(scopeRequested: string | null | undefined): MsAccountType {
  const m = STATE_PREFIX.exec(scopeRequested ?? "");
  return (m?.[1] as MsAccountType | undefined) ?? "work";
}
/** Tenant to store: the account's real tenant when the token response carried one, else MSA for personal, else the configured one. */
export function tenantToStore(type: MsAccountType, tokenTenant: string | null | undefined, cfgTenant: string): string {
  return tokenTenant || (type === "personal" ? MSA_TENANT_ID : cfgTenant);
}

type Sb = SupabaseClient;
type FetchLike = typeof fetch;

export interface ConnectInput {
  userId: string;
  orgId: string;
  email: string;
  tokens: { accessToken: string; refreshToken: string; expiresAt: Date; scopes: string[] };
  tenantId: string;
  /** Default 'work'. Non-work rows never get login_enabled. A re-auth must use the stored row's type. */
  accountType?: MsAccountType;
  /** Sign-in flow only: the identity proved itself by logging in, so enable login on that row. */
  loginEnabled?: boolean;
  /** Agent-slot guard: refuse these identities (MS_EXCLUDED_EMAILS). Omitted by the sign-in flow. */
  excludedEmails?: string[];
}
export type ConnectResult =
  | { ok: true; connectionId: string; isPrimary: boolean; created: boolean }
  | { ok: false; reason: "excluded" }
  | { ok: false; reason: "type_mismatch"; existingType: MsAccountType };

/**
 * Stores a connection (tokens encrypted, fail closed). Same (user, lower(email)) = re-auth of that row;
 * a new email = a new row (primary only when it is the user's first) with its own EMPTY sync state.
 * Only the primary account writes the user_connected_accounts mirror. Throws on failure.
 */
export async function connectMicrosoftAccount(db: Sb, c: ConnectInput): Promise<ConnectResult> {
  if (c.excludedEmails && isExcludedIdentity(c.email, c.excludedEmails)) return { ok: false, reason: "excluded" };

  const encryptedAccess = await encryptToken(c.tokens.accessToken);
  const encryptedRefresh = await encryptToken(c.tokens.refreshToken);
  const now = new Date().toISOString();
  const accountType: MsAccountType = c.accountType ?? "work";
  const loginEnabled = !!c.loginEnabled && accountType === "work";
  const fields = {
    encrypted_access_token: encryptedAccess,
    encrypted_refresh_token: encryptedRefresh,
    token_expires_at: c.tokens.expiresAt.toISOString(),
    email: c.email,
    tenant_id: c.tenantId,
    ...(accountType === "work" ? {} : { account_type: accountType }),
    granted_scopes: c.tokens.scopes,
    connection_status: "active",
    last_refresh_error: null,
    updated_at: now,
  };

  const find = async () => {
    const { data, error } = await db.from("microsoft_oauth_master").select("id, email, is_primary, account_type").eq("user_id", c.userId);
    if (error) throw new Error(`save failed: ${error.message}`);
    return (data ?? []) as Array<{ id: string; email: string; is_primary: boolean; account_type?: MsAccountType | null }>;
  };
  let rows = await find();
  let row = rows.find((r) => r.email.toLowerCase() === c.email.toLowerCase());
  let created = false;

  if (row) {
    const existingType = row.account_type ?? "work";
    if (existingType !== accountType) return { ok: false, reason: "type_mismatch", existingType };
    const { error } = await db.from("microsoft_oauth_master").update({
      ...fields,
      ...(loginEnabled ? { login_enabled: true } : {}), // never reset an existing enablement
    }).eq("id", row.id);
    if (error) throw new Error(`save failed: ${error.message}`);
  } else {
    const first = rows.length === 0;
    const { data, error } = await db.from("microsoft_oauth_master").insert({
      user_id: c.userId,
      organization_id: c.orgId,
      ...fields,
      is_primary: first,
      login_enabled: loginEnabled, // secondary accounts never sign in unless the sign-in flow says so
    }).select("id, email, is_primary").single();
    if (error?.code === "23505") {
      // lost a race with a concurrent connect of the same email: treat it as a re-auth of that row
      rows = await find();
      row = rows.find((r) => r.email.toLowerCase() === c.email.toLowerCase());
      if (!row) throw new Error(`save failed: ${error.message}`);
      if ((row.account_type ?? "work") !== accountType) return { ok: false, reason: "type_mismatch", existingType: row.account_type ?? "work" };
      const { error: e2 } = await db.from("microsoft_oauth_master").update(fields).eq("id", row.id);
      if (e2) throw new Error(`save failed: ${e2.message}`);
    } else if (error || !data) {
      throw new Error(`save failed: ${error?.message ?? "no row"}`);
    } else {
      row = data as { id: string; email: string; is_primary: boolean; account_type?: MsAccountType | null };
      created = true;
    }
  }
  const connectionId = row!.id;
  const isPrimary = !!row!.is_primary;

  if (isPrimary) {
    // user_connected_accounts mirrors the PRIMARY account only
    await db.from("user_connected_accounts").upsert({
      user_id: c.userId, provider: "microsoft_365", provider_account_id: c.email, provider_account_email: c.email,
      scopes: c.tokens.scopes, connected_at: now, updated_at: now,
    }, { onConflict: "user_id,provider" });
  }

  // Sync state is per connection. A new mailbox starts with EMPTY cursors; a re-auth keeps the cursors.
  const { data: state } = await db.from("outlook_sync_state").select("id").eq("connection_id", connectionId).maybeSingle();
  if (state) {
    await db.from("outlook_sync_state").update({ sync_status: "idle", updated_at: now }).eq("connection_id", connectionId);
  } else {
    let claimed = false;
    if (isPrimary) {
      // adopt a legacy row written by pre-multi-account code (connection_id NULL) rather than creating a duplicate
      const { data: legacy } = await db.from("outlook_sync_state").select("id").eq("user_id", c.userId).is("connection_id", null).maybeSingle();
      if (legacy) {
        await db.from("outlook_sync_state").update({ connection_id: connectionId, sync_status: "idle", updated_at: now }).eq("id", (legacy as { id: string }).id);
        claimed = true;
      }
    }
    if (!claimed) {
      const { error } = await db.from("outlook_sync_state").insert({
        user_id: c.userId, organization_id: c.orgId, connection_id: connectionId, sync_status: "idle", updated_at: now,
      });
      if (error) throw new Error(`save failed: ${error.message}`);
    }
  }
  return { ok: true, connectionId, isPrimary, created };
}

export interface DisconnectResult { status: number; body: Record<string, unknown> }

/**
 * Removes one Microsoft account (rows, sync state, calendar events) or, with no connection_id and exactly one
 * account, everything as before. With several accounts and no connection_id it refuses (400).
 * Deleting the primary makes the DB promote the oldest remaining account and move the mirror.
 */
export async function disconnectMicrosoft(db: Sb, userId: string, connectionId?: string | null): Promise<DisconnectResult> {
  const conns = await listMsConnections(db, userId);
  if (connectionId) {
    if (!conns.some((c) => c.id === connectionId)) return { status: 404, body: { error: "That Microsoft account is not connected" } };
  } else if (conns.length > 1) {
    return { status: 400, body: { error: "You have more than one Microsoft account connected; choose which account to disconnect (connection_id)." } };
  }
  const target = connectionId ?? conns[0]?.id ?? null;
  const last = conns.length <= 1;

  const ops = [];
  if (last) {
    // last (or only) account: clear everything for the user, including legacy rows without a connection_id
    ops.push(
      db.from("outlook_sync_state").delete().eq("user_id", userId),
      db.from("microsoft_calendar_events").delete().eq("user_id", userId),
    );
  } else {
    ops.push(
      db.from("outlook_sync_state").delete().eq("connection_id", target),
      db.from("microsoft_calendar_events").delete().eq("connection_id", target),
    );
  }
  const childErr = (await Promise.all(ops)).find((r) => r.error);
  if (childErr?.error) {
    console.error("[microsoft-disconnect]", childErr.error.message);
    return { status: 500, body: { error: "Failed to disconnect" } };
  }
  const masterQ = db.from("microsoft_oauth_master").delete();
  const { error } = await (last ? masterQ.eq("user_id", userId) : masterQ.eq("id", target));
  if (error) {
    console.error("[microsoft-disconnect]", error.message);
    return { status: 500, body: { error: "Failed to disconnect" } };
  }
  if (last) {
    const { error: mErr } = await db.from("user_connected_accounts").delete().eq("user_id", userId).eq("provider", "microsoft_365");
    if (mErr) {
      console.error("[microsoft-disconnect]", mErr.message);
      return { status: 500, body: { error: "Failed to disconnect" } };
    }
  }
  await db.from("audit_logs").insert({
    user_id: userId, action: "microsoft_disconnected", entity_type: "microsoft_oauth",
    ...(target ? { after_state: { connection_id: target } } : {}),
  });
  return { status: 200, body: { success: true } };
}

/**
 * Token cron core: every active connection (one row each) whose access token expires inside the window,
 * soonest first, capped per run. A row that fails is flagged needs_reauth by getValidAccessToken itself
 * (per row); one bad account never blocks the others.
 */
export async function refreshActiveConnections(
  db: Sb,
  cfg: MsConfig,
  opts: { windowMs: number; maxBatch: number; fetchImpl?: FetchLike },
): Promise<{ checked: number; refreshed: number; failed: number }> {
  const { data: rows, error } = await db
    .from("microsoft_oauth_master")
    .select("id, user_id")
    .eq("connection_status", "active")
    .lt("token_expires_at", new Date(Date.now() + opts.windowMs).toISOString())
    .order("token_expires_at", { ascending: true })
    .limit(opts.maxBatch);
  if (error) throw new Error(error.message);
  let refreshed = 0;
  let failed = 0;
  for (const r of (rows ?? []) as Array<{ id: string; user_id: string }>) {
    try {
      await getValidAccessToken(db, r.user_id, { cfg, connectionId: r.id, fetchImpl: opts.fetchImpl });
      refreshed++;
    } catch (e) {
      failed++;
      console.error(`[ms-refresh] connection ${r.id}: ${(e as Error).message}`);
    }
  }
  return { checked: rows?.length ?? 0, refreshed, failed };
}

/** What the UI may see of a connection: never any token column. */
export interface PublicMsAccount {
  id: string; email: string; label: string | null; is_primary: boolean; connection_status: string;
  login_enabled: boolean; account_type: MsAccountType; last_refresh_at: string | null; last_refresh_error: string | null;
}
const PUBLIC_COLS = "id, email, label, is_primary, connection_status, login_enabled, account_type, last_refresh_at, last_refresh_error, created_at";

export async function listPublicAccounts(db: Sb, userId: string): Promise<PublicMsAccount[]> {
  const { data, error } = await db.from("microsoft_oauth_master").select(PUBLIC_COLS).eq("user_id", userId)
    .order("is_primary", { ascending: false }).order("created_at", { ascending: true });
  if (error) throw new Error(error.message);
  return ((data ?? []) as Array<Record<string, unknown>>).map((r) => ({
    id: r.id as string, email: r.email as string, label: (r.label as string | null) ?? null, is_primary: !!r.is_primary,
    connection_status: r.connection_status as string, login_enabled: !!r.login_enabled, account_type: ((r.account_type as MsAccountType | null) ?? "work"),
    last_refresh_at: (r.last_refresh_at as string | null) ?? null, last_refresh_error: (r.last_refresh_error as string | null) ?? null,
  }));
}

export type AccountsAction =
  | { action: "list" }
  | { action: "set-primary"; connection_id: string }
  | { action: "set-label"; connection_id: string; label?: string | null };

/** Owner-scoped actions behind `microsoft-accounts`. A connection id that is not the caller's is refused (404). */
export async function runAccountsAction(db: Sb, userId: string, req: AccountsAction, env: { get(k: string): string | undefined } = Deno.env): Promise<DisconnectResult> {
  const capabilities = accountCapabilities(env);
  if (req.action === "list") return { status: 200, body: { accounts: await listPublicAccounts(db, userId), capabilities } };
  if (req.action !== "set-primary" && req.action !== "set-label") return { status: 400, body: { error: "Unknown action" } };
  if (!req.connection_id || typeof req.connection_id !== "string") return { status: 400, body: { error: "connection_id required" } };
  const mine: MsConnection[] = await listMsConnections(db, userId);
  if (!mine.some((c) => c.id === req.connection_id)) return { status: 404, body: { error: "That Microsoft account is not connected" } };
  const { error } = req.action === "set-primary"
    ? await db.rpc("ms_set_primary", { p_connection: req.connection_id })
    : await db.rpc("ms_set_label", { p_connection: req.connection_id, p_label: req.label ?? "" });
  if (error) return { status: 500, body: { error: "Update failed" } };
  return { status: 200, body: { accounts: await listPublicAccounts(db, userId), capabilities } };
}
