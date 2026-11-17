import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";
import { createOAuthState } from "../_shared/oauth-state.ts";
import { createLoginState } from "../_shared/ms-login.ts";
import { authorizeUrl, listMsConnections, msConfig, scopesFor } from "../_shared/ms-graph.ts";
import { decideAccountType, stateScopeRequested } from "../_shared/ms-accounts.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 200, headers: corsHeaders });

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    const cfg = msConfig();
    if (!supabaseUrl || !serviceRoleKey || !cfg) {
      return json({ error: "Microsoft integration is not configured. Set MS_OAUTH_* secrets." }, 500);
    }

    // Sign-in mode: anonymous by design (the user is identified by Microsoft, not by a session).
    if (req.method === "POST") {
      let body: { mode?: string; redirect_uri?: string } = {};
      try { body = await req.clone().json(); } catch { /* not JSON */ }
      if (body.mode === "login") {
        const db = createClient(supabaseUrl, serviceRoleKey, { auth: { autoRefreshToken: false, persistSession: false } });
        const oauthRedirectUri = `${supabaseUrl}/functions/v1/microsoft-oauth-callback`;
        const state = await createLoginState(db, oauthRedirectUri, body.redirect_uri);
        return json({ authUrl: authorizeUrl(cfg, { redirectUri: oauthRedirectUri, state }) });
      }
    }

    const authHeader = req.headers.get("Authorization");
    if (!authHeader) return json({ error: "Unauthorized" }, 401);

    const supabase = createClient(supabaseUrl, serviceRoleKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
    const { data: { user }, error: authError } = await supabase.auth.getUser(
      authHeader.replace("Bearer ", ""),
    );
    if (authError || !user) return json({ error: "Unauthorized" }, 401);

    const { data: userData } = await supabase
      .from("users")
      .select("id, organization_id")
      .eq("id", user.id)
      .maybeSingle();
    if (!userData) return json({ error: "User not found" }, 404);

    let appRedirectUri = `${req.headers.get("Origin") || ""}/settings/profile?tab=connected-accounts`;
    let forAgent: string | undefined;
    let loginHint: string | undefined;
    let requestedType: unknown;
    if (req.method === "POST") {
      try {
        const body = await req.json();
        if (body.redirect_uri) appRedirectUri = body.redirect_uri;
        if (typeof body.agent === "string") forAgent = body.agent.toLowerCase();
        // re-auth of a specific account; mode:'add' (an additional account) needs nothing extra: the account chooser always shows
        requestedType = body.account_type;
        if (typeof body.login_hint === "string" && /^[^\s@]+@[^\s@]+$/.test(body.login_hint.trim())) loginHint = body.login_hint.trim();
      } catch { /* use default */ }
    }

    // Connecting an AGENT's mailbox (e.g. Clara's): a SuperAdmin attaches it to the agent's own OS user.
    // The agent user must be a same-org agent role; login stays disabled for it (login_enabled defaults false).
    let targetUserId = userData.id as string;
    if (forAgent) {
      const levelOf = async (id: string) => {
        const { data: u } = await supabase.from("users").select("role_id").eq("id", id).maybeSingle();
        if (!u?.role_id) return null;
        const { data: r } = await supabase.from("roles").select("hierarchy_level").eq("id", u.role_id).maybeSingle();
        return (r?.hierarchy_level as number | undefined) ?? null;
      };
      const mine = await levelOf(userData.id);
      if (mine === null || mine > 1) return json({ error: "Only a SuperAdmin can connect an agent mailbox" }, 403);
      if (!/^[a-z]+$/.test(forAgent)) return json({ error: "Unknown agent" }, 400);
      // Find the agent by its role (clara -> ClaraAgent): an agent's account can be re-created under a
      // different address (CLARA under her Microsoft email). The old fixed address is the fallback.
      const roleName = `${forAgent[0].toUpperCase()}${forAgent.slice(1)}Agent`;
      const { data: role } = await supabase.from("roles").select("id").eq("name", roleName).maybeSingle();
      let agent: { id: string } | null = null;
      if (role) {
        const { data } = await supabase.from("users").select("id").eq("organization_id", userData.organization_id)
          .eq("role_id", role.id).or("status.is.null,status.neq.inactive").order("created_at").limit(1).maybeSingle();
        agent = data;
      }
      const agentDomain = Deno.env.get("BUSINESS_DOMAIN")?.trim();
      if (!agent && agentDomain) {
        const { data } = await supabase.from("users").select("id").eq("organization_id", userData.organization_id)
          .eq("email", `${forAgent}@${agentDomain}`).maybeSingle();
        agent = data;
      }
      if (!agent) return json({ error: `No ${roleName} user yet. Invite the agent's account first (Settings → Staff).` }, 404);
      const lvl = await levelOf(agent.id);
      if (lvl === null || lvl < 10) return json({ error: "That user is not an agent" }, 400);
      targetUserId = agent.id;
    }

    // Account type: 'work' (home tenant) by default; a re-auth of an existing account (login_hint) uses that row's type.
    // 'external' / 'personal' need the MS_OAUTH_ALLOW_OTHER_ACCOUNTS=on secret.
    let existingType: "work" | "external" | "personal" | null = null;
    if (loginHint) {
      const hit = (await listMsConnections(supabase, targetUserId)).find((c) => c.email.toLowerCase() === loginHint!.toLowerCase());
      existingType = hit ? (hit.account_type ?? "work") : null;
    }
    const decision = decideAccountType(requestedType, { existingType });
    if (!decision.ok) return json(decision.body, decision.status);
    const accountType = decision.accountType;

    const oauthRedirectUri = `${supabaseUrl}/functions/v1/microsoft-oauth-callback`;
    const state = await createOAuthState({
      supabase,
      orgId: userData.organization_id,
      userId: targetUserId,
      integrationKey: "microsoft_365",
      redirectUri: oauthRedirectUri,
      appUrl: appRedirectUri,
      scopeRequested: stateScopeRequested(accountType, scopesFor(accountType)),
    });

    return json({ authUrl: authorizeUrl(cfg, { redirectUri: oauthRedirectUri, state, loginHint, accountType }) });
  } catch (err) {
    console.error("microsoft-oauth-start error:", err);
    return json({ error: (err as Error).message || "An error occurred" }, 500);
  }
});
