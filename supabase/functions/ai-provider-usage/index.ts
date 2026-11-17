/**
 * ai-provider-usage — subscription and API-key status/usage for the Agent Health dashboard.
 *
 * Admin-only (SuperAdmin, or a member holding ai_agents.manage). For every AI provider connection
 * the OS holds, returns: where the credential lives, whether it is present/enabled/valid, and what the
 * provider's own usage/cost/subscription API says — when one is reachable with credentials the OS
 * stores. It NEVER returns a credential or any part of one.
 *
 * Credentials read (server-side only):
 *   llm_providers.api_key_encrypted (sealed)  anthropic / openai / elevenlabs rows
 *   ANTHROPIC_API_KEY, OPENAI_API_KEY, ELEVENLABS_API_KEY   edge secrets the agents use
 *   ANTHROPIC_ADMIN_API_KEY  (optional) Anthropic Admin key -> usage_report + cost_report
 *   OPENAI_ADMIN_KEY         (optional) OpenAI Admin key -> organization usage + costs
 *
 * Results are cached per provider in ai_provider_usage_cache for 15 minutes; POST {"refresh": true}
 * bypasses the cache. Provider usage APIs lag a few minutes and are rate-limited, so the dashboard
 * should never call them directly.
 */
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2";
import { extractUserContext } from "../_shared/auth.ts";
import { openSecret } from "../_shared/secrets.ts";
import {
  anthropicAdminUsage,
  checkAnthropicKey,
  checkOpenAIKey,
  elevenLabsSubscription,
  type ElevenLabsSubscription,
  openaiAdminUsage,
  type UsageSummary,
} from "../_shared/provider-usage.ts";

const CACHE_TTL_MS = 15 * 60 * 1000;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });

interface Credential {
  label: string;
  /** Where it is stored — a table or an edge secret NAME, never its value. */
  location: string;
  present: boolean;
  enabled?: boolean;
  valid?: boolean | null;
  error?: string;
}

interface ProviderCard {
  key: string;
  name: string;
  auth_type: "api_key" | "subscription";
  credentials: Credential[];
  usage_api: { available: boolean; configured: boolean; requires?: string; note: string };
  usage?: UsageSummary | null;
  subscription?: ElevenLabsSubscription | null;
  credits?: number | null;
  error?: string;
  fetched_at: string;
  cached?: boolean;
}

interface ProviderRow { provider: string; api_key_encrypted: string | null; enabled: boolean; updated_at: string | null }

const env = (k: string) => Deno.env.get(k)?.trim() || "";

async function loadProviderRows(db: SupabaseClient, orgId: string): Promise<Map<string, ProviderRow>> {
  const { data } = await db.from("llm_providers").select("provider, api_key_encrypted, enabled, updated_at").eq("org_id", orgId);
  const map = new Map<string, ProviderRow>();
  for (const r of (data ?? []) as ProviderRow[]) map.set(r.provider, r);
  return map;
}

async function rowKey(row: ProviderRow | undefined): Promise<string> {
  if (!row?.api_key_encrypted) return "";
  try { return (await openSecret(row.api_key_encrypted))?.trim() ?? ""; } catch { return ""; }
}

/** Validate each distinct credential once; identical keys in two places share one check. */
async function validate(
  creds: Array<{ c: Credential; key: string }>,
  check: (key: string) => Promise<{ valid: boolean; error?: string }>,
): Promise<void> {
  const seen = new Map<string, Promise<{ valid: boolean; error?: string }>>();
  await Promise.all(creds.map(async ({ c, key }) => {
    if (!key) { c.valid = null; return; }
    if (!seen.has(key)) seen.set(key, check(key).catch((e) => ({ valid: false, error: (e as Error).message })));
    const r = await seen.get(key)!;
    c.valid = r.valid;
    if (r.error) c.error = r.error;
  }));
}

function periodStart(now: Date): Date {
  // From the first day of the previous month (UTC): enough for month-to-date vs the previous period.
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
}

async function anthropicCard(rows: Map<string, ProviderRow>, now: Date): Promise<ProviderCard> {
  const row = rows.get("anthropic");
  const dbKey = await rowKey(row);
  const envKey = env("ANTHROPIC_API_KEY");
  const adminKey = env("ANTHROPIC_ADMIN_API_KEY");
  const creds = [
    { c: { label: "Agents & edge functions (Clara, OS AI features)", location: "edge secret ANTHROPIC_API_KEY", present: !!envKey } as Credential, key: envKey },
    { c: { label: "AI Settings provider", location: "llm_providers (anthropic)", present: !!dbKey, enabled: row?.enabled ?? false } as Credential, key: dbKey },
  ];
  await validate(creds, (k) => checkAnthropicKey(k));
  const card: ProviderCard = {
    key: "anthropic", name: "Anthropic API", auth_type: "api_key",
    credentials: creds.map((x) => x.c),
    usage_api: {
      available: true, configured: !!adminKey, requires: "Anthropic Admin API key (sk-ant-admin...) in edge secret ANTHROPIC_ADMIN_API_KEY",
      note: adminKey
        ? "Usage and cost from Anthropic's Usage & Cost Admin API (organization-wide, every key)."
        : "A standard API key cannot read usage or cost. Add an Admin API key to see billed spend; until then the numbers below come from the OS's own call log.",
    },
    fetched_at: now.toISOString(),
  };
  if (adminKey) {
    try { card.usage = await anthropicAdminUsage(adminKey, periodStart(now), now); } catch (e) { card.error = `Usage API: ${(e as Error).message}`; }
  }
  return card;
}

async function openaiCard(rows: Map<string, ProviderRow>, now: Date): Promise<ProviderCard> {
  const row = rows.get("openai");
  const dbKey = await rowKey(row);
  const envKey = env("OPENAI_API_KEY");
  const adminKey = env("OPENAI_ADMIN_KEY");
  const creds = [
    { c: { label: "AI Settings provider", location: "llm_providers (openai)", present: !!dbKey, enabled: row?.enabled ?? false } as Credential, key: dbKey },
    { c: { label: "Edge functions", location: "edge secret OPENAI_API_KEY", present: !!envKey } as Credential, key: envKey },
  ];
  await validate(creds, (k) => checkOpenAIKey(k));
  const card: ProviderCard = {
    key: "openai", name: "OpenAI API", auth_type: "api_key",
    credentials: creds.map((x) => x.c),
    usage_api: {
      available: true, configured: !!adminKey, requires: "OpenAI Admin key (sk-admin-...) in edge secret OPENAI_ADMIN_KEY",
      note: adminKey
        ? "Usage and cost from OpenAI's organization Usage & Costs API."
        : "A project API key cannot read usage or cost. The OS does not call OpenAI today (provider disabled), so there is nothing to meter.",
    },
    fetched_at: now.toISOString(),
  };
  if (adminKey) {
    try { card.usage = await openaiAdminUsage(adminKey, periodStart(now), now); } catch (e) { card.error = `Usage API: ${(e as Error).message}`; }
  }
  return card;
}

async function elevenLabsCard(db: SupabaseClient, orgId: string, rows: Map<string, ProviderRow>, now: Date): Promise<ProviderCard> {
  const row = rows.get("elevenlabs");
  const dbKey = await rowKey(row);
  const envKey = env("ELEVENLABS_API_KEY");
  const { data: conn } = await db.from("elevenlabs_connection").select("api_key_encrypted, enabled").eq("org_id", orgId).maybeSingle();
  const connRow = conn as { api_key_encrypted: string | null; enabled: boolean } | null;
  let connKey = "";
  try { connKey = (await openSecret(connRow?.api_key_encrypted ?? null))?.trim() ?? ""; } catch { connKey = ""; }
  const card: ProviderCard = {
    key: "elevenlabs", name: "ElevenLabs (Clara's voice)", auth_type: "subscription",
    credentials: [
      { label: "Clara voice (TTS)", location: "edge secret ELEVENLABS_API_KEY", present: !!envKey },
      { label: "AI Settings provider", location: "llm_providers (elevenlabs)", present: !!dbKey, enabled: row?.enabled ?? false },
      { label: "Voice settings connection", location: "elevenlabs_connection", present: !!connKey, enabled: connRow?.enabled ?? false },
    ],
    usage_api: { available: true, configured: !!(envKey || dbKey || connKey), note: "Plan tier and character quota from ElevenLabs' subscription endpoint." },
    fetched_at: now.toISOString(),
  };
  // The quota is per ElevenLabs account, so one read is enough: use the key Clara actually speaks with.
  const keys = [envKey, dbKey, connKey];
  const used = keys.findIndex((k) => !!k);
  if (used >= 0) {
    try {
      card.subscription = await elevenLabsSubscription(keys[used]);
      card.credentials[used].valid = true;
    } catch (e) {
      card.credentials[used].valid = false;
      card.error = `Subscription API: ${(e as Error).message}`;
    }
  }
  return card;
}

function subscriptionsCard(now: Date): ProviderCard {
  return {
    key: "consumer-subscriptions", name: "Claude / ChatGPT subscriptions (agent CLIs)", auth_type: "subscription",
    credentials: [{ label: "Signed in on the agent workstation (Claude Code / Codex CLI)", location: "not stored in the OS", present: false }],
    usage_api: {
      available: false, configured: false,
      note: "Consumer plans (Claude Pro/Max, ChatGPT Plus/Pro) have no usage or cost API, and their OAuth sign-in lives on the agent box, not in the OS. What is shown is only what the agents report through the MCP tool agent_usage_report (tokens and the API-equivalent value the CLI reports), not money billed.",
    },
    fetched_at: now.toISOString(),
  };
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 200, headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);

  const db = createClient(env("SUPABASE_URL"), env("SUPABASE_SERVICE_ROLE_KEY"), { auth: { autoRefreshToken: false, persistSession: false } });
  const user = await extractUserContext(req, db);
  if (!user) return json({ error: "Unauthenticated" }, 401);
  if (!user.isSuperAdmin && !user.permissions.includes("ai_agents.manage")) {
    return json({ error: "You need the ai_agents.manage permission" }, 403);
  }

  const body = await req.json().catch(() => ({})) as { refresh?: boolean };
  const orgId = user.orgId;
  const now = new Date();

  try {
    const { data: cacheRows } = await db.from("ai_provider_usage_cache").select("provider, payload, fetched_at").eq("org_id", orgId);
    const cache = new Map<string, { payload: ProviderCard; fetched_at: string }>();
    for (const r of (cacheRows ?? []) as Array<{ provider: string; payload: ProviderCard; fetched_at: string }>) cache.set(r.provider, r);
    const fresh = (k: string) => {
      const hit = cache.get(k);
      return !body.refresh && hit && now.getTime() - new Date(hit.fetched_at).getTime() < CACHE_TTL_MS ? { ...hit.payload, cached: true } : null;
    };

    let rows: Map<string, ProviderRow> | null = null;
    const getRows = async () => (rows ??= await loadProviderRows(db, orgId));

    const build: Array<[string, () => Promise<ProviderCard | null>]> = [
      ["anthropic", async () => anthropicCard(await getRows(), now)],
      ["openai", async () => openaiCard(await getRows(), now)],
      ["elevenlabs", async () => elevenLabsCard(db, orgId, await getRows(), now)],
    ];

    const cards: ProviderCard[] = [];
    const toCache: Array<{ org_id: string; provider: string; payload: ProviderCard; ok: boolean; fetched_at: string }> = [];
    const results = await Promise.all(build.map(async ([k, fn]) => {
      const hit = fresh(k);
      if (hit) return hit;
      const card = await fn().catch((e) => ({
        key: k, name: k, auth_type: "api_key" as const, credentials: [], fetched_at: now.toISOString(),
        usage_api: { available: false, configured: false, note: "" }, error: (e as Error).message,
      }));
      if (card) toCache.push({ org_id: orgId, provider: k, payload: card, ok: !card.error, fetched_at: now.toISOString() });
      return card;
    }));
    for (const c of results) if (c) cards.push(c);
    cards.push(subscriptionsCard(now));

    if (toCache.length) {
      const { error } = await db.from("ai_provider_usage_cache").upsert(toCache, { onConflict: "org_id,provider" });
      if (error) console.warn(`[ai-provider-usage] cache write failed: ${error.message}`);
    }

    return json({ generated_at: now.toISOString(), providers: cards });
  } catch (e) {
    console.error("[ai-provider-usage]", e);
    return json({ error: "Could not read provider usage" }, 500);
  }
});
