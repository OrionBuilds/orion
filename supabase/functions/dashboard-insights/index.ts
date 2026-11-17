import { meteredFetch } from "../_shared/ai-usage.ts";
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { getSupabaseClient, extractUserContext, requireAuth, AuthError } from "../_shared/auth.ts";
import { handleCors, jsonResponse, errorResponse } from "../_shared/cors.ts";
import { openSecret } from "../_shared/secrets.ts";
import { callWithKeyFallback } from "../_shared/key-fallback.ts";
import {
  CLARA_MODEL_HEAVY,
  buildAnthropicHeaders,
  type AnthropicResponse,
} from "../_shared/claraConfig.ts";

// dashboard-insights
// -------------------
// Powers the Dashboard "AI Report Insights" widget. The 6 finance/sales KPIs are
// recomputed LIVE from the DB on every call (cheap aggregate SQL, service role,
// correct org columns, contact-scoped invoices so QuickBooks orphans are excluded).
// Only the Claude-generated narrative + per-card insight TEXT is cached per org and
// regenerated at most once / 24h (or immediately when force=true).

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

interface CardDef {
  card_id: string;
  title: string;
  period: string;
  cur: number;
  prev: number | null; // null = no comparable previous period
}

function getQuarterStart(d: Date): Date {
  const q = Math.floor(d.getUTCMonth() / 3);
  return new Date(Date.UTC(d.getUTCFullYear(), q * 3, 1));
}

function round2(n: number): number {
  return Math.round((Number(n) || 0) * 100) / 100;
}

function computeTrend(cur: number, prev: number | null): { delta_pct: number | null; trend: "up" | "down" | "flat" } {
  if (prev == null) return { delta_pct: null, trend: "flat" };
  if (prev <= 0) {
    return { delta_pct: null, trend: cur > 0 ? "up" : "flat" };
  }
  const pct = (cur - prev) / prev;
  const trend = pct > 0.02 ? "up" : pct < -0.02 ? "down" : "flat";
  return { delta_pct: Math.round(pct * 1000) / 10, trend };
}

async function callAnthropic(
  apiKey: string,
  systemPrompt: string,
  userPrompt: string,
): Promise<string> {
  const response = await meteredFetch({ source: "dashboard-insights", agent: "os" })("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: buildAnthropicHeaders(apiKey),
    body: JSON.stringify({
      model: CLARA_MODEL_HEAVY,
      system: systemPrompt,
      messages: [{ role: "user", content: userPrompt }],
      max_tokens: 1024,
    }),
  });
  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Anthropic API error ${response.status}: ${errText}`);
  }
  const data = (await response.json()) as AnthropicResponse;
  return data.content.find((b: { type: string }) => b.type === "text")?.text || "";
}

Deno.serve(async (req: Request) => {
  const corsResp = handleCors(req);
  if (corsResp) return corsResp;

  try {
    const supabase = getSupabaseClient();
    const userContext = await extractUserContext(req, supabase);
    const user = requireAuth(userContext);

    const orgId = user.orgId;
    if (!orgId || !UUID_RE.test(orgId)) {
      return errorResponse("NO_ORG", "No organization context", 400);
    }

    // force regeneration via body { force: true } or ?force=1
    let force = false;
    try {
      const url = new URL(req.url);
      if (url.searchParams.get("force") === "1") force = true;
      const body = await req.json().catch(() => ({}));
      if (body && (body.force === true || body.force === "1")) force = true;
    } catch {
      // no body / not JSON - ignore
    }

    // ---- 1. Compute the 6 KPIs deterministically (current + previous window) ----
    const now = new Date();
    const curStart = getQuarterStart(now);
    const curEnd = now;
    const elapsedMs = curEnd.getTime() - curStart.getTime();
    const prevStart = new Date(Date.UTC(curStart.getUTCFullYear(), curStart.getUTCMonth() - 3, 1));
    const prevEnd = new Date(prevStart.getTime() + elapsedMs);

    const cs = curStart.toISOString();
    const ce = curEnd.toISOString();
    const ps = prevStart.toISOString();
    const pe = prevEnd.toISOString();
    const ORG = orgId; // validated uuid above

    // Single round-trip via exec_report_query (SELECT-only, JOIN-capable).
    // Invoice/payment money totals INNER JOIN contacts to drop QuickBooks orphans,
    // matching the Payments + Dashboard pages.
    const kpiSql = `
SELECT
  COALESCE((SELECT SUM(i.total) FROM public.invoices i JOIN public.contacts c ON c.id = i.contact_id
    WHERE i.org_id = '${ORG}' AND i.status = 'paid' AND i.paid_at >= '${cs}' AND i.paid_at < '${ce}'), 0) AS collected_cur,
  COALESCE((SELECT SUM(i.total) FROM public.invoices i JOIN public.contacts c ON c.id = i.contact_id
    WHERE i.org_id = '${ORG}' AND i.status = 'paid' AND i.paid_at >= '${ps}' AND i.paid_at < '${pe}'), 0) AS collected_prev,
  COALESCE((SELECT SUM(i.total) FROM public.invoices i JOIN public.contacts c ON c.id = i.contact_id
    WHERE i.org_id = '${ORG}' AND i.status <> 'void' AND i.created_at >= '${cs}' AND i.created_at < '${ce}'), 0) AS invoiced_cur,
  COALESCE((SELECT SUM(i.total) FROM public.invoices i JOIN public.contacts c ON c.id = i.contact_id
    WHERE i.org_id = '${ORG}' AND i.status <> 'void' AND i.created_at >= '${ps}' AND i.created_at < '${pe}'), 0) AS invoiced_prev,
  COALESCE((SELECT SUM(i.total) FROM public.invoices i JOIN public.contacts c ON c.id = i.contact_id
    WHERE i.org_id = '${ORG}' AND i.status IN ('sent','viewed','overdue')), 0) AS outstanding_cur,
  COALESCE((SELECT SUM(o.value_amount) FROM public.opportunities o
    WHERE o.org_id = '${ORG}' AND o.status = 'won' AND o.closed_at >= '${cs}' AND o.closed_at < '${ce}'), 0) AS won_value_cur,
  COALESCE((SELECT SUM(o.value_amount) FROM public.opportunities o
    WHERE o.org_id = '${ORG}' AND o.status = 'won' AND o.closed_at >= '${ps}' AND o.closed_at < '${pe}'), 0) AS won_value_prev,
  COALESCE((SELECT SUM(o.value_amount) FROM public.opportunities o
    WHERE o.org_id = '${ORG}' AND o.created_at >= '${cs}' AND o.created_at < '${ce}'), 0) AS pipeline_cur,
  COALESCE((SELECT SUM(o.value_amount) FROM public.opportunities o
    WHERE o.org_id = '${ORG}' AND o.created_at >= '${ps}' AND o.created_at < '${pe}'), 0) AS pipeline_prev,
  COALESCE((SELECT SUM(o.value_amount) FROM public.opportunities o
    WHERE o.org_id = '${ORG}' AND o.status = 'won'), 0) AS won_alltime`.trim();

    const { data: kpiData, error: kpiErr } = await supabase.rpc("exec_report_query", { query_text: kpiSql });
    if (kpiErr) {
      console.error("KPI query failed:", kpiErr.message);
      return errorResponse("QUERY_FAILED", "Failed to compute dashboard metrics", 500);
    }

    const row = (Array.isArray(kpiData) ? kpiData[0] : null) || {};
    const num = (v: unknown) => Number(v) || 0;

    const defs: CardDef[] = [
      { card_id: "collected_revenue", title: "Collected Revenue", period: "This quarter", cur: round2(num(row.collected_cur)), prev: round2(num(row.collected_prev)) },
      { card_id: "invoiced_revenue", title: "Invoiced Revenue", period: "This quarter", cur: round2(num(row.invoiced_cur)), prev: round2(num(row.invoiced_prev)) },
      { card_id: "outstanding_balance", title: "Outstanding Balance", period: "Current", cur: round2(num(row.outstanding_cur)), prev: null },
      { card_id: "won_deal_value", title: "Won Deal Value", period: "This quarter", cur: round2(num(row.won_value_cur)), prev: round2(num(row.won_value_prev)) },
      { card_id: "pipeline_created", title: "Total Pipeline Created", period: "This quarter", cur: round2(num(row.pipeline_cur)), prev: round2(num(row.pipeline_prev)) },
      { card_id: "won_revenue", title: "Won Revenue", period: "All time", cur: round2(num(row.won_alltime)), prev: null },
    ];

    const cards = defs.map((d) => {
      const { delta_pct, trend } = computeTrend(d.cur, d.prev);
      return {
        card_id: d.card_id,
        title: d.title,
        period: d.period,
        value: d.cur,
        format: "currency" as const,
        delta_pct,
        trend,
        insight: "",
      };
    });

    // ---- 2. Insight cache (day-cached Claude text) ----
    const { data: cached } = await supabase
      .from("dashboard_ai_insights")
      .select("insight, generated_at")
      .eq("org_id", orgId)
      .eq("scope", "org")
      .maybeSingle();

    let narrative = "";
    let cardInsights: Record<string, string> = {};
    let generatedAt = cached?.generated_at || null;
    const fresh = cached && !force &&
      (now.getTime() - new Date(cached.generated_at).getTime()) < CACHE_TTL_MS;

    if (fresh && cached?.insight) {
      const ins = cached.insight as { narrative?: string; cards?: Record<string, string> };
      narrative = ins.narrative || "";
      cardInsights = ins.cards || {};
    } else {
      // Need a fresh insight. Look up the org's Anthropic key (same pattern as ai-report-generate).
      const { data: llmProvider } = await supabase
        .from("llm_providers")
        .select("api_key_encrypted")
        .eq("org_id", orgId)
        .eq("enabled", true)
        .order("created_at", { ascending: true })
        .limit(1)
        .maybeSingle();

      const platformKey = (Deno.env.get("ANTHROPIC_API_KEY") ?? "").trim();
      if (platformKey || llmProvider?.api_key_encrypted) {
        try {
          const metricsForAI = cards.map((c) => ({
            id: c.card_id,
            title: c.title,
            period: c.period,
            value: c.value,
            change_pct: c.delta_pct,
            trend: c.trend,
          }));
          const systemPrompt = `You are a concise financial analyst for a CRM/business platform dashboard. You are given 6 already-computed finance & sales KPIs (current value, period, % change vs the comparable prior window, and trend). All values are in USD.

Write a short, specific, data-driven read. Do NOT invent numbers, do NOT restate the raw value verbatim - interpret it. If a metric is 0, say so plainly and neutrally.

Respond with ONLY valid JSON, no prose outside it:
{
  "narrative": "1-2 sentence overall summary of the org's financial momentum this quarter",
  "cards": {
    "collected_revenue": "<=12 word insight",
    "invoiced_revenue": "<=12 word insight",
    "outstanding_balance": "<=12 word insight",
    "won_deal_value": "<=12 word insight",
    "pipeline_created": "<=12 word insight",
    "won_revenue": "<=12 word insight"
  }
}`;
          const userPrompt = `KPIs:\n${JSON.stringify(metricsForAI, null, 2)}`;
          const savedKey = llmProvider?.api_key_encrypted ? await openSecret(llmProvider.api_key_encrypted) : null;
          const raw = await callWithKeyFallback([platformKey, savedKey], (k) => callAnthropic(k, systemPrompt, userPrompt));
          const jsonStart = raw.indexOf("{");
          const jsonEnd = raw.lastIndexOf("}");
          const parsed = JSON.parse(raw.slice(jsonStart, jsonEnd + 1)) as {
            narrative?: string;
            cards?: Record<string, string>;
          };
          narrative = parsed.narrative || "";
          cardInsights = parsed.cards || {};

          // Cache the generated insight text (numbers stay live).
          const { error: upsertErr } = await supabase
            .from("dashboard_ai_insights")
            .upsert(
              {
                org_id: orgId,
                scope: "org",
                insight: { narrative, cards: cardInsights },
                generated_at: now.toISOString(),
              },
              { onConflict: "org_id,scope" },
            );
          if (upsertErr) console.error("Failed to cache insight:", upsertErr.message);
          generatedAt = now.toISOString();
        } catch (e) {
          console.error("Insight generation failed:", e instanceof Error ? e.message : e);
          // Fall back to stale cache if present, else neutral message.
          if (cached?.insight) {
            const ins = cached.insight as { narrative?: string; cards?: Record<string, string> };
            narrative = ins.narrative || "";
            cardInsights = ins.cards || {};
          } else {
            narrative = "AI insight unavailable right now. Metrics below are live.";
          }
        }
      } else {
        // No AI provider configured - cards still render with real numbers.
        narrative = "Connect an AI provider in Settings to get narrative insights. Metrics below are live.";
      }
    }

    // Attach insight text to each card
    for (const c of cards) {
      c.insight = cardInsights[c.card_id] || "";
    }

    return jsonResponse({
      success: true,
      cards,
      narrative,
      generated_at: generatedAt,
      window: { current: { start: cs, end: ce }, previous: { start: ps, end: pe } },
    });
  } catch (error) {
    if (error instanceof AuthError) {
      return errorResponse(error.code, error.message, 401);
    }
    console.error("dashboard-insights error:", error);
    return errorResponse(
      "INTERNAL_ERROR",
      error instanceof Error ? error.message : "Internal server error",
      500,
    );
  }
});
