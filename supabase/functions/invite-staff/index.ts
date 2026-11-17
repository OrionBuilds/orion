/**
 * invite-staff — creates a staff login (human or agent) for the caller's organization.
 *
 * The browser used to call supabase.auth.admin.createUser directly, which Supabase rejects (403 "User not
 * allowed": admin endpoints need the service role, which must never ship to a browser). So the Invite User
 * drawer could not add anybody. This function does it server-side, after checking the caller:
 *   - a valid signed-in session (JWT verified by the anon client);
 *   - an active SuperAdmin or Admin of an organization;
 *   - the target role must not outrank the caller (SuperAdmin may assign any role) — same rule as the UI.
 * The new user always lands in the CALLER'S organization (the body cannot choose another one).
 * The browser then sends the set-password email (resetPasswordForEmail) as before.
 */
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { getAnonClient, getSupabaseClient } from "../_shared/auth.ts";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};
const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { ...cors, "Content-Type": "application/json" } });

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 200, headers: cors });
  if (req.method !== "POST") return json({ error: "Use POST" }, 405);

  const token = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!token) return json({ error: "Missing authorization" }, 401);
  const { data: { user: caller }, error: authError } = await getAnonClient().auth.getUser(token);
  if (authError || !caller) return json({ error: "Invalid or expired session" }, 401);

  const db = getSupabaseClient();
  const { data: me } = await db
    .from("users")
    .select("id, organization_id, status, role:roles(name, hierarchy_level)")
    .eq("id", caller.id)
    .maybeSingle();
  const myRole = (me as { role?: { name: string; hierarchy_level: number } } | null)?.role;
  if (!me || me.status === "inactive" || me.status === "disabled" || !myRole || !["SuperAdmin", "Admin"].includes(myRole.name)) {
    return json({ error: "Only an Admin or SuperAdmin can invite users" }, 403);
  }

  let body: Record<string, unknown> = {};
  try { body = await req.json(); } catch { /* empty */ }
  const email = String(body.email ?? "").trim().toLowerCase();
  const name = `${String(body.first_name ?? "").trim()} ${String(body.last_name ?? "").trim()}`.trim();
  const roleId = String(body.role_id ?? "");
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) || !name || !roleId) {
    return json({ error: "email, first_name and role_id are required" }, 400);
  }

  const { data: targetRole } = await db.from("roles").select("id, name, hierarchy_level").eq("id", roleId).maybeSingle();
  if (!targetRole) return json({ error: "Invalid role selected" }, 400);
  if (myRole.name !== "SuperAdmin" && !(targetRole.hierarchy_level > myRole.hierarchy_level)) {
    return json({ error: "You cannot assign a role with higher privileges than your own" }, 403);
  }

  const { data: existing } = await db.from("users").select("id").ilike("email", email).maybeSingle();
  if (existing) return json({ error: "A user with this email already exists" }, 409);

  const bytes = crypto.getRandomValues(new Uint8Array(18));
  const password = btoa(String.fromCharCode(...bytes)) + "Aa1!";
  const { data: created, error: createError } = await db.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: { name },
  });
  if (createError || !created?.user) return json({ error: createError?.message ?? "Could not create the login" }, 400);

  // A handle_new_auth_user trigger may already have inserted a default row: upsert sets the real values.
  const { data: row, error: rowError } = await db
    .from("users")
    .upsert({
      id: created.user.id,
      email,
      name,
      role_id: targetRole.id,
      organization_id: me.organization_id,
      department_id: body.department_id ? String(body.department_id) : null,
      phone: body.phone ? String(body.phone) : null,
      timezone: body.timezone ? String(body.timezone) : "America/New_York",
      status: "invited",
      invited_by: caller.id,
    }, { onConflict: "id" })
    .select("*, role:roles(*), department:departments(*)")
    .single();
  if (rowError) {
    await db.auth.admin.deleteUser(created.user.id);
    return json({ error: rowError.message }, 400);
  }

  await db.from("audit_logs").insert({
    user_id: caller.id,
    action: "staff.invite",
    entity_type: "user",
    entity_id: created.user.id,
    after_state: { email, name, role: targetRole.name },
  });
  return json({ success: true, user: row });
});
