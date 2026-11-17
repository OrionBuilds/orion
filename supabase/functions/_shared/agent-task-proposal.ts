/**
 * Agent task builder — proposal contract + validator.
 *
 * The conversational "New schedule" flow (agent-task-builder edge function + ScheduleBuilder UI)
 * turns an owner's plain-English ask into ONE agent_task_schedules row that runs under a single
 * generic, instruction-driven task key per agent (`clara.instruction` / `friday.instruction`).
 * The agent's handler for that key reads `config.instructions` (the confirmed brief) and executes
 * it with its normal tool loop.
 *
 * Every proposal — whether the model produced it or the owner edited it on the confirm card — goes
 * through validateProposal() before it can become a row. The allow-lists below mirror the CHECK
 * constraints on agent_task_schedules (migration 20260730045337_agent_task_scheduling_backbone.sql);
 * nothing outside them reaches the DB, and nothing the model emits is spread into `config` as-is.
 *
 * Pure and import-free so it runs in Deno (edge function) and in Vitest/the browser alike.
 */

export const BUILDER_AGENTS = ["clara", "friday"] as const;
export type BuilderAgent = typeof BUILDER_AGENTS[number];

/** custom_cron is deliberately absent: agent_task_next_run_at() does not evaluate cron in SQL. */
export const BUILDER_CADENCES = ["hourly", "daily", "weekly", "monthly"] as const;
export type BuilderCadence = typeof BUILDER_CADENCES[number];

export const RISK_TIERS = ["autonomous", "owner_review", "client_visible"] as const;
export type BuilderRiskTier = typeof RISK_TIERS[number];

export const OUTPUT_KINDS = ["owner_briefing", "client_deliverable", "housekeeping_report", "none"] as const;
export type BuilderOutputKind = typeof OUTPUT_KINDS[number];

/** "Create & enable" never creates an off row. */
export const CREATE_MODES = ["shadow", "active"] as const;
export type CreateMode = typeof CREATE_MODES[number];

export const DEFAULT_TIMEZONE = "America/New_York";

/** Upper bound on clarifying rounds; after this the server forces a proposal. */
export const MAX_QUESTION_ROUNDS = 4;

export const LIMITS = {
  title: 120,
  summary: 1200,
  instructions: 8000,
  scope: 1500,
  successCriteria: 1500,
  outputDestination: 300,
  messageChars: 4000,
  messages: 16,
} as const;

export function instructionTaskKey(agent: BuilderAgent): string {
  return `${agent}.instruction`;
}

export function isBuilderAgent(v: unknown): v is BuilderAgent {
  return typeof v === "string" && (BUILDER_AGENTS as readonly string[]).includes(v);
}

export interface TaskProposal {
  title: string;
  /** Plain-English description of exactly what will happen, shown to the owner. */
  summary: string;
  /** The brief the agent executes on every run (stored as config.instructions). */
  instructions: string;
  cadence: BuilderCadence;
  /** 'HH:MM' 24h in `timezone`; for hourly only the minutes are used. */
  time_of_day: string;
  /** 0=Sun..6=Sat; weekly only. */
  days_of_week: number[] | null;
  /** 1..31; monthly only. */
  day_of_month: number | null;
  timezone: string;
  risk_tier: BuilderRiskTier;
  output_kind: BuilderOutputKind;
  /** Where the result goes, in words ("your OS inbox", "email to you"). */
  output_destination: string;
  approval_required: boolean;
  /** True when a run sends anything outside the OS (email/SMS/calls/posts) or spends money. */
  external_effects: boolean;
  /** Sources, accounts, clients or systems the task is limited to. */
  scope: string;
  success_criteria: string;
}

export type ValidationResult =
  | { ok: true; proposal: TaskProposal; adjustments: string[] }
  | { ok: false; errors: string[] };

const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

function str(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

function bool(v: unknown): boolean | null {
  if (typeof v === "boolean") return v;
  if (v === "true") return true;
  if (v === "false") return false;
  return null;
}

function oneOf<T extends string>(v: unknown, allowed: readonly T[]): T | null {
  return typeof v === "string" && (allowed as readonly string[]).includes(v) ? (v as T) : null;
}

export function isValidTimezone(tz: string): boolean {
  if (!tz || tz.length > 64) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** Accept 'H:MM' too and zero-pad; anything else is invalid. */
function normalizeTime(v: unknown): string | null {
  const s = str(v);
  const padded = /^\d:\d\d$/.test(s) ? `0${s}` : s;
  return TIME_RE.test(padded) ? padded : null;
}

/**
 * Validate + normalise a proposal. Unknown keys are dropped. Safety rules are applied here (not
 * trusted to the model or the UI) and reported in `adjustments`:
 *   - client_visible output is always approval-gated (DB CHECK client_visible_requires_approval);
 *   - anything with external effects is approval-gated and at least owner_review.
 */
export function validateProposal(raw: unknown): ValidationResult {
  const errors: string[] = [];
  const adjustments: string[] = [];
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, errors: ["proposal must be an object"] };
  }
  const r = raw as Record<string, unknown>;

  const title = str(r.title);
  if (!title) errors.push("title is required");
  else if (title.length > LIMITS.title) errors.push(`title must be at most ${LIMITS.title} characters`);

  const summary = str(r.summary);
  if (!summary) errors.push("summary is required");
  else if (summary.length > LIMITS.summary) errors.push(`summary must be at most ${LIMITS.summary} characters`);

  const instructions = str(r.instructions);
  if (!instructions) errors.push("instructions are required");
  else if (instructions.length > LIMITS.instructions) {
    errors.push(`instructions must be at most ${LIMITS.instructions} characters`);
  }

  const cadence = oneOf(r.cadence, BUILDER_CADENCES);
  if (!cadence) errors.push(`cadence must be one of ${BUILDER_CADENCES.join(", ")}`);

  const time = normalizeTime(r.time_of_day ?? "09:00");
  if (!time) errors.push("time_of_day must be HH:MM (24h)");

  let days: number[] | null = null;
  if (cadence === "weekly") {
    const rawDays = Array.isArray(r.days_of_week) ? r.days_of_week : [];
    const valid = rawDays.every((d) => Number.isInteger(d) && (d as number) >= 0 && (d as number) <= 6);
    if (!valid || rawDays.length === 0) errors.push("weekly cadence needs days_of_week (0=Sun..6=Sat)");
    else days = Array.from(new Set(rawDays as number[])).sort((a, b) => a - b);
  }

  let dom: number | null = null;
  if (cadence === "monthly") {
    const d = r.day_of_month;
    if (!Number.isInteger(d) || (d as number) < 1 || (d as number) > 31) {
      errors.push("monthly cadence needs day_of_month between 1 and 31");
    } else dom = d as number;
  }

  const tzRaw = str(r.timezone) || DEFAULT_TIMEZONE;
  if (!isValidTimezone(tzRaw)) errors.push("timezone must be a valid IANA timezone");

  let risk = oneOf(r.risk_tier, RISK_TIERS);
  if (!risk) errors.push(`risk_tier must be one of ${RISK_TIERS.join(", ")}`);

  const output = oneOf(r.output_kind, OUTPUT_KINDS);
  if (!output) errors.push(`output_kind must be one of ${OUTPUT_KINDS.join(", ")}`);

  const outputDestination = str(r.output_destination);
  if (outputDestination.length > LIMITS.outputDestination) {
    errors.push(`output_destination must be at most ${LIMITS.outputDestination} characters`);
  }

  const scope = str(r.scope);
  if (scope.length > LIMITS.scope) errors.push(`scope must be at most ${LIMITS.scope} characters`);

  const successCriteria = str(r.success_criteria);
  if (successCriteria.length > LIMITS.successCriteria) {
    errors.push(`success_criteria must be at most ${LIMITS.successCriteria} characters`);
  }

  const external = bool(r.external_effects);
  if (external === null) errors.push("external_effects must be true or false");
  let approval = bool(r.approval_required);
  if (approval === null) errors.push("approval_required must be true or false");

  if (errors.length) return { ok: false, errors };

  if (output === "client_deliverable" && risk !== "client_visible") {
    risk = "client_visible";
    adjustments.push("Client deliverables are client-visible, so the risk tier was set to client_visible.");
  }
  if (external && risk === "autonomous") {
    risk = "owner_review";
    adjustments.push("Tasks with external effects run at owner_review or higher.");
  }
  if ((risk === "client_visible" || external) && !approval) {
    approval = true;
    adjustments.push(
      risk === "client_visible"
        ? "Client-visible output always needs your approval before delivery."
        : "Anything sent outside the OS or that spends money needs your approval first.",
    );
  }

  return {
    ok: true,
    adjustments,
    proposal: {
      title,
      summary,
      instructions,
      cadence: cadence!,
      time_of_day: time!,
      days_of_week: days,
      day_of_month: dom,
      timezone: tzRaw,
      risk_tier: risk!,
      output_kind: output!,
      output_destination: outputDestination,
      approval_required: approval!,
      external_effects: external!,
      scope,
      success_criteria: successCriteria,
    },
  };
}

/** Risky work starts in SHADOW (dry run) unless the owner explicitly picks ACTIVE. */
export function recommendedMode(p: Pick<TaskProposal, "external_effects" | "risk_tier">): CreateMode {
  return p.external_effects || p.risk_tier === "client_visible" ? "shadow" : "active";
}

export interface BuilderMessage {
  role: "user" | "assistant";
  content: string;
}

export type MessagesResult = { ok: true; messages: BuilderMessage[] } | { ok: false; error: string };

/**
 * Conversation guard: user/assistant text turns, first is the owner, capped. `requireLastUser`
 * holds for a converse call (the owner just spoke); a transcript stored on create may end on the
 * assistant's proposal turn.
 */
export function validateMessages(raw: unknown, opts: { requireLastUser?: boolean } = {}): MessagesResult {
  const requireLastUser = opts.requireLastUser ?? true;
  if (!Array.isArray(raw) || raw.length === 0) return { ok: false, error: "messages must be a non-empty array" };
  if (raw.length > LIMITS.messages) return { ok: false, error: `at most ${LIMITS.messages} messages` };
  const out: BuilderMessage[] = [];
  for (const m of raw) {
    if (!m || typeof m !== "object") return { ok: false, error: "each message must be an object" };
    const role = (m as Record<string, unknown>).role;
    const content = str((m as Record<string, unknown>).content);
    if (role !== "user" && role !== "assistant") return { ok: false, error: "message role must be user or assistant" };
    if (!content) return { ok: false, error: "message content must be non-empty text" };
    if (content.length > LIMITS.messageChars) {
      return { ok: false, error: `each message must be at most ${LIMITS.messageChars} characters` };
    }
    out.push({ role, content });
  }
  if (out[0].role !== "user") return { ok: false, error: "the first message must be from the owner" };
  if (requireLastUser && out[out.length - 1].role !== "user") {
    return { ok: false, error: "the last message must be from the owner" };
  }
  return { ok: true, messages: out };
}

/** How many clarifying rounds the assistant has already used. */
export function questionRounds(messages: BuilderMessage[]): number {
  return messages.filter((m) => m.role === "assistant").length;
}

/**
 * The only shape that reaches agent_task_schedules.config for a builder-created task. Built from
 * validated fields — never from a client- or model-supplied object.
 */
export function buildScheduleConfig(
  p: TaskProposal,
  meta: { createdBy: string; createdAt: string; model: string | null; transcript: BuilderMessage[] },
): Record<string, unknown> {
  return {
    instructions: p.instructions,
    summary: p.summary,
    scope: p.scope || null,
    success_criteria: p.success_criteria || null,
    output_destination: p.output_destination || null,
    external_effects: p.external_effects,
    builder: {
      version: 1,
      source: "agent-task-builder",
      created_by: meta.createdBy,
      created_at: meta.createdAt,
      model: meta.model,
      // Kept for audit ("why does this task exist?"); capped so the poll payload stays small.
      transcript: meta.transcript.slice(-LIMITS.messages).map((m) => ({
        role: m.role,
        content: m.content.slice(0, 1500),
      })),
    },
  };
}

const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** Human cadence label, e.g. "Weekly on Mon, Thu at 09:00 (America/New_York)". */
export function describeCadence(
  p: Pick<TaskProposal, "cadence" | "time_of_day" | "days_of_week" | "day_of_month" | "timezone">,
): string {
  const tz = ` (${p.timezone})`;
  switch (p.cadence) {
    case "hourly":
      return `Every hour at :${p.time_of_day.split(":")[1] ?? "00"}${tz}`;
    case "daily":
      return `Daily at ${p.time_of_day}${tz}`;
    case "weekly":
      return `Weekly on ${(p.days_of_week ?? []).map((d) => DOW[d]).join(", ")} at ${p.time_of_day}${tz}`;
    case "monthly":
      return `Monthly on day ${p.day_of_month} at ${p.time_of_day}${tz}`;
  }
}
