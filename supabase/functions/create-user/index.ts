import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";
import { getAnonClient, isCronRequest, isServiceRoleRequest } from "../_shared/auth.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};

interface CreateUserRequest {
  email: string;
  password: string;
  name: string;
  roleName?: string;
  organizationId?: string;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, {
      status: 200,
      headers: corsHeaders,
    });
  }

  // This creates logins with any role in any org using the service role. It used to run for ANYONE
  // holding the public anon key (verify_jwt only checks the key is valid), i.e. an unauthenticated
  // "create a SuperAdmin" endpoint. Now: the cron secret, the service role (MCP / edge-to-edge), or a
  // signed-in SuperAdmin. The Invite User drawer uses invite-staff instead.
  if (!isCronRequest(req) && !isServiceRoleRequest(req)) {
    const token = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
    const { data: { user: caller } } = token ? await getAnonClient().auth.getUser(token) : { data: { user: null } };
    let ok = false;
    if (caller) {
      const gate = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
      const { data: me } = await gate.from("users").select("role:roles(name)").eq("id", caller.id).maybeSingle();
      ok = (me as { role?: { name: string } } | null)?.role?.name === "SuperAdmin";
    }
    if (!ok) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
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

    const body: CreateUserRequest = await req.json();
    const { email, password, name, roleName = "Sales" } = body;
    let { organizationId } = body;

    if (!email || !password || !name) {
      return new Response(
        JSON.stringify({ error: "Missing required fields: email, password, name" }),
        {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
    }

    // Resolve organization by email domain if caller didn't specify one
    if (!organizationId) {
      const domain = email.split("@")[1]?.toLowerCase();
      if (domain) {
        const { data: domainRow } = await supabase
          .from("organization_email_domains")
          .select("organization_id")
          .ilike("domain", domain)
          .maybeSingle();
        if (domainRow) {
          organizationId = domainRow.organization_id;
        }
      }
      if (!organizationId) {
        return new Response(
          JSON.stringify({
            error: `Email domain "${domain}" is not registered with any organization. Pass organizationId explicitly or register the domain first.`,
          }),
          {
            status: 400,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          }
        );
      }
    }

    const { data: existingUser } = await supabase
      .from("users")
      .select("id")
      .eq("email", email)
      .maybeSingle();

    if (existingUser) {
      return new Response(
        JSON.stringify({ error: "User with this email already exists" }),
        {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
    }

    const { data: authData, error: authError } = await supabase.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
    });

    if (authError) {
      throw authError;
    }

    if (!authData.user) {
      throw new Error("Failed to create auth user");
    }

    const { data: role } = await supabase
      .from("roles")
      .select("id")
      .eq("name", roleName)
      .single();

    if (!role) {
      throw new Error(`Role "${roleName}" not found`);
    }

    // The handle_new_auth_user trigger may have already created a row
    // with default role/org based on email domain. UPSERT to set the
    // explicitly-requested role and org.
    const { error: userError } = await supabase
      .from("users")
      .upsert(
        {
          id: authData.user.id,
          email,
          name,
          role_id: role.id,
          organization_id: organizationId,
          status: "active",
        },
        { onConflict: "id" },
      );

    if (userError) {
      await supabase.auth.admin.deleteUser(authData.user.id);
      throw userError;
    }

    await supabase.from("audit_logs").insert({
      user_id: authData.user.id,
      action: "create",
      entity_type: "user",
      entity_id: authData.user.id,
      after_state: {
        email,
        name,
        role: roleName,
        note: "User created via API",
      },
    });

    return new Response(
      JSON.stringify({
        success: true,
        message: "User created successfully",
        user: {
          id: authData.user.id,
          email,
          name,
        },
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
