import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";
import { isCronRequest } from "../_shared/auth.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, {
      status: 200,
      headers: corsHeaders,
    });
  }

  // This endpoint creates a SuperAdmin. It was deployed verify_jwt=false with no caller
  // check, so anyone who could reach the URL reached the code below - verified 2026-07-29
  // by an anonymous POST, which got as far as the "System already bootstrapped" branch.
  //
  // Bootstrap is a one-shot operator action, not something the public should be able to
  // attempt at all. Require the shared cron secret so an operator can still run it
  // deliberately.
  if (!isCronRequest(req)) {
    console.warn("[bootstrap-admin] rejected request without a valid cron secret");
    return new Response(
      JSON.stringify({ error: "Unauthorized" }),
      { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

    if (!supabaseUrl || !serviceRoleKey) {
      throw new Error("Missing environment variables");
    }

    const supabase = createClient(supabaseUrl, serviceRoleKey, {
      auth: {
        autoRefreshToken: false,
        persistSession: false,
      },
    });

    // Fail CLOSED on a failed lookup. This previously destructured `data` and ignored
    // `error`: on any query failure existingUsers was null, the guard below evaluated
    // false, and the function proceeded to mint a SuperAdmin. A lookup that did not
    // succeed tells us nothing about whether the system is bootstrapped, so the only
    // safe reading is "refuse".
    const { data: existingUsers, error: existingUsersError } = await supabase
      .from("users")
      .select("id")
      .limit(1);

    if (existingUsersError) {
      console.error("[bootstrap-admin] could not verify bootstrap state:", existingUsersError.message);
      return new Response(
        JSON.stringify({ error: "Could not verify bootstrap state; refusing to proceed" }),
        { status: 503, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    if (!existingUsers || existingUsers.length > 0) {
      return new Response(
        JSON.stringify({ error: "System already bootstrapped" }),
        {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
    }

    // Credentials MUST come from env — never hardcode them (they live forever in git).
    const adminEmail = Deno.env.get("BOOTSTRAP_ADMIN_EMAIL");
    const adminPassword = Deno.env.get("BOOTSTRAP_ADMIN_PASSWORD");
    const adminName = "System Administrator";

    if (!adminEmail || !adminPassword) {
      return new Response(
        JSON.stringify({
          error:
            "Bootstrap admin credentials not configured. Set BOOTSTRAP_ADMIN_EMAIL and BOOTSTRAP_ADMIN_PASSWORD env vars.",
        }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const { data: authData, error: authError } = await supabase.auth.admin.createUser({
      email: adminEmail,
      password: adminPassword,
      email_confirm: true,
    });

    if (authError) {
      throw authError;
    }

    if (!authData.user) {
      throw new Error("Failed to create auth user");
    }

    const { data: superAdminRole } = await supabase
      .from("roles")
      .select("id")
      .eq("name", "SuperAdmin")
      .single();

    if (!superAdminRole) {
      throw new Error("SuperAdmin role not found");
    }

    // Single-tenant install: the org row seeded by supabase/setup.sql.
    const orgId = "00000000-0000-0000-0000-000000000001";

    // The handle_new_auth_user trigger may have already created a row
    // with the Admin role. UPSERT to upgrade to SuperAdmin.
    const { error: userError } = await supabase
      .from("users")
      .upsert(
        {
          id: authData.user.id,
          email: adminEmail,
          name: adminName,
          role_id: superAdminRole.id,
          organization_id: orgId,
          status: "active",
        },
        { onConflict: "id" },
      );

    if (userError) {
      throw userError;
    }

    await supabase.from("audit_logs").insert({
      user_id: authData.user.id,
      action: "create",
      entity_type: "user",
      entity_id: authData.user.id,
      after_state: {
        email: adminEmail,
        name: adminName,
        role: "SuperAdmin",
        note: "System bootstrap",
      },
    });

    return new Response(
      JSON.stringify({
        success: true,
        message: "SuperAdmin account created successfully",
        email: adminEmail,
      }),
      {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      }
    );
  } catch (error) {
    return new Response(
      JSON.stringify({ error: error.message }),
      {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      }
    );
  }
});
