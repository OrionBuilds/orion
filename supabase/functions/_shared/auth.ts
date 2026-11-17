import { createClient, SupabaseClient } from "npm:@supabase/supabase-js@2";
import type { UserContext } from "./types.ts";

export function getAnonClient(): SupabaseClient {
  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
  return createClient(supabaseUrl, anonKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

export function getSupabaseClient(): SupabaseClient {
  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  return createClient(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

export async function extractUserContext(
  req: Request,
  supabase: SupabaseClient
): Promise<UserContext | null> {
  const authHeader = req.headers.get("Authorization");
  if (!authHeader) {
    console.error("[Auth] No Authorization header");
    return null;
  }

  const token = authHeader.replace("Bearer ", "");

  // Validate the JWT via the anon client — this VERIFIES the signature.
  //
  // There is deliberately no fallback here. A previous version, on getUser() failure,
  // base64-decoded the token payload and trusted its `sub` claim. That is an
  // authentication bypass: a getUser() failure is precisely the signal that the token
  // is forged, expired, or from another project, and an unverified payload proves
  // nothing about the caller. If "missing sub"/project-mismatch tokens are genuinely
  // being issued, fix that at issuance — never by trusting an unverified claim.
  const anonClient = getAnonClient();
  const { data: { user }, error: authError } = await anonClient.auth.getUser(token);

  if (authError || !user) {
    console.warn("[Auth] Token rejected:", authError?.message ?? "no user in token");
    return null;
  }

  // Use service role client for database queries (bypass RLS).
  // super_admin_active_org_id lets a SuperAdmin pivot active org via the
  // OrgSwitcher; we honor it below the same way get_user_org_id() does.
  const { data: userData, error: userError } = await supabase
    .from("users")
    .select("id, email, organization_id, super_admin_active_org_id, role_id, department_id")
    .eq("id", user.id)
    .maybeSingle();

  if (userError) {
    console.error("[Auth] Failed to fetch user data:", userError.message);
    return null;
  }

  if (!userData) {
    console.error("[Auth] User not found in database:", user.id);
    return null;
  }

  console.log("[Auth] User data loaded successfully");

  let roleName = "Unknown";
  if (userData.role_id) {
    const { data: roleData } = await supabase
      .from("roles")
      .select("id, name")
      .eq("id", userData.role_id)
      .maybeSingle();
    if (roleData) {
      roleName = roleData.name;
    }
  }

  const rolePermissions = new Set<string>();

  if (userData.role_id) {
    const { data: rpRows } = await supabase
      .from("role_permissions")
      .select("permission_id")
      .eq("role_id", userData.role_id);

    if (rpRows && rpRows.length > 0) {
      const permIds = rpRows.map((r: { permission_id: string }) => r.permission_id);
      const { data: perms } = await supabase
        .from("permissions")
        .select("key")
        .in("id", permIds);

      if (perms) {
        for (const p of perms) {
          rolePermissions.add(p.key);
        }
      }
    }
  }

  const { data: overrides } = await supabase
    .from("user_permission_overrides")
    .select("permission_id, granted")
    .eq("user_id", userData.id);

  if (overrides && overrides.length > 0) {
    const overridePermIds = overrides.map((o: { permission_id: string }) => o.permission_id);
    const { data: overridePerms } = await supabase
      .from("permissions")
      .select("id, key")
      .in("id", overridePermIds);

    if (overridePerms) {
      const permKeyMap = new Map(overridePerms.map((p: { id: string; key: string }) => [p.id, p.key]));
      for (const override of overrides) {
        const key = permKeyMap.get(override.permission_id);
        if (key) {
          if (override.granted) {
            rolePermissions.add(key);
          } else {
            rolePermissions.delete(key);
          }
        }
      }
    }
  }

  const isSuperAdmin = roleName === "SuperAdmin";

  // SuperAdmin org pivot: when super_admin_active_org_id is set, use it as
  // the effective org. Mirrors public.get_user_org_id() so server-side data
  // queries in edge functions match the active org the user is viewing.
  const activeOrgId =
    (isSuperAdmin && userData.super_admin_active_org_id) ||
    userData.organization_id;

  return {
    id: userData.id,
    email: userData.email,
    orgId: activeOrgId,
    homeOrgId: userData.organization_id,
    roleId: userData.role_id,
    roleName,
    departmentId: userData.department_id,
    isSuperAdmin,
    permissions: Array.from(rolePermissions),
  };
}

export async function extractUserContextById(
  supabase: SupabaseClient,
  userId: string
): Promise<UserContext | null> {
  const { data: userData, error: userError } = await supabase
    .from("users")
    .select("id, email, organization_id, super_admin_active_org_id, role_id, department_id")
    .eq("id", userId)
    .maybeSingle();

  if (userError || !userData) {
    console.error("[Auth] Internal lookup failed for user:", userId);
    return null;
  }

  let roleName = "Unknown";
  if (userData.role_id) {
    const { data: roleData } = await supabase
      .from("roles")
      .select("id, name")
      .eq("id", userData.role_id)
      .maybeSingle();
    if (roleData) roleName = roleData.name;
  }

  const rolePermissions = new Set<string>();
  if (userData.role_id) {
    const { data: rpRows } = await supabase
      .from("role_permissions")
      .select("permission_id")
      .eq("role_id", userData.role_id);
    if (rpRows && rpRows.length > 0) {
      const permIds = rpRows.map((r: { permission_id: string }) => r.permission_id);
      const { data: perms } = await supabase
        .from("permissions")
        .select("key")
        .in("id", permIds);
      if (perms) {
        for (const p of perms) rolePermissions.add(p.key);
      }
    }
  }

  const { data: overrides } = await supabase
    .from("user_permission_overrides")
    .select("permission_id, granted")
    .eq("user_id", userData.id);
  if (overrides && overrides.length > 0) {
    const overridePermIds = overrides.map((o: { permission_id: string }) => o.permission_id);
    const { data: overridePerms } = await supabase
      .from("permissions")
      .select("id, key")
      .in("id", overridePermIds);
    if (overridePerms) {
      const permKeyMap = new Map(overridePerms.map((p: { id: string; key: string }) => [p.id, p.key]));
      for (const override of overrides) {
        const key = permKeyMap.get(override.permission_id);
        if (key) {
          if (override.granted) rolePermissions.add(key);
          else rolePermissions.delete(key);
        }
      }
    }
  }

  const isSuperAdmin2 = roleName === "SuperAdmin";
  const activeOrgId =
    (isSuperAdmin2 && userData.super_admin_active_org_id) ||
    userData.organization_id;

  return {
    id: userData.id,
    email: userData.email,
    orgId: activeOrgId,
    homeOrgId: userData.organization_id,
    roleId: userData.role_id,
    roleName,
    departmentId: userData.department_id,
    isSuperAdmin: isSuperAdmin2,
    permissions: Array.from(rolePermissions),
  };
}

export function isServiceRoleRequest(req: Request): boolean {
  const authHeader = req.headers.get("Authorization");
  if (!authHeader) return false;
  const token = authHeader.replace("Bearer ", "");
  const expected = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
  // Constant-time comparison to prevent timing attacks
  if (token.length !== expected.length) return false;
  const encoder = new TextEncoder();
  const a = encoder.encode(token);
  const b = encoder.encode(expected);
  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a[i] ^ b[i];
  }
  return result === 0;
}

/**
 * True when the caller presents the shared cron secret in `X-Cron-Secret`.
 *
 * Used by functions that only pg_cron should reach. It exists because
 * `isServiceRoleRequest` cannot serve that purpose here: it compares against
 * Deno.env.get("SUPABASE_SERVICE_ROLE_KEY"), whose runtime value matches none of the project's
 * four API keys (verified 2026-07-28 by calling a gated function with each of them - all 401), and
 * the Management API returns only digests, so pg_cron has no way to present a matching value.
 * `isServiceRoleRequest` still works for edge-to-edge calls, where both sides read the same env var.
 *
 * A purpose-made secret is also least-privilege: leaking it allows invoking cron endpoints, not
 * full database access. Stored as edge secret CRON_SECRET and as vault secret `cron_secret`.
 */
export function isCronRequest(req: Request): boolean {
  const provided = req.headers.get("X-Cron-Secret");
  if (!provided) return false;
  const expected = Deno.env.get("CRON_SECRET") || "";
  if (!expected || provided.length !== expected.length) return false;
  // Constant-time comparison to prevent timing attacks.
  const encoder = new TextEncoder();
  const a = encoder.encode(provided);
  const b = encoder.encode(expected);
  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a[i] ^ b[i];
  }
  return result === 0;
}

export function requireAuth(userContext: UserContext | null): UserContext {
  if (!userContext) {
    throw new AuthError("Authentication required", "AUTH_REQUIRED");
  }
  return userContext;
}

export class AuthError extends Error {
  code: string;

  constructor(message: string, code: string) {
    super(message);
    this.code = code;
    this.name = "AuthError";
  }
}
