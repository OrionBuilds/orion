import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";
import { createOAuthState } from "../_shared/oauth-state.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};

const QBO_AUTH_ENDPOINT = "https://appcenter.intuit.com/connect/oauth2";

Deno.serve(async (req: Request) => {
  try {
    if (req.method === "OPTIONS") {
      return new Response(null, { status: 200, headers: corsHeaders });
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    const qboClientId = Deno.env.get("QBO_CLIENT_ID");

    if (!supabaseUrl || !supabaseServiceKey || !qboClientId) {
      return new Response(
        JSON.stringify({ error: "QBO_CLIENT_ID is not configured in Supabase secrets" }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Require a session JWT and derive orgId from it. Previously this took orgId from the
    // request body with NO auth check at all, so anyone could start an OAuth flow for any
    // organization's QBO tenant. The callback derives its own orgId from a JWT, so the
    // pre-fix damage was mostly CSRF / session-fixation rather than direct token theft,
    // but no reason for either to exist.
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return new Response(
        JSON.stringify({ error: "Unauthorized" }),
        { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }
    const supabase = createClient(supabaseUrl, supabaseServiceKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
    const { data: { user }, error: authError } = await supabase.auth.getUser(
      authHeader.replace("Bearer ", ""),
    );
    if (authError || !user) {
      return new Response(
        JSON.stringify({ error: "Unauthorized" }),
        { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }
    const { data: userData } = await supabase
      .from("users")
      .select("id, organization_id")
      .eq("id", user.id)
      .maybeSingle();
    if (!userData) {
      return new Response(
        JSON.stringify({ error: "User not found" }),
        { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const body = await req.json();
    const { redirectUri } = body;

    if (!redirectUri) {
      return new Response(
        JSON.stringify({ error: "Missing required parameter: redirectUri" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Opaque server-side state so the flow is bound to this user's session, not to
    // caller-supplied JSON. qbo-oauth-callback should consume this in a follow-up (it
    // currently uses the frontend JWT to derive org, which is safe today because the
    // frontend forwards the JWT with the callback POST - but consuming the state token
    // adds CSRF defence and makes the flow one-shot).
    const state = await createOAuthState({
      supabase,
      orgId: userData.organization_id,
      userId: userData.id,
      integrationKey: "quickbooks_online",
      redirectUri,
      appUrl: redirectUri,
    });
    const scope = "com.intuit.quickbooks.accounting";

    const params = new URLSearchParams({
      client_id: qboClientId,
      response_type: "code",
      scope,
      redirect_uri: redirectUri,
      state,
    });

    const authUrl = `${QBO_AUTH_ENDPOINT}?${params.toString()}`;

    return new Response(
      JSON.stringify({ authUrl }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (error) {
    console.error("QBO OAuth start error:", error);
    return new Response(
      JSON.stringify({ error: error.message || "Internal server error" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
