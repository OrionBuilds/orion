/**
 * Effective per-agent configuration for FRIDAY, CLARA and their subagents (table agent_settings).
 *
 * Keys: a root agent is `clara` / `friday`; a subagent is `<parent>.<id>` (e.g. `clara.front-desk`,
 * `friday.builder`). Every column is nullable and null means "inherit":
 *   subagent  →  parent agent  →  org defaults (ai_agent_settings_defaults, default llm_models row,
 *                                  default elevenlabs_voices row)
 *
 * Inheritance mirrors agent-core's subagent model (workerpool/index.ts): a subagent runs on its
 * parent's adapter and can only narrow what the parent may do. So for a subagent:
 *   - status is the more restrictive of the two (disabled > paused > active)
 *   - allowed_tools is intersected with the parent's, denied_tools is unioned
 *   - numeric limits take the lower value; require_approval is OR-ed
 *   - model / fallback / voice / knowledge fall back to the parent when unset
 *   - persona and prompt templates are per agent (the parent's prompt already wraps a subagent's)
 *
 * Pure functions only — the edge function (agent-settings-get) does the I/O.
 */

export const AGENT_KEY_PATTERN = /^[a-z][a-z0-9-]{0,40}(\.[a-z0-9][a-z0-9-]{0,40})?$/;

/** Role a signed-in agent account carries → the root agent key it may read. */
export const ROLE_AGENT_KEYS: Record<string, string> = {
  ClaraAgent: "clara",
  FridayAgent: "friday",
};

export type AgentStatus = "active" | "paused" | "disabled";
export type SettingSource = "agent" | "parent" | "org_default" | "none";

export interface AgentSettingsRow {
  agent_key: string;
  display_name?: string | null;
  status?: AgentStatus | null;
  primary_model_id?: string | null;
  fallback_model_id?: string | null;
  voice_id?: string | null;
  voice_settings?: Record<string, unknown> | null;
  persona_override?: string | null;
  persona_mode?: "append" | "replace" | null;
  prompt_template_ids?: string[] | null;
  knowledge_collection_ids?: string[] | null;
  include_global_knowledge?: boolean | null;
  allowed_tools?: string[] | null;
  denied_tools?: string[] | null;
  daily_budget_usd?: number | string | null;
  max_tokens?: number | null;
  max_calls_per_day?: number | null;
  rate_limit_per_minute?: number | null;
  max_turns?: number | null;
  require_approval?: boolean | null;
  updated_at?: string | null;
}

export interface OrgAgentDefaults {
  default_model_id: string | null;
  default_voice_id: string | null;
  require_approval: boolean | null;
}

export interface Sourced<T> {
  value: T;
  source: SettingSource;
}

export interface ResolvedAgentSettings {
  agent_key: string;
  parent_key: string | null;
  display_name: string | null;
  status: AgentStatus;
  primary_model_id: Sourced<string | null>;
  fallback_model_id: Sourced<string | null>;
  voice_id: Sourced<string | null>;
  voice_settings: Record<string, unknown>;
  persona_override: string | null;
  persona_mode: "append" | "replace";
  prompt_template_ids: string[];
  knowledge_collection_ids: string[];
  include_global_knowledge: boolean;
  allowed_tools: string[] | null;
  denied_tools: string[];
  limits: {
    daily_budget_usd: number | null;
    max_tokens: number | null;
    max_calls_per_day: number | null;
    rate_limit_per_minute: number | null;
    max_turns: number | null;
  };
  require_approval: boolean;
  updated_at: string | null;
}

export function parentKeyOf(agentKey: string): string | null {
  const dot = agentKey.indexOf(".");
  return dot === -1 ? null : agentKey.slice(0, dot);
}

/**
 * Which agent key the caller may read. Agent accounts (ClaraAgent/FridayAgent) are pinned to their
 * own root and its subagents; human admins with ai.settings.view may preview any key.
 * Returns the key, or an error string.
 */
export function authorizeAgentKey(opts: {
  roleName: string;
  canPreview: boolean;
  requestedAgent?: string | null;
  requestedSubagent?: string | null;
}): { agentKey: string } | { error: string; status: number } {
  const ownRoot = ROLE_AGENT_KEYS[opts.roleName] ?? null;
  const sub = opts.requestedSubagent?.trim().toLowerCase() || null;
  let requested = opts.requestedAgent?.trim().toLowerCase() || null;

  if (!requested && ownRoot) requested = ownRoot;
  if (!requested) return { error: "agent is required (e.g. \"clara\" or \"friday.builder\")", status: 400 };
  if (sub) {
    if (requested.includes(".")) return { error: "Pass either agent=<parent>.<id> or subagent=<id>, not both", status: 400 };
    requested = `${requested}.${sub}`;
  }
  if (!AGENT_KEY_PATTERN.test(requested)) return { error: `Invalid agent key: ${requested}`, status: 400 };

  if (ownRoot) {
    const root = parentKeyOf(requested) ?? requested;
    if (root !== ownRoot) return { error: `This account may only read ${ownRoot} settings`, status: 403 };
    return { agentKey: requested };
  }
  if (!opts.canPreview) return { error: "Not an agent account and missing ai.settings.view", status: 403 };
  return { agentKey: requested };
}

const STATUS_RANK: Record<AgentStatus, number> = { active: 0, paused: 1, disabled: 2 };

function pick<T>(own: T | null | undefined, parent: T | null | undefined, org: T | null | undefined, isSub: boolean): Sourced<T | null> {
  if (own !== null && own !== undefined) return { value: own, source: "agent" };
  if (isSub && parent !== null && parent !== undefined) return { value: parent, source: "parent" };
  if (org !== null && org !== undefined) return { value: org, source: "org_default" };
  return { value: null, source: "none" };
}

function num(v: number | string | null | undefined): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

function lower(own: number | null, parent: number | null): number | null {
  if (own === null) return parent;
  if (parent === null) return own;
  return Math.min(own, parent);
}

function uniq(list: string[]): string[] {
  return Array.from(new Set(list.map((t) => t.trim()).filter(Boolean)));
}

/** Resolve one agent. Pass the parent's *resolved* settings for a subagent, or null for a root. */
export function resolveAgentSettings(
  agentKey: string,
  row: AgentSettingsRow | null,
  parent: ResolvedAgentSettings | null,
  org: OrgAgentDefaults,
): ResolvedAgentSettings {
  const isSub = parent !== null;
  const own = row ?? { agent_key: agentKey };

  const ownStatus: AgentStatus = own.status ?? "active";
  const status = isSub && STATUS_RANK[parent.status] > STATUS_RANK[ownStatus] ? parent.status : ownStatus;

  let allowed: string[] | null = own.allowed_tools ? uniq(own.allowed_tools) : null;
  if (isSub && parent.allowed_tools) {
    allowed = allowed ? allowed.filter((t) => parent.allowed_tools!.includes(t)) : [...parent.allowed_tools];
  }
  const denied = uniq([...(own.denied_tools ?? []), ...(isSub ? parent.denied_tools : [])]);
  if (allowed) allowed = allowed.filter((t) => !denied.includes(t));

  const pl = parent?.limits;
  const limits = {
    daily_budget_usd: lower(num(own.daily_budget_usd), pl?.daily_budget_usd ?? null),
    max_tokens: lower(num(own.max_tokens), pl?.max_tokens ?? null),
    max_calls_per_day: lower(num(own.max_calls_per_day), pl?.max_calls_per_day ?? null),
    rate_limit_per_minute: lower(num(own.rate_limit_per_minute), pl?.rate_limit_per_minute ?? null),
    max_turns: lower(num(own.max_turns), pl?.max_turns ?? null),
  };

  const ownApproval = own.require_approval ?? null;
  const require_approval = (ownApproval ?? (isSub ? parent.require_approval : org.require_approval) ?? false) ||
    (isSub && parent.require_approval);

  return {
    agent_key: agentKey,
    parent_key: parentKeyOf(agentKey),
    display_name: own.display_name ?? null,
    status,
    primary_model_id: pick(own.primary_model_id, parent?.primary_model_id.value, org.default_model_id, isSub),
    fallback_model_id: pick(own.fallback_model_id, parent?.fallback_model_id.value, null, isSub),
    voice_id: pick(own.voice_id, parent?.voice_id.value, org.default_voice_id, isSub),
    voice_settings: { ...(isSub ? parent.voice_settings : {}), ...(own.voice_settings ?? {}) },
    persona_override: own.persona_override?.trim() ? own.persona_override : null,
    persona_mode: own.persona_mode ?? "append",
    prompt_template_ids: uniq(own.prompt_template_ids ?? []),
    knowledge_collection_ids: uniq(own.knowledge_collection_ids ?? (isSub ? parent.knowledge_collection_ids : [])),
    include_global_knowledge: own.include_global_knowledge ?? (isSub ? parent.include_global_knowledge : true),
    allowed_tools: allowed,
    denied_tools: denied,
    limits,
    require_approval,
    updated_at: latest(own.updated_at ?? null, parent?.updated_at ?? null),
  };
}

function latest(a: string | null, b: string | null): string | null {
  if (!a) return b;
  if (!b) return a;
  return a > b ? a : b;
}

/** Model rows as the edge function loads them (llm_models joined to llm_providers). */
export interface ModelRow {
  id: string;
  model_key: string;
  display_name: string;
  context_window: number | null;
  enabled: boolean;
  metadata?: Record<string, unknown> | null;
  provider?: { provider: string; enabled: boolean } | null;
}

export interface ModelChoice {
  id: string;
  model_key: string;
  provider: string | null;
  display_name: string;
  context_window: number | null;
  max_output_tokens: number | null;
  available: boolean;
  unavailable_reason?: string;
}

export function describeModel(row: ModelRow | undefined): ModelChoice | null {
  if (!row) return null;
  let reason: string | undefined;
  if (!row.enabled) reason = "model disabled";
  else if (!row.provider) reason = "provider missing";
  else if (!row.provider.enabled) reason = "provider disabled";
  else if (row.metadata?.available === false) reason = "no longer offered by provider";
  const maxOut = row.metadata?.max_output_tokens;
  return {
    id: row.id,
    model_key: row.model_key,
    provider: row.provider?.provider ?? null,
    display_name: row.display_name,
    context_window: row.context_window,
    max_output_tokens: typeof maxOut === "number" ? maxOut : null,
    available: !reason,
    ...(reason ? { unavailable_reason: reason } : {}),
  };
}

/** First available of primary → fallback → org default; null means "use your built-in default". */
export function effectiveModel(candidates: (ModelChoice | null)[]): ModelChoice | null {
  return candidates.find((c) => c?.available) ?? null;
}
