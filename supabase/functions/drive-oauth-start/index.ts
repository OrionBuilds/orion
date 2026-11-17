import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";
import { createOAuthState } from "../_shared/oauth-state.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers":
    "Content-Type, Authorization, X-Client-Info, Apikey",
};

const GOOGLE_OAUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const SCOPES = [
  "https://www.googleapis.com/auth/drive",
  "https://www.googleapis.com/auth/userinfo.email",
  "https://www.googleapis.com/auth/userinfo.profile",
].join(" ");

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 200, headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    const googleClientId = Deno.env.get("GOOGLE_CLIENT_ID");

    if (!supabaseUrl || !serviceRoleKey || !googleClientId) {
      return new Response(
        JSON.stringify({
          error:
            "Google Drive integration is not configured. Please set GOOGLE_CLIENT_ID in Edge Function secrets.",
        }),
        {
          status: 500,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
    }

    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const token = authHeader.replace("Bearer ", "");
    const supabase = createClient(supabaseUrl, serviceRoleKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });

    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser(token);
    if (authError || !user) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { data: userData } = await supabase
      .from("users")
      .select("id, organization_id")
      .eq("id", user.id)
      .maybeSingle();

    if (!userData) {
      return new Response(JSON.stringify({ error: "User not found" }), {
        status: 404,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    let appRedirectUri = `${req.headers.get("Origin") || ""}/media`;
    let addAccount = false;
    let loginHint = "";
    if (req.method === "POST") {
      try {
        const body = await req.json();
        if (body.redirect_uri) appRedirectUri = body.redirect_uri;
        if (body.mode === "add") addAccount = true;
        if (typeof body.login_hint === "string" && body.login_hint.trim().length <= 254) loginHint = body.login_hint.trim();
      } catch {
        // use default
      }
    }

    const oauthRedirectUri = `${supabaseUrl}/functions/v1/drive-oauth-callback`;

    // State is now an unguessable server-side token backed by oauth_states, not
    // base64-encoded caller data. The callback re-reads user_id/org_id from the row we
    // just inserted rather than trusting anything in the URL, and the row is deleted on
    // first use so a leaked (code, state) pair cannot be replayed.
    const state = await createOAuthState({
      supabase,
      orgId: userData.organization_id,
      userId: userData.id,
      integrationKey: "google_drive",
      redirectUri: oauthRedirectUri,
      appUrl: appRedirectUri,
      scopeRequested: SCOPES,
    });

    const authUrl = new URL(GOOGLE_OAUTH_URL);
    authUrl.searchParams.set("client_id", googleClientId);
    authUrl.searchParams.set("redirect_uri", oauthRedirectUri);
    authUrl.searchParams.set("response_type", "code");
    authUrl.searchParams.set("scope", SCOPES);
    authUrl.searchParams.set("access_type", "offline");
    authUrl.searchParams.set("prompt", addAccount || loginHint ? "select_account consent" : "consent");
    if (loginHint) authUrl.searchParams.set("login_hint", loginHint);
    authUrl.searchParams.set("include_granted_scopes", "true");
    authUrl.searchParams.set("state", state);

    return new Response(JSON.stringify({ authUrl: authUrl.toString() }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    console.error("drive-oauth-start error:", err);
    return new Response(
      JSON.stringify({ error: (err as Error).message || "An error occurred" }),
      {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      }
    );
  }
});
