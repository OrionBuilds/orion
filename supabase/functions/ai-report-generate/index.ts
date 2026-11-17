import { meteredFetch } from "../_shared/ai-usage.ts";
import { builtinAiName, builtinAiMeter, withBuiltinAi } from "../_shared/clara/builtin-ai.ts";
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { getSupabaseClient, extractUserContext, requireAuth } from "../_shared/auth.ts";
import { handleCors, jsonResponse, errorResponse } from "../_shared/cors.ts";
import {
  CLARA_MODEL_HEAVY,
  buildAnthropicHeaders,
  type AnthropicResponse,
} from "../_shared/claraConfig.ts";
import {
  REPORT_DATA_SOURCES,
  assertReportSqlAllowed,
} from "../_shared/report-sources.ts";

interface RequestPayload {
  prompt: string;
  scope: "my" | "team" | "org";
  timeframe: {
    type: "preset" | "custom";
    preset?: string;
    customStart?: string;
    customEnd?: string;
  };
  parent_report_id?: string;
}

function getTimeRangeDates(timeframe: RequestPayload["timeframe"]): { start: string; end: string } {
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());

  if (timeframe.type === "custom" && timeframe.customStart && timeframe.customEnd) {
    return { start: timeframe.customStart, end: timeframe.customEnd };
  }

  let start: Date;
  let end: Date = now;

  switch (timeframe.preset) {
    case "today": start = today; break;
    case "yesterday": start = new Date(today.getTime() - 86400000); end = today; break;
    case "last_7_days": start = new Date(today.getTime() - 7 * 86400000); break;
    case "last_30_days": start = new Date(today.getTime() - 30 * 86400000); break;
    case "last_90_days": start = new Date(today.getTime() - 90 * 86400000); break;
    case "this_month": start = new Date(now.getFullYear(), now.getMonth(), 1); break;
    case "last_month":
      start = new Date(now.getFullYear(), now.getMonth() - 1, 1);
      end = new Date(now.getFullYear(), now.getMonth(), 1);
      break;
    case "this_quarter": {
      const q = Math.floor(now.getMonth() / 3);
      start = new Date(now.getFullYear(), q * 3, 1);
      break;
    }
    case "last_quarter": {
      const lq = Math.floor(now.getMonth() / 3) - 1;
      const yr = lq < 0 ? now.getFullYear() - 1 : now.getFullYear();
      const qq = lq < 0 ? 3 : lq;
      start = new Date(yr, qq * 3, 1);
      end = new Date(yr, qq * 3 + 3, 1);
      break;
    }
    case "this_year": start = new Date(now.getFullYear(), 0, 1); break;
    case "last_year":
      start = new Date(now.getFullYear() - 1, 0, 1);
      end = new Date(now.getFullYear(), 0, 1);
      break;
    default: start = new Date(today.getTime() - 30 * 86400000);
  }

  return { start: start.toISOString(), end: end.toISOString() };
}

function sanitizeSQL(sql: string): string {
  const forbidden = [
    /\bINSERT\b/i, /\bUPDATE\b/i, /\bDELETE\b/i, /\bDROP\b/i,
    /\bCREATE\b/i, /\bALTER\b/i, /\bTRUNCATE\b/i, /\bEXEC\b/i,
    /\bEXECUTE\b/i, /--/, /;.*SELECT/i,
  ];
  for (const pattern of forbidden) {
    if (pattern.test(sql)) throw new Error("Unsafe SQL detected");
  }
  if (!sql.trim().toUpperCase().startsWith("SELECT")) {
    throw new Error("Only SELECT queries allowed");
  }
  // Reads are limited to the report data sources (no auth/vault/pg_* or unlisted tables).
  assertReportSqlAllowed(sql);
  return sql;
}

function buildScopeRule(scope: string): string {
  if (scope === "my") {
    const perTable = REPORT_DATA_SOURCES
      .filter((ds) => ds.userColumn || ds.userNote)
      .map((ds) => ds.userColumn ? `${ds.table}.${ds.userColumn} = '{{USER_ID}}'` : `${ds.table}: ${ds.userNote}`)
      .join("; ");
    return `My Data scope: filter each table to the current user with ${perTable}. Tables with no per-user column (lookups, agent runs, invoices) stay org-wide.`;
  }
  if (scope === "team") {
    return "Team scope: add department_id = '{{DEPARTMENT_ID}}' on tables that have a department_id column (contacts, opportunities, projects, conversations); other tables stay org-wide.";
  }
  return "Organization scope: show organization-wide data (still scoped to the org).";
}

function buildPlanSystemPrompt(scope: string, timeRangeDates: { start: string; end: string }): string {
  const schemas = REPORT_DATA_SOURCES.map(
    (ds) => {
      const orgScope = ds.orgColumn
        ? `WHERE public.${ds.table}.${ds.orgColumn} = '{{ORG_ID}}'`
        : ds.orgNote || "no org column";
      return `${ds.name} (table: public.${ds.table}): ${ds.description}\n  Org scope: ${orgScope}\n  Fields: ${ds.fields.join(", ")}`;
    }
  ).join("\n\n");

  return `You are an expert data analytics AI for the operating system of an engineering services company (software/engineering delivery for clients, sales pipeline, proposals and contracts, client meetings, AI agents).
Your job is to create a report plan and then compose a full report from data.

STEP 1: You will first output a report_plan JSON object.

Available data sources (these are the ONLY tables you may query - any other table is rejected):
${schemas}

IMPORTANT RULES:
0. CRITICAL: Every table MUST be schema-qualified as public.<table> (e.g. public.projects, public.contacts, public.opportunities). The query runs with an empty search_path, so an unqualified table name like "projects" will error with "relation does not exist". Never reference any other schema or any pg_* function.
1. Generate ONLY aggregate/summary SQL queries - never raw row dumps
2. Scope EVERY query (and every joined table) to the organization using the exact "Org scope" clause listed for each table above. Most tables use org_id = '{{ORG_ID}}'; contacts, users, conversations, messages and form_submissions use organization_id = '{{ORG_ID}}'; contact_tasks has NO org column and must be scoped by joining contacts. Never apply organization_id to a table whose Org scope says org_id (and vice versa) - using the wrong column will error.
3. ${buildScopeRule(scope)}
4. Apply time filter: created_at >= '${timeRangeDates.start}' AND created_at < '${timeRangeDates.end}' (use the primary date field for each table; for paid revenue use paid_at, for received payments use received_at, for closed deals use closed_at, for meetings use meeting_date, for agent runs use scheduled_for, for signed proposals/contracts use signed_at, for sent proposals use sent_at). Point-in-time snapshots (current pipeline value by stage, open tasks, active project status) describe the present: filter them by status, not by created_at.
4b. Labels: never use a uuid as a chart label or table dimension. JOIN public.users for people, public.pipeline_stages / public.project_stages for stage names, public.pipelines / public.project_pipelines for board names, public.agent_task_schedules for agent job titles, and public.contacts for client names.
5. Use COUNT, SUM, AVG, MIN, MAX aggregations
6. GROUP BY for dimensional breakdowns
7. Limit to top 25 groups max
8. NEVER return raw rows - only aggregated summaries, totals, grouped breakdowns, top N
9. Generate multiple queries if data from multiple tables is needed
10. Choose appropriate chart types: line for time series, bar for comparisons, pie for proportions
11. For invoice or payment money totals (revenue, collected, outstanding), ALWAYS write "FROM public.invoices i JOIN public.contacts c ON c.id = i.contact_id WHERE i.org_id = '{{ORG_ID}}'" (or the equivalent for public.payments). The inner JOIN drops externally-synced (QuickBooks) records that aren't linked to a CRM contact, matching the Payments and Dashboard pages. Never SUM invoices/payments without the contacts JOIN.

You MUST output valid JSON in this exact format:
{
  "type": "report_plan",
  "report_name": "descriptive report title",
  "report_category": "sales|marketing|ops|finance|projects|custom",
  "scope": "${scope}",
  "timeframe": { "preset": "...", "start": "${timeRangeDates.start}", "end": "${timeRangeDates.end}" },
  "data_sources": [
    { "module": "table_name", "entities": ["entity"], "fields": ["field1","field2"] }
  ],
  "sql_queries": [
    {
      "id": "unique_query_id",
      "purpose": "what this query computes",
      "sql": "SELECT ... FROM public.<table> WHERE <org scope for that table> ... GROUP BY ... ORDER BY ... LIMIT 25"
    }
  ],
  "charts": [
    { "chart_id": "unique_id", "title": "Chart Title", "type": "line|bar|pie|area", "query_id": "references sql_queries.id", "series": [{"label":"Series Name","metric":"column_name"}], "x": "x_axis_column" }
  ],
  "tables": [
    { "table_id": "unique_id", "title": "Table Title", "query_id": "references sql_queries.id", "columns": ["col1","col2"] }
  ],
  "kpi_queries": [
    { "id": "kpi_id", "label": "KPI Label", "sql": "SELECT COUNT(*) as value FROM ...", "format": "number|currency|percentage" }
  ]
}

You MUST respond with valid JSON only. Do not include any text outside the JSON object.`;
}

function buildComposeSystemPrompt(): string {
  return `You are an expert business analyst composing a professional report from computed data.

Given the aggregated data results, compose a comprehensive report. You MUST output valid JSON:

{
  "type": "report_compose",
  "title": "Report Title",
  "executive_summary": "2-4 paragraph narrative summarizing findings, trends, and performance. Write in professional business language.",
  "kpis": [
    { "label": "Metric Name", "value": 12345, "delta_pct": 0.15, "trend": "up|down|flat", "format": "number|currency|percentage" }
  ],
  "charts": [
    {
      "chart_id": "unique_id",
      "title": "Chart Title",
      "type": "line|bar|pie|area",
      "config": {},
      "data": [{"x_label": "value1", "series_name": 123}, ...]
    }
  ],
  "tables": [
    {
      "table_id": "unique_id",
      "title": "Table Title",
      "columns": [{"key": "col_key", "label": "Column Label", "format": "number|currency|percentage|text"}],
      "rows": [{"col_key": "value"}, ...]
    }
  ],
  "insights": ["Insight 1", "Insight 2", "Insight 3"],
  "recommendations": ["Action item 1", "Action item 2"],
  "dashboard_cards": [
    { "card_id": "unique", "title": "Card Title", "value": 123, "trend": "up|down|flat", "delta_pct": 0.1, "category": "sales" }
  ]
}

RULES:
1. KPIs should be 4-6 key metrics with delta percentages where meaningful
2. Charts MUST have properly formatted data arrays matching the type
3. Tables should be summary tables (not raw data dumps)
4. Insights should be specific, data-driven observations
5. Recommendations should be actionable business advice
6. Dashboard cards should be 2-4 key metrics suitable for a dashboard widget
7. All numeric values should be actual numbers, not strings
8. Format currency values as plain numbers (formatting happens on frontend)

You MUST respond with valid JSON only. Do not include any text outside the JSON object.`;
}

/**
 * Loose JSON-schema shapes for the two report stages. These constrain the response to
 * valid JSON at the API level (structured outputs), which removes the whole class of
 * "model emitted prose / fences / truncated JSON" parse failures this function used to
 * hit. Kept permissive (additionalProperties allowed, few required keys) so the model
 * still has room to shape the report — the detailed field contract lives in the system
 * prompt, the schema just guarantees parseability.
 */
const PLAN_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    type: { type: "string" },
    report_name: { type: "string" },
    report_category: { type: "string" },
    scope: { type: "string" },
    timeframe: { type: "object" },
    data_sources: { type: "array", items: { type: "object" } },
    sql_queries: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "string" },
          purpose: { type: "string" },
          sql: { type: "string" },
        },
        required: ["id", "sql"],
      },
    },
    charts: { type: "array", items: { type: "object" } },
    tables: { type: "array", items: { type: "object" } },
    kpi_queries: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "string" },
          label: { type: "string" },
          sql: { type: "string" },
          format: { type: "string" },
        },
        required: ["id", "sql"],
      },
    },
  },
  required: ["report_name", "sql_queries"],
};

const COMPOSE_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    type: { type: "string" },
    title: { type: "string" },
    executive_summary: { type: "string" },
    kpis: { type: "array", items: { type: "object" } },
    charts: { type: "array", items: { type: "object" } },
    tables: { type: "array", items: { type: "object" } },
    insights: { type: "array", items: { type: "string" } },
    recommendations: { type: "array", items: { type: "string" } },
    dashboard_cards: { type: "array", items: { type: "object" } },
  },
  required: ["title", "executive_summary"],
};

async function callAnthropic(
  apiKey: string,
  systemPrompt: string,
  userPrompt: string,
  schema?: Record<string, unknown>,
  schemaName?: string,
  maxTokens = 32000,
  aiName: string | null = null,
  orgId?: string
): Promise<{ content: string; tokensUsed: number; stopReason: string | null }> {
  const body: Record<string, unknown> = {
    model: CLARA_MODEL_HEAVY,
    system: withBuiltinAi(aiName, systemPrompt),
    messages: [{ role: "user", content: userPrompt }],
    // Sized per call: a plan is a small structured object, a composed report can be long.
    // 16k was once tight enough that long compositions hit stop_reason=max_tokens and
    // truncated mid-JSON, so the compose budget stays generous.
    max_tokens: maxTokens,
  };

  if (schema) {
    // Force a tool call so the model returns a parsed object instead of free-form text.
    // This is what removes the "model emitted prose/fences/truncated JSON" parse failures
    // — the previous approach (assistant prefill + JSON.parse of raw text) was brittle.
    const toolName = schemaName || "result";
    body.tools = [{
      name: toolName,
      description: "Return the structured result.",
      input_schema: schema,
    }];
    body.tool_choice = { type: "tool", name: toolName };
  }

  const response = await meteredFetch(builtinAiMeter(aiName, "ai-report-generate", orgId))("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: buildAnthropicHeaders(apiKey),
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Anthropic API error ${response.status}: ${errText}`);
  }

  const data = await response.json() as AnthropicResponse;
  const tokensUsed = (data.usage?.input_tokens || 0) + (data.usage?.output_tokens || 0);

  // With a forced tool call the payload arrives already-parsed in the tool_use block;
  // re-serialize so the caller's parseModelJson stays a no-op passthrough.
  const toolBlock = data.content.find((b: { type: string }) => b.type === "tool_use");
  if (toolBlock?.input) {
    return {
      content: JSON.stringify(toolBlock.input),
      tokensUsed,
      stopReason: data.stop_reason ?? null,
    };
  }

  const text = data.content.find((b: { type: string }) => b.type === "text")?.text || "";
  return {
    content: text,
    tokensUsed,
    stopReason: data.stop_reason ?? null,
  };
}

/** Parse a JSON object out of a model response, tolerating code fences and
 *  prose around it. Throws if no valid JSON object can be parsed. */
function parseModelJson(raw: string): Record<string, unknown> {
  let t = (raw || "").trim();
  if (t.startsWith("```")) {
    t = t.replace(/^```[a-zA-Z]*\s*/, "").replace(/\s*```$/, "").trim();
  }
  const first = t.indexOf("{");
  const last = t.lastIndexOf("}");
  if (first !== -1 && last !== -1 && last > first) {
    t = t.slice(first, last + 1);
  }
  return JSON.parse(t) as Record<string, unknown>;
}

function generateRenderedHTML(compose: Record<string, unknown>, reportName: string, timeStart: string, timeEnd: string): string {
  const kpis = (compose.kpis as Array<Record<string, unknown>>) || [];
  const tables = (compose.tables as Array<Record<string, unknown>>) || [];
  const insights = (compose.insights as string[]) || [];
  const recommendations = (compose.recommendations as string[]) || [];
  const summary = (compose.executive_summary as string) || "";

  const formatVal = (v: unknown, fmt?: string) => {
    if (typeof v === "number") {
      if (fmt === "currency") return `$${v.toLocaleString("en-US", { minimumFractionDigits: 2 })}`;
      if (fmt === "percentage") return `${(v * 100).toFixed(1)}%`;
      return v.toLocaleString("en-US");
    }
    return String(v ?? "");
  };

  const kpiHTML = kpis.map((k) => `
    <div style="background:#1e293b;border:1px solid #334155;border-radius:8px;padding:16px;text-align:center;">
      <div style="color:#94a3b8;font-size:12px;margin-bottom:4px;">${k.label}</div>
      <div style="color:#f1f5f9;font-size:24px;font-weight:700;">${formatVal(k.value, k.format as string)}</div>
      ${k.delta_pct != null ? `<div style="color:${(k.delta_pct as number) >= 0 ? "#10b981" : "#ef4444"};font-size:12px;">${(k.delta_pct as number) >= 0 ? "+" : ""}${((k.delta_pct as number) * 100).toFixed(1)}%</div>` : ""}
    </div>`).join("");

  const tablesHTML = tables.map((t) => {
    const cols = (t.columns as Array<Record<string, string>>) || [];
    const rows = (t.rows as Array<Record<string, unknown>>) || [];
    const headerRow = cols.map((c) => `<th style="padding:8px 12px;text-align:left;border-bottom:1px solid #334155;color:#94a3b8;font-size:12px;">${c.label}</th>`).join("");
    const bodyRows = rows.slice(0, 25).map((r) =>
      `<tr>${cols.map((c) => `<td style="padding:8px 12px;border-bottom:1px solid #1e293b;color:#e2e8f0;font-size:13px;">${formatVal(r[c.key], c.format)}</td>`).join("")}</tr>`
    ).join("");
    return `<div style="margin-bottom:24px;">
      <h3 style="color:#f1f5f9;font-size:16px;margin-bottom:8px;">${t.title}</h3>
      <table style="width:100%;border-collapse:collapse;background:#0f172a;border-radius:8px;overflow:hidden;">
        <thead><tr>${headerRow}</tr></thead>
        <tbody>${bodyRows}</tbody>
      </table>
    </div>`;
  }).join("");

  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${reportName}</title>
<style>body{background:#0f172a;color:#e2e8f0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;margin:0;padding:32px;}
@media print{body{background:#fff;color:#1e293b;}}</style></head><body>
<h1 style="color:#f1f5f9;font-size:24px;margin-bottom:4px;">${reportName}</h1>
<p style="color:#64748b;font-size:13px;margin-bottom:24px;">${new Date(timeStart).toLocaleDateString()} - ${new Date(timeEnd).toLocaleDateString()}</p>
<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:12px;margin-bottom:32px;">${kpiHTML}</div>
<div style="margin-bottom:32px;"><h2 style="color:#f1f5f9;font-size:18px;margin-bottom:12px;">Executive Summary</h2>
<div style="color:#cbd5e1;font-size:14px;line-height:1.6;white-space:pre-wrap;">${summary}</div></div>
${tablesHTML}
${insights.length > 0 ? `<div style="margin-bottom:24px;"><h2 style="color:#f1f5f9;font-size:18px;margin-bottom:12px;">Key Insights</h2>
<ul style="color:#cbd5e1;font-size:14px;line-height:1.8;">${insights.map((i) => `<li>${i}</li>`).join("")}</ul></div>` : ""}
${recommendations.length > 0 ? `<div style="margin-bottom:24px;"><h2 style="color:#f1f5f9;font-size:18px;margin-bottom:12px;">Recommendations</h2>
<ul style="color:#cbd5e1;font-size:14px;line-height:1.8;">${recommendations.map((r) => `<li>${r}</li>`).join("")}</ul></div>` : ""}
<p style="color:#475569;font-size:11px;margin-top:32px;">Generated on ${new Date().toLocaleString()}</p>
</body></html>`;
}

function generateCSVData(compose: Record<string, unknown>): string {
  const tables = (compose.tables as Array<Record<string, unknown>>) || [];
  if (tables.length === 0) return "";

  const sections: string[] = [];
  for (const t of tables) {
    const cols = (t.columns as Array<Record<string, string>>) || [];
    const rows = (t.rows as Array<Record<string, unknown>>) || [];
    const header = cols.map((c) => `"${(c.label || c.key).replace(/"/g, '""')}"`).join(",");
    const body = rows.map((r) =>
      cols.map((c) => {
        const val = r[c.key];
        if (val == null) return "";
        const str = String(val);
        return str.includes(",") || str.includes('"') || str.includes("\n")
          ? `"${str.replace(/"/g, '""')}"`
          : str;
      }).join(",")
    ).join("\n");
    sections.push(`${t.title}\n${header}\n${body}`);
  }

  const kpis = (compose.kpis as Array<Record<string, unknown>>) || [];
  if (kpis.length > 0) {
    const kpiHeader = '"Metric","Value","Change %"';
    const kpiRows = kpis.map((k) =>
      `"${k.label}",${k.value},${k.delta_pct != null ? ((k.delta_pct as number) * 100).toFixed(1) + "%" : ""}`
    ).join("\n");
    sections.unshift(`Key Metrics\n${kpiHeader}\n${kpiRows}`);
  }

  return sections.join("\n\n");
}

/** How many earlier turns of a report thread are replayed into a follow-up's plan prompt. */
const THREAD_CONTEXT_DEPTH = 5;

/**
 * Context for a follow-up ("break that down by month", "only enterprise clients"): the
 * thread's earlier turns oldest-first, plus the previous turn's SQL so a refinement can edit
 * the queries that produced the answer instead of re-deriving them. The old single-parent
 * context only carried the last summary, so a second refinement lost the first one.
 */
async function buildThreadContext(
  supabase: ReturnType<typeof getSupabaseClient>,
  parentId: string,
  orgId: string,
): Promise<string> {
  type ThreadRow = {
    id: string;
    parent_report_id: string | null;
    report_name: string;
    prompt: string;
    status: string;
    result_json: Record<string, unknown> | null;
    plan_json: Record<string, unknown> | null;
  };
  const turns: ThreadRow[] = [];
  const seen = new Set<string>();
  let nextId: string | null = parentId;
  while (nextId && turns.length < THREAD_CONTEXT_DEPTH && !seen.has(nextId)) {
    seen.add(nextId);
    const { data } = await supabase
      .from("ai_reports")
      .select("id, parent_report_id, report_name, prompt, status, result_json, plan_json")
      .eq("id", nextId)
      .eq("organization_id", orgId)
      .maybeSingle();
    if (!data) break;
    const row = data as ThreadRow;
    turns.unshift(row);
    nextId = row.parent_report_id;
  }
  if (turns.length === 0) return "";

  const history = turns.map((t, i) => {
    const summary = ((t.result_json?.executive_summary as string) || "").slice(0, 700);
    const insights = ((t.result_json?.insights as string[]) || []).slice(0, 5);
    return `Turn ${i + 1}: user asked "${t.prompt}"\n  Report: ${t.report_name} (${t.status})` +
      (summary ? `\n  Summary: ${summary}` : "") +
      (insights.length ? `\n  Insights: ${JSON.stringify(insights)}` : "");
  }).join("\n");

  const last = turns[turns.length - 1];
  const lastQueries = [
    ...((last.plan_json?.sql_queries as Array<Record<string, string>>) || []),
    ...((last.plan_json?.kpi_queries as Array<Record<string, string>>) || []),
  ].map((q) => `- ${q.id}${q.purpose ? ` (${q.purpose})` : q.label ? ` (${q.label})` : ""}: ${q.sql}`)
    .join("\n")
    .slice(0, 6000);

  return `\n\nCONVERSATION SO FAR (this request is a follow-up in a report thread):\n${history}` +
    (lastQueries ? `\n\nQueries behind the previous turn (still contain the {{ORG_ID}}-style placeholders):\n${lastQueries}` : "") +
    `\n\nTreat the new request as a refinement of the latest turn: keep its subject, filters and scope unless the user changes them, and apply the new instruction (e.g. a monthly breakdown, a client filter, a different grouping) on top. If the user names a client or company, filter with contacts.company ILIKE '%name%'.`;
}

Deno.serve(async (req: Request) => {
  const corsResp = handleCors(req);
  if (corsResp) return corsResp;

  // Hoisted so the outer catch can mark the report failed. Without this, any error thrown
  // after the row is inserted (an Anthropic API error, a query blow-up) left the report
  // stuck at status='running' forever with no error surfaced to the user.
  let activeReportId: string | null = null;
  let activeSupabase: ReturnType<typeof getSupabaseClient> | null = null;

  try {
    const supabase = getSupabaseClient();
    activeSupabase = supabase;
    const userContext = await extractUserContext(req, supabase);
    const user = requireAuth(userContext);

    const payload: RequestPayload = await req.json();
    const { prompt, scope, timeframe, parent_report_id } = payload;

    if (!prompt || !scope) {
      return errorResponse("MISSING_FIELDS", "Missing required fields: prompt, scope");
    }

    if (!["my", "team", "org"].includes(scope)) {
      return errorResponse("INVALID_SCOPE", "scope must be one of: my, team, org");
    }
    // The seeded role is "SuperAdmin" (no space); "Super Admin" is kept for older rows. Only
    // checking "Super Admin" used to 403 the owner's Organization-wide reports.
    const isAdmin = user.isSuperAdmin || ["SuperAdmin", "Super Admin", "Admin"].includes(user.roleName);
    if (scope === "org" && !isAdmin) {
      return errorResponse("FORBIDDEN", "Organization-wide reports require Admin role", 403);
    }
    if (scope === "team" && !isAdmin && user.roleName !== "Manager") {
      return errorResponse("FORBIDDEN", "Team reports require Manager role", 403);
    }
    if (scope === "team" && !user.departmentId) {
      // department_id = '' would make every team query fail its uuid cast and come back empty.
      return errorResponse("NO_DEPARTMENT", "Team reports need you to belong to a department");
    }

    const timeRangeDates = getTimeRangeDates(timeframe);

    // Sweep this org's stranded reports before starting a new one. A report can only be
    // legitimately 'running' for a few minutes; anything older lost its isolate (wall-clock
    // kill / OOM) and will never resolve itself. Mirrors how meet-processing-cron retires
    // unrecoverable rows at the top of each run — no extra cron needed, and it fires exactly
    // when a user would otherwise be looking at the stale row.
    // This also sweeps the orphan rows ai-report-schedule-runner leaves behind: it inserts
    // its own ai_reports row and then calls this function, which inserts a second one, so
    // the runner's row was never completed by anything.
    try {
      const staleCutoff = new Date(Date.now() - 15 * 60 * 1000).toISOString();
      await supabase
        .from("ai_reports")
        .update({
          status: "failed",
          error_message: "Generation timed out — the report took too long and was stopped",
        })
        .eq("organization_id", user.orgId)
        .eq("status", "running")
        .lt("created_at", staleCutoff);
    } catch (e) {
      console.error("[ai-report-generate] stale-report sweep failed:", e);
    }

    // A follow-up must continue a report from the caller's own org. This runs with the
    // service role, so without the check any report id would leak its summary into the thread.
    if (parent_report_id) {
      const { data: parentRow } = await supabase
        .from("ai_reports")
        .select("id")
        .eq("id", parent_report_id)
        .eq("organization_id", user.orgId)
        .maybeSingle();
      if (!parentRow) {
        return errorResponse("PARENT_NOT_FOUND", "The report you are following up on was not found", 404);
      }
    }

    const { data: reportRow, error: insertErr } = await supabase
      .from("ai_reports")
      .insert({
        organization_id: user.orgId,
        created_by_user_id: user.id,
        scope,
        report_name: prompt.slice(0, 100),
        prompt,
        status: "running",
        timeframe_start: timeRangeDates.start,
        timeframe_end: timeRangeDates.end,
        parent_report_id: parent_report_id || null,
      })
      .select()
      .single();

    if (insertErr || !reportRow) {
      return errorResponse("DB_ERROR", "Failed to create report record");
    }
    activeReportId = reportRow.id;
    const reportId = reportRow.id as string;

    /**
     * Everything below used to run inline, inside the caller's HTTP request: two Claude
     * calls with a serial SQL loop between them, easily 60s-3min. That exceeded the
     * platform wall clock, and a wall-clock kill destroys the isolate — so the outer
     * catch never ran and the row sat at 'running' forever. Running it as a background
     * task detaches it from the request: the caller gets its report_id immediately and
     * polls (pollReportStatus already exists client-side), and every exit path here
     * writes a terminal status.
     */
    const task = (async () => {
      try {
        // Use the platform Anthropic (Claude) key — the same source every other AI
        // edge function uses (assistant-chat, contract-ai-generate, proposal-ai-generate,
        // etc.). The per-org llm_providers/llm_models tables are not used for report
        // generation; callAnthropic targets CLARA_MODEL_HEAVY.
        const anthropicKey = (Deno.env.get("ANTHROPIC_API_KEY") || "").trim();
        if (!anthropicKey) {
          await supabase.from("ai_reports").update({ status: "failed", error_message: "ANTHROPIC_API_KEY not configured" }).eq("id", reportId);
          return;
        }

        const parentContext = parent_report_id
          ? await buildThreadContext(supabase, parent_report_id, user.orgId)
          : "";

        // Reports are written by the workspace assistant (Clara by default): persona + attribution only.
        const aiName = await builtinAiName(supabase, user.orgId);
        const planSystemPrompt = buildPlanSystemPrompt(scope, timeRangeDates);
        const planUserPrompt = `Generate a report plan for this request: "${prompt}"${parentContext}`;

        const { content: planContent, stopReason: planStop } = await callAnthropic(
          anthropicKey,
          planSystemPrompt,
          planUserPrompt,
          PLAN_SCHEMA,
          "report_plan",
          // A plan is a small structured object (PLAN_SCHEMA); the 32k default was far
          // more headroom than it needs and cost real latency on every report.
          8000,
          aiName,
          user.orgId
        );

        let plan: Record<string, unknown>;
        try {
          plan = parseModelJson(planContent);
        } catch (e) {
          console.error("[ai-report-generate] plan parse failed. stop_reason:", planStop, "raw:", planContent.slice(0, 1000));
          const detail = planStop === "max_tokens" ? "response truncated (max_tokens)" : (e instanceof Error ? e.message : "invalid JSON");
          await supabase.from("ai_reports").update({ status: "failed", error_message: `Failed to parse AI plan response: ${detail}` }).eq("id", reportId);
          return;
        }

        const sqlQueries = (plan.sql_queries as Array<Record<string, string>>) || [];
        const kpiQueries = (plan.kpi_queries as Array<Record<string, string>>) || [];

        const queryResults: Record<string, unknown[]> = {};

        // Independent read-only aggregates — run them concurrently rather than serially.
        // Each keeps its own guard so one bad query still yields [] for that id instead
        // of failing the whole report.
        await Promise.all([...sqlQueries, ...kpiQueries].map(async (q) => {
          try {
            let sql = sanitizeSQL(q.sql);
            sql = sql
              .replace(/\{\{ORG_ID\}\}/g, user.orgId)
              .replace(/\{\{USER_ID\}\}/g, user.id)
              .replace(/\{\{DEPARTMENT_ID\}\}/g, user.departmentId || "")
              .replace(/\{\{TIME_RANGE_START\}\}/g, timeRangeDates.start)
              .replace(/\{\{TIME_RANGE_END\}\}/g, timeRangeDates.end);

            const { data: results, error: qErr } = await supabase.rpc("exec_report_query", { query_text: sql });
            if (qErr) {
              console.error(`Query ${q.id} failed:`, qErr.message);
              queryResults[q.id] = [];
            } else {
              queryResults[q.id] = results || [];
            }
          } catch (e) {
            console.error(`Query ${q.id} error:`, e);
            queryResults[q.id] = [];
          }
        }));

        const dataSources = (plan.data_sources as Array<Record<string, unknown>> || []).map((d) => d.module as string);
        const category = (plan.report_category as string) || "custom";
        const reportName = (plan.report_name as string) || prompt.slice(0, 100);

        await supabase.from("ai_reports").update({
          plan_json: plan,
          report_name: reportName,
          report_category: category,
          data_sources_used: dataSources,
        }).eq("id", reportId);

        const composeSystemPrompt = buildComposeSystemPrompt();
        const composeUserPrompt = `Compose a full report from this data.

Report Plan: ${JSON.stringify({ name: reportName, category, scope, timeframe: { start: timeRangeDates.start, end: timeRangeDates.end } })}

Chart definitions from plan: ${JSON.stringify(plan.charts || [])}
Table definitions from plan: ${JSON.stringify(plan.tables || [])}
KPI definitions from plan: ${JSON.stringify(plan.kpi_queries || [])}

Query results:
${Object.entries(queryResults).map(([id, rows]) => `\n--- ${id} (${(rows as unknown[]).length} rows) ---\n${JSON.stringify((rows as unknown[]).slice(0, 50), null, 2)}`).join("\n")}

Compose the full report with all sections. Make sure chart data arrays match the chart type and contain actual data points from the results.`;

        const { content: composeContent, stopReason: composeStop } = await callAnthropic(
          anthropicKey,
          composeSystemPrompt,
          composeUserPrompt,
          COMPOSE_SCHEMA,
          "report_compose",
          undefined,
          aiName,
          user.orgId
        );

        let compose: Record<string, unknown>;
        try {
          compose = parseModelJson(composeContent);
        } catch (e) {
          console.error("[ai-report-generate] compose parse failed. stop_reason:", composeStop, "raw:", composeContent.slice(0, 1000));
          const detail = composeStop === "max_tokens" ? "response truncated (max_tokens)" : (e instanceof Error ? e.message : "invalid JSON");
          await supabase.from("ai_reports").update({ status: "failed", error_message: `Failed to parse AI compose response: ${detail}` }).eq("id", reportId);
          return;
        }

        const renderedHTML = generateRenderedHTML(compose, reportName, timeRangeDates.start, timeRangeDates.end);
        const csvData = generateCSVData(compose);

        const versionSuffix = parent_report_id ? " v2" : "";

        const { error: updateErr } = await supabase.from("ai_reports").update({
          report_name: (compose.title as string) || reportName + versionSuffix,
          status: "complete",
          result_json: compose,
          rendered_html: renderedHTML,
          csv_data: csvData,
          data_sources_used: dataSources,
          updated_at: new Date().toISOString(),
        }).eq("id", reportId);

        if (updateErr) {
          console.error("Failed to update report:", updateErr);
        }
      } catch (error) {
        console.error("[ai-report-generate] background generation failed:", error);
        try {
          await supabase.from("ai_reports").update({
            status: "failed",
            error_message: error instanceof Error ? error.message : "Report generation failed",
          }).eq("id", reportId);
        } catch {
          // best-effort: the logged error is what matters
        }
      }
    })();

    // Keep the isolate alive for the generation after the response is sent. Falls back to
    // awaiting inline where EdgeRuntime isn't present (local dev), matching the idiom in
    // twilio-sms-inbound.
    const rt = (globalThis as { EdgeRuntime?: { waitUntil?: (p: Promise<unknown>) => void } }).EdgeRuntime;
    if (rt?.waitUntil) rt.waitUntil(task);
    else await task;

    // Returns as soon as the row exists. Callers poll ai_reports for the terminal status —
    // no consumer reads a finished report off this response.
    return jsonResponse({
      success: true,
      report_id: reportId,
      status: "running",
    });

  } catch (error) {
    console.error("AI report generate error:", error);

    // Never leave a report stranded at 'running' — the UI has no way to distinguish
    // "still working" from "died", and the row would spin forever.
    if (activeReportId && activeSupabase) {
      try {
        await activeSupabase
          .from("ai_reports")
          .update({
            status: "failed",
            error_message: error instanceof Error ? error.message : "Internal server error",
          })
          .eq("id", activeReportId);
      } catch {
        // best-effort: the original error is what matters
      }
    }

    return errorResponse(
      "INTERNAL_ERROR",
      error instanceof Error ? error.message : "Internal server error",
      500
    );
  }
});
