import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";
import { consumeOAuthState } from "../_shared/oauth-state.ts";
import { exchangeCode, msConfig, whoAmI } from "../_shared/ms-graph.ts";
import { accountTypeFromState, connectMicrosoftAccount, otherAccountsEnabled, tenantToStore } from "../_shared/ms-accounts.ts";
import { consumeLoginState, resolveLoginUser } from "../_shared/ms-login.ts";

const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

function failure(message: string): Response {
  return new Response(
    `<html><body><h1>Microsoft Connection Failed</h1><p>${escapeHtml(message)}</p>` +
      `<p>Please close this window and try again.</p></body></html>`,
    { status: 200, headers: { "Content-Type": "text/html" } },
  );
}


Deno.serve(async (req: Request) => {
  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    const cfg = msConfig();
    if (!supabaseUrl || !serviceRoleKey || !cfg) return failure("Missing server configuration");

    const supabase = createClient(supabaseUrl, serviceRoleKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });

    const url = new URL(req.url);
    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state");
    if (url.searchParams.get("error")) return failure("Authorization was denied");
    if (!code || !state) return failure("Missing authorization code or state");

    // Sign-in flow: the state belongs to an anonymous login attempt, not a signed-in user.
    const login = await consumeLoginState(supabase, state);
    if (login) {
      const tokens = await exchangeCode(cfg, code, login.redirectUri);
      const { email } = await whoAmI(tokens.accessToken);
      // MS_EXCLUDED_EMAILS is deliberately NOT applied here: it keeps the owner's own mailbox out of an
      // AGENT slot (connect flow below). A human sign-in is gated by resolveLoginUser instead.
      const who = await resolveLoginUser(supabase, email);
      if (!who.ok) {
        console.warn(`[microsoft-oauth-callback] login refused: ${who.reason}`);
        return failure(
          who.reason === "disabled" ? "Your account is disabled. Contact your administrator."
            : who.reason === "ambiguous" ? "This Microsoft account matches more than one user. Contact your administrator."
            : "No Orion account is linked to this Microsoft account. Sign in the usual way first, then use Connect Microsoft in Settings.",
        );
      }
      try {
        const stored = await connectMicrosoftAccount(supabase, { userId: who.user.userId, orgId: who.user.orgId, email, tokens, tenantId: cfg.tenantId, loginEnabled: true });
        if (!stored.ok) return failure("That Microsoft address is already connected here as a different kind of account. Disconnect it in Settings first.");
      } catch (e) {
        console.error("[microsoft-oauth-callback]", (e as Error).message);
        return failure("Failed to save Microsoft connection");
      }
      await supabase.from("users").update({ status: "active", updated_at: new Date().toISOString() }).eq("id", who.user.userId).eq("status", "invited");
      await supabase.from("audit_logs").insert({ user_id: who.user.userId, action: "microsoft_login", entity_type: "microsoft_oauth", after_state: { email, organization_id: who.user.orgId } });
      const appUrl = login.appUrl ?? `${new URL(req.url).origin}/`;
      const { data: link, error: linkError } = await supabase.auth.admin.generateLink({ type: "magiclink", email: who.user.email, options: { redirectTo: appUrl } });
      const actionLink = link?.properties?.action_link;
      if (linkError || !actionLink) {
        console.error("[microsoft-oauth-callback] generateLink failed:", linkError?.message);
        return failure("Signed in with Microsoft, but could not start your session. Try again.");
      }
      return Response.redirect(actionLink, 302);
    }

    const consumed = await consumeOAuthState({
      supabase,
      stateToken: state,
      expectedIntegrationKey: "microsoft_365",
    });
    if (!consumed.valid) {
      console.warn(`[microsoft-oauth-callback] state rejected: ${consumed.reason}`);
      return failure("Invalid or expired state token");
    }
    const { user_id: userId, org_id: orgId, redirect_uri: oauthRedirectUri } = consumed.state;
    const appRedirectUri = consumed.state.app_url ?? "/settings/profile?tab=connected-accounts";

    // The account type was chosen at start and travels in the server-side state ('work' = home tenant, as before).
    const accountType = accountTypeFromState(consumed.state.scope_requested);
    if (accountType !== "work" && !otherAccountsEnabled()) return failure("Connecting other organizations or personal Microsoft accounts is not enabled.");
    const tokens = await exchangeCode(cfg, code, oauthRedirectUri, fetch, { accountType });

    // Verify which mailbox this actually is before storing anything.
    const { email } = await whoAmI(tokens.accessToken);
    try {
      // Same email = re-auth of that account; a new email = an additional account (primary only if it is the first).
      const stored = await connectMicrosoftAccount(supabase, { userId, orgId, email, tokens, tenantId: tenantToStore(accountType, tokens.tenantId, cfg.tenantId), accountType, excludedEmails: cfg.excludedEmails });
      if (!stored.ok && stored.reason === "type_mismatch") {
        return failure(`That Microsoft account is already connected as a ${stored.existingType} account. Reconnect it with the same type, or disconnect it first.`);
      }
      if (!stored.ok) {
        console.warn("[microsoft-oauth-callback] refused excluded identity");
        return failure(
          "That Microsoft account is not allowed to be connected here. Sign in with the intended mailbox.",
        );
      }
    } catch (e) {
      console.error("[microsoft-oauth-callback]", (e as Error).message);
      return failure("Failed to save Microsoft connection");
    }

    await supabase.from("audit_logs").insert({
      user_id: userId,
      action: "microsoft_connected",
      entity_type: "microsoft_oauth",
      after_state: { email, organization_id: orgId },
    });

    const success = new URL(appRedirectUri);
    success.searchParams.set("microsoft_connected", "true");
    success.searchParams.set("email", email);
    return Response.redirect(success.toString(), 302);
  } catch (err) {
    console.error("microsoft-oauth-callback error:", err);
    return failure("An error occurred while connecting Microsoft");
  }
});
