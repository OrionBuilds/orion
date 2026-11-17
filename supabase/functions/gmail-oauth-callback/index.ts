import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";
import { GMAIL_SCOPES } from "../_shared/google-oauth-helpers.ts";
import { connectGoogleAccount, fetchGoogleEmail, registerGmailMailbox } from "../_shared/google-accounts.ts";
import { escapeHtml } from "../_shared/html.ts";
import { consumeOAuthState } from "../_shared/oauth-state.ts";

const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GMAIL_API_URL = "https://gmail.googleapis.com/gmail/v1";

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 200 });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    const clientId = Deno.env.get("GOOGLE_CLIENT_ID");
    const clientSecret = Deno.env.get("GOOGLE_CLIENT_SECRET");

    if (!supabaseUrl || !serviceRoleKey || !clientId || !clientSecret) {
      return redirectWithError("Missing server configuration");
    }

    const supabase = createClient(supabaseUrl, serviceRoleKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });

    const url = new URL(req.url);
    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state");
    const error = url.searchParams.get("error");

    if (error) {
      return redirectWithError("Authorization denied by user");
    }

    if (!code || !state) {
      return redirectWithError("Missing authorization code or state");
    }

    // Server-side state lookup - see _shared/oauth-state.ts for the anti-pattern being
    // replaced. Previously the callback JSON.parse(atob(state))'d and trusted the
    // caller-supplied user_id/org_id, so anyone with a Google auth `code` could store
    // Gmail tokens under any identity.
    const consumeResult = await consumeOAuthState({
      supabase,
      stateToken: state,
      expectedIntegrationKey: "gmail",
    });
    if (!consumeResult.valid) {
      console.warn(`[gmail-oauth-callback] state rejected: ${consumeResult.reason}`);
      return redirectWithError("Invalid or expired state token");
    }
    const userId = consumeResult.state.user_id;
    const finalOrgId = consumeResult.state.org_id;
    const appRedirectUri = consumeResult.state.app_url ?? "/settings/profile?tab=connected-accounts";
    const oauthRedirectUri = consumeResult.state.redirect_uri;

    const tokenResponse = await fetch(GOOGLE_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: oauthRedirectUri,
        grant_type: "authorization_code",
      }),
    });

    if (!tokenResponse.ok) {
      const tokenError = await tokenResponse.json();
      console.error("Token exchange failed:", tokenError);
      return redirectWithError("Failed to exchange authorization code");
    }

    const tokens = await tokenResponse.json();
    const { access_token, refresh_token, expires_in } = tokens;

    if (!refresh_token) {
      return redirectWithError("No refresh token received. Please revoke access and try again.");
    }

    // The mailbox is identified by the address Google reports for the signed-in account.
    const profileResponse = await fetch(`${GMAIL_API_URL}/users/me/profile`, {
      headers: { Authorization: `Bearer ${access_token}` },
    });
    let email: string | null = null;
    if (profileResponse.ok) {
      const profile = await profileResponse.json();
      email = typeof profile.emailAddress === "string" && profile.emailAddress.includes("@") ? profile.emailAddress : null;
    }
    email = email ?? await fetchGoogleEmail(access_token);
    if (!email) {
      return redirectWithError("Google did not return the email address of the account, so it could not be connected");
    }

    const tokenExpiry = new Date(Date.now() + expires_in * 1000).toISOString();

    const grantedScopes = tokens.scope
      ? tokens.scope.split(" ").filter(Boolean)
      : GMAIL_SCOPES.concat(["https://www.googleapis.com/auth/userinfo.email", "https://www.googleapis.com/auth/userinfo.profile"]);

    // One connection per Google address: the same address re-authorizes its own row, a new address adds an account and never
    // touches another one. Tokens are encrypted; if that is not possible nothing is stored (no plaintext fallback).
    let connected;
    try {
      connected = await connectGoogleAccount(supabase, {
        orgId: finalOrgId, userId, email, accessToken: access_token, refreshToken: refresh_token, tokenExpiry, scopes: grantedScopes,
      });
    } catch (saveErr) {
      console.error("Failed to save tokens:", (saveErr as Error).message);
      return redirectWithError("Failed to save Gmail connection");
    }

    await supabase.from("audit_logs").insert({
      user_id: userId,
      action: "gmail_connected",
      entity_type: "gmail_oauth",
      after_state: { email, organization_id: finalOrgId, connection_id: connected.connectionId },
    });

    await registerGmailMailbox(supabase, {
      orgId: finalOrgId, userId, connectionId: connected.connectionId, email, isPrimary: connected.isPrimary, accessToken: access_token,
      pubsubTopic: Deno.env.get("GMAIL_PUBSUB_TOPIC"), supabaseUrl, serviceKey: serviceRoleKey, awaitSyncTrigger: true,
    });

    const successUrl = new URL(appRedirectUri);
    successUrl.searchParams.set("gmail_connected", "true");
    successUrl.searchParams.set("email", email);

    return Response.redirect(successUrl.toString(), 302);
  } catch (err) {
    console.error("Gmail OAuth callback error:", err);
    return redirectWithError((err as Error).message || "An error occurred");
  }
});

function redirectWithError(message: string): Response {
  return new Response(
    `<html><body>
      <h1>Gmail Connection Failed</h1>
      <p>${escapeHtml(message)}</p>
      <p>Please close this window and try again.</p>
    </body></html>`,
    {
      status: 200,
      headers: { "Content-Type": "text/html" },
    }
  );
}
