/**
 * "Sign in with Microsoft": state handling and identity -> OS user resolution.
 *
 * A Microsoft identity may sign in as an OS user when EITHER
 *   1. it is already connected to that user with login_enabled=true (so the owner's Microsoft
 *      address need not equal their OS email; an agent mailbox connected to a user never
 *      qualifies because login_enabled defaults false), OR
 *   2. its address exactly matches an active OS user's email (after +alias normalization).
 * Anything else, a disabled user, or an ambiguous match is refused.
 */
import type { SupabaseClient } from "npm:@supabase/supabase-js@2";
import { normalizeEmail } from "./ms-graph.ts";

export async function createLoginState(db: SupabaseClient, redirectUri: string, appUrl?: string): Promise<string> {
  const token = crypto.randomUUID();
  const { error } = await db.from("ms_login_states").insert({ state_token: token, redirect_uri: redirectUri, app_url: appUrl ?? null });
  if (error) throw new Error(`login state insert failed: ${error.message}`);
  return token;
}

/** One-shot: the row is deleted whether or not it was still valid. Null when unknown/expired. */
export async function consumeLoginState(db: SupabaseClient, token: string, now = new Date()): Promise<{ redirectUri: string; appUrl: string | null } | null> {
  const { data } = await db.from("ms_login_states").select("id, redirect_uri, app_url, expires_at").eq("state_token", token).maybeSingle();
  const row = data as { id: string; redirect_uri: string; app_url: string | null; expires_at: string } | null;
  if (!row) return null;
  await db.from("ms_login_states").delete().eq("id", row.id);
  if (Date.parse(row.expires_at) < now.getTime()) return null;
  return { redirectUri: row.redirect_uri, appUrl: row.app_url };
}

export interface LoginUser { userId: string; orgId: string; email: string }
export type LoginResolution = { ok: true; user: LoginUser } | { ok: false; reason: "no_account" | "disabled" | "ambiguous" };

// An invited user may sign in: Microsoft has just proven they own the invited address, and the callback marks them active.
const active = (u: { status?: string | null; disabled_at?: string | null }) => ["active", "invited"].includes(u.status ?? "active") && !u.disabled_at;

async function userById(db: SupabaseClient, id: string): Promise<LoginResolution> {
  const { data: u } = await db.from("users").select("id, organization_id, email, status, disabled_at").eq("id", id).maybeSingle();
  const user = u as { id: string; organization_id: string; email: string; status?: string; disabled_at?: string | null } | null;
  if (!user) return { ok: false, reason: "no_account" };
  return active(user) ? { ok: true, user: { userId: user.id, orgId: user.organization_id, email: user.email } } : { ok: false, reason: "disabled" };
}

export async function resolveLoginUser(db: SupabaseClient, msEmail: string): Promise<LoginResolution> {
  const lower = msEmail.trim().toLowerCase();
  const norm = normalizeEmail(msEmail);
  const variants = [...new Set([msEmail.trim(), lower, norm])];

  // The login-enabled set is tiny and deliberate, so compare normalized addresses here rather than
  // trusting how a given row happened to be cased when stored.
  // Explicit owner-managed links take precedence (the Microsoft address may differ from the OS email).
  const { data: explicit } = await db.from("ms_login_links").select("user_id, microsoft_email");
  const ex = ((explicit ?? []) as { user_id: string; microsoft_email: string }[]).filter((l) => normalizeEmail(l.microsoft_email) === norm);
  if (ex.length > 1) return { ok: false, reason: "ambiguous" };
  if (ex.length === 1) return userById(db, ex[0].user_id);

  const { data: linked } = await db.from("microsoft_oauth_master").select("user_id, organization_id, email").eq("login_enabled", true);
  const links = ((linked ?? []) as { user_id: string; organization_id: string; email: string }[]).filter((l) => normalizeEmail(l.email) === norm);
  if (links.length > 1) return { ok: false, reason: "ambiguous" };
  if (links.length === 1) return userById(db, links[0].user_id);

  const { data: byEmail } = await db.from("users").select("id, organization_id, email, status, disabled_at").in("email", variants);
  const rows = ((byEmail ?? []) as { id: string; organization_id: string; email: string; status?: string; disabled_at?: string | null }[]).filter((u) => normalizeEmail(u.email) === norm);
  if (rows.length === 0) return { ok: false, reason: "no_account" };
  if (rows.length > 1) return { ok: false, reason: "ambiguous" };
  return active(rows[0]) ? { ok: true, user: { userId: rows[0].id, orgId: rows[0].organization_id, email: rows[0].email } } : { ok: false, reason: "disabled" };
}
