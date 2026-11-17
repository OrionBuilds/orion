import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";
import {
  ALL_GOOGLE_SCOPES,
  hasGmailScopes,
  hasCalendarScopes,
} from "../_shared/google-oauth-helpers.ts";
import {
  buildGoogleAuthUrl,
  connectGoogleAccount,
  disconnectGoogle,
  enqueueCalendarInitialSync,
  fetchGoogleEmail,
  getGoogleConnectionStatus,
  parseStartRequest,
  readGoogleState,
  registerGmailMailbox,
  signGoogleState,
} from "../_shared/google-accounts.ts";
import { escapeHtml } from "../_shared/html.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};

const GOOGLE_CLIENT_ID = Deno.env.get("GOOGLE_CLIENT_ID") || "";
const GOOGLE_CLIENT_SECRET = Deno.env.get("GOOGLE_CLIENT_SECRET") || "";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL") || "";
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") || "";
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";

function jsonResponse(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function getAnonClient() {
  return createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

function getServiceClient() {
  return createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

async function getUserFromRequest(req: Request) {
  const authHeader = req.headers.get("Authorization");
  if (!authHeader) {
    console.error("[UnifiedOAuth] No Authorization header");
    return null;
  }
  const token = authHeader.replace("Bearer ", "");
  const anonClient = getAnonClient();
  const { data: { user }, error } = await anonClient.auth.getUser(token);
  if (error) {
    console.error("[UnifiedOAuth] JWT validation failed:", error.message);
    return null;
  }
  if (!user) {
    console.error("[UnifiedOAuth] No user found in JWT");
    return null;
  }
  console.log("[UnifiedOAuth] Authenticated user:", user.id);
  return user;
}

async function getUserDetails(userId: string) {
  const supabase = getServiceClient();
  const { data } = await supabase
    .from("users")
    .select("id, organization_id, name, email")
    .eq("id", userId)
    .maybeSingle();
  return data;
}

async function handleStart(req: Request): Promise<Response> {
  const user = await getUserFromRequest(req);
  if (!user) return jsonResponse({ error: "Unauthorized" }, 401);

  const userDetails = await getUserDetails(user.id);
  if (!userDetails) return jsonResponse({ error: "User not found" }, 404);

  if (!GOOGLE_CLIENT_ID) {
    return jsonResponse({ error: "Google integration not configured" }, 500);
  }

  const url = new URL(req.url);
  let body: unknown = null;
  try { body = await req.json(); } catch { /* no body: a plain connect */ }
  const { appOrigin, mode, loginHint } = parseStartRequest(body, url.searchParams);

  const callbackUri = `${SUPABASE_URL}/functions/v1/google-oauth-unified/callback`;

  // The state is ALWAYS HMAC-signed. If signing is not configured we refuse to start: there is no unsigned fallback,
  // because the callback trusts the userId/orgId inside the state.
  let state: string;
  try {
    state = await signGoogleState({
      userId: user.id,
      orgId: userDetails.organization_id,
      redirectUri: callbackUri,
      appOrigin,
      ...(mode ? { mode } : {}),
      ts: Date.now(),
    });
  } catch (e) {
    console.error("[UnifiedOAuth] cannot sign OAuth state:", (e as Error).message);
    return jsonResponse({ error: "Google sign-in is not available: OAuth state signing is not configured" }, 500);
  }

  const authUrl = buildGoogleAuthUrl({ clientId: GOOGLE_CLIENT_ID, callbackUri, scopes: ALL_GOOGLE_SCOPES, state, mode, loginHint });
  return jsonResponse({ authUrl });
}

function htmlPage(message: string, status = 200): Response {
  return new Response(`<html><body><p>${escapeHtml(message)}</p></body></html>`, { status, headers: { "Content-Type": "text/html" } });
}

/** Back to the app with an error when we know where the app is (signed state), else a plain page. */
function failure(appOrigin: string | undefined, message: string, status = 200): Response {
  if (appOrigin) {
    const errorRedirect = new URL(`${appOrigin}/oauth/google-calendar/callback`);
    errorRedirect.searchParams.set("status", "error");
    errorRedirect.searchParams.set("error", message);
    return Response.redirect(errorRedirect.toString(), 302);
  }
  return htmlPage(message, status);
}

async function handleCallback(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const stateParam = url.searchParams.get("state");
  const error = url.searchParams.get("error");

  // The state must be HMAC-signed. An unsigned or tampered state is rejected before anything else happens, and it is never
  // used to decide where to redirect.
  const parsed = await readGoogleState(stateParam);

  if (error) {
    // `error` is the provider's query parameter, i.e. attacker-controlled: it is escaped on the page and URL-encoded in redirects.
    if (parsed.ok && parsed.state.appOrigin) return failure(parsed.state.appOrigin, error);
    return htmlPage(`Authentication failed: ${error}. You can close this window.`);
  }

  if (!code || !stateParam) {
    return new Response("Missing code or state", { status: 400, headers: corsHeaders });
  }

  if (!parsed.ok) {
    if (parsed.reason === "expired") return htmlPage("OAuth session expired. Please try connecting again.");
    console.warn(`[UnifiedOAuth] state rejected: ${parsed.reason}`);
    return htmlPage("This sign-in link is not valid. Please close this window and start connecting again from the app.", 400);
  }
  const state = parsed.state;

  const tokenController = new AbortController();
  const tokenTimeout = setTimeout(() => tokenController.abort(), 15000);
  let tokenResponse: Response;
  try {
    tokenResponse = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        client_id: GOOGLE_CLIENT_ID,
        client_secret: GOOGLE_CLIENT_SECRET,
        redirect_uri: state.redirectUri,
        grant_type: "authorization_code",
      }),
      signal: tokenController.signal,
    });
  } catch (fetchErr) {
    clearTimeout(tokenTimeout);
    console.error("Token exchange fetch error:", fetchErr);
    return failure(state.appOrigin, "Token exchange timed out. Please try again.");
  }
  clearTimeout(tokenTimeout);

  const tokenData = await tokenResponse.json();
  if (!tokenResponse.ok) {
    console.error("Token exchange failed:", tokenData?.error);
    return failure(state.appOrigin, "Token exchange failed");
  }

  const { access_token, refresh_token, expires_in, scope: grantedScopeStr } = tokenData;

  if (!refresh_token) {
    return failure(state.appOrigin, "No refresh token received. Please revoke access and try again.");
  }

  // The account is identified by its Google email. Without one we cannot tell accounts apart, so we refuse.
  const email = await fetchGoogleEmail(access_token);
  if (!email) {
    return failure(state.appOrigin, "Google did not return the email address of the account you signed in with, so it could not be connected. Please try again.");
  }

  const tokenExpiry = new Date(Date.now() + expires_in * 1000).toISOString();
  const grantedScopes: string[] = grantedScopeStr ? grantedScopeStr.split(" ").filter(Boolean) : ALL_GOOGLE_SCOPES;

  const supabase = getServiceClient();

  let connected;
  try {
    connected = await connectGoogleAccount(supabase, {
      orgId: state.orgId, userId: state.userId, email, accessToken: access_token, refreshToken: refresh_token, tokenExpiry, scopes: grantedScopes,
    });
  } catch (e) {
    console.error("[UnifiedOAuth] could not store the Google connection:", (e as Error).message);
    return failure(state.appOrigin, "Failed to save the Google connection. Please try again.");
  }
  const scopes = connected.scopes;

  const backgroundTasks: Promise<void>[] = [];

  if (hasGmailScopes(scopes)) {
    backgroundTasks.push(registerGmailMailbox(supabase, {
      orgId: state.orgId, userId: state.userId, connectionId: connected.connectionId, email, isPrimary: connected.isPrimary,
      accessToken: access_token, pubsubTopic: Deno.env.get("GMAIL_PUBSUB_TOPIC"),
      supabaseUrl: SUPABASE_URL, serviceKey: SUPABASE_SERVICE_ROLE_KEY,
    }));
  }

  if (hasCalendarScopes(scopes) && connected.cross.calendarConnectionId) {
    backgroundTasks.push(enqueueCalendarInitialSync(supabase, state.orgId, connected.cross.calendarConnectionId));
  }

  backgroundTasks.push(
    supabase.from("audit_logs").insert({
      user_id: state.userId,
      action: "google_unified_connected",
      entity_type: "google_oauth_master",
      after_state: { email, scopes, organization_id: state.orgId, connection_id: connected.connectionId, created: connected.created },
    }).then(() => {})
  );

  await Promise.allSettled(backgroundTasks);

  if (state.appOrigin) {
    const successRedirect = new URL(`${state.appOrigin}/oauth/google-calendar/callback`);
    successRedirect.searchParams.set("status", "success");
    successRedirect.searchParams.set("email", email);
    return Response.redirect(successRedirect.toString(), 302);
  }

  return htmlPage("Connected successfully! You can close this window.");
}

async function handleConnection(req: Request): Promise<Response> {
  const user = await getUserFromRequest(req);
  if (!user) return jsonResponse({ error: "Unauthorized" }, 401);

  return jsonResponse(await getGoogleConnectionStatus(getServiceClient(), user.id));
}

async function handleDisconnect(req: Request): Promise<Response> {
  const user = await getUserFromRequest(req);
  if (!user) return jsonResponse({ error: "Unauthorized" }, 401);

  let connectionId: string | null = null;
  try {
    const body = await req.json();
    if (body && typeof body.connection_id === "string" && body.connection_id) connectionId = body.connection_id;
  } catch { /* no body: the user's only account */ }

  const r = await disconnectGoogle(getServiceClient(), user.id, connectionId);
  return jsonResponse(r.body, r.status);
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 200, headers: corsHeaders });
  }

  try {
    const url = new URL(req.url);
    const path = url.pathname.replace("/google-oauth-unified", "");

    if (path === "/start" && req.method === "POST") {
      return await handleStart(req);
    }
    if (path === "/callback" && req.method === "GET") {
      return await handleCallback(req);
    }
    if (path === "/connection" && req.method === "GET") {
      return await handleConnection(req);
    }
    if (path === "/disconnect" && req.method === "POST") {
      return await handleDisconnect(req);
    }

    return jsonResponse({ error: "Not found" }, 404);
  } catch (error) {
    console.error("google-oauth-unified error:", error);
    return jsonResponse({ error: "Internal server error" }, 500);
  }
});
