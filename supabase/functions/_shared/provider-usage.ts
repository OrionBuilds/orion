/**
 * Provider usage / cost / subscription readers for the ai-provider-usage edge function.
 *
 * Every reader takes the credential as an argument and returns a summary that contains NO part of
 * the credential. Parsers are pure and unit-tested; the fetchers are thin.
 *
 * What each provider exposes, with the credential type the OS can hold:
 *   Anthropic  standard API key  -> validity only (GET /v1/models). Usage + cost need an Admin API key
 *                                   (sk-ant-admin...): /v1/organizations/usage_report/messages and
 *                                   /v1/organizations/cost_report (amounts are USD cents as decimal strings).
 *   OpenAI     standard API key  -> validity only. Usage + costs need an Admin key:
 *                                   /v1/organization/usage/completions, /v1/organization/costs.
 *   ElevenLabs API key           -> subscription tier, characters used / limit, reset date
 *                                   (GET /v1/user/subscription).
 *   Claude / ChatGPT consumer subscriptions (used through the Claude Code / Codex CLIs on the agent box)
 *              -> no credential in the OS and no usage API; only what agents report (ai_call_usage).
 */

export interface DailyCost { day: string; cost_usd: number }
export interface ModelUsage { model: string; input_tokens: number; output_tokens: number; cache_read_tokens: number; cache_write_tokens: number; requests?: number }

export interface UsageSummary {
  period_start: string;
  period_end: string;
  cost_usd: number | null;
  daily: DailyCost[];
  by_model: ModelUsage[];
  input_tokens: number;
  output_tokens: number;
}

type Json = Record<string, unknown>;
const n = (v: unknown): number => {
  const x = typeof v === "string" ? Number(v) : v;
  return typeof x === "number" && Number.isFinite(x) ? x : 0;
};
const day = (iso: unknown): string => (typeof iso === "string" ? iso.slice(0, 10) : typeof iso === "number" ? new Date(iso * 1000).toISOString().slice(0, 10) : "");

function addModel(map: Map<string, ModelUsage>, model: string, u: Omit<ModelUsage, "model">) {
  const cur = map.get(model) ?? { model, input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0, requests: 0 };
  cur.input_tokens += u.input_tokens;
  cur.output_tokens += u.output_tokens;
  cur.cache_read_tokens += u.cache_read_tokens;
  cur.cache_write_tokens += u.cache_write_tokens;
  cur.requests = (cur.requests ?? 0) + (u.requests ?? 0);
  map.set(model, cur);
}

/** Anthropic usage_report/messages pages (group_by[]=model, bucket_width=1d) -> per-model tokens. */
export function parseAnthropicUsage(pages: Json[]): ModelUsage[] {
  const map = new Map<string, ModelUsage>();
  for (const page of pages) {
    for (const bucket of (page.data as Json[] | undefined) ?? []) {
      for (const r of (bucket.results as Json[] | undefined) ?? []) {
        const cc = (r.cache_creation as Json | undefined) ?? {};
        addModel(map, String(r.model ?? "unknown"), {
          input_tokens: n(r.uncached_input_tokens),
          output_tokens: n(r.output_tokens),
          cache_read_tokens: n(r.cache_read_input_tokens),
          cache_write_tokens: n(cc.ephemeral_5m_input_tokens) + n(cc.ephemeral_1h_input_tokens),
        });
      }
    }
  }
  return [...map.values()].sort((a, b) => b.output_tokens + b.input_tokens - (a.output_tokens + a.input_tokens));
}

/** Anthropic cost_report pages -> USD per day. Amounts are decimal strings in cents. */
export function parseAnthropicCost(pages: Json[]): DailyCost[] {
  const byDay = new Map<string, number>();
  for (const page of pages) {
    for (const bucket of (page.data as Json[] | undefined) ?? []) {
      const d = day(bucket.starting_at);
      let cents = 0;
      for (const r of (bucket.results as Json[] | undefined) ?? []) cents += n(r.amount);
      byDay.set(d, (byDay.get(d) ?? 0) + cents / 100);
    }
  }
  return [...byDay.entries()].map(([d, usd]) => ({ day: d, cost_usd: Math.round(usd * 1e4) / 1e4 })).sort((a, b) => a.day.localeCompare(b.day));
}

/** OpenAI /v1/organization/costs pages -> USD per day (amount.value is in dollars). */
export function parseOpenAICosts(pages: Json[]): DailyCost[] {
  const byDay = new Map<string, number>();
  for (const page of pages) {
    for (const bucket of (page.data as Json[] | undefined) ?? []) {
      const d = day(bucket.start_time);
      let usd = 0;
      for (const r of (bucket.results as Json[] | undefined) ?? []) usd += n((r.amount as Json | undefined)?.value);
      byDay.set(d, (byDay.get(d) ?? 0) + usd);
    }
  }
  return [...byDay.entries()].map(([d, usd]) => ({ day: d, cost_usd: Math.round(usd * 1e4) / 1e4 })).sort((a, b) => a.day.localeCompare(b.day));
}

/** OpenAI /v1/organization/usage/completions pages (group_by=model) -> per-model tokens. */
export function parseOpenAIUsage(pages: Json[]): ModelUsage[] {
  const map = new Map<string, ModelUsage>();
  for (const page of pages) {
    for (const bucket of (page.data as Json[] | undefined) ?? []) {
      for (const r of (bucket.results as Json[] | undefined) ?? []) {
        const cached = n(r.input_cached_tokens);
        addModel(map, String(r.model ?? "unknown"), {
          input_tokens: Math.max(0, n(r.input_tokens) - cached),
          output_tokens: n(r.output_tokens),
          cache_read_tokens: cached,
          cache_write_tokens: 0,
          requests: n(r.num_model_requests),
        });
      }
    }
  }
  return [...map.values()];
}

export function summarize(periodStart: string, periodEnd: string, daily: DailyCost[] | null, byModel: ModelUsage[]): UsageSummary {
  return {
    period_start: periodStart,
    period_end: periodEnd,
    cost_usd: daily ? Math.round(daily.reduce((s, d) => s + d.cost_usd, 0) * 1e4) / 1e4 : null,
    daily: daily ?? [],
    by_model: byModel,
    input_tokens: byModel.reduce((s, m) => s + m.input_tokens + m.cache_read_tokens + m.cache_write_tokens, 0),
    output_tokens: byModel.reduce((s, m) => s + m.output_tokens, 0),
  };
}

export interface ElevenLabsSubscription {
  tier: string | null;
  status: string | null;
  characters_used: number;
  character_limit: number;
  resets_at: string | null;
}

export function parseElevenLabsSubscription(j: Json): ElevenLabsSubscription {
  const reset = n(j.next_character_count_reset_unix);
  return {
    tier: typeof j.tier === "string" ? j.tier : null,
    status: typeof j.status === "string" ? j.status : null,
    characters_used: n(j.character_count),
    character_limit: n(j.character_limit),
    resets_at: reset > 0 ? new Date(reset * 1000).toISOString() : null,
  };
}

// ── fetchers ─────────────────────────────────────────────────────────────────────────────────

const TIMEOUT = 15_000;

async function getJson(url: string, headers: Record<string, string>, f: typeof fetch): Promise<{ ok: boolean; status: number; json: Json | null }> {
  const r = await f(url, { headers, signal: AbortSignal.timeout(TIMEOUT) });
  const json = await r.json().catch(() => null) as Json | null;
  return { ok: r.ok, status: r.status, json };
}

function providerError(status: number, json: Json | null): string {
  const e = json?.error as Json | string | undefined;
  const msg = typeof e === "string" ? e : typeof e?.message === "string" ? e.message : json?.detail ? String((json.detail as Json).message ?? json.detail) : "";
  return `HTTP ${status}${msg ? `: ${String(msg).slice(0, 200)}` : ""}`;
}

/** Follow has_more/next_page up to maxPages. */
async function pages(baseUrl: string, headers: Record<string, string>, f: typeof fetch, maxPages = 5): Promise<Json[]> {
  const out: Json[] = [];
  let url = baseUrl;
  for (let i = 0; i < maxPages; i++) {
    const r = await getJson(url, headers, f);
    if (!r.ok || !r.json) throw new Error(providerError(r.status, r.json));
    out.push(r.json);
    const next = r.json.next_page;
    if (!r.json.has_more || typeof next !== "string" || !next) break;
    const u = new URL(baseUrl);
    u.searchParams.set("page", next);
    url = u.toString();
  }
  return out;
}

export async function checkAnthropicKey(key: string, f: typeof fetch = fetch): Promise<{ valid: boolean; error?: string }> {
  const r = await getJson("https://api.anthropic.com/v1/models?limit=1", { "x-api-key": key, "anthropic-version": "2023-06-01" }, f);
  return r.ok ? { valid: true } : { valid: false, error: providerError(r.status, r.json) };
}

export async function anthropicAdminUsage(adminKey: string, start: Date, end: Date, f: typeof fetch = fetch): Promise<UsageSummary> {
  const headers = { "x-api-key": adminKey, "anthropic-version": "2023-06-01", "user-agent": "orion/agent-health" };
  const qs = `starting_at=${encodeURIComponent(start.toISOString())}&ending_at=${encodeURIComponent(end.toISOString())}`;
  const [usagePages, costPages] = await Promise.all([
    pages(`https://api.anthropic.com/v1/organizations/usage_report/messages?${qs}&bucket_width=1d&group_by[]=model&limit=31`, headers, f),
    pages(`https://api.anthropic.com/v1/organizations/cost_report?${qs}&limit=31`, headers, f),
  ]);
  return summarize(start.toISOString(), end.toISOString(), parseAnthropicCost(costPages), parseAnthropicUsage(usagePages));
}

export async function checkOpenAIKey(key: string, f: typeof fetch = fetch): Promise<{ valid: boolean; error?: string }> {
  const r = await getJson("https://api.openai.com/v1/models", { authorization: `Bearer ${key}` }, f);
  return r.ok ? { valid: true } : { valid: false, error: providerError(r.status, r.json) };
}

export async function openaiAdminUsage(adminKey: string, start: Date, end: Date, f: typeof fetch = fetch): Promise<UsageSummary> {
  const headers = { authorization: `Bearer ${adminKey}` };
  const s = Math.floor(start.getTime() / 1000), e = Math.floor(end.getTime() / 1000);
  const [costPages, usagePages] = await Promise.all([
    pages(`https://api.openai.com/v1/organization/costs?start_time=${s}&end_time=${e}&bucket_width=1d&limit=31`, headers, f),
    pages(`https://api.openai.com/v1/organization/usage/completions?start_time=${s}&end_time=${e}&bucket_width=1d&group_by=model&limit=31`, headers, f),
  ]);
  return summarize(start.toISOString(), end.toISOString(), parseOpenAICosts(costPages), parseOpenAIUsage(usagePages));
}

export async function elevenLabsSubscription(key: string, f: typeof fetch = fetch): Promise<ElevenLabsSubscription> {
  const r = await getJson("https://api.elevenlabs.io/v1/user/subscription", { "xi-api-key": key }, f);
  if (!r.ok || !r.json) throw new Error(providerError(r.status, r.json));
  return parseElevenLabsSubscription(r.json);
}

