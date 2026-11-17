import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import type { SupabaseClient } from "npm:@supabase/supabase-js@2";
import { extractUserContext, getSupabaseClient } from "../_shared/auth.ts";
import { handleCors, jsonResponse } from "../_shared/cors.ts";
import { hasPermission } from "../_shared/permissions.ts";

/**
 * admin-mfa-reset — Staff Management recovery for a user who lost their second factor.
 *
 * POST { action: "status", userId } -> { factors: [{ id, factor_type, friendly_name, status, created_at, phone_masked }] }
 * POST { action: "reset",  userId } -> { removed: number }
 *   Deletes every MFA factor on the target with the service role (auth.admin.mfa.deleteFactor).
 *   Deleting a verified factor also signs the target out of all sessions; they sign back in with
 *   their password alone and can enroll again from Settings -> My Profile -> Security.
 *
 * Auth (all checks server-side; the browser only shows/hides the button):
 *  - user JWT validated in code (extractUserContext -> auth.getUser) and the gateway's
 *    verify_jwt=true stays on (not listed in config.toml), same as agent-task-builder.
 *  - caller must hold staff.reset_password (Admin / SuperAdmin), the permission that already
 *    gates "Reset Password" in the same drawer.
 *  - caller's own session must be aal2 when the caller has a verified factor. Without this, a
 *    stolen admin password (aal1 session) could call this endpoint directly and strip MFA.
 *  - target must be in the caller's active org (SuperAdmin exempt), must rank strictly below the
 *    caller (roles.hierarchy_level, lower = more senior; SuperAdmin exempt), and cannot be the
 *    caller (self-service lives in the Security tab, which requires a fresh code).
 *  - every reset is written to audit_logs (shows in the user's Activity tab).
 */

interface RoleRow {
  name: string | null;
  hierarchy_level: number | null;
}

interface TargetRow {
  id: string;
  email: string | null;
  name: string | null;
  organization_id: string | null;
  role: RoleRow | RoleRow[] | null;
}

interface FactorRow {
  id: string;
  factor_type: string;
  friendly_name?: string | null;
  status: string;
  created_at: string;
  phone?: string | null;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function error(code: string, message: string, status: number): Response {
  return jsonResponse({ error: { code, message } }, status);
}

/** The aal claim of a token whose signature auth.getUser() has already verified. */
function tokenAal(req: Request): string | null {
  const token = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  const part = token.split(".")[1];
  if (!part) return null;
  try {
    const b64 = part.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(part.length / 4) * 4, "=");
    const payload = JSON.parse(atob(b64)) as { aal?: unknown };
    return typeof payload.aal === "string" ? payload.aal : null;
  } catch {
    return null;
  }
}

function maskPhone(phone: string | null | undefined): string | null {
  if (!phone) return null;
  const digits = phone.replace(/\D/g, "");
  return digits.length >= 4 ? `•••• ${digits.slice(-4)}` : null;
}

async function listFactors(svc: SupabaseClient, userId: string): Promise<FactorRow[]> {
  const { data, error: err } = await svc.auth.admin.mfa.listFactors({ userId });
  if (err) throw err;
  return (data?.factors ?? []) as FactorRow[];
}

function firstRole(role: RoleRow | RoleRow[] | null): RoleRow | null {
  if (!role) return null;
  return Array.isArray(role) ? role[0] ?? null : role;
}

Deno.serve(async (req: Request) => {
  const cors = handleCors(req);
  if (cors) return cors;
  if (req.method !== "POST") return error("METHOD_NOT_ALLOWED", "Use POST", 405);

  try {
    const svc = getSupabaseClient();
    const caller = await extractUserContext(req, svc);
    if (!caller) return error("AUTH_REQUIRED", "Authentication required", 401);

    if (!hasPermission(caller, "staff.reset_password")) {
      return error("PERMISSION_DENIED", "Permission denied: staff.reset_password required", 403);
    }

    // Step-up: an MFA-enrolled admin must be at aal2 to administer anyone's MFA.
    const callerFactors = await listFactors(svc, caller.id);
    const callerHasVerified = callerFactors.some((f) => f.status === "verified");
    if (callerHasVerified && tokenAal(req) !== "aal2") {
      return error("MFA_REQUIRED", "Complete two-factor verification before managing MFA for others", 403);
    }

    const body = await req.json().catch(() => ({})) as { action?: unknown; userId?: unknown };
    const action = body.action;
    const userId = typeof body.userId === "string" ? body.userId : "";
    if (action !== "status" && action !== "reset") {
      return error("INVALID_ACTION", "action must be 'status' or 'reset'", 400);
    }
    if (!UUID_RE.test(userId)) return error("INVALID_USER", "userId must be a UUID", 400);

    const { data: target, error: targetErr } = await svc
      .from("users")
      .select("id, email, name, organization_id, role:roles(name, hierarchy_level)")
      .eq("id", userId)
      .maybeSingle<TargetRow>();
    if (targetErr) throw targetErr;
    // Same 404 for "no such user" and "not in your org" so org membership isn't probeable.
    if (!target || (!caller.isSuperAdmin && target.organization_id !== caller.orgId)) {
      return error("NOT_FOUND", "User not found", 404);
    }

    if (target.id === caller.id && action === "reset") {
      return error(
        "SELF_RESET_NOT_ALLOWED",
        "Manage your own two-factor methods from Settings > My Profile > Security",
        400,
      );
    }

    if (!caller.isSuperAdmin && target.id !== caller.id) {
      const targetRole = firstRole(target.role);
      if (targetRole?.name === "SuperAdmin") {
        return error("PERMISSION_DENIED", "Only a SuperAdmin can manage a SuperAdmin's MFA", 403);
      }
      const { data: callerRole } = await svc
        .from("roles")
        .select("hierarchy_level")
        .eq("id", caller.roleId)
        .maybeSingle<{ hierarchy_level: number | null }>();
      const callerLevel = callerRole?.hierarchy_level ?? Number.POSITIVE_INFINITY;
      const targetLevel = targetRole?.hierarchy_level ?? Number.POSITIVE_INFINITY;
      if (!(targetLevel > callerLevel)) {
        return error("PERMISSION_DENIED", "You can only manage MFA for users below your role", 403);
      }
    }

    const factors = await listFactors(svc, target.id);
    const summary = factors.map((f) => ({
      id: f.id,
      factor_type: f.factor_type,
      friendly_name: f.friendly_name ?? null,
      status: f.status,
      created_at: f.created_at,
      phone_masked: maskPhone(f.phone),
    }));

    if (action === "status") {
      return jsonResponse({ factors: summary });
    }

    let removed = 0;
    const failures: string[] = [];
    for (const f of factors) {
      const { error: delErr } = await svc.auth.admin.mfa.deleteFactor({ id: f.id, userId: target.id });
      if (delErr) failures.push(`${f.factor_type}:${delErr.message}`);
      else removed++;
    }

    const { error: auditErr } = await svc.from("audit_logs").insert({
      user_id: caller.id,
      organization_id: target.organization_id ?? caller.orgId,
      action: "mfa_reset",
      entity_type: "user",
      entity_id: target.id,
      before_state: {
        factors: summary.map(({ factor_type, friendly_name, status }) => ({ factor_type, friendly_name, status })),
      },
      after_state: { removed, failed: failures.length, target_email: target.email },
    });
    if (auditErr) console.error("[admin-mfa-reset] audit insert failed:", auditErr.message);

    if (failures.length > 0) {
      console.error("[admin-mfa-reset] some factors failed to delete:", failures.join("; "));
      return error("PARTIAL_FAILURE", `Removed ${removed} of ${factors.length} factors. Try again.`, 500);
    }

    return jsonResponse({ removed });
  } catch (err) {
    console.error("[admin-mfa-reset] error:", err instanceof Error ? err.message : err);
    return error("INTERNAL_ERROR", "Failed to process MFA request", 500);
  }
});
