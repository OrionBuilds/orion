/**
 * Workspace-provider resolver: decides whether a user (or an org, for background jobs with no
 * user context) works through Google Workspace or Microsoft 365.
 *
 * Source of truth is `user_connected_accounts` (status = 'connected'):
 *   - Microsoft: provider = 'microsoft_365' (written by microsoft-oauth-callback / ms-login).
 *   - Google:    provider = 'google_workspace' (written by google-oauth-unified) or the legacy
 *                'google_gmail' row (gmail scopes only). Both normalise to 'google'.
 * Org default: organizations.default_workspace_provider when set, else whichever provider most of
 * the org's users have connected (Microsoft wins ties, so existing Microsoft orgs never regress).
 *
 * The frontend twin is src/services/connectedProvider.ts — keep the pure helpers in sync.
 */
import type { SupabaseClient } from "npm:@supabase/supabase-js@2";

export type WorkspaceProvider = "google" | "microsoft";

export const GOOGLE_ACCOUNT_PROVIDERS = ["google_workspace", "google_gmail"] as const;
export const MICROSOFT_ACCOUNT_PROVIDERS = ["microsoft_365"] as const;
export const ALL_ACCOUNT_PROVIDERS: string[] = [...GOOGLE_ACCOUNT_PROVIDERS, ...MICROSOFT_ACCOUNT_PROVIDERS];

/** Maps a user_connected_accounts.provider value to a workspace provider (null = not a workspace row). */
export function normalizeAccountProvider(p: string | null | undefined): WorkspaceProvider | null {
  if (!p) return null;
  if ((GOOGLE_ACCOUNT_PROVIDERS as readonly string[]).includes(p)) return "google";
  if ((MICROSOFT_ACCOUNT_PROVIDERS as readonly string[]).includes(p)) return "microsoft";
  return null;
}

export function isWorkspaceProvider(v: unknown): v is WorkspaceProvider {
  return v === "google" || v === "microsoft";
}

export interface AccountRow {
  provider: string;
  status?: string | null;
  provider_account_email?: string | null;
}

/** Distinct connected workspace providers in a set of account rows. */
export function connectedProviders(rows: AccountRow[]): WorkspaceProvider[] {
  const out = new Set<WorkspaceProvider>();
  for (const r of rows) {
    if (r.status && r.status !== "connected") continue;
    const p = normalizeAccountProvider(r.provider);
    if (p) out.add(p);
  }
  // Stable order: Microsoft first (the incumbent), then Google.
  return (["microsoft", "google"] as WorkspaceProvider[]).filter((p) => out.has(p));
}

/**
 * Picks one provider. `prefer` (explicit caller choice) wins if connected, then the org default
 * if connected, then the only/first connected one. Null when nothing is connected.
 */
export function pickProvider(
  connected: WorkspaceProvider[],
  opts: { prefer?: WorkspaceProvider | null; orgDefault?: WorkspaceProvider | null } = {},
): WorkspaceProvider | null {
  if (connected.length === 0) return null;
  if (opts.prefer && connected.includes(opts.prefer)) return opts.prefer;
  if (opts.orgDefault && connected.includes(opts.orgDefault)) return opts.orgDefault;
  return connected[0];
}

/** Org default from the explicit setting, else the majority of connected users (Microsoft wins ties). */
export function pickOrgDefault(
  setting: string | null | undefined,
  perUser: WorkspaceProvider[][],
): WorkspaceProvider | null {
  if (isWorkspaceProvider(setting)) return setting;
  let ms = 0, g = 0;
  for (const ps of perUser) {
    if (ps.includes("microsoft")) ms++;
    if (ps.includes("google")) g++;
  }
  if (ms === 0 && g === 0) return null;
  return ms >= g ? "microsoft" : "google";
}

// deno-lint-ignore no-explicit-any
type Db = SupabaseClient<any, any, any> | { from: (t: string) => any };

/** All connected workspace providers for a user (empty when none). */
export async function getUserProviders(supabase: Db, userId: string): Promise<WorkspaceProvider[]> {
  // deno-lint-ignore no-explicit-any
  const { data } = await (supabase as any)
    .from("user_connected_accounts")
    .select("provider, status, provider_account_email")
    .eq("user_id", userId)
    .in("provider", ALL_ACCOUNT_PROVIDERS);
  return connectedProviders((data ?? []) as AccountRow[]);
}

/** The connected account email for a user on a given provider, if any (Google: the PRIMARY account's). */
export async function getProviderAccountEmail(
  supabase: Db,
  userId: string,
  provider: WorkspaceProvider,
): Promise<string | null> {
  const providers = provider === "google" ? [...GOOGLE_ACCOUNT_PROVIDERS] : [...MICROSOFT_ACCOUNT_PROVIDERS];
  if (provider === "google") {
    // several Google accounts: the primary's email (the user_connected_accounts mirror is kept equal to it by a trigger,
    // but the master row is the source of truth)
    // deno-lint-ignore no-explicit-any
    const { data: primary } = await (supabase as any)
      .from("google_oauth_master")
      .select("email")
      .eq("user_id", userId)
      .eq("is_primary", true)
      .limit(1);
    const email = ((primary ?? []) as { email?: string | null }[])[0]?.email;
    if (email) return email;
  }
  // deno-lint-ignore no-explicit-any
  const { data } = await (supabase as any)
    .from("user_connected_accounts")
    .select("provider, status, provider_account_email")
    .eq("user_id", userId)
    .in("provider", providers);
  const row = ((data ?? []) as AccountRow[]).find((r) => !r.status || r.status === "connected");
  return row?.provider_account_email ?? null;
}

/** Org default provider for background jobs (null when the org has nothing connected and no setting). */
export async function resolveOrgDefaultProvider(supabase: Db, orgId: string): Promise<WorkspaceProvider | null> {
  // deno-lint-ignore no-explicit-any
  const db = supabase as any;
  const { data: org } = await db.from("organizations").select("default_workspace_provider").eq("id", orgId).maybeSingle();
  const setting = (org as { default_workspace_provider?: string | null } | null)?.default_workspace_provider ?? null;
  if (isWorkspaceProvider(setting)) return setting;
  const { data: users } = await db.from("users").select("id").eq("organization_id", orgId);
  const ids = ((users ?? []) as { id: string }[]).map((u) => u.id);
  if (ids.length === 0) return null;
  const { data: rows } = await db
    .from("user_connected_accounts")
    .select("user_id, provider, status")
    .in("user_id", ids)
    .in("provider", ALL_ACCOUNT_PROVIDERS);
  const byUser = new Map<string, AccountRow[]>();
  for (const r of (rows ?? []) as (AccountRow & { user_id: string })[]) {
    (byUser.get(r.user_id) ?? byUser.set(r.user_id, []).get(r.user_id)!).push(r);
  }
  return pickOrgDefault(null, [...byUser.values()].map(connectedProviders));
}

/**
 * The provider to use for a user's personal workspace action (mail, calendar, files).
 * `prefer` lets a caller pin a provider (e.g. an event that lives in Google). When the user has
 * both connected, the org default decides. Null = the user has neither connected.
 */
export async function resolveUserProvider(
  supabase: Db,
  userId: string,
  opts: { prefer?: WorkspaceProvider | null; orgId?: string | null } = {},
): Promise<WorkspaceProvider | null> {
  const connected = await getUserProviders(supabase, userId);
  if (opts.prefer && connected.includes(opts.prefer)) return opts.prefer;
  if (connected.length <= 1) return connected[0] ?? null;
  const orgDefault = opts.orgId ? await resolveOrgDefaultProvider(supabase, opts.orgId) : null;
  return pickProvider(connected, { orgDefault });
}
