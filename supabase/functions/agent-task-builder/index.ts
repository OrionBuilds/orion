import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2";
import { extractUserContext } from "../_shared/auth.ts";
import { handleCors, jsonResponse } from "../_shared/cors.ts";
import { openSecret } from "../_shared/secrets.ts";
import { meteredFetch } from "../_shared/ai-usage.ts";
import {
  buildAnthropicHeaders,
  getAnthropicMessagesUrl,
} from "../_shared/claraConfig.ts";
import {
  BUILDER_CADENCES,
  buildScheduleConfig,
  type BuilderAgent,
  type BuilderMessage,
  CREATE_MODES,
  type CreateMode,
  DEFAULT_TIMEZONE,
  instructionTaskKey,
  isBuilderAgent,
  LIMITS,
  MAX_QUESTION_ROUNDS,
  OUTPUT_KINDS,
  questionRounds,
  recommendedMode,
  RISK_TIERS,
  validateMessages,
  validateProposal,
} from "../_shared/agent-task-proposal.ts";

/**
 * agent-task-builder — the conversational "New schedule" flow on /agent-tasks.
 *
 * POST { action: "converse", agent, messages[] }
 *   -> { type: "questions", text } | { type: "proposal", proposal, adjustments, recommended_mode }
 *   The model either asks the owner clarifying questions (at most MAX_QUESTION_ROUNDS rounds) or
 *   proposes a task. Proposals are validated against the agent_task_schedules allow-lists before
 *   they leave this function; an invalid one gets one repair attempt, then an error.
 *
 * POST { action: "create", agent, proposal, mode, messages[] }
 *   -> { schedule, adjustments }
 *   Re-validates the (possibly owner-edited) proposal and inserts ONE schedule row under the
 *   agent's generic `<agent>.instruction` task key with config.instructions = the confirmed brief.
 *   The row is written by this function (service role) after the permission check, so the browser
 *   never writes builder config straight into the table.
 *
 * Auth: user JWT validated in code (extractUserContext) and the caller must hold
 * agent_tasks.manage (or be SuperAdmin) — the same permission the Agent Schedules page requires to
 * create schedules. The org is always the caller's, never taken from the body. Not listed in
 * config.toml, so the gateway's verify_jwt=true stays on as a second layer (same as
 * workflow-ai-generator / assistant-chat, which are browser-only like this one).
 *
 * LLM: the org's AI provider resolved exactly like assistant-chat's resolveLLMConfig (platform
 * ANTHROPIC_API_KEY secret first, then the org's enabled llm_providers Anthropic row). It runs on the
 * newest Claude model: turning a loose request into a safe, exact task brief is worth the extra cost.
 */

const MODEL = "claude-opus-5-5";

const AGENT_PROFILES: Record<BuilderAgent, { label: string; blurb: string; capabilities: string }> = {
  clara: {
    label: "CLARA",
    blurb: "Personal / owner assistant — briefings, triage, meeting prep",
    capabilities:
      "Works for the owner personally: reads and triages the owner's email inbox, calendar and contacts/CRM, " +
      "prepares meeting briefs (Google Docs), drafts follow-ups and replies, does web research, composes briefings " +
      "and summaries, and can text/email/call the owner. Anything she sends to people other than the owner goes " +
      "through approval.",
  },
  friday: {
    label: "FRIDAY",
    blurb: "Engineering — housekeeping, data hygiene, monitoring, orchestration",
    capabilities:
      "Engineering and operations: monitors client websites (uptime, security headers), runs dependency and " +
      "devops housekeeping, scans OS data for hygiene problems and proposes fixes, triages client project tickets " +
      "and change requests, plans and dispatches code changes to client repos as pull requests through her " +
      "approval gates, and reports on the health of the other agents.",
  },
};

interface ContentBlock {
  type: string;
  text?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  [k: string]: unknown;
}
interface ApiMessage {
  role: "user" | "assistant";
  content: string | ContentBlock[];
}
interface ApiResponse {
  content: ContentBlock[];
  stop_reason: string | null;
}

class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

// --- tools the model answers through ----------------------------------------------------------

const ASK_TOOL = {
  name: "ask_clarifying_questions",
  description:
    "Ask the owner the clarifying questions you still need answered before you can propose the task. " +
    "Use only when something essential is genuinely ambiguous.",
  input_schema: {
    type: "object",
    additionalProperties: false,
    required: ["questions"],
    properties: {
      questions: {
        type: "string",
        description:
          "1-4 short numbered questions in plain English, addressed to the owner. Offer a sensible default " +
          "in each question where you can (e.g. 'Daily at 8am ET — OK?').",
      },
    },
  },
};

const PROPOSE_TOOL = {
  name: "propose_task",
  description: "Propose the complete task for the owner to confirm.",
  input_schema: {
    type: "object",
    additionalProperties: false,
    required: [
      "title", "summary", "instructions", "cadence", "time_of_day", "days_of_week", "day_of_month",
      "timezone", "risk_tier", "output_kind", "output_destination", "approval_required",
      "external_effects", "scope", "success_criteria",
    ],
    properties: {
      title: { type: "string", description: `Short schedule title, at most ${LIMITS.title} characters.` },
      summary: {
        type: "string",
        description:
          "Plain-English description for the owner of exactly what will happen on each run: what the agent reads, " +
          "what it does, what it produces, where it goes, and what needs approval.",
      },
      instructions: {
        type: "string",
        description:
          "The self-contained brief the agent executes on every run, written to the agent in the imperative. " +
          "Include goal, steps, scope/sources, output format and destination, what NOT to do, when to stop and " +
          "request approval, and how to avoid duplicating work done on a previous run.",
      },
      cadence: { type: "string", enum: [...BUILDER_CADENCES] },
      time_of_day: { type: "string", description: "HH:MM 24h in `timezone`. For hourly, only the minutes are used." },
      days_of_week: {
        type: "array",
        items: { type: "integer", minimum: 0, maximum: 6 },
        description: "Weekly only: 0=Sun..6=Sat. Use [] for other cadences.",
      },
      day_of_month: { type: "integer", minimum: 0, maximum: 31, description: "Monthly only: 1-31. Use 0 otherwise." },
      timezone: { type: "string", description: `IANA timezone; default ${DEFAULT_TIMEZONE}.` },
      risk_tier: {
        type: "string",
        enum: [...RISK_TIERS],
        description:
          "autonomous = runs and reports, internal only; owner_review = output is gated on the owner; " +
          "client_visible = anything a client sees (always approval-gated).",
      },
      output_kind: {
        type: "string",
        enum: [...OUTPUT_KINDS],
        description:
          "owner_briefing = a summary for the owner (OS inbox); housekeeping_report = recorded on the run report; " +
          "client_deliverable = something delivered to a client; none = no output beyond the run record.",
      },
      output_destination: { type: "string", description: "Where the result goes, in words, e.g. 'Your OS inbox'." },
      approval_required: { type: "boolean", description: "Owner approves before any output is delivered/sent." },
      external_effects: {
        type: "boolean",
        description:
          "True if a run sends anything outside the OS (email, SMS, calls, social posts, messages to clients or " +
          "third parties), changes client-visible systems, or spends money.",
      },
      scope: { type: "string", description: "Sources, accounts, clients or systems the task is limited to." },
      success_criteria: { type: "string", description: "How the owner will know a run did its job." },
    },
  },
};

function systemPrompt(agent: BuilderAgent, existing: string[], forceProposal: boolean, now: string): string {
  const p = AGENT_PROFILES[agent];
  return `You help the owner of the business set up a recurring task for ${p.label}, one of the company's AI agents.
The owner describes what they want in plain English; you turn it into one precise, safe, recurring task.

## ${p.label}
${p.blurb}.
${p.capabilities}

## How tasks run
- The OS stores the task as a schedule. ${p.label} polls the OS, claims due runs, executes the task's instructions with its own tools, and reports a result back.
- Cadences available: hourly (at a minute past the hour), daily, weekly (chosen days), monthly (day of month), always at a time of day in a timezone. Default timezone ${DEFAULT_TIMEZONE}.
- There are no event triggers. "When X happens, do Y" becomes a recurring check at a sensible cadence ("every hour, look for new X since the last run and do Y").
- One-off tasks are not supported here. If the owner wants something done once, ask whether a recurring version would help; otherwise propose the closest recurring version and say so in the summary.
- Shadow mode means the agent runs and records what it would do without side effects. External or risky work starts in shadow unless the owner turns it fully on.

## Safety rules (non-negotiable)
- Anything that sends messages outside the OS (to clients, leads, vendors, the public), posts content, changes client-visible systems, or spends money: external_effects=true and approval_required=true.
- Client-visible output: risk_tier=client_visible and approval_required=true.
- Never put credentials, passwords, card numbers or API keys into instructions. If the owner offers any, tell them the agent uses its own connected accounts.
- If the request is outside what ${p.label} does, say so in a question and suggest the other agent (CLARA = owner's personal assistant; FRIDAY = engineering/ops).

## Conversation
- Ask only what you genuinely need. If the request already says enough, propose immediately with sensible defaults; the owner can edit everything on the confirm card.
- Topics worth asking about when unclear: when/how often; scope and sources; where the output goes; whether approval is needed before anything is sent externally; what success looks like.
- Batch questions: at most 4 per round, at most ${MAX_QUESTION_ROUNDS} rounds in total (used so far is shown by the conversation).
- Respond ONLY by calling exactly one tool: ask_clarifying_questions or propose_task.
${forceProposal ? "- You have used all clarifying rounds. Call propose_task now, choosing sensible defaults for anything still open and noting assumptions in the summary.\n" : ""}
## Writing the instructions
Write them for ${p.label}, imperative, self-contained (the agent sees only these instructions plus the schedule fields). Cover: goal; step-by-step what to do each run; scope and sources; output format and where to deliver it; what not to do; when to stop and request approval instead of acting; how to avoid redoing or re-sending work from earlier runs.

## Already scheduled for ${p.label}
${existing.length ? existing.map((e) => `- ${e}`).join("\n") : "- (nothing yet)"}
If the request duplicates one of these, point it out in a question.

Current time: ${now} (UTC).`;
}

// --- LLM provider (mirrors assistant-chat resolveLLMConfig) -----------------------------------

async function resolveAnthropicKey(db: SupabaseClient, orgId: string): Promise<string> {
  const platformKey = (Deno.env.get("ANTHROPIC_API_KEY") ?? "").trim();
  if (platformKey) return platformKey;
  const { data: providers } = await db
    .from("llm_providers")
    .select("provider, api_key_encrypted")
    .eq("org_id", orgId)
    .eq("enabled", true)
    .limit(10);
  for (const p of (providers ?? []) as Array<{ provider: string; api_key_encrypted: string | null }>) {
    if (p.provider === "anthropic" && p.api_key_encrypted) {
      const key = ((await openSecret(p.api_key_encrypted)) ?? "").trim();
      if (key) return key;
    }
  }
  throw new HttpError(503, "No AI provider is configured for this organization (Settings → AI).");
}

async function callModel(apiKey: string, system: string, messages: ApiMessage[], tools: unknown[]): Promise<ApiResponse> {
  const res = await meteredFetch({ source: "agent-task-builder", agent: "os", purpose: "agent task builder" })(getAnthropicMessagesUrl(), {
    method: "POST",
    headers: buildAnthropicHeaders(apiKey),
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 8000,
      output_config: { effort: "medium" },
      system,
      messages,
      tools,
      tool_choice: { type: "auto" },
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    console.error("[agent-task-builder] Anthropic error", res.status, body.slice(0, 500));
    throw new HttpError(502, `AI service error (${res.status})`);
  }
  const data = (await res.json()) as ApiResponse;
  if (data.stop_reason === "refusal") throw new HttpError(422, "The assistant declined this request.");
  return data;
}

// --- data helpers ------------------------------------------------------------------------------

/** The agent's provisioned OS user: whoever owns most of its live schedules, else its role user. */
async function resolveAgentUserId(db: SupabaseClient, orgId: string, agent: BuilderAgent): Promise<string | null> {
  const { data: rows } = await db
    .from("agent_task_schedules")
    .select("agent_user_id, mode")
    .eq("org_id", orgId)
    .eq("agent_slug", agent)
    .limit(500);
  const score = new Map<string, number>();
  for (const r of (rows ?? []) as Array<{ agent_user_id: string; mode: string }>) {
    // A live schedule is evidence the agent actually polls as this identity; an off one barely is.
    score.set(r.agent_user_id, (score.get(r.agent_user_id) ?? 0) + (r.mode === "off" ? 1 : 100));
  }
  const best = [...score.entries()].sort((a, b) => b[1] - a[1])[0];
  if (best) return best[0];

  const roleName = agent === "clara" ? "ClaraAgent" : "FridayAgent";
  const { data: role } = await db.from("roles").select("id").eq("name", roleName).maybeSingle();
  if (!role) return null;
  const { data: user } = await db
    .from("users")
    .select("id")
    .eq("organization_id", orgId)
    .eq("role_id", (role as { id: string }).id)
    .limit(1)
    .maybeSingle();
  return (user as { id: string } | null)?.id ?? null;
}

async function existingSchedules(db: SupabaseClient, orgId: string, agent: BuilderAgent): Promise<string[]> {
  const { data } = await db
    .from("agent_task_schedules")
    .select("title, cadence, time_of_day, mode")
    .eq("org_id", orgId)
    .eq("agent_slug", agent)
    .neq("mode", "off")
    .order("next_run_at", { ascending: true })
    .limit(40);
  return ((data ?? []) as Array<{ title: string; cadence: string; time_of_day: string | null; mode: string }>)
    .map((s) => `${s.title} (${s.cadence}${s.time_of_day ? ` ${s.time_of_day}` : ""}, ${s.mode})`);
}

// --- actions -----------------------------------------------------------------------------------

async function converse(db: SupabaseClient, orgId: string, body: Record<string, unknown>) {
  const agent = body.agent;
  if (!isBuilderAgent(agent)) throw new HttpError(400, "agent must be clara or friday");
  const mv = validateMessages(body.messages);
  if (!mv.ok) throw new HttpError(400, mv.error);

  const forceProposal = questionRounds(mv.messages) >= MAX_QUESTION_ROUNDS;
  const tools = forceProposal ? [PROPOSE_TOOL] : [ASK_TOOL, PROPOSE_TOOL];
  const [apiKey, existing] = await Promise.all([resolveAnthropicKey(db, orgId), existingSchedules(db, orgId, agent)]);
  const system = systemPrompt(agent, existing, forceProposal, new Date().toISOString());
  const messages: ApiMessage[] = mv.messages.map((m) => ({ role: m.role, content: m.content }));

  // One repair round: if the proposal fails validation, hand the errors back as a tool error.
  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await callModel(apiKey, system, messages, tools);
    const toolUse = res.content.find((b) => b.type === "tool_use");
    const text = res.content.filter((b) => b.type === "text").map((b) => b.text ?? "").join("\n").trim();

    if (!toolUse) {
      if (text && !forceProposal) return { type: "questions", text, model: MODEL };
      throw new HttpError(502, "The assistant did not return a usable answer — try rephrasing.");
    }
    if (toolUse.name === ASK_TOOL.name && !forceProposal) {
      const q = typeof toolUse.input?.questions === "string" ? toolUse.input.questions.trim() : "";
      if (q) return { type: "questions", text: q.slice(0, LIMITS.messageChars), model: MODEL };
    }
    if (toolUse.name === PROPOSE_TOOL.name) {
      const v = validateProposal(toolUse.input);
      if (v.ok) {
        return {
          type: "proposal",
          proposal: v.proposal,
          adjustments: v.adjustments,
          recommended_mode: recommendedMode(v.proposal),
          model: MODEL,
        };
      }
      messages.push({ role: "assistant", content: res.content });
      messages.push({
        role: "user",
        content: [{
          type: "tool_result",
          tool_use_id: toolUse.id,
          is_error: true,
          content: `The proposal is invalid: ${v.errors.join("; ")}. Call propose_task again with corrected fields.`,
        }],
      });
      continue;
    }
    break;
  }
  throw new HttpError(502, "The assistant could not produce a valid task — try adding a little more detail.");
}

async function create(db: SupabaseClient, orgId: string, userId: string, body: Record<string, unknown>) {
  const agent = body.agent;
  if (!isBuilderAgent(agent)) throw new HttpError(400, "agent must be clara or friday");
  const v = validateProposal(body.proposal);
  if (!v.ok) throw new HttpError(400, `Invalid task: ${v.errors.join("; ")}`);
  const mode = body.mode;
  if (typeof mode !== "string" || !(CREATE_MODES as readonly string[]).includes(mode)) {
    throw new HttpError(400, "mode must be shadow or active");
  }
  const transcript: BuilderMessage[] = [];
  if (body.messages !== undefined) {
    const mv = validateMessages(body.messages, { requireLastUser: false });
    if (!mv.ok) throw new HttpError(400, mv.error);
    transcript.push(...mv.messages);
  }
  const p = v.proposal;

  const agentUserId = await resolveAgentUserId(db, orgId, agent);
  if (!agentUserId) throw new HttpError(409, `No provisioned OS user found for ${agent.toUpperCase()}.`);

  const { data: nextRunAt, error: nextErr } = await db.rpc("agent_task_next_run_at", {
    p_cadence: p.cadence,
    p_time_of_day: p.time_of_day,
    p_days_of_week: p.days_of_week,
    p_day_of_month: p.day_of_month,
    p_timezone: p.timezone,
    p_from: new Date().toISOString(),
  });
  if (nextErr || !nextRunAt) throw new HttpError(500, `Could not compute the next run: ${nextErr?.message ?? "no value"}`);

  const now = new Date().toISOString();
  const { data, error } = await db
    .from("agent_task_schedules")
    .insert({
      org_id: orgId,
      agent_user_id: agentUserId,
      agent_slug: agent,
      task_key: instructionTaskKey(agent),
      subject_id: null,
      title: p.title,
      description: p.summary,
      cadence: p.cadence,
      time_of_day: p.time_of_day,
      days_of_week: p.days_of_week,
      day_of_month: p.day_of_month,
      timezone: p.timezone,
      next_run_at: nextRunAt,
      risk_tier: p.risk_tier,
      output_kind: p.output_kind,
      approval_required: p.approval_required,
      mode: mode as CreateMode,
      config: buildScheduleConfig(p, {
        createdBy: userId,
        createdAt: now,
        model: typeof body.model === "string" ? body.model.slice(0, 64) : null,
        transcript,
      }),
      created_by_user_id: userId,
    })
    .select("*")
    .single();
  if (error) {
    if (error.code === "23505") {
      throw new HttpError(
        409,
        `${agent.toUpperCase()} already has an instruction task. Apply migration ` +
          "20261029120000_agent_instruction_tasks_multi.sql to allow several.",
      );
    }
    throw new HttpError(500, `Could not create the schedule: ${error.message}`);
  }
  return { schedule: data, adjustments: v.adjustments };
}

Deno.serve(async (req: Request) => {
  const cors = handleCors(req);
  if (cors) return cors;
  if (req.method !== "POST") return jsonResponse({ error: "Method not allowed" }, 405);

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
    if (!supabaseUrl || !serviceRoleKey) return jsonResponse({ error: "Server is not configured" }, 500);
    const db = createClient(supabaseUrl, serviceRoleKey, { auth: { autoRefreshToken: false, persistSession: false } });

    const user = await extractUserContext(req, db);
    if (!user) return jsonResponse({ error: "Unauthorized" }, 401);
    if (!user.orgId) return jsonResponse({ error: "No organization for caller" }, 403);
    if (!user.isSuperAdmin && !user.permissions.includes("agent_tasks.manage")) {
      return jsonResponse({ error: "Requires agent_tasks.manage" }, 403);
    }

    const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body || typeof body !== "object") return jsonResponse({ error: "Invalid JSON body" }, 400);

    const action = body.action ?? "converse";
    if (action === "converse") return jsonResponse(await converse(db, user.orgId, body));
    if (action === "create") return jsonResponse(await create(db, user.orgId, user.id, body));
    return jsonResponse({ error: "Unknown action" }, 400);
  } catch (err) {
    if (err instanceof HttpError) return jsonResponse({ error: err.message }, err.status);
    console.error("[agent-task-builder] unexpected error", err);
    return jsonResponse({ error: "Unexpected error" }, 500);
  }
});
