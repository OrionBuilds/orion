import { assertEquals } from "jsr:@std/assert@1";
import {
  authorizeAgentKey,
  describeModel,
  effectiveModel,
  type OrgAgentDefaults,
  parentKeyOf,
  resolveAgentSettings,
} from "./agent-settings.ts";

const ORG: OrgAgentDefaults = { default_model_id: "m-org", default_voice_id: "v-org", require_approval: false };

Deno.test("parentKeyOf splits <parent>.<id>", () => {
  assertEquals(parentKeyOf("clara"), null);
  assertEquals(parentKeyOf("clara.front-desk"), "clara");
});

Deno.test("root with no row inherits org defaults", () => {
  const r = resolveAgentSettings("clara", null, null, ORG);
  assertEquals(r.status, "active");
  assertEquals(r.primary_model_id, { value: "m-org", source: "org_default" });
  assertEquals(r.fallback_model_id, { value: null, source: "none" });
  assertEquals(r.voice_id, { value: "v-org", source: "org_default" });
  assertEquals(r.allowed_tools, null);
  assertEquals(r.include_global_knowledge, true);
  assertEquals(r.require_approval, false);
});

Deno.test("subagent inherits model/voice from parent, narrows tools and limits", () => {
  const parent = resolveAgentSettings("friday", {
    agent_key: "friday",
    primary_model_id: "m-opus",
    fallback_model_id: "m-sonnet",
    voice_id: "v-friday",
    allowed_tools: ["deploy", "read_deploys", "list_projects"],
    denied_tools: ["rollback_deploy"],
    daily_budget_usd: "40",
    max_tokens: 8000,
    require_approval: true,
    persona_override: "Be terse.",
  }, null, ORG);

  const sub = resolveAgentSettings("friday.devops-deploy", {
    agent_key: "friday.devops-deploy",
    allowed_tools: ["deploy", "rollback_deploy", "site_health"],
    daily_budget_usd: 100,
    max_tokens: 2000,
    require_approval: false,
  }, parent, ORG);

  assertEquals(sub.parent_key, "friday");
  assertEquals(sub.primary_model_id, { value: "m-opus", source: "parent" });
  assertEquals(sub.fallback_model_id, { value: "m-sonnet", source: "parent" });
  assertEquals(sub.voice_id, { value: "v-friday", source: "parent" });
  // intersection with parent, minus denied
  assertEquals(sub.allowed_tools, ["deploy"]);
  assertEquals(sub.denied_tools, ["rollback_deploy"]);
  // cannot raise the parent's ceilings
  assertEquals(sub.limits.daily_budget_usd, 40);
  assertEquals(sub.limits.max_tokens, 2000);
  // approval is OR-ed with the parent
  assertEquals(sub.require_approval, true);
  // persona is per agent
  assertEquals(sub.persona_override, null);
});

Deno.test("subagent own model wins; status takes the more restrictive", () => {
  const parent = resolveAgentSettings("clara", { agent_key: "clara", status: "paused" }, null, ORG);
  const sub = resolveAgentSettings("clara.scheduler", {
    agent_key: "clara.scheduler",
    status: "active",
    primary_model_id: "m-haiku",
  }, parent, ORG);
  assertEquals(sub.primary_model_id, { value: "m-haiku", source: "agent" });
  assertEquals(sub.status, "paused");

  const disabledSub = resolveAgentSettings("clara.advisor", { agent_key: "clara.advisor", status: "disabled" }, parent, ORG);
  assertEquals(disabledSub.status, "disabled");
});

Deno.test("parent allowlist applies to a subagent with no allowlist of its own", () => {
  const parent = resolveAgentSettings("clara", { agent_key: "clara", allowed_tools: ["a", "b"] }, null, ORG);
  const sub = resolveAgentSettings("clara.researcher", { agent_key: "clara.researcher", denied_tools: ["b"] }, parent, ORG);
  assertEquals(sub.allowed_tools, ["a"]);
});

Deno.test("authorizeAgentKey pins agent accounts to their own tree", () => {
  assertEquals(authorizeAgentKey({ roleName: "ClaraAgent", canPreview: false }), { agentKey: "clara" });
  assertEquals(
    authorizeAgentKey({ roleName: "ClaraAgent", canPreview: false, requestedSubagent: "front-desk" }),
    { agentKey: "clara.front-desk" },
  );
  assertEquals(
    authorizeAgentKey({ roleName: "FridayAgent", canPreview: true, requestedAgent: "clara" }),
    { error: "This account may only read friday settings", status: 403 },
  );
  assertEquals(
    authorizeAgentKey({ roleName: "FridayAgent", canPreview: true, requestedAgent: "friday.builder" }),
    { agentKey: "friday.builder" },
  );
});

Deno.test("authorizeAgentKey: admins preview any key, others are refused", () => {
  assertEquals(
    authorizeAgentKey({ roleName: "SuperAdmin", canPreview: true, requestedAgent: "clara.front-desk" }),
    { agentKey: "clara.front-desk" },
  );
  assertEquals(
    authorizeAgentKey({ roleName: "Sales", canPreview: false, requestedAgent: "clara" }),
    { error: "Not an agent account and missing ai.settings.view", status: 403 },
  );
  assertEquals(
    authorizeAgentKey({ roleName: "SuperAdmin", canPreview: true }),
    { error: "agent is required (e.g. \"clara\" or \"friday.builder\")", status: 400 },
  );
  assertEquals(
    authorizeAgentKey({ roleName: "SuperAdmin", canPreview: true, requestedAgent: "../etc" }),
    { error: "Invalid agent key: ../etc", status: 400 },
  );
});

Deno.test("effectiveModel skips unavailable candidates", () => {
  const disabled = describeModel({
    id: "1", model_key: "claude-opus-5-5", display_name: "Opus", context_window: 1_000_000, enabled: false,
    provider: { provider: "anthropic", enabled: true },
  });
  const ok = describeModel({
    id: "2", model_key: "gemini-2.5-pro", display_name: "Gemini", context_window: 1_048_576, enabled: true,
    metadata: { max_output_tokens: 65536 }, provider: { provider: "google", enabled: true },
  });
  assertEquals(disabled?.available, false);
  assertEquals(disabled?.unavailable_reason, "model disabled");
  assertEquals(effectiveModel([disabled, ok])?.model_key, "gemini-2.5-pro");
  assertEquals(ok?.max_output_tokens, 65536);
  assertEquals(effectiveModel([disabled, null]), null);
});
