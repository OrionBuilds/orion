/**
 * Microsoft Graph helpers for the OS: OAuth (Entra ID v2.0), token storage/refresh, and a
 * host-allowlisted fetch.
 *
 * Ported from CLARA's standalone `src/lib/clara/ms-auth.ts`, keeping its safety properties:
 *   - Tokens are AES-GCM encrypted (`_shared/crypto.ts`). Unlike the Gmail callback, encryption
 *     failure FAILS CLOSED here; we never fall back to storing a plaintext token.
 *   - The connected mailbox is verified through Graph `/me` before anything is stored, and
 *     refused if it is on the excluded list (the owner's personal address / own work mailbox,
 *     so an agent's slot can never silently hold the owner's identity).
 *   - Microsoft rotates refresh tokens on use; the rotated token is persisted every refresh.
 *   - `graphFetch` only talks to graph.microsoft.com / login.microsoftonline.com.
 */
import type { SupabaseClient } from "npm:@supabase/supabase-js@2";
import { decryptToken, encryptToken } from "./crypto.ts";

export const MS_SCOPES = [
  "offline_access",
  "openid",
  "profile",
  "User.Read",
  "Mail.ReadWrite",
  "Mail.Send",
  "MailboxSettings.ReadWrite",
  "Calendars.ReadWrite",
  "Contacts.ReadWrite",
  "Sites.ReadWrite.All",
  "Files.ReadWrite.All",
  // Teams meeting transcripts/recordings for meetings the user organises (admin consent required).
  "OnlineMeetings.Read",
  "OnlineMeetingTranscript.Read.All",
  // OnlineMeetingRecording.Read.All is intentionally NOT requested: it requires tenant admin
  // consent, which would block user self-consent at reconnect. Recording-playback links are
  // best-effort (fetchRecordingUrl returns null without it); transcripts need only the scope above.
  // No Chat.* scopes: Teams is used for meeting transcripts only, not two-way chat.
] as const;

/** home = the owner's own tenant (full scopes); external = another organization's work/school account; personal = outlook.com/live/hotmail. */
export type MsAccountType = "work" | "external" | "personal";
export const MSA_TENANT_ID = "9188040d-6c67-4c5b-b112-36a304b66dad";

/** Other organizations: no Teams transcript scopes (they need tenant admin consent), everything else as for the home tenant. */
export const MS_SCOPES_EXTERNAL = MS_SCOPES.filter((x) => x !== "OnlineMeetings.Read" && x !== "OnlineMeetingTranscript.Read.All");
/** Personal Microsoft accounts reject organisational-only scopes (Sites.*, OnlineMeetings*, *.All), so the set is smaller. */
export const MS_SCOPES_PERSONAL = [
  "offline_access", "openid", "profile", "User.Read", "Mail.ReadWrite", "Mail.Send", "MailboxSettings.ReadWrite",
  "Calendars.ReadWrite", "Contacts.ReadWrite", "Files.ReadWrite",
] as const;

export function scopesFor(type: MsAccountType = "work"): readonly string[] {
  return type === "personal" ? MS_SCOPES_PERSONAL : type === "external" ? MS_SCOPES_EXTERNAL : MS_SCOPES;
}

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/**
 * The login authority for an account type. Home accounts use the configured tenant (unchanged). Personal accounts use
 * `consumers`. Other organizations sign in at `organizations`; a refresh may use the account's real tenant id when known.
 */
export function authorityFor(cfg: Pick<MsConfig, "tenantId">, type: MsAccountType = "work", tenantId?: string | null, purpose: "authorize" | "token" = "authorize"): string {
  if (type === "personal") return "consumers";
  if (type === "external") return purpose === "token" && tenantId && GUID.test(tenantId) && tenantId.toLowerCase() !== MSA_TENANT_ID ? tenantId : "organizations";
  return cfg.tenantId;
}

/** The `tid` claim of an id token (decoded, not verified: it came straight from the token endpoint). */
export function tenantFromIdToken(idToken: string | undefined | null): string | null {
  try {
    const part = String(idToken ?? "").split(".")[1];
    if (!part) return null;
    const json = JSON.parse(atob(part.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(part.length / 4) * 4, "=")));
    return typeof json.tid === "string" && GUID.test(json.tid) ? json.tid.toLowerCase() : null;
  } catch { return null; }
}

const ALLOWED_HOSTS = new Set(["graph.microsoft.com", "login.microsoftonline.com"]);
const REFRESH_SKEW_MS = 60_000;

export interface MsConfig {
  clientId: string;
  clientSecret: string;
  tenantId: string;
  /** Lower-cased, normalized addresses an agent slot must never hold. */
  excludedEmails: string[];
}

/** Reads MS_OAUTH_* secrets. Returns null if any required one is missing. */
export function msConfig(env: { get(k: string): string | undefined } = Deno.env): MsConfig | null {
  const clientId = env.get("MS_OAUTH_CLIENT_ID")?.trim();
  const clientSecret = env.get("MS_OAUTH_CLIENT_SECRET")?.trim();
  const tenantId = env.get("MS_OAUTH_TENANT_ID")?.trim();
  if (!clientId || !clientSecret || !tenantId) return null;
  const excludedEmails = (env.get("MS_EXCLUDED_EMAILS") ?? "")
    .split(",")
    .map((e) => normalizeEmail(e))
    .filter(Boolean);
  return { clientId, clientSecret, tenantId, excludedEmails };
}

/** Lower-case and strip +tag aliases so an alias can't dodge the exclusion check. */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase().replace(/\+[^@]*@/, "@");
}

export function isExcludedIdentity(email: string, excluded: string[]): boolean {
  return excluded.includes(normalizeEmail(email));
}

export function authorizeUrl(
  cfg: Pick<MsConfig, "clientId" | "tenantId">,
  opts: { redirectUri: string; state: string; scopes?: readonly string[]; loginHint?: string; accountType?: MsAccountType },
): string {
  const u = new URL(`https://login.microsoftonline.com/${authorityFor(cfg, opts.accountType)}/oauth2/v2.0/authorize`);
  u.searchParams.set("client_id", cfg.clientId);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("response_mode", "query");
  u.searchParams.set("redirect_uri", opts.redirectUri);
  u.searchParams.set("scope", (opts.scopes ?? scopesFor(opts.accountType)).join(" "));
  // Always show the account chooser: the failure this prevents is the browser silently
  // reusing the owner's session and connecting the wrong mailbox to an agent.
  u.searchParams.set("prompt", "select_account");
  if (opts.loginHint) u.searchParams.set("login_hint", opts.loginHint); // re-auth of a specific account
  u.searchParams.set("state", opts.state);
  return u.toString();
}

type FetchLike = typeof fetch;

export interface TokenSet {
  accessToken: string;
  refreshToken: string;
  expiresAt: Date;
  scopes: string[];
  /** Tenant of the signed-in account (`tid` of the id token) when the response carried one. */
  tenantId?: string | null;
}

/** Which kind of account a token request is for (default: the home tenant, exactly as before). */
export interface AccountKind { accountType?: MsAccountType; tenantId?: string | null }

async function tokenRequest(
  cfg: MsConfig,
  params: Record<string, string>,
  fetchImpl: FetchLike,
  kind: AccountKind = {},
): Promise<TokenSet> {
  const r = await fetchImpl(
    `https://login.microsoftonline.com/${authorityFor(cfg, kind.accountType, kind.tenantId, "token")}/oauth2/v2.0/token`,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: cfg.clientId,
        client_secret: cfg.clientSecret,
        scope: scopesFor(kind.accountType).join(" "),
        ...params,
      }),
    },
  );
  const text = await r.text();
  if (!r.ok) {
    // Surface Entra's error code (e.g. invalid_grant) without echoing the whole body.
    let code = `http_${r.status}`;
    try {
      code = (JSON.parse(text) as { error?: string }).error ?? code;
    } catch { /* keep http code */ }
    throw new MsTokenError(code, r.status);
  }
  const j = JSON.parse(text) as {
    access_token: string;
    refresh_token?: string;
    expires_in?: number;
    scope?: string;
    id_token?: string;
  };
  if (!j.refresh_token) throw new MsTokenError("no_refresh_token", 200);
  return {
    accessToken: j.access_token,
    refreshToken: j.refresh_token,
    expiresAt: new Date(Date.now() + (j.expires_in ?? 3600) * 1000),
    scopes: (j.scope ?? "").split(" ").filter(Boolean),
    tenantId: tenantFromIdToken(j.id_token),
  };
}

export class MsTokenError extends Error {
  constructor(public code: string, public status: number) {
    super(`Microsoft token request failed: ${code}`);
  }
  /** invalid_grant / interaction_required mean the user must reconnect, not retry. */
  get needsReauth(): boolean {
    return this.code === "invalid_grant" || this.code === "interaction_required";
  }
}

export function exchangeCode(
  cfg: MsConfig,
  code: string,
  redirectUri: string,
  fetchImpl: FetchLike = fetch,
  kind: AccountKind = {},
): Promise<TokenSet> {
  return tokenRequest(cfg, {
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri,
  }, fetchImpl, kind);
}

export function refreshTokens(
  cfg: MsConfig,
  refreshToken: string,
  fetchImpl: FetchLike = fetch,
  kind: AccountKind = {},
): Promise<TokenSet> {
  return tokenRequest(cfg, { grant_type: "refresh_token", refresh_token: refreshToken }, fetchImpl, kind);
}

/** Host-allowlisted Graph call. `pathOrUrl` is a /v1.0-relative path or a full Graph URL. */
export async function graphFetch(
  accessToken: string,
  pathOrUrl: string,
  init: RequestInit = {},
  fetchImpl: FetchLike = fetch,
): Promise<Response> {
  const url = pathOrUrl.startsWith("http")
    ? pathOrUrl
    : `https://graph.microsoft.com/v1.0${pathOrUrl.startsWith("/") ? "" : "/"}${pathOrUrl}`;
  const host = new URL(url).hostname;
  if (!ALLOWED_HOSTS.has(host)) throw new Error(`graphFetch: host not permitted: ${host}`);
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${accessToken}`);
  if (init.body && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  return fetchImpl(url, { ...init, headers });
}

/** Resolve the mailbox behind a token via /me. */
export async function whoAmI(
  accessToken: string,
  fetchImpl: FetchLike = fetch,
): Promise<{ email: string; displayName?: string }> {
  const r = await graphFetch(accessToken, "/me?$select=mail,userPrincipalName,displayName", {}, fetchImpl);
  if (!r.ok) throw new Error(`Graph /me failed: ${r.status}`);
  const j = await r.json() as { mail?: string; userPrincipalName?: string; displayName?: string };
  const email = j.mail ?? j.userPrincipalName;
  if (!email) throw new Error("Graph /me returned no mailbox address");
  return { email, displayName: j.displayName };
}

/** One connected Microsoft 365 account (a microsoft_oauth_master row; `id` is the connection_id used everywhere). */
export interface MsConnection {
  id: string; user_id: string; organization_id: string; email: string; label: string | null;
  is_primary: boolean; connection_status: "active" | "needs_reauth"; login_enabled: boolean; created_at?: string;
  account_type?: MsAccountType; tenant_id?: string;
}
export interface ConnectionSelector { connectionId?: string | null; email?: string | null }
const CONN_COLS = "id, user_id, organization_id, email, label, is_primary, connection_status, login_enabled, created_at, account_type, tenant_id";

/**
 * Pure choice among one user's connections: by id, else by email (case-insensitive), else the primary, else the only/oldest row.
 * A selector that names an account the user does not have returns null (never a different account).
 */
export function pickConnection<T extends { id: string; email: string; is_primary?: boolean; created_at?: string }>(rows: T[], sel: ConnectionSelector = {}): T | null {
  if (!rows.length) return null;
  if (sel.connectionId) return rows.find((r) => r.id === sel.connectionId) ?? null;
  if (sel.email) return rows.find((r) => r.email.toLowerCase() === String(sel.email).toLowerCase()) ?? null;
  return rows.find((r) => r.is_primary) ?? [...rows].sort((a, b) => String(a.created_at ?? "").localeCompare(String(b.created_at ?? "")))[0];
}

/** Every Microsoft account the user has connected, primary first. */
export async function listMsConnections(supabase: SupabaseClient, userId: string): Promise<MsConnection[]> {
  const { data, error } = await supabase.from("microsoft_oauth_master").select(CONN_COLS).eq("user_id", userId)
    .order("is_primary", { ascending: false }).order("created_at", { ascending: true });
  if (error) throw new Error(`microsoft_oauth_master lookup failed: ${error.message}`);
  return (data ?? []) as MsConnection[];
}

/** The connection a call should use: the selected one, else the user's primary. Null when there is none. */
export async function resolveMsConnection(supabase: SupabaseClient, userId: string, sel: ConnectionSelector = {}): Promise<MsConnection | null> {
  return pickConnection(await listMsConnections(supabase, userId), sel);
}

/**
 * Returns a usable access token for a connected user, refreshing (and persisting the rotated
 * refresh token) when it is within a minute of expiry. Marks the connection `needs_reauth`
 * on invalid_grant so the UI can prompt a reconnect instead of failing silently.
 * A user may have several accounts: pass `connectionId` (or `email`) to pick one; the default is the primary.
 */
export async function getValidAccessToken(
  supabase: SupabaseClient,
  userId: string,
  opts: { cfg?: MsConfig | null; fetchImpl?: FetchLike } & ConnectionSelector = {},
): Promise<string> {
  const cfg = opts.cfg === undefined ? msConfig() : opts.cfg;
  if (!cfg) throw new Error("Microsoft integration not configured (MS_OAUTH_* secrets)");

  const { data: rows, error } = await supabase
    .from("microsoft_oauth_master")
    .select("id, encrypted_access_token, encrypted_refresh_token, token_expires_at, email, connection_status, is_primary, created_at, account_type, tenant_id")
    .eq("user_id", userId);
  if (error) throw new Error(`microsoft_oauth_master lookup failed: ${error.message}`);
  const row = pickConnection((rows ?? []) as Array<{ id: string; email: string; is_primary?: boolean; created_at?: string } & Record<string, any>>, opts);
  if (!row) throw new Error(opts.connectionId || opts.email ? "That Microsoft account is not connected for this user" : "Microsoft is not connected for this user");
  if (row.connection_status === "needs_reauth") {
    throw new Error("Microsoft connection needs to be re-authorized");
  }

  const expiresAt = new Date(row.token_expires_at).getTime();
  if (expiresAt - Date.now() > REFRESH_SKEW_MS) {
    return await decryptToken(row.encrypted_access_token);
  }

  const refreshToken = await decryptToken(row.encrypted_refresh_token);
  let tokens: TokenSet;
  try {
    tokens = await refreshTokens(cfg, refreshToken, opts.fetchImpl ?? fetch, { accountType: (row.account_type as MsAccountType | null) ?? "work", tenantId: row.tenant_id as string | null });
  } catch (e) {
    const needsReauth = e instanceof MsTokenError && e.needsReauth;
    await supabase.from("microsoft_oauth_master").update({
      connection_status: needsReauth ? "needs_reauth" : row.connection_status,
      last_refresh_error: e instanceof MsTokenError ? e.code : String((e as Error).message),
      updated_at: new Date().toISOString(),
    }).eq("id", row.id);
    throw e;
  }

  const now = new Date().toISOString();
  const { error: saveErr } = await supabase.from("microsoft_oauth_master").update({
    encrypted_access_token: await encryptToken(tokens.accessToken),
    encrypted_refresh_token: await encryptToken(tokens.refreshToken),
    token_expires_at: tokens.expiresAt.toISOString(),
    last_refresh_at: now,
    last_refresh_error: null,
    updated_at: now,
  }).eq("id", row.id);
  // The rotated refresh token is the only valid one now; if we can't save it the connection
  // is effectively lost, so this must be loud.
  if (saveErr) throw new Error(`failed to persist rotated Microsoft token: ${saveErr.message}`);
  return tokens.accessToken;
}
