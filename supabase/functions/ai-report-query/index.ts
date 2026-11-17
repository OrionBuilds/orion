import { meteredFetch } from "../_shared/ai-usage.ts";
import { builtinAiName, builtinAiMeter, withBuiltinAi } from "../_shared/clara/builtin-ai.ts";
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";
import { openSecret } from "../_shared/secrets.ts";
import {
  CLARA_MODEL_HEAVY,
  buildAnthropicHeaders,
  type AnthropicResponse,
} from "../_shared/claraConfig.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};

interface RequestPayload {
  /** Honored for service-role (edge-to-edge) callers only; derived from the JWT otherwise. */
  organization_id?: string;
  user_id?: string;
  query_text: string;
  data_scope: "my_data" | "department" | "organization";
  time_range: {
    type: "preset" | "custom";
    preset?: string;
    customStart?: string;
    customEnd?: string;
  };
}

/** Constant-time comparison, so a mismatch leaks neither length nor prefix. */
function isServiceRoleToken(token: string, serviceRoleKey: string): boolean {
  if (!token || !serviceRoleKey || token.length !== serviceRoleKey.length) return false;
  const encoder = new TextEncoder();
  const a = encoder.encode(token);
  const b = encoder.encode(serviceRoleKey);
  let result = 0;
  for (let i = 0; i < a.length; i++) result |= a[i] ^ b[i];
  return result === 0;
}

interface DataSourceSchema {
  name: string;
  table: string;
  description: string;
  fields: Array<{
    name: string;
    type: string;
    description: string;
  }>;
}

interface LLMQueryPlan {
  data_sources: string[];
  sql_query: string;
  explanation: string;
  chart_type?: "table" | "bar" | "line" | "pie";
}

const DATA_SOURCE_SCHEMAS: DataSourceSchema[] = [
  {
    name: "contacts",
    table: "contacts",
    description: "Customer and lead contact records",
    fields: [
      { name: "id", type: "uuid", description: "Unique identifier" },
      { name: "first_name", type: "text", description: "First name" },
      { name: "last_name", type: "text", description: "Last name" },
      { name: "email", type: "text", description: "Email address" },
      { name: "phone", type: "text", description: "Phone number" },
      { name: "company", type: "text", description: "Company name" },
      { name: "status", type: "text", description: "Contact status (active, inactive, archived)" },
      { name: "source", type: "text", description: "Lead source" },
      { name: "owner_id", type: "uuid", description: "Assigned owner user ID" },
      { name: "department_id", type: "uuid", description: "Department ID" },
      { name: "created_at", type: "timestamptz", description: "Creation timestamp" },
      { name: "updated_at", type: "timestamptz", description: "Last update timestamp" },
      { name: "lead_score", type: "integer", description: "Lead score (0-100)" },
    ],
  },
  {
    name: "conversations",
    table: "conversations",
    description: "Communication threads with contacts",
    fields: [
      { name: "id", type: "uuid", description: "Unique identifier" },
      { name: "contact_id", type: "uuid", description: "Related contact ID" },
      { name: "status", type: "text", description: "Status (open, closed, pending)" },
      { name: "assigned_user_id", type: "uuid", description: "Assigned agent user ID" },
      { name: "department_id", type: "uuid", description: "Department ID" },
      { name: "unread_count", type: "integer", description: "Number of unread messages" },
      { name: "created_at", type: "timestamptz", description: "Creation timestamp" },
      { name: "last_message_at", type: "timestamptz", description: "Last message timestamp" },
    ],
  },
  {
    name: "appointments",
    table: "appointments",
    description: "Scheduled appointments and meetings",
    fields: [
      { name: "id", type: "uuid", description: "Unique identifier" },
      { name: "contact_id", type: "uuid", description: "Related contact ID" },
      { name: "calendar_id", type: "uuid", description: "Calendar ID" },
      { name: "status", type: "text", description: "Status (scheduled, completed, canceled, no_show)" },
      { name: "source", type: "text", description: "Booking source" },
      { name: "assigned_user_id", type: "uuid", description: "Assigned user ID" },
      { name: "start_at_utc", type: "timestamptz", description: "Start time" },
      { name: "end_at_utc", type: "timestamptz", description: "End time" },
      { name: "created_at", type: "timestamptz", description: "Creation timestamp" },
    ],
  },
  {
    name: "opportunities",
    table: "opportunities",
    description: "Sales opportunities and deals",
    fields: [
      { name: "id", type: "uuid", description: "Unique identifier" },
      { name: "contact_id", type: "uuid", description: "Related contact ID" },
      { name: "pipeline_id", type: "uuid", description: "Pipeline ID" },
      { name: "stage_id", type: "uuid", description: "Current stage ID" },
      { name: "status", type: "text", description: "Status (open, won, lost)" },
      { name: "value_amount", type: "numeric", description: "Deal value" },
      { name: "currency", type: "text", description: "Currency code" },
      { name: "source", type: "text", description: "Lead source" },
      { name: "owner_id", type: "uuid", description: "Owner user ID" },
      { name: "closed_at", type: "timestamptz", description: "Close date" },
      { name: "created_at", type: "timestamptz", description: "Creation timestamp" },
    ],
  },
  {
    name: "invoices",
    table: "invoices",
    description: "Customer invoices and billing",
    fields: [
      { name: "id", type: "uuid", description: "Unique identifier" },
      { name: "contact_id", type: "uuid", description: "Related contact ID" },
      { name: "status", type: "text", description: "Status (draft, sent, paid, overdue, void)" },
      { name: "total_amount", type: "numeric", description: "Total invoice amount" },
      { name: "paid_amount", type: "numeric", description: "Amount paid" },
      { name: "balance_due", type: "numeric", description: "Outstanding balance" },
      { name: "currency", type: "text", description: "Currency code" },
      { name: "due_date", type: "date", description: "Payment due date" },
      { name: "paid_at", type: "timestamptz", description: "Payment date" },
      { name: "created_at", type: "timestamptz", description: "Creation timestamp" },
    ],
  },
  {
    name: "payments",
    table: "payments",
    description: "Payment transactions",
    fields: [
      { name: "id", type: "uuid", description: "Unique identifier" },
      { name: "invoice_id", type: "uuid", description: "Related invoice ID" },
      { name: "amount", type: "numeric", description: "Payment amount" },
      { name: "currency", type: "text", description: "Currency code" },
      { name: "status", type: "text", description: "Status (pending, completed, failed, refunded)" },
      { name: "payment_method", type: "text", description: "Payment method" },
      { name: "payment_date", type: "timestamptz", description: "Payment date" },
      { name: "created_at", type: "timestamptz", description: "Creation timestamp" },
    ],
  },
  {
    name: "tasks",
    table: "contact_tasks",
    description: "Tasks and to-dos related to contacts",
    fields: [
      { name: "id", type: "uuid", description: "Unique identifier" },
      { name: "contact_id", type: "uuid", description: "Related contact ID" },
      { name: "title", type: "text", description: "Task title" },
      { name: "status", type: "text", description: "Status (pending, in_progress, completed)" },
      { name: "priority", type: "text", description: "Priority (low, medium, high, urgent)" },
      { name: "task_type", type: "text", description: "Task type" },
      { name: "assigned_to", type: "uuid", description: "Assigned user ID" },
      { name: "due_date", type: "timestamptz", description: "Due date" },
      { name: "completed_at", type: "timestamptz", description: "Completion date" },
      { name: "created_at", type: "timestamptz", description: "Creation timestamp" },
    ],
  },
  {
    name: "ai_runs",
    table: "ai_agent_runs",
    description: "AI agent execution history",
    fields: [
      { name: "id", type: "uuid", description: "Unique identifier" },
      { name: "agent_id", type: "uuid", description: "AI agent ID" },
      { name: "status", type: "text", description: "Status (running, completed, failed)" },
      { name: "trigger_type", type: "text", description: "How the run was triggered" },
      { name: "triggered_by", type: "uuid", description: "User who triggered" },
      { name: "tokens_used", type: "integer", description: "Tokens consumed" },
      { name: "execution_time_ms", type: "integer", description: "Execution duration in milliseconds" },
      { name: "started_at", type: "timestamptz", description: "Start timestamp" },
      { name: "finished_at", type: "timestamptz", description: "End timestamp" },
    ],
  },
];

function buildSystemPrompt(): string {
  const schemaDescriptions = DATA_SOURCE_SCHEMAS.map((ds) => {
    const fieldsDesc = ds.fields
      .map((f) => `    - ${f.name} (${f.type}): ${f.description}`)
      .join("\n");
    return `${ds.name} (table: ${ds.table}):
  Description: ${ds.description}
  Fields:
${fieldsDesc}`;
  }).join("\n\n");

  return `You are a data analytics assistant that converts natural language questions into SQL queries for a CRM/business management system.

Available data sources and their schemas:

${schemaDescriptions}

IMPORTANT RULES:
1. Generate only SELECT queries - never INSERT, UPDATE, DELETE, or DDL
2. Always include org_id = '{{ORG_ID}}' in WHERE clause
3. For user-scoped queries, add owner_id = '{{USER_ID}}' or assigned_user_id = '{{USER_ID}}'
4. For department-scoped queries, add department_id = '{{DEPARTMENT_ID}}'
5. Apply time range filter using '{{TIME_RANGE_START}}' and '{{TIME_RANGE_END}}' placeholders
6. Use proper aggregations (COUNT, SUM, AVG) for metrics
7. Use GROUP BY for dimensional breakdowns
8. Limit results to 1000 rows maximum
9. Use table aliases for readability
10. Return JSON in exactly this format:

{
  "data_sources": ["table_name1", "table_name2"],
  "sql_query": "SELECT ... FROM ...",
  "explanation": "Brief explanation of what this query does",
  "chart_type": "table" | "bar" | "line" | "pie" (optional, based on data shape)
}

Choose chart_type based on:
- "table" for raw data listings
- "bar" for comparing categories
- "line" for time series data
- "pie" for showing proportions of a whole

You MUST respond with valid JSON only. Do not include any text outside the JSON object.`;
}

function buildUserPrompt(
  queryText: string,
  dataScope: string,
  timeRange: RequestPayload["time_range"]
): string {
  let scopeInstruction = "";
  switch (dataScope) {
    case "my_data":
      scopeInstruction = "Filter to only data owned by or assigned to the current user.";
      break;
    case "department":
      scopeInstruction = "Filter to data within the user's department.";
      break;
    case "organization":
      scopeInstruction = "Show data for the entire organization.";
      break;
  }

  let timeInstruction = "";
  if (timeRange.type === "preset" && timeRange.preset !== "all_time") {
    timeInstruction = `Apply time filter: ${timeRange.preset}`;
  } else if (timeRange.type === "custom") {
    timeInstruction = `Apply custom time range: ${timeRange.customStart} to ${timeRange.customEnd}`;
  }

  return `User question: "${queryText}"

Data scope: ${scopeInstruction}
${timeInstruction ? `Time range: ${timeInstruction}` : ""}

Generate the SQL query to answer this question. Return only valid JSON.`;
}

async function callLLM(
  provider: string,
  apiKey: string,
  model: string,
  systemPrompt: string,
  userPrompt: string,
  aiName: string | null = null,
  orgId?: string
): Promise<{ plan: LLMQueryPlan; tokensUsed: number }> {
  let response: Response;
  let tokensUsed = 0;

  // SQL planning stays persona-free (it must emit a query, not talk); only spend attribution changes.
  response = await meteredFetch(builtinAiMeter(aiName, "ai-report-query", orgId))("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      ...buildAnthropicHeaders(apiKey),
    },
    body: JSON.stringify({
      model: CLARA_MODEL_HEAVY,
      system: systemPrompt,
      messages: [
        { role: "user", content: userPrompt },
      ],
      max_tokens: 4096,
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Anthropic API error: ${response.status} - ${errorText}`);
  }

  const data = await response.json();
  tokensUsed = (data as AnthropicResponse).usage ? ((data as AnthropicResponse).usage!.input_tokens + (data as AnthropicResponse).usage!.output_tokens) : 0;
  const content = (data as AnthropicResponse).content.find((b) => b.type === "text")?.text || "";
  return { plan: JSON.parse(content), tokensUsed };
}

function getTimeRangeDates(
  timeRange: RequestPayload["time_range"]
): { start: string; end: string } {
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  let start: Date;
  let end: Date = now;

  if (timeRange.type === "custom" && timeRange.customStart && timeRange.customEnd) {
    return { start: timeRange.customStart, end: timeRange.customEnd };
  }

  switch (timeRange.preset) {
    case "today":
      start = today;
      break;
    case "yesterday":
      start = new Date(today.getTime() - 86400000);
      end = today;
      break;
    case "last_7_days":
      start = new Date(today.getTime() - 7 * 86400000);
      break;
    case "last_30_days":
      start = new Date(today.getTime() - 30 * 86400000);
      break;
    case "last_90_days":
      start = new Date(today.getTime() - 90 * 86400000);
      break;
    case "this_month":
      start = new Date(now.getFullYear(), now.getMonth(), 1);
      break;
    case "last_month":
      start = new Date(now.getFullYear(), now.getMonth() - 1, 1);
      end = new Date(now.getFullYear(), now.getMonth(), 1);
      break;
    case "this_quarter":
      const quarter = Math.floor(now.getMonth() / 3);
      start = new Date(now.getFullYear(), quarter * 3, 1);
      break;
    case "last_quarter":
      const lastQuarter = Math.floor(now.getMonth() / 3) - 1;
      const year = lastQuarter < 0 ? now.getFullYear() - 1 : now.getFullYear();
      const q = lastQuarter < 0 ? 3 : lastQuarter;
      start = new Date(year, q * 3, 1);
      end = new Date(year, q * 3 + 3, 1);
      break;
    case "this_year":
      start = new Date(now.getFullYear(), 0, 1);
      break;
    case "last_year":
      start = new Date(now.getFullYear() - 1, 0, 1);
      end = new Date(now.getFullYear(), 0, 1);
      break;
    default:
      start = new Date(2020, 0, 1);
  }

  return {
    start: start.toISOString(),
    end: end.toISOString(),
  };
}

function sanitizeSQL(sql: string): string {
  const forbidden = [
    /\bINSERT\b/i,
    /\bUPDATE\b/i,
    /\bDELETE\b/i,
    /\bDROP\b/i,
    /\bCREATE\b/i,
    /\bALTER\b/i,
    /\bTRUNCATE\b/i,
    /\bEXEC\b/i,
    /\bEXECUTE\b/i,
    /--/,
    /;.*SELECT/i,
  ];

  for (const pattern of forbidden) {
    if (pattern.test(sql)) {
      throw new Error("Invalid SQL: potentially dangerous operation detected");
    }
  }

  const trimmed = sql.trim().replace(/;\s*$/, "");

  if (!trimmed.toUpperCase().startsWith("SELECT")) {
    throw new Error("Invalid SQL: only SELECT queries are allowed");
  }

  if (trimmed.includes(";")) {
    throw new Error("Invalid SQL: only a single statement is allowed");
  }

  // exec_report_query runs this text through the service-role client, so RLS does not
  // apply and the keyword denylist above stops writes only. A prompt-injected question
  // could otherwise steer the model onto auth.users, vault.decrypted_secrets or another
  // tenant's rows, so restrict it to the documented tables and require the org filter.
  const allowedTables = new Set(DATA_SOURCE_SCHEMAS.map((ds) => ds.table));
  const referenced = [...trimmed.matchAll(/\b(?:FROM|JOIN)\s+([A-Za-z_][A-Za-z0-9_."]*)/gi)]
    .map((m) => m[1].replace(/"/g, "").toLowerCase());

  for (const table of referenced) {
    if (!allowedTables.has(table)) {
      throw new Error(`Invalid SQL: table "${table}" is not an allowed data source`);
    }
  }

  if (!referenced.length) {
    throw new Error("Invalid SQL: no data source referenced");
  }

  if (!trimmed.includes("{{ORG_ID}}")) {
    throw new Error("Invalid SQL: query must be scoped to the caller's organization");
  }

  return trimmed;
}

function applyPlaceholders(
  sql: string,
  orgId: string,
  userId: string,
  departmentId: string | null,
  timeRangeStart: string,
  timeRangeEnd: string
): string {
  return sql
    .replace(/\{\{ORG_ID\}\}/g, orgId)
    .replace(/\{\{USER_ID\}\}/g, userId)
    .replace(/\{\{DEPARTMENT_ID\}\}/g, departmentId || "")
    .replace(/\{\{TIME_RANGE_START\}\}/g, timeRangeStart)
    .replace(/\{\{TIME_RANGE_END\}\}/g, timeRangeEnd);
}

async function generateAnswerFromResults(
  provider: string,
  apiKey: string,
  model: string,
  queryText: string,
  results: unknown[],
  explanation: string,
  aiName: string | null = null,
  orgId?: string
): Promise<{ answer: string; insights: string[]; tokensUsed: number }> {
  const resultsPreview = JSON.stringify(results.slice(0, 20), null, 2);

  const prompt = `Based on this data query and results, provide a natural language answer.

Original question: "${queryText}"
Query explanation: ${explanation}

Results (first 20 rows):
${resultsPreview}

Total rows returned: ${results.length}

Provide:
1. A clear, concise answer to the question
2. Key insights or patterns noticed in the data (as an array)

Return JSON:
{
  "answer": "Your natural language answer here",
  "insights": ["Insight 1", "Insight 2"]
}`;

  let response: Response;
  let tokensUsed = 0;

  response = await meteredFetch(builtinAiMeter(aiName, "ai-report-query", orgId))("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      ...buildAnthropicHeaders(apiKey),
    },
    body: JSON.stringify({
      system: withBuiltinAi(aiName, "You are a data analytics assistant. Analyze query results and provide natural language answers. You MUST respond with valid JSON only."),
      messages: [{ role: "user", content: prompt }],
      model: CLARA_MODEL_HEAVY,
      max_tokens: 2048,
    }),
  });

  if (!response.ok) {
    return { answer: explanation, insights: [], tokensUsed: 0 };
  }

  const data = await response.json();
  tokensUsed = (data as AnthropicResponse).usage ? ((data as AnthropicResponse).usage!.input_tokens + (data as AnthropicResponse).usage!.output_tokens) : 0;
  const content = (data as AnthropicResponse).content.find((b) => b.type === "text")?.text || "";
  const parsed = JSON.parse(content);
  return { answer: parsed.answer, insights: parsed.insights || [], tokensUsed };
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 200, headers: corsHeaders });
  }

  const startTime = Date.now();

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const authHeader = req.headers.get("Authorization");
    const token = authHeader?.replace("Bearer ", "") || "";
    const isServiceRole = isServiceRoleToken(token, supabaseKey);

    const supabase = createClient(supabaseUrl, supabaseKey);

    // Identity comes from the verified JWT, never from the request body (F-25 pattern).
    // This function runs `exec_report_query` with the service-role key, so RLS does not
    // scope the generated SQL: a body-supplied organization_id/user_id would let any
    // authenticated user read another org's data, and pick an Admin of that org to pass
    // the data_scope permission check below.
    let callerId: string | null = null;

    if (!isServiceRole) {
      if (!authHeader) {
        return new Response(
          JSON.stringify({ error: "Missing authorization header" }),
          { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }
      const anonClient = createClient(supabaseUrl, Deno.env.get("SUPABASE_ANON_KEY")!, {
        auth: { autoRefreshToken: false, persistSession: false },
      });
      const { data: { user: authUser }, error: authError } = await anonClient.auth.getUser(token);
      if (authError || !authUser) {
        return new Response(
          JSON.stringify({ error: "Invalid or expired token" }),
          { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }
      callerId = authUser.id;
    }

    const payload: RequestPayload = await req.json();
    const { query_text, data_scope, time_range } = payload;
    const user_id = callerId ?? payload.user_id;

    if (!user_id || !query_text) {
      return new Response(
        JSON.stringify({ error: "Missing required fields" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const { data: user, error: userError } = await supabase
      .from("users")
      .select("*, role:roles(*)")
      .eq("id", user_id)
      .single();

    if (userError || !user) {
      return new Response(
        JSON.stringify({ error: "User not found" }),
        { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Effective org: the caller's own, honoring the SuperAdmin active-org pivot the same
    // way extractUserContext / get_user_org_id() do. Service-role callers may name one.
    const organization_id = isServiceRole
      ? (payload.organization_id || user.super_admin_active_org_id || user.organization_id)
      : (user.super_admin_active_org_id || user.organization_id);

    if (!organization_id) {
      return new Response(
        JSON.stringify({ error: "No organization for caller" }),
        { status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const userRole = user.role?.name || "";
    if (data_scope === "organization" && !["Super Admin", "SuperAdmin", "Admin"].includes(userRole)) {
      return new Response(
        JSON.stringify({ error: "Insufficient permissions for organization-wide queries" }),
        { status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }
    if (data_scope === "department" && !["Super Admin", "SuperAdmin", "Admin", "Manager"].includes(userRole)) {
      return new Response(
        JSON.stringify({ error: "Insufficient permissions for department-wide queries" }),
        { status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const { data: llmProvider, error: providerError } = await supabase
      .from("llm_providers")
      .select("*, models:llm_models(*)")
      .eq("org_id", organization_id)
      .eq("enabled", true)
      .order("created_at", { ascending: true })
      .limit(1)
      .maybeSingle();

    if (providerError || !llmProvider) {
      return new Response(
        JSON.stringify({ error: "No LLM provider configured. Please configure an AI provider in settings." }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const defaultModel = llmProvider.models?.find((m: { is_default: boolean }) => m.is_default) ||
      llmProvider.models?.[0];
    if (!defaultModel) {
      return new Response(
        JSON.stringify({ error: "No LLM model configured" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const aiName = await builtinAiName(supabase, organization_id);
    const systemPrompt = buildSystemPrompt();
    const userPrompt = buildUserPrompt(query_text, data_scope, time_range);

    const { plan, tokensUsed: planTokens } = await callLLM(
      llmProvider.provider,
      (await openSecret(llmProvider.api_key_encrypted)) ?? "",
      defaultModel.model_key,
      systemPrompt,
      userPrompt,
      aiName,
      organization_id
    );

    const sanitizedSQL = sanitizeSQL(plan.sql_query);

    const timeRangeDates = getTimeRangeDates(time_range);
    const finalSQL = applyPlaceholders(
      sanitizedSQL,
      organization_id,
      user_id,
      user.department_id,
      timeRangeDates.start,
      timeRangeDates.end
    );

    const { data: queryResults, error: queryError } = await supabase.rpc("exec_report_query", {
      query_text: finalSQL,
    });

    if (queryError) {
      const errorQueryRecord = await supabase.from("ai_report_queries").insert({
        organization_id,
        user_id,
        query_text,
        data_scope,
        time_range,
        sql_generated: finalSQL,
        data_sources_used: plan.data_sources,
        error: queryError.message,
        tokens_used: planTokens,
        execution_time_ms: Date.now() - startTime,
      }).select().single();

      return new Response(
        JSON.stringify({
          success: false,
          query_id: errorQueryRecord.data?.id,
          error: "Query execution failed. Please try rephrasing your question.",
          sql_generated: finalSQL,
        }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const results = queryResults || [];

    const { answer, insights, tokensUsed: answerTokens } = await generateAnswerFromResults(
      llmProvider.provider,
      (await openSecret(llmProvider.api_key_encrypted)) ?? "",
      defaultModel.model_key,
      query_text,
      results,
      plan.explanation,
      aiName,
      organization_id
    );

    const totalTokens = planTokens + answerTokens;
    const executionTime = Date.now() - startTime;

    let tableColumns: Array<{ key: string; label: string; format?: string }> = [];
    if (results.length > 0) {
      const firstRow = results[0] as Record<string, unknown>;
      tableColumns = Object.keys(firstRow).map((key) => ({
        key,
        label: key.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()),
        format: typeof firstRow[key] === "number" ? "number" : undefined,
      }));
    }

    const responseData = {
      answer,
      explanation: plan.explanation,
      chart_type: plan.chart_type || "table",
      chart_data: results.slice(0, 100),
      table_columns: tableColumns,
      table_rows: results,
      sources: plan.data_sources.map((ds) => ({
        table: ds,
        fields: DATA_SOURCE_SCHEMAS.find((s) => s.name === ds)?.fields.map((f) => f.name) || [],
      })),
      insights,
    };

    const { data: queryRecord, error: insertError } = await supabase
      .from("ai_report_queries")
      .insert({
        organization_id,
        user_id,
        query_text,
        response_text: answer,
        response_data: responseData,
        data_sources_used: plan.data_sources,
        sql_generated: finalSQL,
        execution_time_ms: executionTime,
        tokens_used: totalTokens,
        data_scope,
        time_range,
      })
      .select()
      .single();

    if (insertError) {
      console.error("Failed to save query record:", insertError);
    }

    return new Response(
      JSON.stringify({
        success: true,
        query_id: queryRecord?.id,
        answer,
        explanation: plan.explanation,
        data_sources_used: plan.data_sources,
        chart_type: plan.chart_type || "table",
        chart_data: results.slice(0, 100),
        table_columns: tableColumns,
        table_rows: results,
        execution_time_ms: executionTime,
        tokens_used: totalTokens,
      }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (error) {
    console.error("AI report query error:", error);
    return new Response(
      JSON.stringify({
        success: false,
        error: error instanceof Error ? error.message : "Internal server error",
      }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
