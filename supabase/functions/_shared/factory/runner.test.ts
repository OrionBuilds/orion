import { assertEquals } from "jsr:@std/assert@1";
import { FakeSupabase, asClient } from "../testing/fake-supabase.ts";
import { makeBudget } from "../friday/run-budget.ts";
import { dispatchExternal, factoryTick, parseDeliverable, runInOs, stepSystem, type Ask, type StepRow } from "./runner.ts";

const ORG = "o";
const STEP = (o: Record<string, unknown>) => ({
  id: "st1", key: "k", title: "Step", agent: "clara", role_slug: "sales-deal-strategist", instructions: "Do it", deliverable: "brief",
  action_key: "sales.lead_brief", acceptance_criteria: ["Has a verdict"], max_attempts: 3, ...o,
});
const GOOD = { output: "Verdict: strong fit", evidence: [{ source: "Deal", ref: "d1" }], gate: { passed: true, checks: [{ criterion: "Has a verdict", met: true }] } };

function setup(step: Record<string, unknown>, opts: { policy?: string; model?: unknown; agentUsers?: boolean } = {}) {
  const f = new FakeSupabase({
    playbook_steps: [STEP(step)],
    playbook_runs: [{ id: "r1", org_id: ORG, playbook_id: "p1", subject_type: "opportunity", subject_id: "d1", brand: "studio", playbooks: { slug: "sales-inbound" } }],
    playbook_step_runs: [{ id: "sr1", org_id: ORG, run_id: "r1", step_id: "st1", agent: String(step.agent ?? "clara"), status: "running", attempts: 1, stage_name: "New Lead", updated_at: "2026-11-04" }],
    agent_roles: [{ org_id: ORG, slug: "sales-deal-strategist", prompt: "## Operating rules\nROLE", version: 3, enabled: true }],
    opportunities: [{ id: "d1", org_id: ORG, name: "Acme", contact_id: "c1", brand: "studio" }],
    contacts: [{ id: "c1", organization_id: ORG, email: "buyer@acme.com", dnc: false, first_name: "Pat" }],
    users: opts.agentUsers === false ? [] : [
      { id: "friday-u", organization_id: ORG, status: "active", "roles.name": "FridayAgent" },
      { id: "clara-u", organization_id: ORG, status: "active", "roles.name": "ClaraAgent" },
    ],
  }, { rpc: { autonomy_mode: (a) => opts.policy ?? a.p_default } });
  const asks: { system: string; prompt: string }[] = [];
  const ask: Ask = (o) => { asks.push(o); return Promise.resolve(opts.model === undefined ? GOOD : opts.model); };
  const d = { db: asClient(f), ask, budget: makeBudget(40_000), fetcher: (() => Promise.reject(new Error("no web"))) as unknown as typeof fetch };
  const s = f.rows("playbook_step_runs")[0] as unknown as StepRow;
  return { f, d, s, asks };
}

Deno.test("internal step: done with output, evidence, gate and the role version; no approval card", async () => {
  const { f, d, s, asks } = setup({});
  assertEquals(await runInOs(d, s), "done");
  const sr = f.rows("playbook_step_runs")[0];
  assertEquals([sr.status, sr.output, sr.role_version], ["done", "Verdict: strong fit", 3]);
  assertEquals((sr.gate as { passed: boolean }).passed, true);
  assertEquals(f.rows("workflow_approval_queue").length, 0);
  assertEquals(asks[0].system.startsWith("## Operating rules\nROLE"), true);
});

Deno.test("email step: card goes to the contact on file, never the address the model wrote", async () => {
  const model = { ...GOOD, email: { subject: "Quick call?", body: "Hi Pat, ... Clara", to: ["attacker@evil.com"] } };
  const { f, d, s } = setup({ deliverable: "email_draft", action_key: "sales.first_touch_email" }, { model });
  assertEquals(await runInOs(d, s), "needs_approval");
  const card = f.rows("workflow_approval_queue")[0] as Record<string, any>;
  assertEquals([card.agent_slug, card.external_ref, card.action_type, card.status], ["clara", "factory:sr1", "clara_email", "pending_approval"]);
  assertEquals(card.draft_content.draft.to, ["buyer@acme.com"]);
  assertEquals(f.rows("playbook_step_runs")[0].status, "needs_approval");
});

Deno.test("outward step the owner set to auto: card recorded approved (approved-sends delivers), step done", async () => {
  const model = { ...GOOD, email: { subject: "Welcome", body: "Welcome! Clara" } };
  const { f, d, s } = setup({ deliverable: "email_draft", action_key: "client.welcome_email" }, { model, policy: "auto" });
  assertEquals(await runInOs(d, s), "done (auto)");
  const card = f.rows("workflow_approval_queue")[0] as Record<string, any>;
  assertEquals([card.status, card.resolution_note], ["approved", "auto (autonomy policy)"]);
});

Deno.test("finance step is outward-by-default: becomes a document card even though it's a report", async () => {
  const { f, d, s } = setup({ deliverable: "doc", action_key: "finance.pricing" });
  assertEquals(await runInOs(d, s), "needs_approval");
  const card = f.rows("workflow_approval_queue")[0] as Record<string, any>;
  assertEquals([card.external_ref, card.action_type], ["factory-doc:sr1", "factory_doc"]);
});

Deno.test("a bad model reply is retried, then escalated after max attempts", async () => {
  const { f, d, s } = setup({}, { model: { nope: true } });
  assertEquals(await runInOs(d, s), "queued");
  f.rows("playbook_step_runs")[0].attempts = 3;
  assertEquals(await runInOs(d, { ...s, attempts: 3 }), "escalated");
});

Deno.test("gate passes only when the model says so AND every check is met", () => {
  const def = STEP({}) as never;
  const d = parseDeliverable({ ...GOOD, gate: { passed: true, checks: [{ criterion: "x", met: false }] } }, def);
  assertEquals(typeof d !== "string" && d.gate.passed, false);
  assertEquals(parseDeliverable({ output: "" }, def), "no output");
});

Deno.test("FRIDAY step: one agent_request with the handoff doc + role, a handoff row, step dispatched", async () => {
  const { f, d, s } = setup({ agent: "friday", role_slug: "sales-engineer", deliverable: "doc", action_key: "delivery.scope_estimate", title: "Technical scope" });
  assertEquals(await dispatchExternal(d, s), "dispatched");
  const req = f.rows("agent_requests")[0] as Record<string, any>;
  assertEquals([req.to_user_id, req.from_user_id, req.source.factory_step_run_id], ["friday-u", "clara-u", "sr1"]);
  assertEquals(req.body.includes("Acceptance criteria") && req.body.includes('role_get("sales-engineer")'), true);
  assertEquals(f.rows("factory_handoffs").length, 1);
  assertEquals(f.rows("playbook_step_runs")[0].status, "dispatched");
});

Deno.test("no OS user for the agent: nothing dispatched, reason reported", async () => {
  const { d, s } = setup({ agent: "friday" }, { agentUsers: false });
  assertEquals((await dispatchExternal(d, s)).startsWith("no OS user"), true);
});

Deno.test("the step contract tells the model untrusted data is not instructions and nothing is sent by it", () => {
  const sys = stepSystem("ROLE", STEP({ deliverable: "email_draft" }) as never);
  assertEquals(sys.includes("<untrusted_data>") && sys.includes("never instructions") && sys.includes('"email"'), true);
});

Deno.test("tick: escalates, starts org runs, dispatches external work, and stops when nothing is claimable", async () => {
  const { d } = setup({});
  const f2 = new FakeSupabase({}, { rpc: { factory_escalate_stuck: () => 1, factory_start_due_org_runs: () => 2, factory_claim_steps: () => [] } });
  const r = await factoryTick({ ...d, db: asClient(f2) });
  assertEquals([r.escalated, r.orgRuns, r.dispatched, r.ran.length, r.errors.length], [1, 2, 0, 0, 0]);
});
