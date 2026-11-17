import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";
import { getResendEnvCreds } from "../_shared/resend.ts";
import { openSecret, sealSecret } from "../_shared/secrets.ts";
import { listMotionWorkspaces } from "../_shared/motion.ts";
import { validateSamKey } from "../_shared/sam-key.ts";
import { extractUserContext } from "../_shared/auth.ts";
import {
  type LlmProviderKind,
  syncProviderModelsToOrg,
  validateProviderKey,
} from "../_shared/llm-provider-models.ts";

/**
 * Integration cards whose key is an LLM provider key. For these the canonical store is the sealed
 * llm_providers.api_key_encrypted column (what fetch-provider-models, agent runs and agent-settings-get
 * read); integration_connections only records status. One copy of the key, entered in one place
 * (Settings → Integrations); Settings → AI Agents links here instead of asking again.
 */
const LLM_PROVIDER_INTEGRATIONS: Record<string, { provider: LlmProviderKind; label: string }> = {
  google_gemini: { provider: "google", label: "Google Gemini" },
};

// Legacy "mailgun" integration branch. Mailgun was removed (all outbound mail
// goes through Resend); these local helpers reproduce the behavior of the
// former shared Mailgun shim exactly so this function's responses are
// unchanged: validation passes iff Resend env creds are present (and never
// returns domains), and credential encryption always throws.
type MailgunRegion = "us" | "eu";

// deno-lint-ignore require-await
async function validateMailgunCredentials(
  _apiKey: string,
  _region: MailgunRegion = "us",
): Promise<{ valid: boolean; error?: string; domains?: Array<{ name?: string }> }> {
  const creds = getResendEnvCreds();
  if (creds) return { valid: true };
  return { valid: false, error: "Resend not configured" };
}

// deno-lint-ignore require-await
async function encryptMailgunCreds(
  _creds: { api_key: string; domain: string; webhook_signing_key?: string | null; region?: MailgunRegion },
  _supabaseUrl: string,
  _serviceRoleKey: string,
): Promise<{ encrypted: string; iv: string }> {
  throw new Error(
    "Mailgun encryption removed — SendGrid credentials live in Supabase env vars (SENDGRID_API_KEY / SENDGRID_FROM_EMAIL).",
  );
}

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};

const CLIENT_ID_MAP: Record<string, string> = {
  gmail: "GOOGLE_CLIENT_ID",
  google_workspace: "GOOGLE_CLIENT_ID",
  google_calendar: "GOOGLE_CLIENT_ID",
  google_ads: "GOOGLE_CLIENT_ID",
  google_chat: "GOOGLE_CLIENT_ID",
  quickbooks_online: "QBO_CLIENT_ID",
};

function getOAuthClientIdEnvVar(integrationKey: string): string {
  const envVarName = CLIENT_ID_MAP[integrationKey] || `${integrationKey.toUpperCase()}_CLIENT_ID`;
  return Deno.env.get(envVarName) || "";
}

function getOAuthClientSecretEnvVar(integrationKey: string): string {
  const secretMap: Record<string, string> = {
    gmail: "GOOGLE_CLIENT_SECRET",
    google_workspace: "GOOGLE_CLIENT_SECRET",
    google_calendar: "GOOGLE_CLIENT_SECRET",
    google_ads: "GOOGLE_CLIENT_SECRET",
    google_chat: "GOOGLE_CLIENT_SECRET",
    quickbooks_online: "QBO_CLIENT_SECRET",
  };
  const envVarName = secretMap[integrationKey] || `${integrationKey.toUpperCase()}_CLIENT_SECRET`;
  return Deno.env.get(envVarName) || "";
}

interface RequestPayload {
  action: "initiate_oauth" | "connect_api_key" | "disconnect" | "test";
  integration_key: string;
  credentials?: Record<string, string>;
  force?: boolean;
  app_url?: string;
}


async function encryptWithCrypto(
  plaintext: string,
  supabaseUrl: string,
  serviceRoleKey: string
): Promise<{ encrypted: string; iv: string }> {
  const response = await fetch(`${supabaseUrl}/functions/v1/email-crypto`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${serviceRoleKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ action: "encrypt", plaintext }),
  });
  if (!response.ok) throw new Error("Failed to encrypt credentials");
  return await response.json();
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 200, headers: corsHeaders });
  }

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return new Response(
        JSON.stringify({ error: "Missing authorization header" }),
        { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_ANON_KEY")!,
      { global: { headers: { Authorization: authHeader } } }
    );

    const { data: { user }, error: authError } = await supabase.auth.getUser();
    if (authError || !user) {
      return new Response(
        JSON.stringify({ error: "Unauthorized" }),
        { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const { data: userData, error: userError } = await supabase
      .from("users")
      .select("id, organization_id, role:roles(name)")
      .eq("id", user.id)
      .single();

    if (userError || !userData) {
      return new Response(
        JSON.stringify({ error: "User not found" }),
        { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const payload: RequestPayload = await req.json();
    const { action, integration_key, credentials, force, app_url } = payload;

    const { data: integration, error: intError } = await supabase
      .from("integrations")
      .select("*")
      .eq("org_id", userData.organization_id)
      .eq("key", integration_key)
      .single();

    if (intError || !integration) {
      return new Response(
        JSON.stringify({ error: "Integration not found" }),
        { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const serviceClient = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    switch (action) {
      case "initiate_oauth": {
        if (integration.connection_type !== "oauth") {
          return new Response(
            JSON.stringify({ error: "Integration does not support OAuth" }),
            { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
          );
        }

        // Without the app's client id the provider shows its own cryptic error; say what's missing.
        if (!getOAuthClientIdEnvVar(integration_key)) {
          return new Response(
            JSON.stringify({
              error: `${integration.name} isn't set up yet: its OAuth app client id/secret secrets are missing`,
              message: `${integration.name} isn't set up yet: its OAuth app client id/secret secrets are missing`,
            }),
            { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
          );
        }

        const stateToken = crypto.randomUUID();
        const redirectUri = `${Deno.env.get("SUPABASE_URL")}/functions/v1/integrations-oauth-callback`;

        await serviceClient.from("oauth_states").insert({
          org_id: userData.organization_id,
          user_id: user.id,
          integration_key,
          state_token: stateToken,
          redirect_uri: redirectUri,
          scope_requested: integration.oauth_config?.scopes?.join(" ") || "",
          app_url: app_url || null,
        });

        const oauthConfig = integration.oauth_config;
        const authUrl = new URL(oauthConfig.auth_url);
        authUrl.searchParams.set("client_id", getOAuthClientIdEnvVar(integration_key));
        authUrl.searchParams.set("redirect_uri", redirectUri);
        authUrl.searchParams.set("response_type", "code");
        authUrl.searchParams.set("state", stateToken);
        if (oauthConfig.scopes?.length) {
          authUrl.searchParams.set("scope", oauthConfig.scopes.join(" "));
        }
        authUrl.searchParams.set("access_type", "offline");
        authUrl.searchParams.set("prompt", "consent");

        await serviceClient.from("integration_logs").insert({
          integration_id: integration.id,
          org_id: userData.organization_id,
          user_id: user.id,
          action: "connect",
          status: "success",
          request_meta: { type: "oauth_initiated" },
        });

        return new Response(
          JSON.stringify({ authorization_url: authUrl.toString(), state_token: stateToken }),
          { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      case "connect_api_key": {
        if (integration.connection_type !== "api_key") {
          return new Response(
            JSON.stringify({ error: "Integration does not support API key connection" }),
            { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
          );
        }

        if (!credentials || Object.keys(credentials).length === 0) {
          return new Response(
            JSON.stringify({ error: "Credentials required" }),
            { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
          );
        }

        const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
        const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
        let credentialsEncrypted: string | null;
        let credentialsIv: string | null;
        let accountInfo: Record<string, unknown> = {};

        const llmIntegration = LLM_PROVIDER_INTEGRATIONS[integration_key];
        if (llmIntegration) {
          const caller = await extractUserContext(req, serviceClient);
          const canManageAi = !!caller && (caller.isSuperAdmin ||
            (caller.permissions.includes("ai_agents.manage") && !/Agent$/.test(caller.roleName)));
          if (!canManageAi) {
            return new Response(
              JSON.stringify({ error: "You need the ai_agents.manage permission to connect an AI provider" }),
              { status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" } }
            );
          }
          const apiKey = (credentials.api_key ?? "").trim();
          const validation = await validateProviderKey(llmIntegration.provider, apiKey);
          if (!validation.success) {
            await serviceClient.from("integration_logs").insert({
              integration_id: integration.id,
              org_id: userData.organization_id,
              user_id: user.id,
              action: "connect",
              status: "failure",
              request_meta: { type: "api_key", integration_key, message: validation.error },
            });
            return new Response(
              JSON.stringify({ error: `${llmIntegration.label} rejected the key: ${validation.error}` }),
              { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
            );
          }

          const sealed = await sealSecret(apiKey);
          const { data: existingProvider } = await serviceClient
            .from("llm_providers")
            .select("id")
            .eq("org_id", userData.organization_id)
            .eq("provider", llmIntegration.provider)
            .maybeSingle();
          const providerWrite = existingProvider
            ? serviceClient.from("llm_providers")
                .update({ api_key_encrypted: sealed, enabled: true, updated_at: new Date().toISOString() })
                .eq("id", existingProvider.id)
            : serviceClient.from("llm_providers").insert({
                org_id: userData.organization_id,
                provider: llmIntegration.provider,
                api_key_encrypted: sealed,
                enabled: true,
              });
          const { data: providerRow, error: providerError } = await providerWrite.select("id").single();
          if (providerError || !providerRow) throw providerError ?? new Error("Failed to save provider key");

          // Seed llm_models so Gemini is immediately selectable for agents. Best effort.
          let modelsSynced: number | null = null;
          try {
            const sync = await syncProviderModelsToOrg(
              serviceClient,
              userData.organization_id,
              { id: providerRow.id, provider: llmIntegration.provider },
              apiKey,
            );
            modelsSynced = sync.fetched;
          } catch (e) {
            console.warn(`[integrations-connect] ${integration_key} model sync failed:`, e instanceof Error ? e.message : e);
          }

          credentialsIv = null;
          credentialsEncrypted = null;
          accountInfo = {
            provider: llmIntegration.provider,
            configured: true,
            api_key_set: true,
            key_store: "llm_providers",
            model_count: validation.model_count ?? null,
            models_synced: modelsSynced,
          };
        } else if (integration_key === "mailgun") {
          const apiKey = credentials.api_key;
          const domain = credentials.domain;
          if (!apiKey || !domain) {
            return new Response(
              JSON.stringify({ error: "API key and domain are required" }),
              { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
            );
          }

          const region = (credentials.region === "eu" ? "eu" : "us") as MailgunRegion;
          const validation = await validateMailgunCredentials(apiKey, region);
          if (!validation.valid) {
            return new Response(
              JSON.stringify({ error: validation.error }),
              { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
            );
          }

          const matchingDomain = (validation.domains ?? []).find((d) => d.name === domain);
          if (!matchingDomain) {
            return new Response(
              JSON.stringify({
                error: `Domain '${domain}' not found in your Mailgun account.`,
              }),
              { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
            );
          }

          const encrypted = await encryptMailgunCreds(
            {
              api_key: apiKey,
              domain,
              webhook_signing_key: credentials.webhook_signing_key ?? null,
              region,
            },
            supabaseUrl,
            serviceRoleKey,
          );
          credentialsEncrypted = encrypted.encrypted;
          credentialsIv = encrypted.iv;
          accountInfo = {
            provider: "mailgun",
            configured: true,
            api_key_set: true,
            domain,
            region,
            nickname: credentials.nickname || null,
          };
        } else if (integration_key === "sam_gov") {
          const apiKey = (credentials.api_key ?? "").trim();
          if (!apiKey) {
            return new Response(JSON.stringify({ error: "SAM.gov API key is required" }),
              { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });
          }
          let check: Awaited<ReturnType<typeof validateSamKey>>;
          try {
            check = await validateSamKey(apiKey);
          } catch (e) {
            check = { ok: false, error: `Could not reach SAM.gov: ${(e as Error).message}` };
          }
          if (!check.ok) {
            return new Response(JSON.stringify({ error: check.error }),
              { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });
          }
          credentialsIv = null;
          credentialsEncrypted = await sealSecret(JSON.stringify({ api_key: apiKey }));
          accountInfo = { provider: "sam_gov", configured: true, api_key_set: true };
        } else if (integration_key === "motion") {
          // Validate by listing workspaces, keep the key sealed, and remember which workspace tasks go to.
          const apiKey = (credentials.api_key ?? "").trim();
          if (!apiKey) {
            return new Response(JSON.stringify({ error: "Motion API key is required" }),
              { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });
          }
          let workspaces: { id: string; name: string }[];
          try {
            workspaces = await listMotionWorkspaces(apiKey);
          } catch (e) {
            return new Response(JSON.stringify({ error: `Motion rejected the key: ${(e as Error).message}` }),
              { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });
          }
          const wanted = (credentials.workspace_id ?? "").trim();
          const workspace = wanted ? workspaces.find((w) => w.id === wanted) : workspaces[0];
          if (!workspace) {
            return new Response(JSON.stringify({
              error: wanted ? "That workspace ID is not in your Motion account" : "Motion key has no workspaces",
            }), { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });
          }
          credentialsIv = null;
          credentialsEncrypted = await sealSecret(JSON.stringify({
            api_key: apiKey, workspace_id: workspace.id, project_id: (credentials.project_id ?? "").trim(),
          }));
          accountInfo = { provider: "motion", configured: true, api_key_set: true, workspace_id: workspace.id, workspace_name: workspace.name };
        } else {
          // Sealed JSON (_shared/secrets.ts); the IV lives inside the sealed value. These used to be
          // stored as plain JSON next to a random, unused "IV".
          credentialsIv = null;
          credentialsEncrypted = await sealSecret(JSON.stringify(credentials));
          accountInfo = {};
        }

        const { data: existingConnection } = await serviceClient
          .from("integration_connections")
          .select("id")
          .eq("integration_id", integration.id)
          .eq("org_id", userData.organization_id)
          .is("user_id", integration.scope === "global" ? null : user.id)
          .maybeSingle();

        const connectionData = {
          integration_id: integration.id,
          org_id: userData.organization_id,
          user_id: integration.scope === "global" ? null : user.id,
          status: "connected",
          credentials_encrypted: credentialsEncrypted,
          credentials_iv: credentialsIv,
          account_info: accountInfo,
          connected_at: new Date().toISOString(),
          connected_by: user.id,
        };

        let connection;
        if (existingConnection) {
          const { data, error } = await serviceClient
            .from("integration_connections")
            .update(connectionData)
            .eq("id", existingConnection.id)
            .select()
            .single();
          if (error) throw error;
          connection = data;
        } else {
          const { data, error } = await serviceClient
            .from("integration_connections")
            .insert(connectionData)
            .select()
            .single();
          if (error) throw error;
          connection = data;
        }

        await serviceClient.from("integration_logs").insert({
          integration_id: integration.id,
          org_id: userData.organization_id,
          user_id: user.id,
          action: "connect",
          status: "success",
          request_meta: { type: "api_key", integration_key },
        });

        return new Response(
          JSON.stringify(connection),
          { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      case "disconnect": {
        const { data: affectedModules } = await serviceClient
          .from("module_integration_requirements")
          .select("module_key, feature_description")
          .eq("org_id", userData.organization_id)
          .eq("integration_key", integration_key);

        if (affectedModules?.length && !force) {
          return new Response(
            JSON.stringify({
              success: false,
              affected_modules: affectedModules.map((m) => m.module_key),
              message: "This integration is used by other modules. Set force=true to disconnect anyway.",
            }),
            { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
          );
        }

        const llmOnDisconnect = LLM_PROVIDER_INTEGRATIONS[integration_key];
        if (llmOnDisconnect) {
          // Disable rather than delete: deleting the provider row would cascade away its llm_models
          // and silently clear every agent's model choice. Reconnecting re-enables it with a new key.
          await serviceClient
            .from("llm_providers")
            .update({ enabled: false, updated_at: new Date().toISOString() })
            .eq("org_id", userData.organization_id)
            .eq("provider", llmOnDisconnect.provider);
        }

        await serviceClient
          .from("integration_connections")
          .update({
            status: "disconnected",
            credentials_encrypted: null,
            credentials_iv: null,
            access_token_encrypted: null,
            refresh_token_encrypted: null,
            error_message: null,
          })
          .eq("integration_id", integration.id)
          .eq("org_id", userData.organization_id);

        await serviceClient.from("integration_logs").insert({
          integration_id: integration.id,
          org_id: userData.organization_id,
          user_id: user.id,
          action: "disconnect",
          status: "success",
        });

        return new Response(
          JSON.stringify({ success: true }),
          { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      case "test": {
        const llmOnTest = LLM_PROVIDER_INTEGRATIONS[integration_key];
        if (llmOnTest) {
          const { data: providerRow } = await serviceClient
            .from("llm_providers")
            .select("api_key_encrypted, enabled")
            .eq("org_id", userData.organization_id)
            .eq("provider", llmOnTest.provider)
            .maybeSingle();
          const key = (await openSecret(providerRow?.api_key_encrypted)) ?? "";
          const validation = providerRow?.enabled && key
            ? await validateProviderKey(llmOnTest.provider, key)
            : { success: false, error: `${llmOnTest.label} is not connected` };

          await serviceClient.from("integration_logs").insert({
            integration_id: integration.id,
            org_id: userData.organization_id,
            user_id: user.id,
            action: "test",
            status: validation.success ? "success" : "failure",
            request_meta: { message: validation.success ? `${llmOnTest.label} key is valid` : validation.error },
          });
          await serviceClient
            .from("integration_connections")
            .update(validation.success
              ? { status: "connected", error_message: null }
              : { status: "error", error_message: validation.error })
            .eq("integration_id", integration.id)
            .eq("org_id", userData.organization_id);

          return new Response(
            JSON.stringify(validation.success
              ? { success: true, message: `${llmOnTest.label} connection is healthy` }
              : { success: false, message: validation.error }),
            { status: validation.success ? 200 : 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
          );
        }

        if (integration_key === "mailgun") {
          const mgUrl = Deno.env.get("SUPABASE_URL")!;
          const mgSrk = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

          const { data: conn } = await serviceClient
            .from("integration_connections")
            .select("credentials_encrypted, credentials_iv, status")
            .eq("integration_id", integration.id)
            .eq("org_id", userData.organization_id)
            .maybeSingle();

          if (!conn || conn.status !== "connected" || !conn.credentials_encrypted || !conn.credentials_iv) {
            return new Response(
              JSON.stringify({ success: false, message: "Mailgun is not connected" }),
              { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
            );
          }

          const decryptRes = await fetch(`${mgUrl}/functions/v1/email-crypto`, {
            method: "POST",
            headers: {
              Authorization: `Bearer ${mgSrk}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({ action: "decrypt", encrypted: conn.credentials_encrypted, iv: conn.credentials_iv }),
          });

          if (!decryptRes.ok) {
            return new Response(
              JSON.stringify({ success: false, message: "Failed to decrypt credentials" }),
              { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
            );
          }

          const { plaintext } = await decryptRes.json();
          let parsed: Record<string, unknown> = {};
          try {
            parsed = JSON.parse(plaintext);
          } catch {
            return new Response(
              JSON.stringify({ success: false, message: "Failed to parse stored Mailgun credentials" }),
              { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
            );
          }
          const apiKey = typeof parsed.api_key === "string" ? parsed.api_key : "";
          const region = (parsed.region === "eu" ? "eu" : "us") as MailgunRegion;
          const validation = await validateMailgunCredentials(apiKey, region);

          await serviceClient.from("integration_logs").insert({
            integration_id: integration.id,
            org_id: userData.organization_id,
            user_id: user.id,
            action: "test",
            status: validation.valid ? "success" : "failure",
            request_meta: { message: validation.valid ? "Mailgun API key is valid" : validation.error },
          });

          if (!validation.valid) {
            await serviceClient
              .from("integration_connections")
              .update({ status: "error", error_message: validation.error })
              .eq("integration_id", integration.id)
              .eq("org_id", userData.organization_id);

            return new Response(
              JSON.stringify({ success: false, message: validation.error }),
              { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
            );
          }

          return new Response(
            JSON.stringify({ success: true, message: "Mailgun connection is healthy" }),
            { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
          );
        }

        await serviceClient.from("integration_logs").insert({
          integration_id: integration.id,
          org_id: userData.organization_id,
          user_id: user.id,
          action: "test",
          status: "success",
          request_meta: { message: "Connection test successful" },
        });

        return new Response(
          JSON.stringify({ success: true, message: "Connection test successful" }),
          { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      default:
        return new Response(
          JSON.stringify({ error: "Invalid action" }),
          { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
    }
  } catch (error) {
    console.error("Error in integrations-connect:", error);
    return new Response(
      JSON.stringify({ error: (error instanceof Error && error.message) || "Internal server error" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
