/**
 * AI call usage metering → public.ai_call_usage (one row per model call).
 *
 * The OS called Anthropic from ~20 places with a bare fetch and logged nothing, so nobody could say
 * what an agent costs. meteredFetch() is a drop-in fetch: it passes every request through untouched
 * except for one thing, the US spelling rule added to model calls' system prompts (us-english.ts),
 * and for Anthropic Messages / OpenAI chat calls it reads the usage block from a CLONE of the
 * response in the background and inserts a row with the service role. It never changes, delays or
 * fails the caller's request — metering errors are logged and dropped.
 *
 *   const r = await meteredFetch({ source: "clara-sms-responder", agent: "clara", orgId })(url, init);
 *
 * Cost: the provider's own figure when the response carries one; otherwise an estimate from the
 * published per-token prices below (cost_source 'estimated'); unknown models get cost NULL
 * ('unknown') rather than a guess.
 *
 * Disabled (pure pass-through) when SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are absent, e.g. in unit
 * tests, so nothing is cloned or written there.
 */
import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2";
import { withUsSpelling } from "./us-english.ts";

export interface MeterContext {
  /** Edge function or module that made the call, e.g. "clara-sms-responder". */
  source: string;
  /** Who the spend belongs to: an agent slug ("clara", "friday") or an OS surface ("assistant", "os"). */
  agent: string;
  /** Org to bill. When omitted, the single org of a single-tenant install is used (else the row is skipped). */
  orgId?: string | null;
  agentUserId?: string | null;
  purpose?: string | null;
  runId?: string | null;
  taskRef?: string | null;
}

export interface UsageNumbers {
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /** Provider-reported cost in USD, when the response carries one. */
  reportedCostUsd?: number;
}

export type Provider = "anthropic" | "openai";

/** USD per million tokens. Cache writes are priced at 1.25x input (5-minute TTL), the default TTL. */
interface Price { in: number; out: number; cacheRead?: number }

// Published first-party prices (USD / MTok), checked 2026-10. Longest prefix wins.
const PRICES: Array<[prefix: string, price: Price]> = [
  ["claude-fable-5-1", { in: 10, out: 50, cacheRead: 0.25 }],
  ["claude-fable-5", { in: 10, out: 50 }],
  ["claude-opus-5-5", { in: 4, out: 20, cacheRead: 0.2 }],
  ["claude-opus-5", { in: 5, out: 25 }],
  ["claude-opus-4-8", { in: 5, out: 25 }],
  ["claude-opus-4-7", { in: 5, out: 25 }],
  ["claude-opus-4-6", { in: 5, out: 25 }],
  ["claude-opus-4-5", { in: 5, out: 25 }],
  ["claude-opus-4", { in: 15, out: 75 }],
  ["claude-sonnet-5-5", { in: 2, out: 10, cacheRead: 0.2 }],
  ["claude-sonnet-5", { in: 2, out: 10 }],
  ["claude-sonnet-4", { in: 3, out: 15 }],
  ["claude-3-7-sonnet", { in: 3, out: 15 }],
  ["claude-3-5-sonnet", { in: 3, out: 15 }],
  ["claude-haiku-5-5", { in: 0.1, out: 0.5 }],
  ["claude-haiku-4-5", { in: 1, out: 5 }],
  ["claude-3-5-haiku", { in: 0.8, out: 4 }],
  ["claude-3-haiku", { in: 0.25, out: 1.25 }],
];

function priceFor(model: string): Price | null {
  const m = model.toLowerCase();
  let best: [string, Price] | null = null;
  for (const entry of PRICES) {
    if (m.startsWith(entry[0]) && (!best || entry[0].length > best[0].length)) best = entry;
  }
  return best ? best[1] : null;
}

/** Estimated USD for one call, or null when the model's price is unknown. */
export function estimateCostUsd(u: UsageNumbers): number | null {
  const p = priceFor(u.model);
  if (!p) return null;
  const cacheRead = p.cacheRead ?? p.in * 0.1;
  const usd = (u.inputTokens * p.in + u.outputTokens * p.out + u.cacheReadTokens * cacheRead + u.cacheWriteTokens * p.in * 1.25) / 1e6;
  return Math.round(usd * 1e6) / 1e6;
}

const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.round(v) : 0);

/** Which provider a request goes to, when it is a metered model call; null otherwise. */
export function meteredProvider(url: string): Provider | null {
  let u: URL;
  try { u = new URL(url); } catch { return null; }
  if (u.hostname === "api.anthropic.com" && u.pathname.startsWith("/v1/messages") && !u.pathname.includes("count_tokens")) return "anthropic";
  if (u.hostname === "api.openai.com" && (u.pathname.startsWith("/v1/chat/completions") || u.pathname.startsWith("/v1/responses"))) return "openai";
  return null;
}

/** Usage from a non-streaming JSON body. */
export function usageFromJson(provider: Provider, body: unknown, requestModel?: string): UsageNumbers | null {
  if (!body || typeof body !== "object") return null;
  const b = body as Record<string, unknown>;
  const usage = b.usage as Record<string, unknown> | undefined;
  if (!usage || typeof usage !== "object") return null;
  const model = typeof b.model === "string" && b.model ? b.model : (requestModel || "unknown");
  if (provider === "anthropic") {
    return {
      model,
      inputTokens: num(usage.input_tokens),
      outputTokens: num(usage.output_tokens),
      cacheReadTokens: num(usage.cache_read_input_tokens),
      cacheWriteTokens: num(usage.cache_creation_input_tokens),
    };
  }
  // OpenAI chat completions (prompt/completion) and Responses API (input/output).
  const details = (usage.prompt_tokens_details ?? usage.input_tokens_details) as Record<string, unknown> | undefined;
  const cached = num(details?.cached_tokens);
  const input = num(usage.prompt_tokens ?? usage.input_tokens);
  return {
    model,
    inputTokens: Math.max(0, input - cached),
    outputTokens: num(usage.completion_tokens ?? usage.output_tokens),
    cacheReadTokens: cached,
    cacheWriteTokens: 0,
  };
}

/** Usage from an Anthropic SSE stream: message_start carries input/cache, message_delta the running output total. */
export function usageFromAnthropicSse(text: string, requestModel?: string): UsageNumbers | null {
  let found = false;
  const u: UsageNumbers = { model: requestModel || "unknown", inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
  for (const line of text.split("\n")) {
    if (!line.startsWith("data:")) continue;
    let ev: Record<string, unknown>;
    try { ev = JSON.parse(line.slice(5).trim()); } catch { continue; }
    if (ev.type === "message_start") {
      const msg = ev.message as Record<string, unknown> | undefined;
      const usage = msg?.usage as Record<string, unknown> | undefined;
      if (typeof msg?.model === "string") u.model = msg.model;
      if (usage) {
        found = true;
        u.inputTokens = num(usage.input_tokens);
        u.cacheReadTokens = num(usage.cache_read_input_tokens);
        u.cacheWriteTokens = num(usage.cache_creation_input_tokens);
        u.outputTokens = Math.max(u.outputTokens, num(usage.output_tokens));
      }
    } else if (ev.type === "message_delta") {
      const usage = ev.usage as Record<string, unknown> | undefined;
      if (usage) {
        found = true;
        u.outputTokens = Math.max(u.outputTokens, num(usage.output_tokens));
        if (num(usage.input_tokens)) u.inputTokens = num(usage.input_tokens);
      }
    }
  }
  return found ? u : null;
}

/** A short, key-free reason for a failed call, from the provider's error body (pure; exported for tests). */
export function errorMessageFromBody(status: number, body: string): string {
  let msg = "";
  try {
    const j = JSON.parse(body);
    msg = String(j?.error?.message ?? j?.error?.type ?? j?.message ?? j?.error ?? "");
  } catch { msg = body; }
  msg = msg.replace(/\s+/g, " ").trim()
    .replace(/\b(sk|rk|pk|key|AIza)[-_A-Za-z0-9]{12,}/g, "[redacted]")
    .replace(/Bearer\s+\S+/gi, "Bearer [redacted]")
    .slice(0, 300);
  return msg ? `HTTP ${status}: ${msg}` : `HTTP ${status}`;
}

/** The row that would be written for one call (pure; exported for tests). */
export function buildUsageRow(ctx: MeterContext, orgId: string, provider: Provider, u: UsageNumbers, extra: { ok: boolean; durationMs: number; errorMessage?: string }) {
  const estimated = u.reportedCostUsd === undefined ? estimateCostUsd(u) : null;
  const cost = u.reportedCostUsd ?? estimated;
  return {
    org_id: orgId,
    agent: ctx.agent,
    agent_user_id: ctx.agentUserId ?? null,
    provider,
    model: (u.model || "unknown").slice(0, 120),
    auth_type: "api_key",
    source: ctx.source.slice(0, 80),
    purpose: ctx.purpose?.slice(0, 120) ?? null,
    input_tokens: u.inputTokens,
    output_tokens: u.outputTokens,
    cache_read_tokens: u.cacheReadTokens,
    cache_write_tokens: u.cacheWriteTokens,
    cost_usd: cost,
    cost_source: u.reportedCostUsd !== undefined ? "reported" : cost === null ? "unknown" : "estimated",
    run_id: ctx.runId ?? null,
    task_ref: ctx.taskRef?.slice(0, 200) ?? null,
    status: extra.ok ? "ok" : "error",
    error_message: extra.ok ? null : (extra.errorMessage ?? null),
    duration_ms: Math.max(0, Math.round(extra.durationMs)),
  };
}

// ── side effects ─────────────────────────────────────────────────────────────────────────────

let client: SupabaseClient | null | undefined;
function serviceClient(): SupabaseClient | null {
  if (client !== undefined) return client;
  const url = Deno.env.get("SUPABASE_URL");
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  client = url && key ? createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } }) : null;
  return client;
}

let defaultOrg: Promise<string | null> | null = null;
/** Single-tenant fallback: the one organization, or null when there are several (then the row is skipped). */
function resolveDefaultOrg(db: SupabaseClient): Promise<string | null> {
  if (!defaultOrg) {
    const fixed = Deno.env.get("AI_USAGE_DEFAULT_ORG_ID")?.trim();
    defaultOrg = fixed
      ? Promise.resolve(fixed)
      : Promise.resolve(db.from("organizations").select("id").limit(2)).then(({ data }) => {
        const rows = (data ?? []) as Array<{ id: string }>;
        return rows.length === 1 ? rows[0].id : null;
      }, () => null);
  }
  return defaultOrg;
}

function requestModel(init?: RequestInit): string | undefined {
  if (!init || typeof init.body !== "string") return undefined;
  try {
    const m = (JSON.parse(init.body) as { model?: unknown }).model;
    return typeof m === "string" ? m : undefined;
  } catch {
    return undefined;
  }
}

function keepAlive(p: Promise<unknown>): void {
  const rt = (globalThis as unknown as { EdgeRuntime?: { waitUntil?: (p: Promise<unknown>) => void } }).EdgeRuntime;
  try { rt?.waitUntil?.(p); } catch { /* not in the edge runtime */ }
}

async function record(ctx: MeterContext, provider: Provider, res: Response, model: string | undefined, startedAt: number): Promise<void> {
  try {
    const db = serviceClient();
    if (!db) return;
    const isSse = (res.headers.get("content-type") ?? "").includes("text/event-stream");
    const text = await res.text();
    const durationMs = Date.now() - startedAt;
    let usage: UsageNumbers | null = null;
    if (isSse) {
      usage = provider === "anthropic" ? usageFromAnthropicSse(text, model) : null;
    } else {
      try { usage = usageFromJson(provider, JSON.parse(text), model); } catch { usage = null; }
    }
    if (!usage) {
      if (res.ok) return; // nothing billable we can read
      usage = { model: model || "unknown", inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
    }
    const orgId = ctx.orgId || (await resolveDefaultOrg(db));
    if (!orgId) return;
    const row = buildUsageRow(ctx, orgId, provider, usage, {
      ok: res.ok, durationMs, errorMessage: res.ok ? undefined : errorMessageFromBody(res.status, text),
    });
    const { error } = await db.from("ai_call_usage").insert(row);
    if (error) console.warn(`[ai-usage] ${ctx.source}: could not record usage: ${error.message}`);
  } catch (e) {
    console.warn(`[ai-usage] ${ctx.source}: metering failed: ${(e as Error).message}`);
  }
}

/**
 * A fetch that records model-call usage. The global fetch is looked up at call time (so tests that
 * stub globalThis.fetch still work) and the caller always gets the original Response.
 */
export function meteredFetch(ctx: MeterContext): typeof fetch {
  const wrapped = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const provider = meteredProvider(url);
    if (provider) init = withUsSpelling(provider, init);
    const startedAt = Date.now();
    const res = await globalThis.fetch(input, init);
    if (!provider || !serviceClient()) return res;
    try {
      const copy = res.clone();
      keepAlive(record(ctx, provider, copy, requestModel(init), startedAt));
    } catch (e) {
      console.warn(`[ai-usage] ${ctx.source}: could not clone response: ${(e as Error).message}`);
    }
    return res;
  };
  return wrapped as typeof fetch;
}
