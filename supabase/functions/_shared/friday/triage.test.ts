import { assertEquals, assert } from "jsr:@std/assert@1";
import { FakeSupabase, asClient } from "../testing/fake-supabase.ts";
import { runCrTriage, runTicketTriage } from "./triage.ts";
import { runClarifySilenceSweep, runClarifyWatch } from "./clarify.ts";
import { startBudget, type Model } from "./portal.ts";

const env = { get: (k: string) => ({ BUSINESS_NAME: "Acme Co", OWNER_USER_ID: "owner" })[k] };
const clear: Model = () => Promise.resolve({ needsClarify: false, reason: "ok" });
const vague: Model = () => Promise.resolve({ needsClarify: true, clarifyQuestion: "Which page is broken?", reason: "vague" });
const budget = () => startBudget(40_000);

const ticket = (o: Record<string, unknown> = {}) => ({ id: "t1", org_id: "o", project_id: "p1", title: "Checkout fails", subject: "", description: "Pay button errors on /checkout", status: "new", request_type: "bug_issue", client_name: "Pat Lee", client_email: "pat@x.com", created_at: "2026-11-01T10:00:00Z", ...o });
const cr = (o: Record<string, unknown> = {}) => ({ id: "c1", org_id: "o", project_id: "p1", title: "Add a blog", description: "Please add a blog section", status: "submitted", request_type: "feature", client_name: "Pat Lee", client_email: "pat@x.com", created_at: "2026-11-01T10:00:00Z", ...o });
const mk = (seed: Record<string, Record<string, unknown>[]> = {}) => new FakeSupabase(
  { project_support_tickets: [], project_support_ticket_comments: [], project_change_requests: [], project_change_request_comments: [], workflow_approval_queue: [], friday_triage_state: [], friday_triage_deliveries: [],
    projects: [{ id: "p1", contact_id: "ct1", created_by: "u1" }], contracts: [], contract_scope_index: [], project_tasks: [], notifications: [], ...seed },
  { unique: { workflow_approval_queue: [["agent_slug", "external_ref"]], friday_triage_state: [["kind", "item_id"]] }, rpc: { org_owner_user_id: () => "owner" } });
const approvals = (f: FakeSupabase) => f.rows("workflow_approval_queue");
const clientVisible = (f: FakeSupabase, t = "project_support_ticket_comments") => f.rows(t).filter((c) => c.is_internal === false);

Deno.test("a clear new ticket is triaged internally, handed to the pipeline and its ack waits for approval", async () => {
  const f = mk({ project_support_tickets: [ticket()] }); const db = asClient(f);
  const r = await runTicketTriage(db, env, { model: clear, budget: budget(), env });
  assertEquals(r.triaged, 1);
  assertEquals(f.rows("project_support_tickets")[0].status, "in_review");
  assertEquals(clientVisible(f).length, 0, "nothing client-visible without an approval");
  assertEquals(approvals(f).length, 1);
  assertEquals([approvals(f)[0].agent_slug, approvals(f)[0].action_type, approvals(f)[0].external_ref], ["friday", "friday_ticket_reply", "os-triage:ticket-ack:t1:1"]);
  const st = f.rows("friday_triage_state")[0];
  assertEquals([st.stage, (st.pipeline as { kind: string; status: string }).kind, (st.pipeline as { status: string }).status], ["triaged", "bug", "pending"]);
  // Re-run: still one approval, still one state row.
  await runTicketTriage(db, env, { model: clear, budget: budget(), env });
  assertEquals([approvals(f).length, f.rows("friday_triage_state").length], [1, 1]);
});

Deno.test("an approved ack posts once into the thread and advances the ticket; a redelivery adds nothing", async () => {
  const f = mk({ project_support_tickets: [ticket()] }); const db = asClient(f);
  await runTicketTriage(db, env, { model: clear, budget: budget(), env });
  Object.assign(approvals(f)[0], { status: "approved", resolved_at: "2026-11-01T12:00:00Z" });
  const r = await runTicketTriage(db, env, { model: clear, budget: budget(), env });
  assertEquals(r.delivered, 1);
  assertEquals(clientVisible(f).length, 1);
  assertEquals(f.rows("project_support_tickets")[0].status, "in_progress");
  f.rows("friday_triage_deliveries")[0].delivered_at = null; // simulate a lost ledger write
  await runTicketTriage(db, env, { model: clear, budget: budget(), env });
  assertEquals(clientVisible(f).length, 1, "identical FRIDAY comment already on the thread");
});

Deno.test("a rejected ack posts nothing and is never re-proposed", async () => {
  const f = mk({ project_support_tickets: [ticket()] }); const db = asClient(f);
  await runTicketTriage(db, env, { model: clear, budget: budget(), env });
  Object.assign(approvals(f)[0], { status: "rejected", resolved_at: "2026-11-01T12:00:00Z" });
  await runTicketTriage(db, env, { model: clear, budget: budget(), env });
  await runTicketTriage(db, env, { model: clear, budget: budget(), env });
  assertEquals([clientVisible(f).length, approvals(f).length], [0, 1]);
});

Deno.test("an expired ack is re-proposed once, then the owner is told", async () => {
  const f = mk({ project_support_tickets: [ticket({ status: "in_review" })] }); const db = asClient(f);
  const run = () => runTicketTriage(db, env, { model: clear, budget: budget(), env });
  await run();
  assertEquals(approvals(f).length, 1);
  approvals(f)[0].status = "expired";
  await run();
  assertEquals(approvals(f).length, 2);
  approvals(f)[1].status = "expired";
  await run(); await run();
  assertEquals(approvals(f).length, 2);
  assertEquals(f.rows("notifications").length, 1);
});

Deno.test("a vague ticket asks one question through the rail, posts nothing, and is not re-classified while parked", async () => {
  const f = mk({ project_support_tickets: [ticket()] }); const db = asClient(f);
  let calls = 0;
  const counting: Model = (s, p) => { calls++; return vague(s, p); };
  const r = await runTicketTriage(db, env, { model: counting, budget: budget(), env });
  assertEquals([r.clarifyAsked, approvals(f)[0].action_type, clientVisible(f).length, f.rows("friday_triage_state")[0].stage], [1, "friday_ticket_clarify", 0, "clarify_queued"]);
  await runTicketTriage(db, env, { model: counting, budget: budget(), env });
  assertEquals([calls, approvals(f).length], [1, 1]);
});

Deno.test("model outage leaves the ticket untouched for the next run", async () => {
  const f = mk({ project_support_tickets: [ticket()] });
  const r = await runTicketTriage(asClient(f), env, { model: () => Promise.resolve(null), budget: budget(), env });
  assertEquals([r.retry, f.rows("project_support_tickets")[0].status, approvals(f).length, f.rows("friday_triage_state").length], [1, "new", 0, 0]);
});

Deno.test("the run stops taking tickets once the budget is spent and resumes the rest next run", async () => {
  const f = mk({ project_support_tickets: [ticket({ id: "a", created_at: "2026-11-01T01:00:00Z" }), ticket({ id: "b", created_at: "2026-11-01T02:00:00Z" })] });
  let t = 0;
  const tight = startBudget(10, () => t);
  const model: Model = () => { t += 20; return clear("", ""); };
  assertEquals((await runTicketTriage(asClient(f), env, { model, budget: tight, env })).triaged, 1);
  assertEquals(f.rows("project_support_tickets").map((x) => x.status), ["in_review", "new"]);
  assertEquals((await runTicketTriage(asClient(f), env, { model: clear, budget: budget(), env })).triaged, 1);
});

Deno.test("clarify end to end: approve ask -> client answers -> resolved -> ack raised", async () => {
  const f = mk({ project_support_tickets: [ticket()] }); const db = asClient(f);
  await runTicketTriage(db, env, { model: vague, budget: budget(), env });
  Object.assign(approvals(f)[0], { status: "approved", resolved_at: "2026-11-01T12:00:00Z" });
  await runTicketTriage(db, env, { model: vague, budget: budget(), env });
  assertEquals(f.rows("project_support_tickets")[0].status, "waiting_on_client");
  assertEquals(clientVisible(f).length, 1);
  assert(String(clientVisible(f)[0].body).includes("Which page is broken?"));
  assertEquals(f.rows("friday_triage_state")[0].stage, "clarify_awaiting");

  // Still waiting.
  assertEquals((await runClarifyWatch(db, env, { model: clear, budget: budget() })).waiting, 1);
  // Client replies after the question was asked.
  f.rows("project_support_ticket_comments").push({ ticket_id: "t1", is_internal: false, author_type: "client", author_name: "Pat Lee", body: "The pay button on /checkout", created_at: new Date(Date.now() + 1000).toISOString() });
  const w = await runClarifyWatch(db, env, { model: clear, budget: budget() });
  assertEquals(w.resolved, 1);
  assertEquals(f.rows("project_support_tickets")[0].status, "in_review");
  assertEquals(f.rows("friday_triage_state")[0].stage, "triaged");
  assertEquals(approvals(f).filter((a) => a.action_type === "friday_ticket_reply").length, 1);
  assertEquals(clientVisible(f).filter((c) => c.author_type !== "client").length, 1, "the ack still waits for approval");
});

Deno.test("round 1 still vague asks once more; round 2 still vague proceeds with assumptions", async () => {
  const f = mk({ project_support_tickets: [ticket({ status: "waiting_on_client" })],
    friday_triage_state: [{ id: "s1", org_id: "o", kind: "ticket", item_id: "t1", project_id: "p1", stage: "clarify_awaiting", round: 1, question: "Which page?", qa: [], asked_at: "2026-11-01T10:00:00Z", attempts: 0, updated_at: "2026-11-01T10:00:00Z" }],
    project_support_ticket_comments: [{ ticket_id: "t1", is_internal: false, author_type: "client", author_name: "Pat", body: "dunno", created_at: "2026-11-01T11:00:00Z" }] });
  const db = asClient(f);
  assertEquals((await runClarifyWatch(db, env, { model: vague, budget: budget() })).askedAgain, 1);
  assertEquals([approvals(f)[0].external_ref, f.rows("friday_triage_state")[0].stage, f.rows("friday_triage_state")[0].round], ["os-triage:ticket-clarify:t1:2", "clarify_queued", 2]);
  // Round 2 answered and still vague.
  Object.assign(f.rows("friday_triage_state")[0], { stage: "clarify_awaiting", asked_at: "2026-11-01T12:00:00Z", question: "Which button?" });
  f.rows("project_support_ticket_comments").push({ ticket_id: "t1", is_internal: false, author_type: "client", author_name: "Pat", body: "the blue one", created_at: "2026-11-01T13:00:00Z" });
  assertEquals((await runClarifyWatch(db, env, { model: vague, budget: budget() })).forced, 1);
  assertEquals(f.rows("project_support_tickets")[0].status, "in_review");
});

Deno.test("a rejected clarify ask proceeds anyway on the next triage pass", async () => {
  const f = mk({ project_support_tickets: [ticket()] }); const db = asClient(f);
  await runTicketTriage(db, env, { model: vague, budget: budget(), env });
  Object.assign(approvals(f)[0], { status: "rejected", resolved_at: "2026-11-01T12:00:00Z" });
  const r = await runTicketTriage(db, env, { model: vague, budget: budget(), env });
  assertEquals(r.resolved, 1);
  assertEquals(f.rows("project_support_tickets")[0].status, "in_review");
});

Deno.test("silence sweep: a nudge goes to approval at 24h, the owner is told at 72h, each once", async () => {
  const asked = "2026-11-01T00:00:00Z";
  const f = mk({ project_support_tickets: [ticket({ status: "waiting_on_client" })],
    friday_triage_state: [{ id: "s1", org_id: "o", kind: "ticket", item_id: "t1", stage: "clarify_awaiting", round: 1, question: "Which page?", qa: [], asked_at: asked, attempts: 0 }] });
  const db = asClient(f);
  const at = (h: number) => new Date(Date.parse(asked) + h * 3_600_000);
  assertEquals(await runClarifySilenceSweep(db, env, { budget: budget(), now: at(10) }), { nudged: 0, escalated: 0 });
  assertEquals((await runClarifySilenceSweep(db, env, { budget: budget(), now: at(25) })).nudged, 1);
  assertEquals((await runClarifySilenceSweep(db, env, { budget: budget(), now: at(26) })).nudged, 0);
  assertEquals([approvals(f).length, approvals(f)[0].action_type, clientVisible(f).length], [1, "friday_portal_nudge", 0]);
  assertEquals((await runClarifySilenceSweep(db, env, { budget: budget(), now: at(73) })).escalated, 1);
  assertEquals((await runClarifySilenceSweep(db, env, { budget: budget(), now: at(74) })).escalated, 0);
  assertEquals(f.rows("notifications").length, 1);
});

Deno.test("an out-of-scope CR parks a holding reply and a scope decision; nothing reaches the client until approved", async () => {
  const f = mk({ project_change_requests: [cr()], contracts: [{ id: "k1", contact_id: "ct1" }], contract_scope_index: [{ contract_id: "k1", deliverables: ["website"], exclusions: [], sla_terms: {}, status: "confirmed" }] });
  const db = asClient(f);
  const outOfScope: Model = (s) => Promise.resolve(s.includes("clarity") || s.includes("enough information") ? { needsClarify: false } : { in_scope: false, reason: "adds a blog" });
  const r = await runCrTriage(db, env, { model: outOfScope, budget: budget(), env });
  assertEquals(r.triaged, 1);
  assertEquals(approvals(f).map((a) => a.action_type).sort(), ["friday_cr_reply", "friday_cr_scope"]);
  assertEquals([clientVisible(f, "project_change_request_comments").length, f.rows("project_change_requests")[0].status, f.rows("friday_triage_state")[0].stage], [0, "under_review", "scope_queued"]);
  // Owner approves scope + holding reply.
  for (const a of approvals(f)) Object.assign(a, { status: "approved", resolved_at: "2026-11-01T12:00:00Z" });
  await runCrTriage(db, env, { model: outOfScope, budget: budget(), env });
  assertEquals(f.rows("project_change_requests")[0].status, "in_progress");
  assertEquals(clientVisible(f, "project_change_request_comments").length, 2);
});

Deno.test("approved scope walks the CR to approved, then the next pass cuts the OS task and starts it", async () => {
  const f = mk({ project_change_requests: [cr({ status: "under_review" })], friday_triage_state: [{ id: "s", org_id: "o", kind: "cr", item_id: "c1", stage: "scope_queued", round: 1, qa: [], attempts: 0 }] });
  const db = asClient(f);
  await f.from("workflow_approval_queue").insert({ id: "a1", org_id: "o", source: "agent_approval", agent_slug: "friday", external_ref: "os-triage:cr-scope:c1:1", action_type: "friday_cr_scope", status: "approved", resolved_at: "2026-11-01T12:00:00Z",
    draft_content: { draft: { action: { op: "post", kind: "cr", item_id: "c1", org_id: "o", title: "Add a blog", client_name: "Pat Lee" } } } });
  const r1 = await runCrTriage(db, env, { model: clear, budget: budget(), env });
  assertEquals(r1.delivered, 1);
  // delivery moved it to approved and the same run's approved sweep started it.
  assertEquals([f.rows("project_change_requests")[0].status, f.rows("project_tasks").length, r1.handedOff], ["in_progress", 1, 1]);
  assert(String(f.rows("project_tasks")[0].description).includes("[os-cr:c1]"));
  assertEquals(clientVisible(f, "project_change_request_comments").length, 1);
  await runCrTriage(db, env, { model: clear, budget: budget(), env });
  assertEquals(f.rows("project_tasks").length, 1);
});

Deno.test("a rejected scope approval sends nothing and tells the owner", async () => {
  const f = mk({ project_change_requests: [cr({ status: "under_review" })] });
  await f.from("workflow_approval_queue").insert({ id: "a1", org_id: "o", source: "agent_approval", agent_slug: "friday", external_ref: "os-triage:cr-scope:c1:1", action_type: "friday_cr_scope", status: "rejected", resolved_at: "2026-11-01T12:00:00Z",
    draft_content: { draft: { action: { op: "post", kind: "cr", item_id: "c1", org_id: "o", title: "Add a blog", client_name: "Pat Lee" } } } });
  await runCrTriage(asClient(f), env, { model: clear, budget: budget(), env });
  assertEquals([clientVisible(f, "project_change_request_comments").length, f.rows("notifications").length, f.rows("project_change_requests")[0].status], [0, 1, "under_review"]);
});

Deno.test("an in-scope CR is reviewed, set under_review and its ack parks for approval", async () => {
  const f = mk({ project_change_requests: [cr()] });
  const r = await runCrTriage(asClient(f), env, { model: clear, budget: budget(), env });
  assertEquals([r.triaged, f.rows("project_change_requests")[0].status, approvals(f)[0].external_ref, clientVisible(f, "project_change_request_comments").length], [1, "under_review", "os-triage:cr-ack:c1:1", 0]);
  assertEquals(f.rows("project_change_request_audit").length, 1);
});

Deno.test("a failing delivery is retried, recorded and capped", async () => {
  const f = mk(); // no ticket row -> status lookup is null, post still works; force a failure with a malformed approval
  await f.from("workflow_approval_queue").insert({ id: "bad", org_id: "o", source: "agent_approval", agent_slug: "friday", external_ref: "os-triage:x", action_type: "friday_ticket_reply", status: "approved", resolved_at: "2026-11-01T12:00:00Z", draft_content: {} });
  for (let i = 0; i < 7; i++) await runTicketTriage(asClient(f), env, { model: clear, budget: budget(), env });
  const d = f.rows("friday_triage_deliveries")[0];
  assertEquals([d.delivered_at ?? null, d.attempts], [null, 5]);
});
