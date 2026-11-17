import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";
import { CALENDAR_SCOPES } from "../_shared/google-oauth-helpers.ts";
import {
  connectGoogleAccount,
  dedupeSelectedCalendars,
  disconnectGoogleCalendar,
  enqueueCalendarInitialSync,
  getCalendarAccessToken,
  pickTeamGoogleRow,
  resolveCalendarRow,
} from "../_shared/google-accounts.ts";
import { escapeHtml } from "../_shared/html.ts";
import { createOAuthState, consumeOAuthState } from "../_shared/oauth-state.ts";

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

const SCOPES = [
  "https://www.googleapis.com/auth/calendar",
  "https://www.googleapis.com/auth/userinfo.email",
].join(" ");

const jsonResp = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });

/** `connection_id` may come in the query string or the JSON body; it is the account's id (or its calendar row's id). */
async function requestedConnectionId(req: Request, body?: Record<string, unknown> | null): Promise<string | null> {
  const fromQuery = new URL(req.url).searchParams.get("connection_id");
  if (fromQuery) return fromQuery;
  const v = body?.connection_id;
  return typeof v === "string" && v ? v : null;
}

async function readJsonBody(req: Request): Promise<Record<string, unknown> | null> {
  try {
    const b = await req.json();
    return b && typeof b === "object" ? b as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function getAnonClient() {
  return createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

function getSupabaseClient() {
  return createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

async function getUserFromRequest(req: Request) {
  const authHeader = req.headers.get("Authorization");
  if (!authHeader) {
    console.error("[OAuth] No Authorization header");
    return null;
  }

  const token = authHeader.replace("Bearer ", "");

  // Use anon client for JWT validation (this is the key fix!)
  const anonClient = getAnonClient();
  const { data: { user }, error } = await anonClient.auth.getUser(token);

  if (error) {
    console.error("[OAuth] JWT validation failed:", error.message);
    return null;
  }

  if (!user) {
    console.error("[OAuth] No user found in JWT");
    return null;
  }

  console.log("[OAuth] JWT validated successfully for user:", user.id);
  return user;
}

async function getUserDetails(userId: string) {
  const supabase = getSupabaseClient();
  const { data } = await supabase
    .from("users")
    .select("id, organization_id, name, email")
    .eq("id", userId)
    .maybeSingle();
  return data;
}

async function handleGetAuthUrl(req: Request): Promise<Response> {
  const user = await getUserFromRequest(req);
  if (!user) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const userDetails = await getUserDetails(user.id);
  if (!userDetails) {
    return new Response(JSON.stringify({ error: "User not found" }), {
      status: 404,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const url = new URL(req.url);
  const redirectUri = url.searchParams.get("redirect_uri") ||
    `${url.origin}/google-calendar-oauth/callback`;

  const appOrigin = url.searchParams.get("app_origin") || "";

  // Server-side state token backed by oauth_states. Previously state = base64(JSON) of
  // caller-supplied user_id/org_id that the callback trusted, so anyone with a Google
  // OAuth `code` could craft a state referencing any user and store Calendar tokens under
  // that identity. See _shared/oauth-state.ts. app_url stores appOrigin so the callback
  // can construct its own post-flow redirect; redirect_uri stores the OAuth redirect URI.
  const state = await createOAuthState({
    supabase: getSupabaseClient(),
    orgId: userDetails.organization_id,
    userId: user.id,
    integrationKey: "google_calendar",
    redirectUri,
    appUrl: appOrigin,
    scopeRequested: SCOPES,
  });

  const authUrl = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  authUrl.searchParams.set("client_id", GOOGLE_CLIENT_ID);
  authUrl.searchParams.set("redirect_uri", redirectUri);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("scope", SCOPES);
  authUrl.searchParams.set("access_type", "offline");
  const loginHint = (url.searchParams.get("login_hint") || "").trim();
  authUrl.searchParams.set("prompt", url.searchParams.get("mode") === "add" || loginHint ? "select_account consent" : "consent");
  if (loginHint && loginHint.length <= 254) authUrl.searchParams.set("login_hint", loginHint);
  authUrl.searchParams.set("include_granted_scopes", "true");
  authUrl.searchParams.set("state", state);

  return new Response(JSON.stringify({ authUrl: authUrl.toString() }), {
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

async function handleCallback(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const stateParam = url.searchParams.get("state");
  const providerError = url.searchParams.get("error");

  const supabase = getSupabaseClient();

  // Server-side state lookup. Previously state was base64(JSON) that the callback trusted
  // for user_id/org_id/redirectUri; see _shared/oauth-state.ts for the anti-pattern being
  // replaced. Consuming the state up front (rather than only on the success path) means
  // the OAuth provider's error path also validates the state, and a leaked (code, state)
  // pair only ever works once regardless of which path is taken.
  const consumeResult = await consumeOAuthState({
    supabase,
    stateToken: stateParam,
    expectedIntegrationKey: "google_calendar",
  });

  // Reshape into the local `state` var previously read from base64. userId/orgId/appOrigin
  // now come from the server row; redirectUri (the OAuth redirect_uri used at token
  // exchange) is stored as `redirect_uri` in oauth_states.
  const state = consumeResult.valid
    ? {
        userId: consumeResult.state.user_id,
        orgId: consumeResult.state.org_id,
        redirectUri: consumeResult.state.redirect_uri,
        appOrigin: consumeResult.state.app_url ?? undefined,
      }
    : null;

  if (providerError) {
    if (state?.appOrigin) {
      const errorRedirect = new URL(`${state.appOrigin}/oauth/google-calendar/callback`);
      errorRedirect.searchParams.set("status", "error");
      errorRedirect.searchParams.set("error", providerError);
      return Response.redirect(errorRedirect.toString(), 302);
    }
    // `providerError` is attacker-controllable - escape before interpolating, or this is
    // reflected XSS on the project origin.
    return new Response(`
      <html><body><p>Authentication failed: ${escapeHtml(providerError)}. You can close this window.</p></body></html>
    `, { headers: { ...corsHeaders, "Content-Type": "text/html" } });
  }

  if (!code || !stateParam) {
    return new Response("Missing code or state", {
      status: 400,
      headers: corsHeaders,
    });
  }

  if (!state) {
    console.warn(`[google-calendar-oauth] state rejected: ${consumeResult.valid ? "unknown" : consumeResult.reason}`);
    return new Response("Invalid or expired state token", {
      status: 400,
      headers: corsHeaders,
    });
  }

  const tokenResponse = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: GOOGLE_CLIENT_ID,
      client_secret: GOOGLE_CLIENT_SECRET,
      redirect_uri: state.redirectUri,
      grant_type: "authorization_code",
    }),
  });

  const tokenData = await tokenResponse.json();
  if (!tokenResponse.ok) {
    if (state.appOrigin) {
      const errorRedirect = new URL(`${state.appOrigin}/oauth/google-calendar/callback`);
      errorRedirect.searchParams.set("status", "error");
      errorRedirect.searchParams.set("error", "Token exchange failed");
      return Response.redirect(errorRedirect.toString(), 302);
    }
    return new Response(`
      <html><body><p>Authentication failed. You can close this window.</p></body></html>
    `, { headers: { ...corsHeaders, "Content-Type": "text/html" } });
  }

  const userInfoResponse = await fetch("https://www.googleapis.com/oauth2/v2/userinfo", {
    headers: { Authorization: `Bearer ${tokenData.access_token}` },
  });
  const userInfo = userInfoResponse.ok ? await userInfoResponse.json() : {};
  const email = typeof userInfo.email === "string" && userInfo.email.includes("@") ? userInfo.email.trim() : "";

  const fail = (message: string) => {
    if (state.appOrigin) {
      const errorRedirect = new URL(`${state.appOrigin}/oauth/google-calendar/callback`);
      errorRedirect.searchParams.set("status", "error");
      errorRedirect.searchParams.set("error", message);
      return Response.redirect(errorRedirect.toString(), 302);
    }
    return new Response(`
      <html><body><p>${escapeHtml(message)} You can close this window.</p></body></html>
    `, { headers: { ...corsHeaders, "Content-Type": "text/html" } });
  };

  // The account is identified by its Google email; without it (or without a refresh token) nothing is stored.
  if (!email) return fail("Google did not return the email address of the account, so it could not be connected.");
  if (!tokenData.refresh_token) return fail("No refresh token received. Please revoke access and try again.");

  const tokenExpiry = new Date(Date.now() + tokenData.expires_in * 1000).toISOString();
  const grantedScopes: string[] = tokenData.scope
    ? tokenData.scope.split(" ").filter(Boolean)
    : CALENDAR_SCOPES.concat(["https://www.googleapis.com/auth/userinfo.email"]);

  // One connection per Google address: the same address re-authorizes its own row, a new address adds an account and never
  // overwrites another one. Tokens are encrypted; if that is not possible nothing is stored (no plaintext fallback).
  let connected;
  try {
    connected = await connectGoogleAccount(supabase, {
      orgId: state.orgId, userId: state.userId, email, accessToken: tokenData.access_token, refreshToken: tokenData.refresh_token,
      tokenExpiry, scopes: grantedScopes,
    });
  } catch (saveErr) {
    console.error("[google-calendar-oauth] could not store the connection:", (saveErr as Error).message);
    return fail("Failed to save connection.");
  }

  if (connected.cross.calendarConnectionId) {
    await enqueueCalendarInitialSync(supabase, state.orgId, connected.cross.calendarConnectionId);
  }

  if (state.appOrigin) {
    const successRedirect = new URL(`${state.appOrigin}/oauth/google-calendar/callback`);
    successRedirect.searchParams.set("status", "success");
    successRedirect.searchParams.set("email", email);
    return Response.redirect(successRedirect.toString(), 302);
  }

  return new Response(`
    <html><body><p>Connected successfully! You can close this window.</p></body></html>
  `, { headers: { ...corsHeaders, "Content-Type": "text/html" } });
}

async function handleDisconnect(req: Request): Promise<Response> {
  const user = await getUserFromRequest(req);
  if (!user) return jsonResp({ error: "Unauthorized" }, 401);

  const connectionId = await requestedConnectionId(req, await readJsonBody(req));
  const r = await disconnectGoogleCalendar(getSupabaseClient(), user.id, connectionId);
  return jsonResp(r.body, r.status);
}

/** The caller's calendar connection (default: the primary account's) or an error response. */
async function loadCalendarRow(req: Request, userId: string, body?: Record<string, unknown> | null) {
  const supabase = getSupabaseClient();
  const found = await resolveCalendarRow(supabase, userId, await requestedConnectionId(req, body));
  if ("error" in found) {
    return { response: jsonResp({ error: found.error === "not_found" ? "That Google calendar is not connected" : "Not connected" }, 404) };
  }
  return { supabase, row: found.row };
}

async function handleGetCalendars(req: Request): Promise<Response> {
  const user = await getUserFromRequest(req);
  if (!user) return jsonResp({ error: "Unauthorized" }, 401);

  const loaded = await loadCalendarRow(req, user.id);
  if ("response" in loaded) return loaded.response;
  const { supabase, row: connection } = loaded;

  let accessToken: string;
  try {
    accessToken = await getCalendarAccessToken(supabase, connection);
  } catch (e) {
    console.warn("[google-calendar-oauth] token refresh failed:", (e as Error).message);
    return jsonResp({ error: "Token refresh failed" }, 401);
  }

  const calendarListResponse = await fetch(
    "https://www.googleapis.com/calendar/v3/users/me/calendarList",
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );

  if (!calendarListResponse.ok) {
    return jsonResp({ error: "Failed to fetch calendars" }, 500);
  }

  const calendarList = await calendarListResponse.json();
  const calendars = calendarList.items?.map((cal: { id: string; summary: string; primary?: boolean; accessRole: string }) => ({
    id: cal.id,
    name: cal.summary,
    primary: cal.primary || false,
    accessRole: cal.accessRole,
  })) || [];

  const primaryCal = calendars.find((c: { primary: boolean }) => c.primary);
  const primaryEmail = primaryCal?.id || connection.email;
  const normalizedSelected = (connection.selected_calendar_ids || []).map(
    (id: string) => id === "primary" && primaryEmail ? primaryEmail : id
  ).filter((id: string, idx: number, arr: string[]) => arr.indexOf(id) === idx);

  return jsonResp({
    calendars,
    selectedCalendarIds: normalizedSelected,
  });
}

async function handleUpdateSelectedCalendars(req: Request): Promise<Response> {
  const user = await getUserFromRequest(req);
  if (!user) return jsonResp({ error: "Unauthorized" }, 401);

  const body = await readJsonBody(req);
  const calendarIds = body?.calendarIds;

  if (!Array.isArray(calendarIds)) {
    return jsonResp({ error: "Invalid calendar IDs" }, 400);
  }

  // Only the chosen account's selection changes (default: the primary's).
  const loaded = await loadCalendarRow(req, user.id, body);
  if ("response" in loaded) return loaded.response;
  const { supabase, row } = loaded;

  const deduped = dedupeSelectedCalendars(calendarIds as string[], row.email);

  const { error } = await supabase
    .from("google_calendar_connections")
    .update({ selected_calendar_ids: deduped })
    .eq("id", row.id);

  if (error) {
    return jsonResp({ error: "Failed to update" }, 500);
  }

  return jsonResp({ success: true });
}

async function handleTestSync(req: Request): Promise<Response> {
  const user = await getUserFromRequest(req);
  if (!user) return jsonResp({ error: "Unauthorized" }, 401);

  const loaded = await loadCalendarRow(req, user.id, await readJsonBody(req));
  if ("response" in loaded) return loaded.response;
  const { supabase, row: connection } = loaded;

  let accessToken: string;
  try {
    accessToken = await getCalendarAccessToken(supabase, connection);
  } catch (e) {
    console.warn("[google-calendar-oauth] token refresh failed:", (e as Error).message);
    return jsonResp({ error: "Token refresh failed", tokenExpired: true }, 401);
  }

  const now = new Date();
  const weekFromNow = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);

  const freeBusyResponse = await fetch(
    "https://www.googleapis.com/calendar/v3/freeBusy",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        timeMin: now.toISOString(),
        timeMax: weekFromNow.toISOString(),
        items: (connection.selected_calendar_ids ?? ["primary"]).map((id: string) => ({ id })),
      }),
    }
  );

  if (!freeBusyResponse.ok) {
    return jsonResp({
      success: false,
      error: "Failed to fetch busy times"
    });
  }

  const freeBusyData = await freeBusyResponse.json();
  let totalBusyBlocks = 0;

  if (freeBusyData.calendars) {
    for (const calId of Object.keys(freeBusyData.calendars)) {
      totalBusyBlocks += freeBusyData.calendars[calId].busy?.length || 0;
    }
  }

  return jsonResp({
    success: true,
    busyBlockCount: totalBusyBlocks,
    message: `Found ${totalBusyBlocks} busy blocks in the next 7 days`
  });
}

async function handleGetConnection(req: Request): Promise<Response> {
  const user = await getUserFromRequest(req);
  if (!user) return jsonResp({ error: "Unauthorized" }, 401);

  const supabase = getSupabaseClient();
  const found = await resolveCalendarRow(supabase, user.id, await requestedConnectionId(req));
  if ("error" in found) return jsonResp({ connected: false });
  const connection = found.row;

  const tokenExpired = new Date(connection.token_expiry) <= new Date();

  return jsonResp({
    connected: true,
    email: connection.email,
    selectedCalendarIds: connection.selected_calendar_ids,
    tokenExpired,
    connectedAt: connection.created_at,
  });
}

async function handleGetTeamConnections(req: Request): Promise<Response> {
  const user = await getUserFromRequest(req);
  if (!user) return jsonResp({ error: "Unauthorized" }, 401);

  const userDetails = await getUserDetails(user.id);
  if (!userDetails) return jsonResp({ error: "User not found" }, 404);

  const supabase = getSupabaseClient();

  const { data: users } = await supabase
    .from("users")
    .select(`
      id, name, email,
      google_connection:google_calendar_connections(id, email, created_at, connection_id)
    `)
    .eq("organization_id", userDetails.organization_id)
    .eq("status", "active")
    .order("name");

  // Dual-provider: also report each member's Microsoft 365 calendar connection.
  const userIds = (users || []).map((u) => u.id);
  const { data: msRows } = userIds.length
    ? await supabase
        .from("user_connected_accounts")
        .select("user_id, provider_account_email, connected_at, status")
        .eq("provider", "microsoft_365")
        .in("user_id", userIds)
    : { data: [] as { user_id: string; provider_account_email: string | null; connected_at: string | null; status: string | null }[] };
  const msByUser = new Map(
    ((msRows || []) as { user_id: string; provider_account_email: string | null; connected_at: string | null; status: string | null }[])
      .filter((r) => !r.status || r.status === "connected")
      .map((r) => [r.user_id, r]),
  );

  // A member may have several Google accounts: report the primary account's calendar (else the oldest).
  const { data: primaries } = userIds.length
    ? await supabase.from("google_oauth_master").select("id").eq("is_primary", true).in("user_id", userIds)
    : { data: [] as { id: string }[] };
  const primaryIds = new Set(((primaries || []) as { id: string }[]).map((p) => p.id));

  const connections = users?.map((u) => {
    const ms = msByUser.get(u.id);
    const g = pickTeamGoogleRow(
      u.google_connection as unknown as { email: string | null; created_at: string | null; connection_id?: string | null } | { email: string | null; created_at: string | null; connection_id?: string | null }[] | null,
      primaryIds,
    );
    const providers = [...(g ? ["google"] : []), ...(ms ? ["microsoft"] : [])];
    return {
      userId: u.id,
      userName: u.name,
      userEmail: u.email,
      connected: providers.length > 0,
      googleEmail: g?.email || null,
      microsoftEmail: ms?.provider_account_email || null,
      providers,
      connectedAt: g?.created_at || ms?.connected_at || null,
    };
  }) || [];

  return jsonResp({ connections });
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 200, headers: corsHeaders });
  }

  try {
    const url = new URL(req.url);
    const path = url.pathname.replace("/google-calendar-oauth", "");

    if (path === "/auth-url" && req.method === "GET") {
      return await handleGetAuthUrl(req);
    }
    if (path === "/callback" && req.method === "GET") {
      return await handleCallback(req);
    }
    if (path === "/disconnect" && req.method === "POST") {
      return await handleDisconnect(req);
    }
    if (path === "/calendars" && req.method === "GET") {
      return await handleGetCalendars(req);
    }
    if (path === "/calendars" && req.method === "POST") {
      return await handleUpdateSelectedCalendars(req);
    }
    if (path === "/test-sync" && req.method === "POST") {
      return await handleTestSync(req);
    }
    if (path === "/connection" && req.method === "GET") {
      return await handleGetConnection(req);
    }
    if (path === "/team-connections" && req.method === "GET") {
      return await handleGetTeamConnections(req);
    }

    return new Response(JSON.stringify({ error: "Not found" }), {
      status: 404,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error) {
    console.error("Error:", error);
    return new Response(JSON.stringify({ error: "Internal server error" }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
